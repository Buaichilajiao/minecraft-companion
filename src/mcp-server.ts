import express from 'express';
import cors from 'cors';
import type { Server as HttpServer } from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { z } from 'zod';
import type { BodyController } from './body-controller';
import { withBody } from './tools/helpers';
import { log } from './utils';

export type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: ToolHandler;
  action: boolean;
}

/** 动作类工具白名单：这些工具会操作 bot 身体（移动/挖掘/放置/攻击/种田/睡觉等），统一走身体锁 */
const ACTION_TOOLS = new Set([
  'move-to', 'move-direction', 'jump', 'fly-to',
  'dig-block', 'collect-tree', 'mine-ore', 'pickup-item',
  'place-block',
  'attack-entity',
  'till-land', 'plant-seed', 'harvest',
  'sleep', 'fish', 'breed-animal',
  'equip-item', 'chest-deposit', 'chest-withdraw', 'drop-item',
  'craft-item',
  'build-schem', 'build-shelter',
  // v17 补齐（审查发现漏登记 → 这些工具会动身体却没锁，会与跟随/保命抢身体）：
  'smelt-batch', 'use-bone-meal', 'eat',
]);

/** OpenAI 工具定义（供大脑直连 LLM 使用） */
export interface OpenAiTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 简易 zod → JSON Schema（OpenAI tools 用），覆盖本项目工具用到的类型 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as {
    typeName?: string;
    innerType?: z.ZodTypeAny;
    values?: string[];
    options?: string[];
    type?: z.ZodTypeAny;
    shape?: () => Record<string, z.ZodTypeAny>;
    description?: string;
  };
  const desc = def.description ? { description: def.description } : {};
  switch (def.typeName) {
    case 'ZodString':
      return { type: 'string', ...desc };
    case 'ZodNumber':
      return { type: 'number', ...desc };
    case 'ZodBoolean':
      return { type: 'boolean', ...desc };
    case 'ZodOptional':
    case 'ZodDefault':
      return zodToJsonSchema(def.innerType!);
    case 'ZodEnum':
      return { type: 'string', enum: def.values ?? def.options ?? [], ...desc };
    case 'ZodArray':
      return { type: 'array', items: zodToJsonSchema(def.type!), ...desc };
    case 'ZodObject': {
      const shape = def.shape ? def.shape() : {};
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = zodToJsonSchema(v);
        const tn = (v._def as { typeName?: string }).typeName;
        if (tn !== 'ZodOptional' && tn !== 'ZodDefault') required.push(k);
      }
      return { type: 'object', properties, required, ...desc };
    }
    default:
      return { type: 'string', ...desc };
  }
}

/** MCP 服务器：支持多客户端并发 SSE 连接（AstrBot 会同时建立多个连接） */
export class McpServerManager {
  private readonly serverName: string;
  private readonly serverVersion: string;
  private transports = new Map<string, { transport: SSEServerTransport; clientId: string }>();
  private app: express.Express;
  private httpServer: HttpServer | null = null;
  private readonly port: number;
  private toolRegistry = new Map<string, ToolDef>();
  private readonly body: BodyController;
  private readonly clientWhitelist: string[];

  constructor(name: string, version: string, port: number, body: BodyController, clientWhitelist: string[] = []) {
    this.serverName = name;
    this.serverVersion = version;
    this.port = port;
    this.body = body;
    this.clientWhitelist = clientWhitelist;
    this.app = express();
    this.app.use(cors());
    // 注意：不能加 express.json()，它会消费 POST body，
    // 导致 SSEServerTransport.handlePostMessage 里 getRawBody(req) 报 "stream is not readable"
  }

  /** 客户端身份（v1.3.0 多方控制）：SSE URL 带 ?clientId=xxx 区分不同客户端 */
  private resolveClientId(raw: unknown): string {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id) {
      log('WARN', '⚠ MCP 客户端未传 clientId，按 anonymous 处理。多客户端控制请带 ?clientId=名字');
      return 'anonymous';
    }
    return id;
  }

  /** 白名单校验：clientWhitelist 非空时仅放行名单内的 clientId；'brain' 内部回路始终放行 */
  private isAllowed(clientId: string): boolean {
    if (clientId === 'brain') return true;
    if (this.clientWhitelist.length === 0) return true;
    return this.clientWhitelist.includes(clientId);
  }

  /**
   * 动作类工具统一包身体锁（v1.2.0 批次 1）：
   * AstrBot 多 agent 经 SSE、大脑工具回路经 callTool、skills 复合技能——
   * 所有入口都经过这里，动作类工具自动获得 player 锁，与 lifestyle/guardian 互斥。
   * v1.3.0：锁 label 带客户端身份（clientId#工具名），不同客户端同优先级互斥、排队。
   */
  private wrapAction(name: string, handler: ToolHandler, clientId: string): ToolHandler {
    const isAction = ACTION_TOOLS.has(name);
    const label = `${clientId}#${name}`;
    return async (args) => {
      // 白名单校验（所有工具生效，不止动作类）
      if (!this.isAllowed(clientId)) {
        return { content: [{ type: 'text', text: `⛔ 客户端 ${clientId} 不在白名单（clientWhitelist）中，拒绝执行 ${name}` }] };
      }
      if (!isAction) return handler(args);
      const release = await this.body.acquire('player', label);
      try {
        return await handler(args);
      } finally {
        release();
      }
    };
  }

  registerTool(
    name: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny>,
    handler: ToolHandler
  ): void {
    // 存原始 handler；clientId 相关包装在连接建立时（createServer）按客户端身份注入
    this.toolRegistry.set(name, { name, description, inputSchema, handler, action: ACTION_TOOLS.has(name) });
  }

  /** 每个 SSE 连接创建独立的 McpServer 实例并注册全部工具（绑定该连接的 clientId） */
  private createServer(clientId: string): McpServer {
    const server = new McpServer({ name: this.serverName, version: this.serverVersion });
    for (const t of this.toolRegistry.values()) {
      const wrapped = this.wrapAction(t.name, t.handler, clientId);
      // SDK 内部类型较深，这里放宽为 never 以兼容不同 SDK 版本
      server.registerTool(
        t.name,
        { title: t.name, description: t.description, inputSchema: t.inputSchema } as never,
        (async (args: unknown) => wrapped((args ?? {}) as Record<string, unknown>)) as never
      );
    }
    return server;
  }

  /** 导出 OpenAI 格式工具清单（供大脑工具回路使用） */
  getToolList(): OpenAiTool[] {
    const list: OpenAiTool[] = [];
    for (const t of this.toolRegistry.values()) {
      list.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: zodToJsonSchema(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { _def: { typeName: 'ZodObject', shape: () => t.inputSchema, description: undefined } } as any
          ),
        },
      });
    }
    return list;
  }

  /** 进程内直接执行工具（供大脑工具回路使用，身份 = brain） */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const t = this.toolRegistry.get(name);
    if (!t) throw new Error(`未知工具: ${name}`);
    const wrapped = this.wrapAction(name, t.handler, 'brain');
    const res = await wrapped(args ?? {});
    return res.content.map((c) => c.text).join(String.fromCharCode(10));
  }

  start(): void {
    this.app.get('/mcp', async (req, res) => {
      const clientId = this.resolveClientId(req.query.clientId);
      const transport = new SSEServerTransport('/mcp/messages', res);
      const sessionId = (transport as unknown as { _sessionId: string })._sessionId;
      this.transports.set(sessionId, { transport, clientId });
      res.on('close', () => {
        this.transports.delete(sessionId);
        log('INFO', `MCP 客户端断开 (SSE) [${sessionId.slice(0, 8)}] clientId=${clientId}，当前连接数=${this.transports.size}`);
      });
      try {
        const server = this.createServer(clientId);
        await server.connect(transport);
        log('INFO', `MCP 客户端已连接 (SSE) [${sessionId.slice(0, 8)}] clientId=${clientId}`);
      } catch (e) {
        log('ERROR', `MCP 连接失败: ${e}`);
        this.transports.delete(sessionId);
      }
    });

    this.app.post('/mcp/messages', (req, res) => {
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
      let entry = sessionId ? this.transports.get(sessionId) : undefined;
      if (!entry) {
        // 兼容不带 sessionId 的客户端：路由到最近建立的连接
        const arr = [...this.transports.values()];
        entry = arr.length > 0 ? arr[arr.length - 1] : undefined;
      }
      if (!entry) {
        res.status(400).json({ error: '没有活跃的 MCP transport' });
        return;
      }
      void entry.transport.handlePostMessage(req, res);
    });

    this.httpServer = this.app.listen(this.port, () => {
      log('INFO', `🚀 MCP SSE 服务: http://127.0.0.1:${this.port}/mcp`);
    });
  }

  stop(): void {
    for (const { transport } of this.transports.values()) {
      try {
        void transport.close();
      } catch {
        /* ignore */
      }
    }
    this.transports.clear();
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
  }
}
