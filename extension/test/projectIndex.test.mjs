import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../src/projectIndex.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] });

test("module discovery reads the descriptor only and never scans legacy app/configs", async () => {
  const calls = [];
  const uri = { toString: () => "file:///game/tiangz.project.json" };
  const vscode = { Uri: { joinPath: () => uri }, workspace: {
    fs: { stat: async value => { calls.push(value); return { size: 10 }; } },
    getConfiguration: () => { throw new Error("legacy discovery must not run"); },
    findFiles: () => { throw new Error("legacy scan must not run"); },
  } };
  const module = { exports: {} };
  const require = createRequire(import.meta.url);
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: name => name === "vscode" ? vscode : require(name) });
  const folder = { uri: {}, name: "game" };
  const result = await module.exports.discoverWorkspaceFolder(folder);
  assert.equal(result.folder, folder);
  assert.equal(result.sourceUris.length, 1);
  assert.equal(result.sourceUris[0], uri);
  assert.deepEqual(calls, [uri]);
});
