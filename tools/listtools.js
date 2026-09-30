const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
(async () => {
  const c = new Client({ name: "list", version: "1" }, { capabilities: {} });
  await c.connect(new SSEClientTransport(new URL("http://127.0.0.1:3001/mcp")));
  const tools = await c.listTools();
  const names = tools.tools.map(t => t.name);
  console.log("工具数:", names.length);
  console.log(names.join("\n"));
  await c.close();
})();
