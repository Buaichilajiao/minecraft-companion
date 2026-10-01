# restart-with-rotate.ps1
# 启动 minecraft-companion 并做日志轮转（包装 npm start，stdout/stderr -> logs/restart.log）
# size 轮转：restart.log 超过阈值 -> 依次后移 .1/.2/.3，最旧删除（与应用内 app.log 轮转策略一致）
# 配合计划任务/手动重启：崩溃后可据此定位启动失败原因（见 README「日志」一节）。
#
# 用法：
#   .\restart-with-rotate.ps1              # 前台启动，日志写 logs\restart.log
#   .\restart-with-rotate.ps1 -Once        # 单次启动后退出（脚本本身；bot 仍在前台跑）
param(
    [int]$MaxMB = 2,
    [int]$Keep   = 3
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$logFile = Join-Path $logDir 'restart.log'

# —— 大小轮转：restart.log 超阈值则 .2->.3、.1->.2、新->.1 ——
function Rotate-Log {
    if (-not (Test-Path $logFile)) { return }
    $size = (Get-Item $logFile).Length
    if ($size -lt ($MaxMB * 1024 * 1024)) { return }
    # 清掉最旧一份
    if (Test-Path "$logFile.$Keep")  { Remove-Item "$logFile.$Keep" -Force }
    for ($i = $Keep - 1; $i -ge 1; $i--) {
        if (Test-Path "$logFile.$i") { Move-Item "$logFile.$i" "$logFile.$($i+1)" -Force }
    }
    Move-Item $logFile "$logFile.1" -Force
    Write-Host "[restart-with-rotate] restart.log 已达 ${MaxMB}MB，已轮转"
}

Rotate-Log

Write-Host "[restart-with-rotate] 启动 minecraft-companion ... (日志: $logFile)"
Push-Location $root
try {
    if (Get-Command npm -ErrorAction SilentlyContinue) {
        & npm run build *>> $logFile
        & node dist/main.js 2>&1 | Tee-Object -FilePath $logFile -Append
    } else {
        Write-Error "npm 不在 PATH 中，无法启动"
    }
}
finally {
    Pop-Location
}