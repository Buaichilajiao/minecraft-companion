const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
(async()=>{
  const c=new Client({name:"s",version:"1"},{capabilities:{}});
  await c.connect(new SSEClientTransport(new URL("http://127.0.0.1:3001/mcp")));
  const call=async(n,a)=>{const r=await c.callTool({name:n,arguments:a},undefined,{timeout:20000});return r.content.map(x=>x.text).join(" ");};
  // 下界 z=3 平面，x11-17，y72-79
  for (let z=2; z<=4; z++) {
    for (let y=79; y>=72; y--) {
      let row="z"+z+" y"+y+" ";
      for (let x=11; x<=17; x++) {
        const t=await call("get-block-info",{x,y,z});
        const n=t.match(/=\s*(\S+)/)?.[1];
        row+=n==="obsidian"?"O":n==="nether_portal"?"P":n==="fire"?"F":n==="air"?".":n[0];
      }
      console.log(row);
    }
  }
  await c.close();
})().catch(e=>{console.error(e.message);process.exit(1)});