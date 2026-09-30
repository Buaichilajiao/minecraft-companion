/* 手动测试 LittleSkin 认证，定位 bot 登录挂起原因 */
const fetch = require('node-fetch');
const cfg = require('../config/config.json');

async function tryAuth(label, username) {
  const body = {
    agent: { name: 'Minecraft', version: 1 },
    username,
    password: cfg.mc.password,
    requestUser: true,
  };
  try {
    const r = await fetch('https://littleskin.cn/api/yggdrasil/authserver/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const t = await r.text();
    console.log(`[${label}] status=${r.status}`);
    console.log(`[${label}] body=${t.slice(0, 350)}`);
  } catch (e) {
    console.log(`[${label}] 请求异常: ${e.message}`);
  }
}

(async () => {
  await tryAuth('角色名', cfg.mc.username);
  await tryAuth('邮箱', '3693500901@qq.com');
})();
