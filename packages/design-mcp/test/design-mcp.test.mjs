import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const serverPath = path.join(root, "dist", "tiangz-design-mcp.cjs");

test("MCP暴露只读设计规则和Quest推荐", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    stderr: "pipe",
  });
  const client = new Client({ name: "tiangz-design-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "infer_system_archetype",
      "list_design_rules",
      "recommend_system_design",
    ]);
    const result = await client.callTool({
      name: "recommend_system_design",
      arguments: { archetype: "quest" },
    });
    assert.equal(result.isError, undefined);
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    assert.match(text, /QuestComponent只持有进行中Quest/);
    assert.equal(result.structuredContent?.archetype, "quest");
  } finally {
    await client.close();
  }
});
