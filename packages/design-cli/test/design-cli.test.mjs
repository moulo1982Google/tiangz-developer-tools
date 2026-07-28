import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = path.join(root, "dist", "tiangz-design.cjs");

test("输出Quest设计Markdown", async () => {
  const result = await execute(["quest"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /QuestComponent只持有进行中Quest/);
  assert.match(result.stdout, /Set\/Bitmap<QuestConfigId>/);
});

test("支持机器可读JSON", async () => {
  const result = await execute(["buff", "--format", "json"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.archetype, "buff");
  assert.ok(parsed.ruleIds.includes("sync.none"));
});

test("拒绝未知系统类型", async () => {
  const result = await execute(["guild"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /未知系统类型guild/);
});

function execute(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(signal)) : resolve({ code, stdout, stderr }));
  });
}
