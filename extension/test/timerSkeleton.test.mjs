import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { businessTimeDiagnostics } from "../../packages/project-core/dist/index.js";

const source = readFileSync(new URL("../guides/delayed-owner.ts.txt", import.meta.url), "utf8");

function fixture() {
  const clock = { ServerNow: 1000 };
  class Owner {
    delayTimerId = null;
    delayRevision = 0;
    delayPending = false;
    delayDueAtMs = 0;
    timers = new Map();
    nextId = 1;
    NewOnceTimer(ms, method, args) { const id = this.nextId++; this.timers.set(id, { ms, method, args }); return id; }
    CancelTimer(id) { return this.timers.delete(id); }
  }
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true }, reportDiagnostics: true });
  assert.deepEqual(result.diagnostics, []);
  const exports = {};
  vm.runInNewContext(result.outputText, { exports, require(name) {
    if (name === "#tiangz/model") return { TimeSystem: { Instance: clock }, systemFor: () => type => type };
    if (name === "#tiangz/module") return { DelayedComponent: Owner };
    throw new Error(name);
  } });
  return { owner: new exports.DelayedComponentSystem(), clock };
}

test("timer draft uses owned methods, returns immediately and does not hide unfinished settlement", () => {
  assert.deepEqual(businessTimeDiagnostics(source, "src/hotfix/DelayedComponentSystem.ts"), []);
  const { owner, clock } = fixture();
  assert.equal(owner.StartDelay(50), undefined);
  assert.equal(owner.delayDueAtMs, 1050);
  assert.equal(owner.timers.get(owner.delayTimerId).method, "OnDelayDue");
  assert.throws(() => owner.StartDelay(50), /已有/);
  clock.ServerNow = 1050;
  assert.throws(() => owner.OnDelayDue(owner.delayRevision), /TODO/);
  assert.equal(owner.delayPending, true);
});

test("cancelled callback cannot touch a new task; recovery uses remaining deadline", () => {
  const { owner, clock } = fixture();
  owner.StartDelay(50);
  const stale = owner.delayRevision;
  owner.CancelDelay();
  assert.equal(owner.timers.size, 0);
  owner.StartDelay(100);
  const current = owner.delayTimerId;
  owner.OnDelayDue(stale);
  assert.equal(owner.delayTimerId, current);
  clock.ServerNow = 1080;
  owner.ArmDelay();
  assert.equal(owner.timers.size, 1);
  assert.equal(owner.timers.get(owner.delayTimerId).ms, 20);
  clock.ServerNow = 1200;
  owner.ArmDelay();
  assert.equal(owner.timers.get(owner.delayTimerId).ms, 1);
});

test("invalid delay is rejected without modifying state; zero delay is scheduled", () => {
  const { owner } = fixture();
  for (const value of [-1, NaN, Infinity]) assert.throws(() => owner.StartDelay(value), /非负/);
  assert.equal(owner.delayPending, false);
  owner.StartDelay(0);
  assert.equal(owner.timers.get(owner.delayTimerId).ms, 1);
});

test("offline guidance and command contributions ship in the extension", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(manifest.files.includes("guides/**"));
  for (const command of ["openTimerPattern", "previewTimerSkeleton"]) {
    assert.ok(manifest.contributes.commands.some(item => item.command === `tiangzDeveloperTools.${command}`));
  }
  const guide = readFileSync(new URL("../guides/delayed-business.md", import.meta.url), "utf8");
  for (const phrase of ["Ctrl+.", "持久", "恢复", "Model", "Hotfix", "TODO"]) assert.ok(guide.includes(phrase));
});
