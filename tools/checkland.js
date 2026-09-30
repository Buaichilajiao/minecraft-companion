const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
(async()=>{
  const c=new Client({name:"q",version:"1"},{capabilities:{}});
  await c.connect(new SSEClientTransport(new URL("http://127.0.0.1:3001/mcp")));
  const call=async(n,a)=>{const r=await c.callTool({name:n,arguments:a},undefined,{timeout:20000});return r.content.map(x=>x.text).join(" ");};
  await call("run-command",{command:"tp XiaoBai_bot 48 100 44"});
  await new Promise(r=>setTimeout(r,3500));
  const st=JSON.parse(await call("get-state",{}));
  console.log("落地:",JSON.stringify(st.self.position),"维度:",st.world.dimension);
  const below=await call("get-block-info",{x:48,y:78,z:44});
  const feet=await call("get-block-info",{x:48,y:79,z:44});
  console.log("y78:",below.match(/=\s*(\S+)/)?.[1],"y79:",feet.match(/=\s*(\S+)/)?.[1]);
  await c.close();
})().catch(e=>{console.error(e.message);process.exit(1)});