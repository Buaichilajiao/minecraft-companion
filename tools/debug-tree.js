/* 调试 collect-tree 起点识别 */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const LOG_BLOCKS = ['oak_log','spruce_log','birch_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log'];

(async () => {
  const client = new Client({ name: 'dbg', version: '1' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  // 用一个临时调试工具：直接通过 get-block-info 看 findBlock 起点
  // 先 find-blocks 拿坐标
  const r = await client.callTool({ name: 'find-blocks', arguments: { block_type: 'acacia_log', max_distance: 48 } });
  console.log('find-blocks:', r.content.map(c=>c.text).join('\n').slice(0,300));
  await client.close();
})().catch(e=>{console.error(e);process.exit(1);});
