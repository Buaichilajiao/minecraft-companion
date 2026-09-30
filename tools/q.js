const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
(async()=>{
  const c=new Client({name:"q",version:"1"},{capabilities:{}});
  await c.connect(new SSEClientTransport(new URL("http://127.0.0.1:3001/mcp")));
  const call=async(n,a)=>{const r=await c.callTool({name:n,arguments:a},undefined,{timeout:15000});return r.content.map(x=>x.text).join(" ");};
  console.log(await call("run-command",{command:"data get entity XiaoBai_bot"}));
  await c.close();
})().catch(e=>{console.error(e.message);process.exit(1)});