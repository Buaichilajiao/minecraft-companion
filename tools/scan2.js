const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
(async()=>{
  const c=new Client({name:"q",version:"1"},{capabilities:{}});
  await c.connect(new SSEClientTransport(new URL("http://127.0.0.1:3001/mcp")));
  const call=async(n,a)=>{const r=await c.callTool({name:n,arguments:a},undefined,{timeout:20000});return r.content.map(x=>x.text).join(" ");};
  // 扫描门 z42-44 x47-50 y79-83
  for (let z=42;z<=44;z++) for (let y=79;y<=83;y++){
    let row="";
    for (let x=47;x<=50;x++){
      const r=await call("get-block-info",{x,y,z});
      const m=/= (\S+)/.exec(r);
      const nm=m?m[1]:"?";
      row += nm==="air"?"·":nm==="nether_portal"?"P":nm==="obsidian"?"O":nm[0];
    }
    console.log(`z${z} y${y} ${row}`);
  }
  await c.close();
})().catch(e=>{console.error(e.message);process.exit(1)});