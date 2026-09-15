import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const bundled = await build({ entryPoints: [new URL("../src/devSourceManager.ts", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] });
function harness() {
  const state = { tasks: [], children: [], timers: [], output: [], exits: [] };
  class Emitter {
    listeners = [];
    event = listener => this.listeners.push(listener);
    fire = value => { for (const listener of this.listeners) listener(value); };
    dispose() {}
  }
  const vscode = {
    workspace: { isTrusted: true },
    EventEmitter: Emitter,
    Task: class { constructor(definition, scope, name, source, execution, matchers) { Object.assign(this, { definition, scope, name, source, execution, matchers }); } },
    CustomExecution: class { constructor(callback) { this.callback = callback; } },
    TaskRevealKind: { Always: 1 }, TaskPanelKind: { Dedicated: 1 },
    tasks: { executeTask: async task => { state.tasks.push(task); return {}; } },
  };
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.writable = true; child.writes = []; child.stdin.write = text => child.writes.push(text);
    child.pid = 12345; child.kill = () => {};
    Object.assign(child, { command, args: [...args], options });
    state.children.push(child);
    return child;
  };
  const require = createRequire(import.meta.url);
  const module = { exports: {} };
  runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, process, Buffer,
    setTimeout: callback => { state.timers.push(callback); return callback; },
    clearTimeout: callback => { state.timers = state.timers.filter(item => item !== callback); },
    require: name => name === "vscode" ? vscode : name === "node:child_process" ? { spawn } : require(name) });
  const manager = new module.exports.DevSourceManager();
  const spec = { folder: { name: "My Game", uri: { fsPath: path.resolve("/my game") } }, machineName: "My Game", configRelativePath: "tiangz.project.json", moduleEngineRoot: path.resolve("/engine with spaces") };
  async function terminal() {
    const terminal = await state.tasks.at(-1).execution.callback();
    terminal.onDidWrite(text => state.output.push(text));
    terminal.onDidClose(code => state.exits.push(code));
    return terminal;
  }
  return { state, manager, spec, terminal, vscode };
}

test("module dev delegates directly to its declared host with no shell and one task owner", async () => {
  const { state, manager, spec, terminal } = harness();
  await manager.start(spec);
  await assert.rejects(manager.start(spec), /已经运行/);
  (await terminal()).open();
  const child = state.children[0];
  assert.equal(child.command, "node");
  assert.deepEqual(child.args, [path.join(spec.moduleEngineRoot, "tools/dev_runtime.mjs"), "--project", spec.folder.uri.fsPath]);
  assert.equal(child.options.cwd, spec.moduleEngineRoot);
  assert.equal(child.options.shell, false);
  manager.stop(); manager.stop();
  assert.deepEqual(child.writes, ["shutdown\n"]);
  child.emit("exit", 0);
  assert.deepEqual(state.exits, [0]);
  assert.equal(state.timers.length, 0);
  await manager.start(spec);
  manager.stop();
});

test("stopping a queued task before terminal open never launches a child", async () => {
  const { state, manager, spec, terminal } = harness();
  await manager.start(spec);
  const taskTerminal = await terminal();
  manager.stop();
  taskTerminal.open();
  assert.equal(state.children.length, 0);
  assert.deepEqual(state.exits, [0]);
});
test("cancellation before CustomExecution still delivers exit once terminal listeners exist", async () => {
  const { state, manager, spec, terminal } = harness();
  await manager.start(spec);
  manager.stop();
  const taskTerminal = await terminal();
  taskTerminal.open();
  assert.equal(state.children.length, 0);
  assert.deepEqual(state.exits, [0]);
});
test("rerunning a completed task acquires a fresh session instead of a disposed terminal", async () => {
  const { state, manager, spec, terminal } = harness();
  await manager.start(spec);
  const first = await terminal(); first.open();
  await assert.rejects(terminal(), /已经运行/);
  state.children[0].emit("exit", 0);
  const second = await terminal();
  assert.notEqual(second, first);
  second.open();
  assert.equal(state.children.length, 2);
  manager.stop();
  assert.deepEqual(state.children[1].writes, ["shutdown\n"]);
  state.children[1].emit("exit", 0);
  assert.deepEqual(state.exits, [0, 0]);
});
test("rerun cannot bypass revoked trust or a disposed task manager", async () => {
  const { state, manager, spec, terminal, vscode } = harness();
  await manager.start(spec); (await terminal()).open();
  state.children[0].emit("exit", 0);
  vscode.workspace.isTrusted = false;
  await assert.rejects(terminal(), /信任工作区/);
  vscode.workspace.isTrusted = true;
  manager.dispose();
  await assert.rejects(terminal(), /已关闭/);
  assert.equal(state.children.length, 1);
});
test("revoking trust while a task is queued prevents the initial process launch", async () => {
  const { state, manager, spec, terminal, vscode } = harness();
  await manager.start(spec);
  vscode.workspace.isTrusted = false;
  (await terminal()).open();
  assert.equal(state.children.length, 0);
  assert.deepEqual(state.exits, [1]);
});

test("Ctrl+C requests graceful stop and a nonzero exit is not reported as success", async () => {
  const { state, manager, spec, terminal } = harness();
  await manager.start(spec);
  const taskTerminal = await terminal(); taskTerminal.open();
  taskTerminal.handleInput("\u0003");
  assert.deepEqual(state.children[0].writes, ["shutdown\n"]);
  state.children[0].stdin.emit("error", new Error("EPIPE"));
  state.children[0].emit("exit", 1);
  assert.deepEqual(state.exits, [1]);
});

test("main-project launch remains compatible and startup failure releases ownership", async () => {
  const { state, manager, spec, terminal } = harness();
  const legacy = { ...spec, moduleEngineRoot: undefined, configRelativePath: "configs/local/StartMachine.json" };
  await manager.start(legacy); (await terminal()).open();
  assert.equal(state.children[0].command, "npm");
  assert.deepEqual(state.children[0].args, ["run", "dev", "--", legacy.configRelativePath]);
  state.children[0].emit("error", new Error("ENOENT"));
  assert.deepEqual(state.exits, [-1]);
  await manager.start(spec); manager.stop();
});
