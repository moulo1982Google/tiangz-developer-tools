import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../src/codegenTaskManager.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] });

test("legacy task commands refuse module projects and revoked trust before constructing tasks", async () => {
  let missing = false;
  const vscode = { Uri: { joinPath: () => ({}) }, Task: class { constructor() { throw new Error("task must not be constructed"); } },
    workspace: { isTrusted: true, fs: { stat: async () => {
      if (missing) throw Object.assign(new Error("missing"), { code: "FileNotFound" });
      return {};
    } } },
  };
  const module = { exports: {} };
  const require = createRequire(import.meta.url);
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: name => name === "vscode" ? vscode : require(name) });
  const manager = new module.exports.CodegenTaskManager();
  const folder = { uri: { toString: () => "file:///module" } };
  await assert.rejects(manager.run(folder, { id: "verify-fast", command: "npm run verify:fast" }), /独立模块工程/);
  missing = true;
  vscode.workspace.isTrusted = false;
  await assert.rejects(manager.run(folder, { id: "verify-fast", command: "npm run verify:fast" }), /信任/);
  manager.dispose();
});
