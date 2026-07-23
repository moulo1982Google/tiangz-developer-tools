import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(repositoryRoot, "dist", "tiangz-check-project.cjs");

test("returns 0 and JSON for a valid project", async (context) => {
  const root = await fixture(context);
  const result = run(root, "--format", "json");
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.version, 1);
  assert.equal(output.passed, true);
  assert.equal(output.errors, 0);
});

test("returns 1 when project diagnostics contain an error", async (context) => {
  const root = await fixture(context);
  await write(root, "app/demo/Broken.ts", "export class {\n");
  const result = run(root, "--format", "json");
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.passed, false);
  assert.ok(output.diagnostics.some((item) => item.code === "tiangz.typescript.syntax"));
});

test("can promote generated orphan warnings to a failed check", async (context) => {
  const root = await fixture(context);
  await write(root, "app/generated/Orphan.ts", "export const orphan = true;\n");
  await write(root, "codegen.manifest.json", JSON.stringify({
    version: 1,
    hashAlgorithm: "sha256-normalized-text-v1",
    generators: {
      demo: {
        command: "npm run codegen:demo",
        contentInputs: {},
        selections: [],
        outputs: {},
        outputRoots: [{ path: "app/generated", extensions: [".ts"] }],
      },
    },
  }));
  assert.equal(run(root).status, 0);
  assert.equal(run(root, "--warnings-as-errors").status, 1);
});

test("returns 2 for a missing project directory", () => {
  const result = run(path.join(os.tmpdir(), `missing-tiangz-${Date.now()}`));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /检查器错误/);
});

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tiangz-check-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function write(root, relativePath, content) {
  const file = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}
