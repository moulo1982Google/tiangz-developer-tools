import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bundle = await build({ entryPoints: [path.join(root, "extension/src/moduleExplorer.ts")], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] });
const report = () => ({ formatVersion: 1, engineVersion: "0.6.0-alpha.0", modulesDirectory: "/game/modules", limitations: ["Static only"], modules: [{
  id: "org.example.probe", version: "0.1.0", description: "test", root: "/game/modules/probe", manifest: "tiangz.module.json", dependencies: [],
  entries: { model: "src/model/index.ts", hotfix: "src/hotfix/index.ts" }, publicApi: null,
  declarations: [{ name: "Probe", kind: "entryScene", layer: "model", generated: false, reachable: true, location: { file: "src/model/Probe.ts", line: 3, column: 2 } }],
  bindings: [], diagnostics: [],
}] });

function harness() {
  const state = { calls: [], errors: [], text: JSON.stringify(report()), error: null, missing: false, opened: undefined, project: undefined };
  const vscode = {
    EventEmitter: class { event = () => {}; fire() {} dispose() {} },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    TreeItemCollapsibleState: { Collapsed: 1, None: 0 }, ProgressLocation: { Notification: 15 },
    Uri: { file: file => ({ fsPath: path.resolve(file) }), joinPath: (uri, file) => ({ fsPath: path.join(uri.fsPath, file) }) },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    workspace: { isTrusted: true, workspaceFolders: [{ name: "Game", uri: { fsPath: path.resolve("/game with spaces") } }],
      getConfiguration: () => ({ get: (key, fallback) => key === "engineRoot" ? "../engine with spaces" : fallback }),
      fs: { stat: async () => { if (state.missing) throw new Error("missing"); return {}; }, readFile: async () => { if (state.project === undefined) throw Object.assign(new Error("missing"), { code: "FileNotFound" }); return new TextEncoder().encode(state.project); } },
      openTextDocument: async uri => uri,
    },
    window: {
      createOutputChannel: () => ({ clear() {}, appendLine() {}, show() {}, dispose() {} }),
      withProgress: async (_, action) => action({}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
      showErrorMessage: message => { state.errors.push(message); },
      showTextDocument: async (document, options) => { state.opened = { document, options }; },
    },
  };
  const require = createRequire(import.meta.url);
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, console, TextDecoder,
    require: name => name === "vscode" ? vscode : name === "node:child_process" ? {
      execFile: (command, args, options, callback) => {
        state.calls.push({ command, args, options });
        queueMicrotask(() => callback(state.error, state.text, ""));
        return { kill() {} };
      },
    } : require(name),
  });
  return { state, vscode, ...module.exports };
}

test("module explorer delegates analysis as separate arguments and opens one-based source locations", async () => {
  const { state, ModuleExplorer, openModuleLocation } = harness();
  const explorer = new ModuleExplorer();
  await explorer.refresh();
  assert.equal(state.errors.length, 0);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].command, "node");
  assert.equal(state.calls[0].options.windowsHide, true);
  assert.equal(state.calls[0].options.shell, undefined);
  assert.equal(state.calls[0].args[1], "--modules-dir");
  assert.equal(state.calls[0].args[2], path.resolve("/game with spaces/modules"));
  const module = explorer.getChildren(explorer.getChildren()[0])[1];
  assert.equal(module.label, "org.example.probe");
  const symbol = explorer.getChildren(module).find(node => node.label === "状态与身份").children[0];
  await openModuleLocation(symbol);
  assert.equal(state.opened.options.selection.start.line, 2);
  assert.equal(state.opened.options.selection.start.character, 1);
  assert.equal(explorer.getChildren(symbol).length, 0);
  explorer.dispose();
});
test("module explorer refuses untrusted execution and gives a missing-host remedy", async () => {
  const { state, vscode, ModuleExplorer } = harness();
  const explorer = new ModuleExplorer();
  vscode.workspace.isTrusted = false;
  await explorer.refresh();
  assert.equal(state.calls.length, 0);
  assert.match(state.errors[0], /信任工作区/);
  vscode.workspace.isTrusted = true;
  state.missing = true;
  await explorer.refresh();
  assert.equal(state.calls.length, 0);
  assert.match(state.errors[1], /engineRoot/);
  explorer.dispose();
});
test("failed refresh removes stale success tree and exposes the host diagnostic", async () => {
  const { state, ModuleExplorer } = harness();
  const explorer = new ModuleExplorer();
  await explorer.refresh();
  state.error = new Error("exit 1");
  state.text = JSON.stringify({ formatVersion: 1, error: { message: "missing dependency org.example.inventory" } });
  await explorer.refresh();
  assert.match(explorer.getChildren()[0].label, /未完成/);
  assert.match(state.errors[0], /missing dependency/);
  explorer.dispose();
});

test("project descriptor delegates complete validation to the host without duplicated module settings", async () => {
  const { state, ModuleExplorer } = harness();
  const explorer = new ModuleExplorer();
  state.project = JSON.stringify({ formatVersion: 1, engineRoot: "../declared engine" });
  await explorer.refresh();
  assert.equal(state.errors.length, 0);
  assert.equal(path.basename(state.calls[0].args[0]), "game_project.mjs");
  assert.deepEqual([...state.calls[0].args.slice(1)], ["inspect", "--project", path.resolve("/game with spaces"), "--json"]);
  assert.equal(state.calls[0].options.cwd, path.resolve("/declared engine"));
  state.project = "{}";
  await explorer.refresh();
  assert.equal(state.calls.length, 1, "invalid project does not fall back to default host");
  assert.match(state.errors[0], /不回退/);
  explorer.dispose();
});

test("state/behavior navigation uses host-proven source locations rather than same-named targets", async () => {
  const { state, ModuleExplorer } = harness();
  const data = report();
  const location = data.modules[0].declarations[0].location;
  data.modules[0].bindings = [
    { name: "ProbeSystem", kind: "systemFor", layer: "hotfix", generated: false, reachable: true, target: "Alias", targetResolution: "local", targetLocation: location, location: { file: "src/hotfix/ProbeSystem.ts", line: 5, column: 1 } },
    { name: "OtherSystem", kind: "systemFor", layer: "hotfix", generated: false, reachable: true, target: "Probe", targetResolution: "unresolved", location: { file: "src/hotfix/OtherSystem.ts", line: 5, column: 1 } },
  ];
  state.text = JSON.stringify(data);
  const explorer = new ModuleExplorer();
  await explorer.refresh();
  const module = explorer.getChildren(explorer.getChildren()[0])[1];
  const symbol = explorer.getChildren(module).find(node => node.label === "状态与身份").children[0];
  assert.equal(symbol.children.length, 1);
  assert.equal(symbol.children[0].label, "ProbeSystem");
  assert.equal(symbol.children[0].children[0].uri.fsPath, path.resolve("/game/modules/probe/src/model/Probe.ts"));
  explorer.dispose();
});
