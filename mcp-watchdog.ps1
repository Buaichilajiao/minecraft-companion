<#
  mcp-watchdog.ps1 - Auto-heal AstrBot <-> minecraft-companion MCP link
  ====================================================================
  WHY
  ----
  The minecraft-companion bot exposes its body as an MCP SSE server on :3001.
  AstrBot connects to it as an MCP client. The connection is one-shot SSE:
  when the companion restarts (crash / manual restart / AstrBot starts
  before the bot), AstrBot's MCP session dies silently. The dashboard may
  even still show "connected" (it only checks the runtime object, not the
  live session), yet every tool call fails with:
      MCP session is not available for MCP function tools.

  FIX
  ---
  AstrBot reconnects cleanly when the MCP server is disabled+re-enabled via
  its dashboard API:
      PATCH /api/v1/mcp/servers/enabled  { server_name, enabled: true }
  This watchdog watches the bot port (default :3001); whenever the bot comes
  UP (restart edge) or AstrBot reports disconnected/zero tools, it fires that
  PATCH once. Run as a scheduled task or in the background.

  CONFIG (open-source friendly: nothing is hardcoded to a machine)
  ------------------------------------------------------------------
  Resolve order for the AstrBot cmd_config.json (dashboard creds live there):
    1. -CmdConfig <path>         explicit parameter
    2. $env:ASTRBOT_CMD_CONFIG   environment variable
    3. default null -> dashboard/port API will NOT be usable; script logs a
       clear FATAL and exits. (No hidden local paths in the repo.)

  All other knobs have portable defaults (see param block).

  USAGE (PowerShell 5.1+)
  -----------------------
    # foreground loop
    .\mcp-watchdog.ps1 -CmdConfig C:\AstrBot\data\cmd_config.json

    # single check (scheduled task every 30s)
    .\mcp-watchdog.ps1 -CmdConfig C:\AstrBot\data\cmd_config.json -Once

    # env var instead of parameter
    $env:ASTRBOT_CMD_CONFIG = 'C:\AstrBot\data\cmd_config.json'
    .\mcp-watchdog.ps1 -Once
#>
param(
  [string]$CmdConfig = $env:ASTRBOT_CMD_CONFIG,
  [string]$AstrUrl = '',
  [string]$ServerName = 'minecraft-companion',
  [string]$BotHost = '127.0.0.1',
  [int]$BotPort = 3001,
  [int]$IntervalSec = 15,
  [int]$PatchCooldownSec = 30,
  [switch]$Once,
  [switch]$ForcePatchOnce
)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'mcp-watchdog.log'

function Write-Log([string]$msg) {
  $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  Write-Host $line
}

# ---- read dashboard credentials (jwt_secret allows self-signed HS256 JWT) ----
function Load-DashboardConfig {
  if (-not $CmdConfig) {
    throw 'No AstrBot cmd_config.json. Pass -CmdConfig <path> or set $env:ASTRBOT_CMD_CONFIG.'
  }
  if (-not (Test-Path $CmdConfig)) { throw "cmd_config not found: $CmdConfig" }
  $cfg = Get-Content $CmdConfig -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $cfg.dashboard) { throw 'no dashboard section in cmd_config.json' }
  $dash = $cfg.dashboard
  if (-not $dash.jwt_secret) { throw 'no dashboard.jwt_secret in cmd_config.json' }
  return @{
    secret = [string]$dash.jwt_secret
    user   = [string]$dash.username
    port   = if ($dash.port) { [int]$dash.port } else { 6185 }
  }
}

# ---- minimal HS256 JWT (header.payload.signature) ----
function New-BearerJwt([string]$secret, [string]$username, [int]$expSec = 600) {
  $enc = [System.Text.Encoding]::UTF8
  function B64Url([byte[]]$bytes) {
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  }
  $header = B64Url ($enc.GetBytes('{"alg":"HS256","typ":"JWT"}'))
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $exp = $now + $expSec
  $payload = B64Url ($enc.GetBytes(('{{"username":"{0}","iat":{1},"exp":{2}}}' -f $username, $now, $exp)))
  $hmac = New-Object System.Security.Cryptography.HMACSHA256
  $hmac.Key = $enc.GetBytes($secret)
  $sig = B64Url ($hmac.ComputeHash($enc.GetBytes("$header.$payload")))
  return "$header.$payload.$sig"
}

# ---- TCP probe: is the bot MCP server reachable? ----
function Test-BotPort([string]$hostName, [int]$port, [int]$timeoutMs = 800) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $c.BeginConnect($hostName, $port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne($timeoutMs, $false) -and $c.Connected
    if ($ok) { $c.EndConnect($iar) }
    return $ok
  } catch { return $false } finally { $c.Close() }
}

function Get-McpState([string]$baseUrl, [string]$bearer, [string]$name) {
  $h = @{ Authorization = "Bearer $bearer" }
  try {
    $r = Invoke-RestMethod -Uri "$baseUrl/api/v1/mcp/servers" -Headers $h -Method GET -TimeoutSec 15
    $srv = $r.data | Where-Object { $_.name -eq $name } | Select-Object -First 1
    if (-not $srv) { return @{ connected = $false; tools = 0 } }
    $tools = @($srv.tools)
    return @{ connected = [bool]$srv.connected; tools = $tools.Count }
  } catch {
    Write-Log "GET mcp/servers failed: $($_.Exception.Message)"
    return $null
  }
}

function Invoke-McpReconnect([string]$baseUrl, [string]$bearer, [string]$name) {
  $h = @{ Authorization = "Bearer $bearer"; 'Content-Type' = 'application/json' }
  $uri = "$baseUrl/api/v1/mcp/servers/enabled"
  try {
    $r = Invoke-RestMethod -Uri $uri -Headers $h -Method PATCH -Body (@{ server_name = $name; enabled = $true } | ConvertTo-Json) -TimeoutSec 60
    Write-Log "PATCH enabled=true OK -> reconnect triggered ($($r.message))"
    return $true
  } catch {
    $detail = ''
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $detail = ' :: ' + ($_.ErrorDetails.Message -replace '\s+', ' ') }
    Write-Log "PATCH enabled=true failed: $($_.Exception.Message)$detail -> fallback disable+enable"
  }
  # 回退：部分 AstrBot 版本对"已是启用状态再置启用"直接返回 400，
  # 用 disable -> enable 强制重建 SSE session（等价于面板里手动关一次再开）。
  try {
    Invoke-RestMethod -Uri $uri -Headers $h -Method PATCH -Body (@{ server_name = $name; enabled = $false } | ConvertTo-Json) -TimeoutSec 60 | Out-Null
    Start-Sleep -Milliseconds 800
    $r = Invoke-RestMethod -Uri $uri -Headers $h -Method PATCH -Body (@{ server_name = $name; enabled = $true } | ConvertTo-Json) -TimeoutSec 60
    Write-Log "PATCH disable+enable OK -> reconnect triggered ($($r.message))"
    return $true
  } catch {
    $detail = ''
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $detail = ' :: ' + ($_.ErrorDetails.Message -replace '\s+', ' ') }
    Write-Log "PATCH disable+enable failed: $($_.Exception.Message)$detail"
    return $false
  }
}

# ============================ main ============================
try {
  $dashCfg = Load-DashboardConfig
} catch {
  Write-Log "FATAL: $($_.Exception.Message)"
  exit 1
}
if (-not $AstrUrl) { $AstrUrl = "http://127.0.0.1:$($dashCfg.port)" }
Write-Log "watchdog start: AstrBot=$AstrUrl server=$ServerName bot=$BotHost`:$BotPort interval=${IntervalSec}s cooldown=${PatchCooldownSec}s (Once=$Once)"

# 上次 up/down 状态持久化(state 文件跨进程共享,计划任务每 30s 拉起一次也能识别 down→up 边沿;
# 首次运行无历史状态 → 只记录基线,不误触发 restart edge)
$stateFile = Join-Path $logDir 'mcp-watchdog.state'
$wasUp = $false    # 历史上一次是否 up
$havePrev = $false # 是否有历史状态(首次运行 = false)
try {
  if (Test-Path $stateFile) {
    $wasUp = ((Get-Content $stateFile -Raw).Trim() -eq '1')
    $havePrev = $true
  }
} catch { $havePrev = $false }

function Save-State([bool]$up) {
  try { [System.IO.File]::WriteAllText($stateFile, $(if ($up) { '1' } else { '0' })) } catch {}
}

$lastPatch = 0
do {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $up = Test-BotPort $BotHost $BotPort

  if ($ForcePatchOnce) {
    $bearer = New-BearerJwt -secret $dashCfg.secret -username $dashCfg.user
    Write-Log 'manual force patch requested'
    Invoke-McpReconnect $AstrUrl $bearer $ServerName | Out-Null
    $ForcePatchOnce = $false
    Save-State $up; $wasUp = $up; $havePrev = $true
    if ($Once) { break }
    Start-Sleep -Seconds $IntervalSec
    continue
  }

  if ($up) {
    $bearer = New-BearerJwt -secret $dashCfg.secret -username $dashCfg.user
    $st = Get-McpState $AstrUrl $bearer $ServerName
    $reasons = New-Object System.Collections.Generic.List[string]

    # 1) restart edge: 历史上 down、现在 up → AstrBot 的 SSE 会话已随 bot 重启而失效(必 patch)
    if ($havePrev -and -not $wasUp) {
      $reasons.Add("restart edge: bot port $BotPort came UP")
    }
    # 2) dashboard 健康: 报 disconnected 或 0 tools → patch(与边沿是 OR 关系,两路都盯)
    if ($st -and (-not $st.connected)) {
      $reasons.Add('dashboard reports disconnected')
    } elseif ($st -and $st.tools -eq 0) {
      $reasons.Add('dashboard reports zero tools')
    }

    if ($reasons.Count -gt 0 -and ($now - $lastPatch) -ge $PatchCooldownSec) {
      Write-Log "need reconnect: $($reasons -join '; ')"
      if (Invoke-McpReconnect $AstrUrl $bearer $ServerName) { $lastPatch = $now }
    } elseif ($reasons.Count -gt 0) {
      Write-Log "need reconnect: $($reasons -join '; ') (cooldown, skip)"
    } elseif ($st) {
      Write-Log ("ok: bot up, connected={0} tools={1}" -f $st.connected, $st.tools)
    }
  } else {
    if ($wasUp) { Write-Log "bot port $BotPort went DOWN" }
  }
  Save-State $up; $wasUp = $up; $havePrev = $true
  if ($Once) { break }
  Start-Sleep -Seconds $IntervalSec
} while ($true)
Write-Log 'watchdog exit'
