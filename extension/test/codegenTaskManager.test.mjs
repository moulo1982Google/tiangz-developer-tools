import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../src/codegenTaskManager.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] });

test("task completion before executeTask resolves and queued cancellation both release waiters", { timeout: 10_000 }, async () => {
  const listeners = { process: new Set(), task: new Set() };
  let mode = "success";
  const subscribe = (kind, fn) => { listeners[kind].add(fn); return { dispose: () => listeners[kind].delete(fn) }; };
  const vscode = {
    Uri: { joinPath: () => ({}) }, Task: class {}, ShellExecution: class {}, TaskRevealKind: { Always: 1 }, TaskPanelKind: { Dedicated: 1 },
    workspace: { isTrusted: true, fs: { stat: async () => { throw Object.assign(new Error("missing"), { code: "FileNotFound" }); } } },
    tasks: {
      onDidEndTaskProcess: fn => subscribe("process", fn), onDidEndTask: fn => subscribe("task", fn),
      executeTask: async task => {
        if (mode === "throw") throw new Error("task launch failed");
        const execution = { task };
        if (mode === "delayed") {
          setImmediate(() => {
            for (const fn of listeners.process) fn({ execution: { task: {} }, exitCode: 99 });
            for (const fn of listeners.process) fn({ execution, exitCode: 3 });
            for (const fn of listeners.task) fn({ execution });
          });
          return execution;
        }
        for (const fn of listeners.process) fn({ execution: { task: {} }, exitCode: 99 });
        if (mode !== "cancel") for (const fn of listeners.process) fn({ execution, exitCode: mode === "failure" ? 7 : 0 });
        for (const fn of listeners.task) fn({ execution });
        return execution;
      },
    },
  };
  const module = { exports: {} };
  const require = createRequire(import.meta.url);
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: name => name === "vscode" ? vscode : require(name) });
  const manager = new module.exports.CodegenTaskManager();
  const folder = { uri: { toString: () => "file:///engine" } };
  for (const [scenario, code] of [["success", 0], ["failure", 7], ["cancel", -1], ["delayed", 3]]) {
    mode = scenario;
    assert.equal(await manager.run(folder, { id: "verify-fast", command: "npm run verify:fast" }), code);
    assert.equal(listeners.process.size + listeners.task.size, 0);
  }
  mode = "throw";
  await assert.rejects(manager.run(folder, { id: "verify-fast", command: "npm run verify:fast" }), /task launch failed/);
  assert.equal(listeners.process.size + listeners.task.size, 0);
  manager.dispose();
});
