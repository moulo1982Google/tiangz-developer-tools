import test from "node:test";
import assert from "node:assert/strict";
import { parseModuleNavigation } from "../dist/moduleNavigation.js";

const fixture = () => ({ formatVersion: 1, engineVersion: "0.6.0-alpha.0", modulesDirectory: "/project/modules", limitations: ["Static navigation only"], modules: [{
  id: "org.example.counter", version: "0.1.0", description: "Counter", root: "/project/modules/counter", manifest: "tiangz.module.json",
  entries: { model: "src/model/index.ts", hotfix: "src/hotfix/index.ts" }, publicApi: null, dependencies: [],
  declarations: [{ name: "Counter", kind: "component", layer: "model", generated: false, reachable: true, location: { file: "src/model/Counter.ts", line: 1, column: 1 } }], bindings: [], diagnostics: [],
}] });

test("navigation accepts engine v1 output, preserves extra fields, and never invents bindings", () => {
  const report = fixture();
  report.graphHash = "opaque";
  assert.deepEqual(parseModuleNavigation(JSON.stringify(report)), report);
});
test("navigation reports engine errors and rejects unknown contracts", () => {
  assert.throws(() => parseModuleNavigation(JSON.stringify({ formatVersion: 1, error: { message: "dependency missing" } })), /dependency missing/);
  assert.throws(() => parseModuleNavigation(JSON.stringify({ ...fixture(), formatVersion: 2 })), /格式不兼容/);
  assert.throws(() => parseModuleNavigation("{}"), /格式不兼容/);
});
test("navigation refuses traversal and invalid source positions", () => {
  for (const file of ["../private.ts", "/private.ts", "C:/private.ts", "src/../private.ts", "src\\private.ts", "src//a.ts"]) {
    const report = fixture();
    report.modules[0].declarations[0].location.file = file;
    assert.throws(() => parseModuleNavigation(JSON.stringify(report)), /格式不兼容/);
  }
  const report = fixture();
  report.modules[0].declarations[0].location.line = 0;
  assert.throws(() => parseModuleNavigation(JSON.stringify(report)), /格式不兼容/);
});

test("target navigation locations are validated like primary declarations", () => {
  const report = fixture();
  report.modules[0].declarations[0].targetLocation = { file: "../private.ts", line: 1, column: 1 };
  assert.throws(() => parseModuleNavigation(JSON.stringify(report)), /格式不兼容/);
});
