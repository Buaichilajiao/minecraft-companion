const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
(async()=>{
  const c=new Client({name:"q",version:"1"},{capabilities:{}});
  await c.connect(new SSEClientTransport(new URL("http://127.0.0.1:3001/mcp")));
  const call=async(n,a)=>{const r=await c.callTool({name:n,arguments:a},undefined,{timeout:20000});return r.content.map(x=>x.text).join(" ");};
  const r1 = await call("run-command",{command:"data get block 14 74 3"});
  console.log("PORTAL:", r1);
  await c.close();
})().catch(e=>{console.error(e.message);process.exit(1)});