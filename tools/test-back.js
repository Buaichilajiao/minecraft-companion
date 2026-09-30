const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
(async()=>{
  const c=new Client({name:"t",version:"1"},{capabilities:{}});
  await c.connect(new SSEClientTransport(new URL("http://127.0.0.1:3001/mcp")));
  const call=async(n,a)=>{const r=await c.callTool({name:n,arguments:a},undefined,{timeout:15000});return r.content.map(x=>x.text).join(" ");};
  const cmd=async(command)=>call("run-command",{command});
  // 先 tp 到远处（z8），再 tp 进门，观察
  await cmd("tp XiaoBai_bot 13.5 74 8");
  await new Promise(r=>setTimeout(r,1500));
  console.log("门外:", JSON.parse(await call("get-state",{})).self.position);
  // 进门
  await cmd("tp XiaoBai_bot 13.5 74 3.5");
  for (let i=0;i<14;i++){
    await new Promise(r=>setTimeout(r,500));
    const st=JSON.parse(await call("get-state",{}));
    console.log((i*0.5+0.5)+"s:",st.world.dimension,JSON.stringify(st.self.position));
    if(st.world.dimension==="overworld"){console.log("✅ 成功");break;}
  }
  await c.close();
})().catch(e=>{console.error(e.message);process.exit(1)});