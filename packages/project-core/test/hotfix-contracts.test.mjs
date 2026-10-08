import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { createRequire } from "node:module";
import { analyzeTiangZProject, hotfixClassDiagnostics, restrictedHotfixDecoratorKind, runtimeContractDiagnostics } from "../dist/index.js";
import { createFixtureProgram, coreSource } from "./runtime-contract-fixture.mjs";

const decoratorSource = `${coreSource}
export declare function systemFor(...args: any[]): any;
export declare function entityExtensionHandler(...args: any[]): any;
export declare function rpcHandler(...args: any[]): any;
`;
const hotfixFile = "app/hotfix/game/Test.ts";
function fixture(text, extra = {}) {
  const result = createFixtureProgram("", { "app/core/public.ts": decoratorSource, [hotfixFile]: text, ...extra });
  return { ...result, source: result.program.getSourceFile(path.join(result.options.projectRoot, hotfixFile)) };
}

test("Hotfix uses current Core identity through renamed exports and namespaces", () => {
  const text = `import { renamed as bind } from "../../core/bridge";
import * as model from "../../core/public";
@bind(model.Component)
class Bad {
  value = 1;
  constructor() {}
  static { }
  static method() {}
  static get accessor() { return 1; }
}
@model.entityExtensionHandler("feature")
class Extension { value = 1; }
@model.rpcHandler("request")
class Allowed { Run() {} get value() { return 1; } set value(value: number) {} }
`;
  const { program, options, source } = fixture(text, { "app/core/bridge.ts": 'export { systemFor as renamed } from "./public";' });
  const diagnostics = runtimeContractDiagnostics(program, options);
  assert.deepEqual(diagnostics.map(item => [item.code, item.severity, item.location.line, item.location.character]), [
    ["tiangz.hotfix.instance-state", "error", 4, 2],
    ["tiangz.hotfix.instance-state", "error", 5, 2],
    ["tiangz.hotfix.instance-state", "error", 6, 2],
    ["tiangz.hotfix.instance-state", "error", 7, 2],
    ["tiangz.hotfix.instance-state", "error", 8, 2],
    ["tiangz.hotfix.instance-state", "error", 11, 18],
  ]);
  assert.ok(diagnostics.every(item => item.location.relativePath === hotfixFile));
  const kinds = source.statements.filter(ts.isClassDeclaration).map(node => restrictedHotfixDecoratorKind(node, program.getTypeChecker(), options));
  assert.deepEqual(kinds, ["System", "Handler", "Handler"]);
  const snapshot = analyzeTiangZProject([{ relativePath: hotfixFile, text }], {
    status: "checked", ruleSetVersion: 2, typescriptVersion: ts.version, diagnostics,
  });
  assert.deepEqual(snapshot.diagnostics.filter(item => item.code.startsWith("tiangz.hotfix.")), diagnostics);
});

test("Hotfix leaves other hosts, local homonyms, Model state and benchmarks alone", () => {
  const text = `import { systemFor as old } from "../../core-old/public";
import { systemFor as core } from "../../core/public";
function systemFor(...args: any[]): any {}
@old(null) class Old { state = 1; }
@systemFor(null) class Local { state = 1; }
class Ordinary { state = 1; constructor() {} static method() {} }
@core(null) class Allowed { run() {} }
`;
  const { program, options } = fixture(text, {
    "app/core-old/public.ts": decoratorSource,
    "app/model/State.ts": 'import { systemFor } from "../core/public"; @systemFor(null) class Model { state = 1; }',
    "app/hotfix/bench/Bench.ts": 'import { systemFor } from "../../core/public"; @systemFor(null) class Bench { state = 1; }',
  });
  assert.deepEqual(runtimeContractDiagnostics(program, options), []);
});

test("module callers select declared Hotfix files regardless of directory convention", () => {
  const { program, options } = fixture("", {
    "custom/behavior.ts": 'import { systemFor } from "../app/core/public"; @systemFor(null) class Bad { state = 1; }',
  });
  assert.deepEqual(runtimeContractDiagnostics(program, options), []);
  const diagnostics = runtimeContractDiagnostics(program, { ...options,
    hotfixSourceFiles: [program.getSourceFile(path.join(options.projectRoot, "custom/behavior.ts"))],
  });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "tiangz.hotfix.instance-state");
  assert.equal(diagnostics[0].location.relativePath, "custom/behavior.ts");
});

test("unresolved stable imports are warnings and foreign ASTs never borrow Program evidence", () => {
  const text = 'import { systemFor as bind } from "#tiangz/model"; @bind(null) class Unknown { state = 1; }';
  const { program, options, source } = fixture(text);
  const check = diagnostics => {
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, "tiangz.hotfix.unverifiable");
    assert.equal(diagnostics[0].severity, "warning");
  };
  check(runtimeContractDiagnostics(program, options));
  check(hotfixClassDiagnostics(source, undefined, options));
  const foreign = ts.createSourceFile(source.fileName, text, ts.ScriptTarget.Latest, true);
  check(runtimeContractDiagnostics(program, { ...options, hotfixSourceFiles: [foreign] }));
  const local = ts.createSourceFile(source.fileName, 'function systemFor(...args: any[]): any {} @systemFor(null) class Local { state = 1; }', ts.ScriptTarget.Latest, true);
  assert.deepEqual(hotfixClassDiagnostics(local, undefined, options), []);
});

test("the same Hotfix fixture has identical diagnostics with plugin TS 5 and host TS 6", {
  skip: !process.env.TIANGZ_TEST_MODULE_HOST && "set TIANGZ_TEST_MODULE_HOST to compare the selected host's compiler",
}, () => {
  const hostTs = createRequire(path.join(path.resolve(process.env.TIANGZ_TEST_MODULE_HOST), "package.json"))("typescript");
  assert.match(ts.version, /^5\./);
  assert.match(hostTs.version, /^6\./);
  const text = `import { systemFor as bind } from "../../core/public";
import * as core from "../../core/public";
import { systemFor as old } from "../../core-old/public";
import { systemFor as unresolved } from "#tiangz/model";
function systemFor(...args: any[]): any {}
@bind(null) class Bad { value = 1; constructor() {} static { } static method() {} }
@core.entityExtensionHandler(null) class Extension { state = 1; }
@core.rpcHandler(null) class Valid { Run() {} get value() { return 1; } }
@old(null) class Old { state = 1; }
@systemFor(null) class Local { state = 1; }
@unresolved(null) class Unknown { state = 1; }
`;
  const diagnostics = [ts, hostTs].map(api => {
    const { program, options } = createFixtureProgram("", {
      "app/core/public.ts": decoratorSource, "app/core-old/public.ts": decoratorSource, [hotfixFile]: text,
    }, api);
    return runtimeContractDiagnostics(program, options);
  });
  assert.equal(diagnostics[0].length, 6);
  assert.equal(diagnostics[0].filter(item => item.severity === "error").length, 5);
  assert.equal(diagnostics[0].filter(item => item.severity === "warning").length, 1);
  assert.deepEqual(diagnostics[1], diagnostics[0]);
});
