import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bundled = await build({ entryPoints: [path.join(root, "extension/src/moduleProjectActions.ts")], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] });
function harness() {
  const state = { tasks: [], inputs: ["org.example.game", "../new game"], confirm: "创建", project: { engineRoot: "../engine with spaces" } };
  const vscode = {
    Uri: { file: fsPath => ({ fsPath }), joinPath: (uri, file) => ({ fsPath: path.join(uri.fsPath, file) }) },
    workspace: { isTrusted: true, workspaceFolders: [{ name: "Game", uri: { fsPath: path.resolve("/game") } }],
      getConfiguration: () => ({ get: (_, fallback) => fallback }),
      fs: { stat: async () => ({}), readFile: async () => new TextEncoder().encode(JSON.stringify(state.project)) } },
    window: { showQuickPick: async items => items.find(item => item.action === "check"), showInputBox: async () => state.inputs.shift(), showInformationMessage: async () => state.confirm },
    Task: class { constructor(definition, scope, name, source, execution, matchers) { Object.assign(this, { definition, scope, name, source, execution, matchers }); } },
    ProcessExecution: class { constructor(command, args, options) { Object.assign(this, { command, args, options }); } },
    TaskRevealKind: { Always: 1 }, TaskPanelKind: { Dedicated: 1 },
    tasks: { executeTask: async task => { state.tasks.push(task); return {}; } },
  };
  const require = createRequire(import.meta.url);
  const module = { exports: {} };
  runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, TextDecoder, require: name => name === "vscode" ? vscode : require(name) });
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
