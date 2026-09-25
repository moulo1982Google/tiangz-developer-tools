import assert from "node:assert/strict";
import test from "node:test";
import { runtimeContractDiagnostics } from "../dist/index.js";
import { createFixtureProgram, contractSource } from "./runtime-contract-fixture.mjs";

function check(source, extra) {
  const { program, options } = createFixtureProgram(source, extra);
  return runtimeContractDiagnostics(program, options);
}

test("uses current Core identity for inferred lifecycle returns, aliases and interfaces", () => {
  const diagnostics = check(`
import { Component as Base, type ITransfer as Transfer, type IDeserialize } from "../core/public";
class A extends Base { async Awake() {} }
class B extends A { OnDestroy() { return Promise.resolve(); } }
class C implements Transfer<Promise<number>> {
  CaptureTransfer() { return Promise.resolve(1); }
  RestoreTransfer(value: Promise<number>) {}
}
class D implements IDeserialize { Deserialize = async () => {}; }
class E extends Base { Deserialize() { return Math.random() ? undefined : { then(callback: () => void) {} }; } }
class Overloaded extends Base { Awake(): void; Awake() { return Promise.resolve(); } }
class Computed extends Base { ["Awake"]() { return Promise.resolve(); } }
class F extends Base { CaptureTransfer() { return { then: 123 }; } }
class Unrelated { async Awake() {}; CaptureTransfer() { return Promise.resolve(); } }
class Static extends Base { static async Awake() {} }
import { Component as Foreign } from "../../old-host/core";
class OtherHost extends Foreign { async Awake() {} }
`, { "old-host/core.ts": "export class Component {}" });
  assert.equal(diagnostics.length, 7, JSON.stringify(diagnostics));
  assert.ok(diagnostics.every(item => item.code === "tiangz.lifecycle.async-method" && item.severity === "error"));
});

test("checks actual receivers outside a class and preserves diagnostic locations", () => {
  const diagnostics = check(contractSource);
  assert.deepEqual(diagnostics.map(item => [item.code, item.location.line, item.severity]), [
    ["tiangz.lifecycle.async-method", 2, "error"],
    ["tiangz.timer.target-missing", 7, "error"],
    ["tiangz.timer.argument-mismatch", 8, "error"],
  ]);
  assert.match(diagnostics[1].message, /on Worker: Missing/);
});

test("handles omitted, optional, ignored, rest and overloaded callback arguments", () => {
  const diagnostics = check(`
import { Component, type TimerCancelledContext } from "../core/public";
class Worker extends Component {
  Ignore() {}
  Optional(value: number, extra?: string) {}
  Undefined(value: undefined) {}
  Many(...values: number[]) {}
  Tuple(...values: [number, TimerCancelledContext, string?]) {}
  NeedsTwo(first: number, second: string) {}
  RestTwo(...values: [number, string]) {}
  BadRest(...values: string[]) {}
  Overload(value: number): void;
  Overload(value: string): void;
  Overload(value: unknown) {}
}
declare const worker: Worker;
worker.NewOnceTimer(1, "Ignore", 1, { onCancelled: "Ignore" });
worker.NewRepeatedTimer(1, "Optional", 1);
worker.NewOnceTimer(1, "Undefined");
worker.NewOnceTimer(1, "Many", 1);
worker.NewOnceTimer(1, "Ignore", 1, { onCancelled: "Tuple" });
worker.NewOnceTimer(1, "Overload", "text");
worker.NewOnceTimer(1, "NeedsTwo", 1);
worker.NewOnceTimer(1, "RestTwo", 1);
worker.NewOnceTimer(1, "BadRest", 1);
worker.NewOnceTimer(1, "Optional");
`);
  assert.equal(diagnostics.length, 4, JSON.stringify(diagnostics));
  assert.ok(diagnostics.every(item => item.code === "tiangz.timer.argument-mismatch"));
  assert.deepEqual(diagnostics.map(item => item.message.split("match ")[1]), ["NeedsTwo", "RestTwo", "BadRest", "Optional"]);
});

test("cancellation uses the current Core context and generated System declarations", () => {
  const diagnostics = check(`
import { Component } from "../core/public";
interface TimerCancelledContext { fake: true }
export class Worker extends Component {
  Cancel(value: number, context: TimerCancelledContext) {}
}
declare const worker: Worker;
worker.NewOnceTimer(1, "GeneratedTick", 1, { onCancelled: "Cancel" });
worker.NewOnceTimer(1, "GeneratedTick", 1, undefined);
worker.NewOnceTimer(1, "GeneratedTick", 1, { onCancelled: undefined });
`, { "app/generated/systems.d.ts": `import "../model/Test"; declare module "../model/Test" { interface Worker { GeneratedTick(value: number): void; } }` });
  assert.equal(diagnostics.length, 1, JSON.stringify(diagnostics));
  assert.equal(diagnostics[0].code, "tiangz.timer.argument-mismatch");
  assert.match(diagnostics[0].message, /onCancelled.*Cancel/);
});

test("literal constants and options work; dynamic and generic contracts remain unproven warnings", () => {
  const diagnostics = check(`
import { Component, TimerSystem } from "../core/public";
class Worker extends Component {
  Tick(value: number) {}
  Generic<T>(value: T) {}
  NumberField = 42;
  Schedule(name: string, erased: any) {
    const method = "Tick";
    const options = { onCancelled: "Tick" } as const;
    this.NewOnceTimer(1, method, 1, options);
    this.NewOnceTimer(1, name, 1);
    this.NewOnceTimer(1, "Generic", 1);
    this.NewOnceTimer(1, "Tick", erased);
    this.NewOnceTimer(1, "NumberField", 1);
  }
}
class Homonym { NewOnceTimer(delay: number, name: string) {} }
new Homonym().NewOnceTimer(1, "Missing");
new TimerSystem().NewOnceTimer(1, () => {});
`);
  assert.deepEqual(diagnostics.map(item => item.code), [
    "tiangz.timer.unverifiable", "tiangz.timer.unverifiable", "tiangz.timer.unverifiable", "tiangz.timer.not-callable",
  ]);
  assert.ok(diagnostics.slice(0, 3).every(item => item.severity === "warning"));
});

test("checks every possible receiver/name and resolves super against the current instance", () => {
  const diagnostics = check(`
import { Component } from "../core/public";
class A extends Component {
  Tick(value: number) {}
  Start() { super.NewOnceTimer(1, "Tick", 1); }
}
class B extends Component { Other(value: number) {} }
declare const union: A | B;
declare const method: "Tick" | "Missing";
declare const a: A;
union.NewOnceTimer(1, "Tick", 1);
a.NewOnceTimer(1, method, 1);
`);
  assert.equal(diagnostics.length, 2, JSON.stringify(diagnostics));
  assert.ok(diagnostics.every(item => item.code === "tiangz.timer.target-missing"));
  assert.match(diagnostics[0].message, /on B: Tick/);
  assert.match(diagnostics[1].message, /on A: Missing/);
});

test("cancellation options account for union branches and later spreads", () => {
  const diagnostics = check(`
import { Component } from "../core/public";
class Worker extends Component { Tick() {} }
declare const worker: Worker;
declare const either: { onCancelled: "Missing" } | { unrelated: true };
declare const dynamic: { onCancelled: string };
worker.NewOnceTimer(1, "Tick", undefined, either);
worker.NewOnceTimer(1, "Tick", undefined, { onCancelled: "Tick", ...dynamic });
worker.NewOnceTimer(1, "Tick", undefined, { ...dynamic, onCancelled: "Tick" });
`);
  assert.deepEqual(diagnostics.map(item => item.code), ["tiangz.timer.target-missing", "tiangz.timer.unverifiable"]);
});
