const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
(async()=>{
  const c=new Client({name:"t",version:"1"},{capabilities:{}});
  await c.connect(new SSEClientTransport(new URL("http://127.0.0.1:3001/mcp")));
  const call=async(n,a)=>{const r=await c.callTool({name:n,arguments:a},undefined,{timeout:20000});return r.content.map(x=>x.text).join(" ");};
  const cmd=async(command)=>call("run-command",{command});
  // 强制重设内孔 portal（axis=x）
  for (const y of [74,75,76]) {
    for (const x of [13,14]) {
      console.log(await cmd(`setblock ${x} ${y} 3 minecraft:nether_portal[axis=x]`));
    }
  }
  await new Promise(r=>setTimeout(r,1000));
  // 确认
  const ch = await call("get-block-info",{x:13,y:74,z:3});
  console.log("确认:",ch);
  await c.close();
})().catch(e=>{console.error(e.message);process.exit(1)});