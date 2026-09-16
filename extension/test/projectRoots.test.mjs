import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../src/projectRoots.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] });
function harness(files, children = []) {
  const uri = fsPath => ({ fsPath, toString: () => fsPath });
  const folder = { uri: uri("/workspace"), name: "workspace", index: 0 };
  const probes = [];
  const missing = () => Object.assign(new Error("missing"), { code: "FileNotFound" });
  const vscode = { Uri: { joinPath: (base, name) => uri(`${base.fsPath}/${name}`) }, workspace: {
    getWorkspaceFolder: () => folder,
    fs: { stat: async target => { probes.push(target.fsPath); if (!files.includes(target.fsPath)) throw missing(); return { type: 1 }; }, readDirectory: async () => children },
  } };
  const module = { exports: {} }, require = createRequire(import.meta.url);
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: name => name === "vscode" ? vscode : require(name) });
  return { ...module.exports, folder, probes, vscode };
}
const hostFiles = name => [`/workspace/${name}/app/core/public.ts`, `/workspace/${name}/package.json`];

test("umbrella discovery recognizes direct host and module roots without traversing caches or links", async () => {
  const h = harness([...hostFiles("TiangZ"), "/workspace/Game/tiangz.project.json", ...hostFiles("Other"), ...hostFiles("dist")], [["TiangZ", 2], ["Game", 2], ["Other", 66], ["dist", 2], ["dbproxy", 2]]);
  const roots = await h.discoverProjectRoots(h.folder);
  assert.deepEqual(Array.from(roots, item => item.name), ["workspace/Game", "workspace/TiangZ"]);
  assert.ok(!h.probes.some(item => item.includes("/Other/") || item.includes("/dist/")));
  assert.equal(h.projectTaskScope(roots[1]), h.folder);
});

test("a root module descriptor stops child discovery even if its content is malformed", async () => {
  const h = harness(["/workspace/tiangz.project.json"]);
  h.vscode.workspace.fs.readDirectory = () => { throw new Error("must not descend"); };
  assert.equal((await h.discoverProjectRoots(h.folder))[0], h.folder);
});

test("overlapping opened folders are deduplicated and filesystem errors are not hidden", async () => {
  const h = harness(hostFiles("TiangZ"), [["TiangZ", 2]]);
  const child = (await h.discoverProjectRoots(h.folder))[0];
  assert.equal((await h.discoverProjectFolders([h.folder, child])).length, 1);
  h.vscode.workspace.fs.stat = async () => { throw new Error("permission denied"); };
  await assert.rejects(h.discoverProjectRoots(h.folder), /permission denied/);
});
