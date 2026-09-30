/* 准备测试：创造模式 + 给黑曜石14 + 打火石  node tools/prep.js */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const client = new Client({ name: 'prep', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  const cmd = async (command) => {
    const res = await client.callTool({ name: 'run-command', arguments: { command } }, undefined, { timeout: 30000 });
    return res.content.map((c) => c.text).join(' ');
  };
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
    return res.content.map((c) => c.text).join(' ');
  };

  console.log('创造模式:', (await cmd('gamemode creative XiaoBai_bot')).slice(0, 60));
  await new Promise((r) => setTimeout(r, 500));
  console.log('给黑曜石:', (await cmd('give XiaoBai_bot obsidian 14')).slice(0, 60));
  console.log('给打火石:', (await cmd('give XiaoBai_bot flint_and_steel 1')).slice(0, 60));
  await new Promise((r) => setTimeout(r, 1200));

  // 查自身位置/模式
  const self = await call('get-self-info', {});
  console.log('自身:', self.slice(0, 260));
  const obs = await call('find-item', { item_name: 'obsidian' });
  console.log('黑曜石:', obs.slice(0, 120));
  const flint = await call('find-item', { item_name: 'flint_and_steel' });
  console.log('打火石:', flint.slice(0, 120));
  await client.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
