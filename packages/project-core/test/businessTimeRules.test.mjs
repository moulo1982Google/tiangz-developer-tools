import assert from "node:assert/strict";
import test from "node:test";
import { businessTimeDiagnostics, analyzeTiangZProject } from "../dist/index.js";

for (const source of [
  "await sleep(100);", "await TimerSystem.Instance.WaitAsync(100);", "void delay(1).then(work);",
  "await new Promise(resolve => setTimeout(resolve, 100));", "setInterval(tick, 100);",
  "import { setTimeout as pause } from 'node:timers/promises'; await pause(100);",
  "import * as timers from 'timers/promises'; await timers.setTimeout(100);",
  "import { sleep as pause } from './time'; const nap = pause; await nap(100);",
  "const pause = globalThis['setTimeout']; pause(work, 100);",
  "import { TimerSystem as Clock } from '#tiangz/model'; await Clock.Instance.WaitAsync(100);",
  "await Promise.all([rpc.Call(), sleep(1)]);",
  "await new Promise(resolve => { this.NewOnceTimer(100, 'Complete'); });",
]) test(`reject time waiting: ${source}`, () => {
  const diagnostics = businessTimeDiagnostics(source, "src/hotfix/Upgrade.ts");
  assert.ok(diagnostics.length);
  assert.equal(diagnostics[0].severity, "error");
  assert.equal(diagnostics[0].code, "tiangz.timer.time-wait-forbidden");
  assert.equal(diagnostics[0].location.relativePath, "src/hotfix/Upgrade.ts");
});

test("normal async results and owned method-name timers remain legal", () => {
  assert.deepEqual(businessTimeDiagnostics(`
    await repository.Save(); await rpc.Call(); await lock.WaitAsync();
    await queue.WaitAsync(); await Promise.all([repository.Save(), rpc.Call()]);
    this.NewOnceTimer(100, "Complete"); this.NewRepeatedTimer(100, "Tick");
    this.CancelTimer(id, "manual");
  `, "src/hotfix/Upgrade.ts"), []);
});

test("timer import aliases respect parameters and sibling lexical scopes", () => {
  const diagnostics = businessTimeDiagnostics(`
    import { setTimeout as pause } from 'node:timers/promises';
    async function waitForResult(pause: () => Promise<void>) { await pause(); }
    async function first() { const nap = pause; await nap(100); }
    async function second() { const nap = () => repository.Save(); await nap(); }
  `, "src/hotfix/Upgrade.ts");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].location.line, 3);
});

test("namespace imports and native globals respect local shadowing", () => {
  const diagnostics = businessTimeDiagnostics(`
    import * as timers from 'node:timers/promises';
    async function read(timers: { setTimeout: () => Promise<void> }) { await timers.setTimeout(); }
    async function save(globalThis: { setTimeout: () => Promise<void> }) { await globalThis.setTimeout(); }
    async function outside() { await timers.setTimeout(100); }
  `, "src/hotfix/Upgrade.ts");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].location.line, 4);
});

test("block and catch bindings do not contaminate surrounding alias resolution", () => {
  const diagnostics = businessTimeDiagnostics(`
    import { setTimeout as pause } from 'node:timers/promises';
    async function work() {
      { const pause = () => repository.Load(); await pause(); }
      try { await repository.Save(); } catch (pause) { pause(); }
      await pause(1);
    }
  `, "src/hotfix/Upgrade.ts");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].location.line, 5);
});

test("editor uses same errors for main and module sources, without applying legacy rules to modules", () => {
  for (const sources of [
    [{ relativePath: "app/hotfix/Upgrade.ts", text: "await sleep(1);" }],
    [{ relativePath: "tiangz.project.json", text: "{}" }, { relativePath: "modules/game/src/hotfix/Upgrade.ts", text: "await sleep(1);" }],
  ]) assert.ok(analyzeTiangZProject(sources).diagnostics.some(item => item.code === "tiangz.timer.time-wait-forbidden"));
  assert.deepEqual(analyzeTiangZProject([{ relativePath: "app/core/Scheduler.ts", text: "await sleep(1);" }]).diagnostics, []);
  assert.deepEqual(businessTimeDiagnostics("await sleep(1);", "src/model/generated/config.ts"), []);
  assert.deepEqual(businessTimeDiagnostics("await sleep(1);", "tests/clock.test.ts"), []);
});
