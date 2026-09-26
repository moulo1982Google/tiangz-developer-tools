import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import ts from "typescript";
import { analyzeTiangZProject, dependencyDiagnostics, programDependencyDiagnostics, RuntimeContractProject } from "../dist/index.js";
import { createFixtureProgram } from "./runtime-contract-fixture.mjs";

function diagnostics(relativePath, text) {
  return analyzeTiangZProject([{ relativePath, text }]).diagnostics
    .filter(item => item.code.startsWith("tiangz.architecture."));
}

test("Model business code must use the Stable Core entry, including import-type expressions", () => {
  for (const text of [
    'import { Entity } from "../core/runtime/entities";',
    'type Entity = import("../core/runtime/entities").Entity;',
  ]) {
    assert.equal(diagnostics("app/model/Inventory.ts", text).length, 1, text);
  }
});

test("Core cannot use the reserved Model alias to bypass dependency direction", () => {
  const found = diagnostics("app/core/Runtime.ts", 'import type { State } from "#tiangz/model";');
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "tiangz.architecture.invalid-dependency");
});

test("type-only and import-equals references cannot enter Hotfix from Model", () => {
  for (const text of [
    'type Behavior = import("../hotfix/Behavior").Behavior;',
    'import Behavior = require("../hotfix/Behavior");',
  ]) assert.equal(diagnostics("app/model/State.ts", text).length, 1, text);
});

test("only exact host bootstrap files may use internal Core dependencies", () => {
  const text = 'import { start } from "../core/runtime/host";';
  assert.deepEqual(diagnostics("app/model/main.ts", text), []);
  assert.equal(diagnostics("app/model/main-helper.ts", text).length, 1);
});

test("dependency-looking comments and ordinary text are not imports", () => {
  assert.deepEqual(diagnostics("app/model/State.ts", '// import { X } from "../core/runtime/entities";\nconst docs = `from "../hotfix/System"`;'), []);
});

test("a checked Program must not suppress syntax rules for source files excluded by tsconfig", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tiangz-dependency-"));
  const project = new RuntimeContractProject(directory);
  try {
    const sources = Object.entries({
      "tsconfig.json": JSON.stringify({ compilerOptions: { noEmit: true, skipLibCheck: true }, include: ["app/core/**/*.ts"] }),
      "app/core/public.ts": "export {};", "app/core/internal.ts": "export interface Hidden {}",
      "app/model/Excluded.ts": 'import { Hidden } from "../core/internal"; export type State = Hidden;',
    }).map(([relativePath, text]) => ({ relativePath, text }));
    for (const source of sources) {
      const file = path.join(directory, source.relativePath);
      await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, source.text);
    }
    const result = project.analyze(sources);
    assert.equal(result.status, "checked");
    const found = analyzeTiangZProject(sources, result).diagnostics.filter(item => item.code.startsWith("tiangz.architecture."));
    assert.equal(found.length, 1);
    assert.equal(found[0].location.relativePath, "app/model/Excluded.ts");
  } finally {
    project.dispose();
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(relative.startsWith("tiangz-dependency-") && !relative.includes(path.sep));
    await rm(directory, { recursive: true, force: true });
  }
});

test("computed imports remain unverified and static templates obey dependency rules", () => {
  const found = diagnostics("app/model/State.ts", 'declare const target: string; import(target); import(`../hotfix/Behavior`);');
  assert.deepEqual(found.map(item => [item.code, item.severity]), [
    ["tiangz.architecture.unverifiable-dependency", "warning"], ["tiangz.architecture.invalid-dependency", "error"],
  ]);
});

const root = path.resolve("dependency-fixture"), moduleRoot = path.join(root, "modules/game"), coreRoot = path.join(root, "app/core");
const moduleContext = {
  modelRoots: [path.join(moduleRoot, "src/model")], hotfixRoots: [path.join(moduleRoot, "src/hotfix")],
  modelEntry: path.join(moduleRoot, "src/model/index.ts"), coreRoot,
  protocolRoot: path.join(moduleRoot, "src/model/generated/protocol"),
  resolvePublicApi: name => { if (name === "#tiangz/modules/shared") return path.join(root, "modules/shared/src/model/public.ts"); throw Error("direct dependency missing"); },
};
function moduleDiagnostics(relative, text, api = ts) {
  const source = api.createSourceFile(path.join(moduleRoot, relative), text, api.ScriptTarget.Latest, true);
  return dependencyDiagnostics(source, { typescript: api, projectRoot: moduleRoot, module: moduleContext });
}
function relativeImport(relative, target) {
  const result = path.relative(path.dirname(path.join(moduleRoot, relative)), target).replaceAll("\\", "/");
  return result.startsWith(".") ? result : `./${result}`;
}

test("module roots and declared public dependencies apply to type imports too", () => {
  assert.deepEqual(moduleDiagnostics("src/model/State.ts", 'import { Entity } from "#tiangz/core"; export * from "./Other";'), []);
  assert.deepEqual(moduleDiagnostics("src/hotfix/Behavior.ts", 'import { State } from "#tiangz/module"; import { X } from "#tiangz/modules/shared";'), []);
  assert.equal(moduleDiagnostics("src/model/State.ts", 'type Bad = import("../hotfix/Behavior").Bad;').length, 1);
  assert.equal(moduleDiagnostics("src/hotfix/Behavior.ts", 'import { State } from "../model/State";').length, 1);
  assert.equal(moduleDiagnostics("src/hotfix/Behavior.ts", 'import { Entity } from "#tiangz/core";').length, 1);
  assert.match(moduleDiagnostics("src/model/State.ts", 'import { X } from "#tiangz/modules/undeclared";')[0].message, /direct dependency missing/);
});

test("resolved Stable paths follow platform separators and case identity", () => {
  const source = ts.createSourceFile(path.join(moduleRoot, "src/model/State.ts"), 'import { Entity } from "#tiangz/core";', ts.ScriptTarget.Latest, true);
  const target = path.join(coreRoot, "public.ts").replaceAll("\\", "/");
  assert.deepEqual(dependencyDiagnostics(source, { projectRoot: moduleRoot, module: moduleContext,
    resolveTarget: () => process.platform === "win32" ? target.toLowerCase() : target }), []);
});

test("protocol ABI exceptions require generator identity, declared output and an exact ABI target", () => {
  const file = "src/model/generated/protocol/messages.ts", header = "// Generated by tools/codegen_proto.mjs. Do not edit by hand.\n";
  for (const target of ["protocol/binary", "protocol/message", "protocol/rpc", "broadcast/index"]) {
    const text = `import { X } from ${JSON.stringify(relativeImport(file, path.join(coreRoot, target)))};`;
    assert.deepEqual(moduleDiagnostics(file, header + text), []);
    assert.equal(moduleDiagnostics(file, text).length, 1);
  }
  assert.equal(moduleDiagnostics(file, header + `import { X } from ${JSON.stringify(relativeImport(file, path.join(coreRoot, "runtime/entities")))};`).length, 1);
  const elsewhere = "src/model/generated/Other.ts";
  assert.equal(moduleDiagnostics(elsewhere, header + `import { X } from ${JSON.stringify(relativeImport(elsewhere, path.join(coreRoot, "protocol/binary")))};`).length, 1);
});

test("generated System augmentations target original domain declarations without widening all generated imports", () => {
  const file = "src/model/generated/bootstrap/systems/InventorySystem.d.ts";
  const target = relativeImport(file, path.resolve(coreRoot, "../model/domains/Inventory"));
  const text = `import { X } from ${JSON.stringify(target)}; declare module ${JSON.stringify(target)} { interface Inventory { Read(): void; } }`;
  assert.deepEqual(moduleDiagnostics(file, "// Generated by tools/codegen_module_systems.mjs. Do not edit.\n" + text), []);
  assert.equal(moduleDiagnostics(file, text).length, 2);
});

test("Program resolution prevents custom aliases and redirected Stable aliases from hiding dependencies", () => {
  const source = 'import { bad } from "@behavior"; import { Component } from "#tiangz/core";';
  const { program, options } = createFixtureProgram(source, { "app/hotfix/Behavior.ts": "export const bad = 1;", "app/core/internal.ts": "export class Component {}" }, ts, {
    paths: { "@behavior": [path.resolve("runtime-contract-fixture/app/hotfix/Behavior.ts")], "#tiangz/core": [path.resolve("runtime-contract-fixture/app/core/internal.ts")] },
  });
  const found = programDependencyDiagnostics(program, { ...options, sourceFiles: [program.getSourceFile(path.join(options.projectRoot, "app/model/Test.ts"))] });
  assert.equal(found.length, 2, JSON.stringify(found));
  assert.ok(found.every(item => item.code === "tiangz.architecture.invalid-dependency"));
});

test("dependency diagnostics are identical with the actual plugin TS 5 and host TS 6", {
  skip: !process.env.TIANGZ_TEST_MODULE_HOST && "set TIANGZ_TEST_MODULE_HOST to compare the selected compiler",
}, () => {
  const hostTs = createRequire(path.join(path.resolve(process.env.TIANGZ_TEST_MODULE_HOST), "package.json"))("typescript");
  assert.match(ts.version, /^5\./); assert.match(hostTs.version, /^6\./);
  const text = 'import { X } from "#tiangz/core"; type State = import("../model/State").State; import(dynamicTarget);';
  const expected = moduleDiagnostics("src/hotfix/Behavior.ts", text);
  assert.equal(expected.length, 3);
  assert.deepEqual(moduleDiagnostics("src/hotfix/Behavior.ts", text, hostTs), expected);
});
