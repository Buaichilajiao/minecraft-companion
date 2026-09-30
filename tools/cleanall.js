const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
(async () => {
  const c = new Client({name:"cl",version:"1"},{capabilities:{}});
  await c.connect(new SSEClientTransport(new URL("http://127.0.0.1:3001/mcp")));
  const cmd = async (command) => { const r = await c.callTool({name:"run-command",arguments:{command}},undefined,{timeout:20000}); return r.content.map(x=>x.text).join(" "); };
  // 传回主世界安全点
  console.log((await cmd("execute as XiaoBai_bot in minecraft:overworld run tp @s 48 100 44")).slice(0,50));
  await new Promise(r=>setTimeout(r,2000));
  // 彻底清理 x44-53, z41-47, y78-87
  console.log((await cmd("fill 44 78 41 53 87 47 air")).slice(0,50));
  // 地下补 stone (x44-53 z41-47 y77-78)
  console.log((await cmd("fill 44 77 41 53 78 47 stone")).slice(0,50));
  await c.close();
})().catch(e=>{console.error("ERR",e.message);process.exit(1)});