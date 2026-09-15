import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bundled = await build({ entryPoints: [path.join(root, "extension/src/moduleProjectActions.ts")], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] });
function harness() {
  const state = { tasks: [], inputs: ["org.example.game", "../new game"], confirm: "创建", project: { engineRoot: "../engine with spaces" }, calls: [], documents: [], hostError: undefined };
  const vscode = {
    Uri: { file: fsPath => ({ fsPath }), joinPath: (uri, file) => ({ fsPath: path.join(uri.fsPath, file) }) },
    workspace: { isTrusted: true, workspaceFolders: [{ name: "Game", uri: { fsPath: path.resolve("/game") } }],
      getConfiguration: () => ({ get: (_, fallback) => fallback }),
      fs: { stat: async () => ({}), readFile: async () => new TextEncoder().encode(JSON.stringify(state.project)) }, openTextDocument: async spec => { state.documents.push(spec); return spec; } },
    window: { showQuickPick: async items => items.find(item => item.action === "check") ?? items[0], showInputBox: async () => state.inputs.shift(), showInformationMessage: async () => state.confirm, showTextDocument: async () => {} },
    Task: class { constructor(definition, scope, name, source, execution, matchers) { Object.assign(this, { definition, scope, name, source, execution, matchers }); } },
    ProcessExecution: class { constructor(command, args, options) { Object.assign(this, { command, args, options }); } },
    TaskRevealKind: { Always: 1 }, TaskPanelKind: { Dedicated: 1 },
    tasks: { executeTask: async task => { state.tasks.push(task); return {}; } },
  };
  const require = createRequire(import.meta.url);
  const module = { exports: {} };
  const execFile = (command, args, options, callback) => {
    state.calls.push({ command, args: [...args], options });
    const value = state.hostError ? { formatVersion: 1, error: { message: state.hostError } } : path.basename(args[0]) === "game_project.mjs"
      ? { formatVersion: 1, modules: [{ id: "org.example.game" }] }
      : { formatVersion: 1, dryRun: true, planHash: "a".repeat(64), changes: [{ file: "modules/starter/src/model/index.ts", operation: "update", content: "// host-owned preview" }] };
    callback(state.hostError ? new Error(state.hostError) : null, JSON.stringify(value), "");
  };
  runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, TextDecoder, require: name => name === "vscode" ? vscode : name === "node:child_process" ? { execFile } : require(name) });
  return { state, vscode, ...module.exports };
}
test("module action uses declared host and argument-array task, not copied build rules", async () => {
  const { state, runModuleProjectAction } = harness();
  await runModuleProjectAction();
  assert.equal(state.tasks.length, 1);
  const task = state.tasks[0];
  assert.equal(task.execution.command, "node");
  assert.equal(path.basename(task.execution.args[0]), "game_project.mjs");
  assert.deepEqual([...task.execution.args.slice(1)], ["check", "--project", path.resolve("/game")]);
  assert.equal(task.execution.options.cwd, path.resolve("/engine with spaces"));
  assert.deepEqual([...task.matchers], ["$tsc", "$tiangz-module"]);
});
test("module diagnostics preserve absolute paths, positions and error codes", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "extension/package.json"), "utf8"));
  const matcher = manifest.contributes.problemMatchers.find(item => item.name === "tiangz-module");
  for (const file of ["D:/game with spaces/CounterSystem.ts", "/tmp/my game/CounterSystem.ts"]) {
    const result = new RegExp(matcher.pattern.regexp).exec(`${file}:6:3 [tiangz.hotfix.instance-state] State belongs in Model`);
    assert.ok(result);
    assert.equal(result[matcher.pattern.file], file);
    assert.equal(result[matcher.pattern.line], "6");
    assert.equal(result[matcher.pattern.column], "3");
    assert.equal(result[matcher.pattern.code], "tiangz.hotfix.instance-state");
    assert.equal(result[matcher.pattern.message], "State belongs in Model");
  }
});
test("watch matchers inherit diagnostics and delimit host check cycles, not runtime readiness", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "extension/package.json"), "utf8"));
  for (const [name, base] of [["tiangz-module-watch", "$tiangz-module"], ["tiangz-tsc-watch", "$tsc"]]) {
    const matcher = manifest.contributes.problemMatchers.find(item => item.name === name);
    assert.equal(matcher.base, base);
    assert.equal(matcher.background.activeOnStart, true);
    assert.match("[tiangz-dev-check] begin", new RegExp(matcher.background.beginsPattern));
    assert.match("[tiangz-dev-check] end", new RegExp(matcher.background.endsPattern));
    assert.doesNotMatch("[dev] 已提交 Reload：candidate", new RegExp(matcher.background.endsPattern));
    assert.doesNotMatch("Runtime ready", new RegExp(matcher.background.endsPattern));
  }
});
test("creation previews destination and delegates initial generation only after confirmation", async () => {
  const { state, createModuleProject } = harness();
  state.confirm = undefined;
  await createModuleProject();
  assert.equal(state.tasks.length, 0);
  state.inputs = ["org.example.game", "../new game"];
  state.confirm = "创建";
  await createModuleProject();
  assert.equal(state.tasks[0].definition.operation, "create");
  assert.equal(path.basename(state.tasks[0].execution.args[0]), "create_game_project.mjs");
  assert.equal(state.tasks[0].execution.args[2], path.resolve("/new game"));
});
test("untrusted and invalid project actions do not start a task", async () => {
  const { state, vscode, createModuleProject, runModuleProjectAction } = harness();
  vscode.workspace.isTrusted = false;
  await assert.rejects(createModuleProject(), /信任工作区/);
  await assert.rejects(runModuleProjectAction(), /信任工作区/);
  vscode.workspace.isTrusted = true;
  state.project = {};
  await assert.rejects(runModuleProjectAction(), /不会回退/);
  assert.equal(state.tasks.length, 0);
});
test("module dev selects the declared host and reuses the existing lifecycle owner", async () => {
  const { state, vscode, startModuleDevelopment } = harness();
  const launches = [];
  const manager = { start: async spec => launches.push(spec) };
  await startModuleDevelopment(manager);
  assert.equal(launches[0].moduleEngineRoot, path.resolve("/engine with spaces"));
  assert.equal(launches[0].configRelativePath, "tiangz.project.json");
  assert.equal(state.tasks.length, 0);
  vscode.workspace.isTrusted = false;
  await assert.rejects(startModuleDevelopment(manager), /信任工作区/);
  assert.equal(launches.length, 1);
});
test("component wizard shows host preview and pins the approved source fingerprint", async () => {
  const { state, createModuleComponent } = harness();
  state.inputs = ["Inventory", "inventory"];
  state.confirm = "创建组件";
  await createModuleComponent();
  assert.equal(state.calls.length, 2);
  assert.ok(state.calls[1].args.includes("--dry-run"));
  assert.match(state.documents[0].content, /host-owned preview/);
  assert.equal(state.tasks[0].definition.operation, "new-component");
  assert.deepEqual([...state.tasks[0].execution.args.slice(-2)], ["--expect-plan", "a".repeat(64)]);
  assert.equal(state.tasks[0].execution.options.cwd, path.resolve("/engine with spaces"));
});
test("component preview errors and declined confirmation never launch a write task", async () => {
  const { state, createModuleComponent } = harness();
  state.inputs = ["Inventory", "inventory"];
  state.confirm = undefined;
  await createModuleComponent();
  assert.equal(state.tasks.length, 0);
  state.hostError = "动态入口请手工登记";
  await assert.rejects(createModuleComponent(), /动态入口/);
  assert.equal(state.tasks.length, 0);
});
