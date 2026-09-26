import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { StdioRpc } from "./stdioRpc.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "../..");
const server = process.env.TIANGZ_TEST_SERVER_PATH ?? path.join(pluginRoot, "extension/dist/server.cjs");
const host = process.env.TIANGZ_TEST_MODULE_HOST;
const uri = file => pathToFileURL(file).toString();
const open = (rpc, file, text, version = 1) => rpc.notify("textDocument/didOpen", { textDocument: { uri: uri(file), languageId: file.endsWith(".ts") ? "typescript" : "json", version, text } });
const change = (rpc, file, text, version) => rpc.notify("textDocument/didChange", { textDocument: { uri: uri(file), version }, contentChanges: [{ text }] });
const close = (rpc, file) => rpc.notify("textDocument/didClose", { textDocument: { uri: uri(file) } });
const index = (rpc, roots, trusted) => rpc.notify("tiangzProject/indexFiles", { trusted, roots: roots.map(root => ({ rootUri: uri(root), uris: [uri(path.join(root, "tiangz.project.json"))] })) });
const snapshot = (rpc, root, predicate = () => true) => rpc.waitForNotification("tiangzProject/snapshot", item => item.rootUri === uri(root) && predicate(item.snapshot));
const stats = rpc => rpc.request("tiangzProject/serverStats", null);

async function connect(roots, timeout = 30_000) {
  const rpc = new StdioRpc(server, timeout);
  await rpc.request("initialize", { processId: null, rootUri: uri(roots[0]), capabilities: {}, workspaceFolders: roots.map(root => ({ uri: uri(root), name: path.basename(root) })) });
  rpc.notify("initialized", {});
  return rpc;
}
async function shutdown(rpc) {
  await rpc.request("shutdown", null);
  rpc.notify("exit", null);
  assert.equal(await rpc.waitForExit(), 0);
}
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail("condition did not settle");
}
function exited(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
}

// The fake host tests IPC scheduling/lifecycle only. Compiler parity is tested below with a real TiangZ checkout.
async function fakeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tiangz-live-ipc-"));
  const engine = path.join(root, "host with spaces");
  await mkdir(path.join(engine, "tools"), { recursive: true });
  await writeFile(path.join(engine, "tools/module_live_worker.mjs"), `
import path from 'node:path';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const root = process.argv[3], engineRoot = path.resolve(import.meta.dirname, '..');
const send = value => process.stdout.write(JSON.stringify({ formatVersion: 1, ...value }) + '\\n');
const identity = { typescriptVersion: 'fixture', ruleSetVersion: 1 };
send({ event: 'ready', engineRoot, projectRoot: root, declarationFiles: [path.join(root, 'tiangz.project.json')], sourceRoots: [path.join(root, 'modules/probe/src/model')], ...identity });
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line), text = request.overlays[0]?.text ?? 'disk';
  appendFileSync(path.join(root, 'requests.log'), text + '\\n');
  if (text === 'exit-worker') process.exit(7);
  if (text === 'hang') return;
  if (text === 'bad-frame') { process.stdout.write('{broken\\n'); return; }
  if (text === 'overflow') { process.stdout.write('x'.repeat(16 * 1024 * 1024 + 1)); return; }
  setTimeout(() => send({ id: request.id, status: 'checked', ...identity, cache: { sourceFiles: 3 },
    diagnostics: [{ code: 'fixture', severity: 'warning', message: text, file: path.join(root, 'modules/probe/src/model/index.ts'), line: 1, column: 1 }] }), text === 'slow' ? 650 : 5);
});`);
  const projects = [];
  for (let i = 0; i < 5; i++) {
    const project = path.join(root, `game-${i}`);
    await mkdir(path.join(project, "modules/probe/src/model"), { recursive: true });
    await writeFile(path.join(project, "modules/probe/src/model/index.ts"), "disk");
    await writeFile(path.join(project, "tiangz.project.json"), JSON.stringify({ formatVersion: 1, hostProfile: "modules", engineRoot: engine }));
    projects.push(project);
  }
  return { root, engine, projects };
}

test("module LSP gates trust, coalesces edits, rejects stale replies and disposes workers", { timeout: 45_000 }, async () => {
  const { projects, engine } = await fakeFixture();
  const root = projects[0], file = path.join(root, "modules/probe/src/model/index.ts");
  const rpc = await connect([root]);
  try {
    let next = snapshot(rpc, root, item => item.runtimeContracts?.status === "unavailable");
    index(rpc, [root], false);
    assert.match((await next).snapshot.runtimeContracts.reason, /受信任/);
    assert.equal((await stats(rpc)).moduleWorkers, 0);
    next = snapshot(rpc, root, item => item.runtimeContracts?.status === "checked");
    index(rpc, [root], true);
    await next;
    const pid = (await stats(rpc)).moduleWorkerPids[0];
    assert.ok(pid > 0);
    open(rpc, file, "slow");
    await until(async () => (await readFile(path.join(root, "requests.log"), "utf8")).includes("slow"));
    next = snapshot(rpc, root, item => item.diagnostics.some(d => d.message === "latest"));
    change(rpc, file, "intermediate", 2);
    change(rpc, file, "latest", 3);
    await next;
    assert.ok(!rpc.notifications.some(item => item.method === "tiangzProject/snapshot" && item.params.snapshot.diagnostics.some(d => d.message === "slow" || d.message === "intermediate")));
    assert.deepEqual((await readFile(path.join(root, "requests.log"), "utf8")).trim().split("\n"), ["disk", "slow", "latest"]);
    next = snapshot(rpc, root, item => item.diagnostics.some(d => d.message === "disk"));
    close(rpc, file);
    await next;

    const descriptor = path.join(root, "tiangz.project.json");
    const original = await readFile(descriptor, "utf8");
    next = snapshot(rpc, root, item => item.runtimeContracts?.status === "unavailable");
    open(rpc, descriptor, original.replace(engine.replaceAll("\\", "\\\\"), "untrusted-other-host"));
    assert.match((await next).snapshot.runtimeContracts.reason, /尚未保存/);
    await until(() => exited(pid));
    next = snapshot(rpc, root, item => item.runtimeContracts?.status === "checked");
    close(rpc, descriptor);
    await next;
    const restarted = (await stats(rpc)).moduleWorkerPids[0];
    open(rpc, file, "slow", 4);
    await until(async () => (await readFile(path.join(root, "requests.log"), "utf8")).split("\n").filter(text => text === "slow").length === 2);
    next = snapshot(rpc, root, item => item.runtimeContracts?.status === "unavailable");
    index(rpc, [root], false);
    await next;
    await until(() => exited(restarted));
    assert.ok(!rpc.notifications.some(item => item.method === "tiangzProject/snapshot" && item.params.snapshot.diagnostics.some(d => d.message === "slow")));
    assert.equal((await stats(rpc)).moduleWorkers, 0);
    index(rpc, [], false);
    await until(async () => (await stats(rpc)).snapshots === 0);
    await shutdown(rpc);
  } finally { rpc.dispose(); }
});

test("module LSP bounds projects and recovers from worker exits, malformed replies and overflow", { timeout: 45_000 }, async () => {
  const { projects } = await fakeFixture();
  const rpc = await connect(projects);
  try {
    const next = snapshot(rpc, projects[4], item => item.runtimeContracts?.status === "unavailable");
    index(rpc, projects, true);
    assert.match((await next).snapshot.runtimeContracts.reason, /四个/);
    const current = await stats(rpc);
    assert.equal(current.moduleWorkers, 4);
    assert.equal(current.moduleWorkerPids.length, 4);
    const refreshed = snapshot(rpc, projects[0], item => item.runtimeContracts?.status === "checked");
    rpc.notify("tiangzProject/indexFiles", { trusted: true, reloadModules: true, roots: projects.map(root => ({ rootUri: uri(root), uris: [uri(path.join(root, "tiangz.project.json"))] })) });
    await refreshed;
    assert.equal((await stats(rpc)).moduleWorkers, 4);
    await until(() => current.moduleWorkerPids.every(exited));
    const root = projects[0], file = path.join(root, "modules/probe/src/model/index.ts");
    for (const [i, text] of ["exit-worker", "bad-frame", "overflow"].entries()) {
      const unavailable = snapshot(rpc, root, item => item.runtimeContracts?.status === "unavailable");
      if (!i) open(rpc, file, text); else change(rpc, file, text, i * 2 + 1);
      await unavailable;
      const recovered = snapshot(rpc, root, item => item.runtimeContracts?.status === "checked");
      change(rpc, file, "recovered", i * 2 + 2);
      await recovered;
    }
    const pids = (await stats(rpc)).moduleWorkerPids;
    const idleFailure = rpc.waitForNotification("tiangzProject/snapshot", item => item.snapshot.runtimeContracts?.status === "unavailable" && /取消/.test(item.snapshot.runtimeContracts.reason ?? ""));
    process.kill(pids[0]);
    await idleFailure;
    await shutdown(rpc);
    await until(() => pids.every(exited));
  } finally { rpc.dispose(); }
});

test("actual module Host CLI and LSP agree on TypeScript 6 diagnostics and unsaved fixes", { skip: !host && "set TIANGZ_TEST_MODULE_HOST to the candidate host", timeout: 60_000 }, async () => {
  const engine = path.resolve(host);
  const project = await mkdtemp(path.join(os.tmpdir(), "tiangz-real-module-lsp-"));
  await mkdir(path.join(engine, "temp"), { recursive: true });
  const module = path.join(await mkdtemp(path.join(engine, "temp/module-live-lsp-")), "probe");
  const created = spawnSync(process.execPath, ["tools/create_game_module.mjs", "--id", "org.example.live", "--path", module, "--host-profile", "modules"], { cwd: engine, encoding: "utf8", windowsHide: true });
  assert.equal(created.status, 0, created.stderr);
  await mkdir(path.join(project, "modules"));
  await symlink(module, path.join(project, "modules/probe"), process.platform === "win32" ? "junction" : "dir");
  await mkdir(path.join(project, "configs"));
  await writeFile(path.join(project, "configs/process.json"), "{}");
  await writeFile(path.join(project, "configs/StartMachine.json"), "{}");
  await writeFile(path.join(project, "tiangz.project.json"), JSON.stringify({ formatVersion: 1, hostProfile: "modules", engineRoot: engine, modulesDirectory: "modules", processConfig: "configs/process.json", machineConfig: "configs/StartMachine.json" }));
  const file = path.join(module, "src/model/index.ts");
  const source = `import { Component } from "#tiangz/core";
export class Probe extends Component {
  protected override async Awake(): Promise<void> {}
  Schedule(name: string): void { this.NewOnceTimer(1, "Missing"); this.NewOnceTimer(1, name); }
  Tick(now = Date.now()): void { void now; }
}`;
  await writeFile(file, source);
  await writeFile(path.join(module, "src/hotfix/index.ts"), "export {};");
  const cli = spawnSync(process.execPath, ["tools/typecheck_game_modules.mjs", "--modules-dir", path.join(project, "modules"), "--host-profile", "modules", "--json"], { cwd: engine, encoding: "utf8", windowsHide: true });
  assert.equal(cli.status, 1, cli.stderr);
  const expected = JSON.parse(cli.stdout).diagnostics.map(item => ({ code: item.code, severity: item.severity ?? "error", message: item.message,
    location: { relativePath: path.relative(project, item.file).replaceAll("\\", "/"), line: item.line - 1, character: item.column - 1 } }));
  const rpc = await connect([project]);
  try {
    let next = snapshot(rpc, project, item => item.runtimeContracts?.status === "checked");
    index(rpc, [project], true);
    const baseline = (await next).snapshot;
    assert.match(baseline.runtimeContracts.typescriptVersion, /^6\./);
    assert.deepEqual(baseline.diagnostics, expected);
    const initial = await stats(rpc);
    assert.equal(rpc.notifications.find(item => item.method === "textDocument/publishDiagnostics" && item.params.uri === uri(file))?.params.diagnostics.length, expected.length);
    assert.equal(initial.moduleWorkers, 1);
    assert.ok(initial.moduleTypeFiles > 10);
    assert.equal(initial.cachedTypeProjects, 0);
    const fixed = source.replace("async Awake(): Promise<void>", "Awake(): void").replace('"Missing"', '"Tick"');
    next = snapshot(rpc, project, item => item.diagnostics.length === 1 && item.diagnostics[0].severity === "warning");
    open(rpc, file, fixed);
    await next;
    assert.equal((await stats(rpc)).moduleWorkerPids[0], initial.moduleWorkerPids[0]);
    next = snapshot(rpc, project, item => item.diagnostics.some(d => d.code === "TS2307"));
    change(rpc, file, fixed + '\nimport { Absent } from "./missing-dependency.js"; export type Missing = Absent;', 2);
    await next;
    next = snapshot(rpc, project, item => item.diagnostics.length === expected.length);
    close(rpc, file);
    assert.deepEqual((await next).snapshot.diagnostics, expected);
    assert.equal(await readFile(file, "utf8"), source);
    const config = path.join(module, "tsconfig.json");
    next = snapshot(rpc, project, item => item.runtimeContracts?.status === "unavailable");
    open(rpc, config, "{}");
    assert.match((await next).snapshot.runtimeContracts.reason, /尚未保存/);
    await until(() => initial.moduleWorkerPids.every(exited));
    next = snapshot(rpc, project, item => item.runtimeContracts?.status === "checked");
    close(rpc, config);
    await next;
    const finalPids = (await stats(rpc)).moduleWorkerPids;
    await shutdown(rpc);
    await until(() => finalPids.every(exited));
  } finally { rpc.dispose(); }
});

test("a stalled module check reaches its real deadline, releases its child and can recover", { timeout: 40_000 }, async () => {
  const { projects } = await fakeFixture();
  const root = projects[0], file = path.join(root, "modules/probe/src/model/index.ts");
  const rpc = await connect([root], 35_000);
  try {
    let next = snapshot(rpc, root, item => item.runtimeContracts?.status === "checked");
    index(rpc, [root], true);
    await next;
    const pids = (await stats(rpc)).moduleWorkerPids;
    // Give the observer separate grace; the production deadline remains 30s and is asserted below.
    open(rpc, file, "hang");
    await until(async () => (await readFile(path.join(root, "requests.log"), "utf8")).includes("hang"));
    const started = performance.now();
    next = snapshot(rpc, root, item => item.runtimeContracts?.status === "unavailable");
    assert.match((await next).snapshot.runtimeContracts.reason, /30 秒/);
    assert.ok(performance.now() - started >= 29_000);
    assert.ok(performance.now() - started < 33_000);
    await until(() => pids.every(exited));
    assert.equal((await stats(rpc)).moduleWorkers, 0);
    next = snapshot(rpc, root, item => item.runtimeContracts?.status === "checked");
    close(rpc, file);
    await next;
    await shutdown(rpc);
  } finally { rpc.dispose(); }
});
