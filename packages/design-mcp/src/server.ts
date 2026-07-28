import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

import {
  DESIGN_RULES,
  formatDesignRecommendation,
  inferSystemArchetype,
  recommendSystemDesign,
  type DesignRequest,
} from "../../design-core/src/index.js";

const archetypeSchema = z.enum(["item", "buff", "quest", "achievement", "numeric", "custom"]);
const designRequestSchema = z.object({
  archetype: archetypeSchema,
  name: z.string().min(1).optional(),
  owner: z.enum(["player", "map", "scene", "session"]).optional(),
  independentIdentity: z.boolean().optional(),
  independentLifecycle: z.boolean().optional(),
  networkTarget: z.boolean().optional(),
  audiences: z.array(z.enum(["none", "self", "party", "aoi", "global"])).min(1).optional(),
  changeSemantics: z.enum(["none", "latest", "event"]).optional(),
  changeFrequency: z.enum(["low", "medium", "high"]).optional(),
  persistent: z.boolean().optional(),
});

/** 创建只读TiangZ设计工具服务；每个MCP连接使用独立Server实例，不共享会话状态。 / Creates a read-only TiangZ design tool server; every MCP connection gets an isolated server instance with no shared session state. */
export function createDesignMcpServer(): McpServer {
  const server = new McpServer(
    { name: "tiangz-design", version: "0.13.0" },
    { capabilities: { tools: {} }, instructions: "Use deterministic TiangZ design rules before suggesting business code. Never modify Core, Rust, or Generated without explicit evidence." },
  );
  server.registerTool("list_design_rules", {
    title: "列出TiangZ设计规则",
    description: "返回稳定规则ID、中文建议和主工程文档路径。",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async () => ({
    content: [{ type: "text", text: JSON.stringify(DESIGN_RULES, null, 2) }],
  }));
  server.registerTool("infer_system_archetype", {
    title: "识别业务系统类型",
    description: "从自然语言中低成本识别Item、Buff、Quest、Achievement或Numeric；无法确定时返回custom。",
    inputSchema: z.object({ text: z.string().min(1).max(20_000) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ text }) => ({
    content: [{ type: "text", text: inferSystemArchetype(text) }],
  }));
  server.registerTool("recommend_system_design", {
    title: "生成TiangZ业务系统设计",
    description: "根据对象身份、所有者、受众、变化语义、频率和持久化要求生成确定性建议。",
    inputSchema: designRequestSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async (input) => {
    const request = input as DesignRequest;
    const result = recommendSystemDesign(request);
    return {
      content: [{ type: "text", text: formatDesignRecommendation(result) }],
      structuredContent: result,
    };
  });
  return server;
}

const handle = serveStdio(() => createDesignMcpServer(), {
  onerror: (error) => process.stderr.write(`[tiangz-design-mcp] ${error.stack ?? error.message}\n`),
});

process.once("SIGINT", () => {
  void handle.close().finally(() => process.exit(0));
});
