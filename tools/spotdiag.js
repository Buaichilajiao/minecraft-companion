const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
(async () => {
  const client = new Client({ name: 'sp', version: '1.0' });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp?clientId=sp1')));
  const my = [-10, 124, -3];
  const spots = [
    [my[0]+1, my[1], my[2]],
    [my[0]-1, my[1], my[2]],
    [my[0], my[1], my[2]+1],
    [my[0], my[1], my[2]-1],
  ];
  for (const s of spots) {
    const args = { x: s[0], y: s[1], z: s[2] };
    const r1 = await client.callTool({ name: 'get-block-info', arguments: args }, undefined, { timeout: 15000 });
    const r2 = await client.callTool({ name: 'get-block-info', arguments: { x: s[0], y: s[1]-1, z: s[2] } }, undefined, { timeout: 15000 });
    const n1 = r1.content[0].text.match(/name[=: ]+"?([a-z_]+)"?/);
    const n2 = r2.content[0].text.match(/name[=: ]+"?([a-z_]+)"?/);
    console.log(`spot(${s[0]},${s[1]},${s[2]}) 格=${n1?n1[1]:'?'} 下方=${n2?n2[1]:'?'}`);
  }
  client.close();
})().catch(e => { console.error(String(e)); process.exit(1); });
