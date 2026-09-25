import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { projectFiles, contractSource } from "../../packages/project-core/test/runtime-contract-fixture.mjs";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const serverPath = process.env.TIANGZ_TEST_SERVER_PATH ?? path.resolve(testRoot, "../dist/server.cjs");

test("CLI and actual LSP share typed contracts, unsaved changes and project cache disposal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tiangz-contract-lsp-"));
  const rpc = new StdioRpc(serverPath);
  try {
    for (const [relative, text] of Object.entries(projectFiles)) {
      const file = path.join(root, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
    }
    const cli = spawnSync(process.execPath, [path.resolve(testRoot, "../../dist/tiangz-check-project.cjs"), root, "--format", "json"], { encoding: "utf8", windowsHide: true });
    assert.equal(cli.status, 1, cli.stderr);
    const checked = JSON.parse(cli.stdout);
    assert.equal(checked.runtimeContracts.status, "checked");
    assert.equal(checked.errors, 3, cli.stdout);
    const rootUri = pathToFileURL(root).toString();
    const sourceUri = pathToFileURL(path.join(root, "app/model/Worker.ts")).toString();
    await rpc.request("initialize", { processId: null, rootUri, capabilities: {}, workspaceFolders: [{ uri: rootUri, name: "contracts" }] });
    rpc.notify("initialized", {});
    const first = rpc.waitForNotification("tiangzProject/snapshot", params => params.rootUri === rootUri);
    rpc.notify("tiangzProject/indexFiles", { roots: [{ rootUri, uris: Object.keys(projectFiles).map(file => pathToFileURL(path.join(root, file)).toString()) }] });
    const snapshot = (await first).snapshot;
    assert.equal(snapshot.runtimeContracts?.status, "checked", JSON.stringify(snapshot.runtimeContracts));
    assert.deepEqual(snapshot.diagnostics, checked.diagnostics);
    const stats = await rpc.request("tiangzProject/serverStats", null);
    assert.equal(stats.cachedTypeProjects, 1);
    assert.ok(stats.cachedTypeFiles > 2 && stats.cachedTypeFiles < 200);

    const fixed = contractSource.replace("async Awake()", "Awake()").replace('"Missing"', '"Tick"').replace('"wrong"', '{ value: 2 }');
    const update = rpc.waitForNotification("tiangzProject/snapshot", params => params.rootUri === rootUri && params.snapshot.runtimeContracts?.status === "checked" && params.snapshot.diagnostics.length === 0);
    open(rpc, sourceUri, fixed, 1);
    await update;
    const afterEdit = await rpc.request("tiangzProject/serverStats", null);
    assert.equal(afterEdit.cachedTypeProjects, 1);
    assert.equal(afterEdit.cachedTypeFiles, stats.cachedTypeFiles);
    const closed = rpc.waitForNotification("textDocument/publishDiagnostics", params => params.uri === sourceUri && params.diagnostics.length === 0);
    rpc.notify("tiangzProject/indexFiles", { roots: [] });
    await closed;
    const afterClose = await rpc.request("tiangzProject/serverStats", null);
    assert.equal(afterClose.cachedTypeProjects, 0);
    assert.equal(afterClose.cachedTypeFiles, 0);
    await rpc.request("shutdown", null);
    rpc.notify("exit", null);
    await rpc.waitForExit();
  } finally {
    rpc.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("provides protocol diagnostics, navigation, Hover and CodeLens", async () => {
  const rpc = new StdioRpc(serverPath);
  try {
    const rootUri = process.platform === "win32" ? "file:///C:/workspace" : "file:///workspace";
    const messagesUri = `${rootUri}/app/generated/model/server/demo/protocol/messages.ts`;
    const codesUri = `${rootUri}/app/generated/model/server/demo/protocol/msgcodes.ts`;
    const rpcsUri = `${rootUri}/app/generated/model/server/demo/protocol/rpcs.ts`;
    const handlerUri = `${rootUri}/app/demo/LoginHandler.ts`;
    const rpcsText = `export const LoginProtocol = {
  Login: defineRpc<C2S_Login, S2C_Login>({
    name: "Login.Login",
    requestCode: MsgCode.C2S_Login,
    responseCode: MsgCode.S2C_Login,
  }),
};`;
    const handlerText = `@sessionRpcHandler(LoginScene, LoginProtocol.Login)
export class LoginHandler implements SessionRpcHandler<LoginScene, LoginSession, C2S_Login, S2C_Login> {}`;

    const initialized = await rpc.request("initialize", {
      processId: null,
      rootUri,
      capabilities: {},
      workspaceFolders: [{ uri: rootUri, name: "workspace" }],
    });
    assert.equal(initialized.capabilities.definitionProvider, true);
    assert.equal(initialized.capabilities.referencesProvider, true);
    assert.equal(initialized.capabilities.hoverProvider, true);
    assert.deepEqual(initialized.capabilities.codeLensProvider, { resolveProvider: false });
    rpc.notify("initialized", {});

    open(rpc, messagesUri, "export interface C2S_Login {}\nexport interface S2C_Login {}", 1);
    open(rpc, codesUri, "export const Codes = { C2S_Login: 10001, S2C_Login: 10002 } as const;", 1);
    open(rpc, rpcsUri, rpcsText, 1);
    const projectSnapshot = rpc.waitForNotification(
      "tiangzProject/snapshot",
      (params) => params.rootUri === rootUri && params.snapshot.handlers.length === 1,
    );
    open(rpc, handlerUri, handlerText, 1);
    const snapshot = await projectSnapshot;
    assert.equal(snapshot.snapshot.protocols.length, 1);
    const stats = await rpc.request("tiangzProject/serverStats", null);
    assert.deepEqual({ roots: stats.roots, cachedFiles: stats.cachedFiles, snapshots: stats.snapshots }, {
      roots: 1,
      cachedFiles: 4,
      snapshots: 1,
    });

    const definition = await rpc.request("textDocument/definition", {
      textDocument: { uri: handlerUri },
      position: { line: 0, character: 39 },
    });
    assert.equal(definition.uri, rpcsUri);
    assert.equal(definition.range.start.line, 1);

    const hover = await rpc.request("textDocument/hover", {
      textDocument: { uri: handlerUri },
      position: { line: 0, character: 39 },
    });
    assert.match(hover.contents.value, /RPC `Login.Login`/);
    assert.match(hover.contents.value, /C2S_Login.*10001/);
    assert.match(hover.contents.value, /LoginHandler/);

    const foundationUri = `${rootUri}/app/hotfix/mmorpg/RuntimeFoundation.ts`;
    const foundationDiagnostics = rpc.waitForNotification(
      "textDocument/publishDiagnostics",
      (params) => params.uri === foundationUri,
    );
    open(rpc, foundationUri, "export class RuntimeFoundation { timerId: TimerId = 0n; }", 1);
    await foundationDiagnostics;
    const foundationHover = await rpc.request("textDocument/hover", {
      textDocument: { uri: foundationUri },
      position: { line: 0, character: 44 },
    });
    assert.match(foundationHover.contents.value, /定时器句柄/);
    assert.match(foundationHover.contents.value, /CancelTimer/);

    const stateUri = `${rootUri}/app/hotfix/mmorpg/StatefulSystem.ts`;
    const stateDiagnostics = rpc.waitForNotification(
      "textDocument/publishDiagnostics",
      (params) => params.uri === stateUri
        && params.diagnostics.some((diagnostic) => diagnostic.code === "tiangz.hotfix.instance-state"),
    );
    open(rpc, stateUri, `import { systemFor as bindSystem, Component } from "#tiangz/model";
@bindSystem(Component)
export class StatefulSystem extends Component {
  private cache = new Map<string, number>();
  constructor() {}
}`, 1);
    const stateDiagnosticCodes = (await stateDiagnostics).diagnostics
      .filter((diagnostic) => diagnostic.code === "tiangz.hotfix.instance-state")
      .map((diagnostic) => diagnostic.code);
    assert.deepEqual(stateDiagnosticCodes, [
      "tiangz.hotfix.instance-state",
      "tiangz.hotfix.instance-state",
    ]);

    const references = await rpc.request("textDocument/references", {
      textDocument: { uri: rpcsUri },
      position: { line: 1, character: 4 },
      context: { includeDeclaration: true },
    });
    assert.equal(references.length, 2);
    assert.deepEqual(references.map((location) => location.uri), [rpcsUri, handlerUri]);

    const protocolDefinition = await rpc.request("textDocument/definition", {
      textDocument: { uri: rpcsUri },
      position: { line: 1, character: 4 },
    });
    assert.equal(protocolDefinition[0].uri, handlerUri);

    const handlerLenses = await rpc.request("textDocument/codeLens", {
      textDocument: { uri: handlerUri },
    });
    assert.equal(handlerLenses.length, 1);
    assert.equal(handlerLenses[0].command.title, "协议 Login.Login");
    assert.equal(handlerLenses[0].command.arguments[0][0].uri, rpcsUri);

    const protocolLenses = await rpc.request("textDocument/codeLens", {
      textDocument: { uri: rpcsUri },
    });
    assert.equal(protocolLenses.length, 1);
    assert.equal(protocolLenses[0].command.title, "1 个 Handler");

    const brokenUri = `${rootUri}/app/demo/BrokenLoginHandler.ts`;
    const brokenDiagnostics = rpc.waitForNotification(
      "textDocument/publishDiagnostics",
      (params) => params.uri === brokenUri,
    );
    const duplicateDiagnostics = rpc.waitForNotification(
      "textDocument/publishDiagnostics",
      (params) => params.uri === handlerUri
        && params.diagnostics.some((diagnostic) => diagnostic.code === "tiangz.handler.duplicate"),
    );
    open(rpc, brokenUri, `@sessionRpcHandler(LoginScene, LoginProtocol.Login)
class BrokenLoginHandler implements SessionRpcHandler<LoginScene, LoginSession, WrongRequest, S2C_Login> {}`, 1);
    assert.deepEqual((await brokenDiagnostics).diagnostics.map((diagnostic) => diagnostic.code), [
      "tiangz.handler.rpc-type-mismatch",
    ]);
    assert.deepEqual((await duplicateDiagnostics).diagnostics.map((diagnostic) => diagnostic.code), [
      "tiangz.handler.duplicate",
    ]);

    const invalidCoreUri = `${rootUri}/app/core/InvalidRuntime.ts`;
    const dependencyDiagnostics = rpc.waitForNotification(
      "textDocument/publishDiagnostics",
      (params) => params.uri === invalidCoreUri
        && params.diagnostics.some((diagnostic) => diagnostic.code === "tiangz.architecture.invalid-dependency"),
    );
    open(rpc, invalidCoreUri, `import { LoginHandler } from "../demo/LoginHandler";`, 1);
    const invalidDependency = (await dependencyDiagnostics).diagnostics.find(
      (diagnostic) => diagnostic.code === "tiangz.architecture.invalid-dependency",
    );
    assert.equal(invalidDependency.severity, 1);
    assert.match(invalidDependency.message, /Core 不允许依赖 业务目录 demo/);

    const generatedUri = `${rootUri}/app/generated/model/server/demo/Changed.ts`;
    const manifestUri = `${rootUri}/codegen.manifest.json`;
    open(rpc, generatedUri, "// changed generated output", 1);
    const generatedDiagnostics = rpc.waitForNotification(
      "textDocument/publishDiagnostics",
      (params) => params.uri === generatedUri
        && params.diagnostics.some((diagnostic) => diagnostic.code === "tiangz.generated.modified"),
    );
    open(rpc, manifestUri, JSON.stringify({
      version: 1,
      hashAlgorithm: "sha256-normalized-text-v1",
      generators: {
        proto: {
          command: "npm run codegen:proto",
          contentInputs: {},
          selections: [],
          outputs: {
            "app/generated/model/server/demo/Changed.ts": textHash("// expected generated output"),
          },
          outputRoots: [{ path: "app/generated/model/server", extensions: [".ts"], ignore: [] }],
        },
      },
    }), 1);
    assert.match(
      (await generatedDiagnostics).diagnostics.find(
        (diagnostic) => diagnostic.code === "tiangz.generated.modified",
      ).message,
      /请勿手工修改/,
    );

    await rpc.request("shutdown", null);
    rpc.notify("exit", null);
    await rpc.waitForExit();
  } finally {
    rpc.dispose();
  }
});

test("indexes arbitrary Manifest input extensions without stale diagnostics", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "tiangz-manifest-input-"));
  const rpc = new StdioRpc(serverPath);
  try {
    const inputPath = path.join(workspace, "game_config", "Datas", "ItemConfig.xlsx");
    const manifestPath = path.join(workspace, "codegen.manifest.json");
    const inputText = "binary-fixture";
    const manifestText = JSON.stringify({
      version: 1,
      hashAlgorithm: "sha256-normalized-text-v1",
      generators: {
        "game-config": {
          command: "npm run codegen:game-config",
          contentInputs: { "game_config/Datas/ItemConfig.xlsx": textHash(inputText) },
          selections: [],
          outputs: {},
          outputRoots: [],
        },
      },
    });
    await mkdir(path.dirname(inputPath), { recursive: true });
    await writeFile(inputPath, inputText, "utf8");
    await writeFile(manifestPath, manifestText, "utf8");

    const rootUri = pathToFileURL(workspace).toString();
    const manifestUri = pathToFileURL(manifestPath).toString();
    const inputUri = pathToFileURL(inputPath).toString();
    await rpc.request("initialize", {
      processId: null,
      rootUri,
      capabilities: {},
      workspaceFolders: [{ uri: rootUri, name: "workspace" }],
    });
    rpc.notify("initialized", {});
    const snapshot = rpc.waitForNotification(
      "tiangzProject/snapshot",
      () => true,
    );
    rpc.notify("tiangzProject/indexFiles", { roots: [{ rootUri, uris: [manifestUri, inputUri] }] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stats = await rpc.request("tiangzProject/serverStats", null);
    assert.equal(stats.cachedFiles, 2);
    assert.deepEqual((await snapshot).snapshot.diagnostics, []);

    await rpc.request("shutdown", null);
    rpc.notify("exit", null);
    await rpc.waitForExit();
  } finally {
    rpc.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("module descriptor clears legacy diagnostics even while legacy documents stay open", async () => {
  const rpc = new StdioRpc(serverPath);
  try {
    const rootUri = process.platform === "win32" ? "file:///C:/module-workspace" : "file:///module-workspace";
    await rpc.request("initialize", { processId: null, rootUri, capabilities: {}, workspaceFolders: [{ uri: rootUri, name: "module" }] });
    rpc.notify("initialized", {});
    const configUri = `${rootUri}/configs/local/game.json`;
    const warned = rpc.waitForNotification("textDocument/publishDiagnostics", params => params.uri === configUri && params.diagnostics.some(item => item.code === "tiangz.config.unknown-entry-scene"));
    open(rpc, configUri, JSON.stringify({ process: { name: "Counter", identity: { originServerId: 92, workerId: 0 } }, scenes: [{ name: "Counter", sceneType: "Counter" }] }), 1);
    await warned;
    const cleared = rpc.waitForNotification("textDocument/publishDiagnostics", params => params.uri === configUri && params.diagnostics.length === 0);
    const delegated = rpc.waitForNotification("tiangzProject/snapshot", params => params.snapshot.analysisMode === "host-delegated");
    open(rpc, `${rootUri}/tiangz.project.json`, "{broken", 1);
    await cleared;
    assert.deepEqual((await delegated).snapshot.processes, []);
    await rpc.request("shutdown", null);
    rpc.notify("exit", null);
    await rpc.waitForExit();
  } finally { rpc.dispose(); }
});

test("umbrella root is replaced by discovered project roots and open documents are reindexed", async () => {
  const rpc = new StdioRpc(serverPath);
  try {
    const umbrella = process.platform === "win32" ? "file:///C:/umbrella" : "file:///umbrella";
    const nested = `${umbrella}/TiangZ`;
    const handlerUri = `${nested}/app/demo/WorldHandler.ts`;
    await rpc.request("initialize", { processId: null, rootUri: umbrella, capabilities: {}, workspaceFolders: [{ uri: umbrella, name: "umbrella" }] });
    rpc.notify("initialized", {});
    const original = rpc.waitForNotification("tiangzProject/snapshot", p => p.rootUri === umbrella);
    open(rpc, handlerUri, "@sessionRpcHandler(LoginScene, LoginProtocol.Login)\nexport class WorldHandler implements SessionRpcHandler<LoginScene, LoginSession, C2S_Login, S2C_Login> {}", 1);
    await original;
    const indexed = rpc.waitForNotification("tiangzProject/snapshot", p => p.rootUri === nested && p.snapshot.handlers.length === 1);
    rpc.notify("tiangzProject/indexFiles", { roots: [{ rootUri: nested, uris: [handlerUri] }] });
    const result = await indexed;
    assert.equal(result.snapshot.handlers[0].location.relativePath, "app/demo/WorldHandler.ts");
    const stats = await rpc.request("tiangzProject/serverStats", null);
    assert.equal(stats.roots, 1);
    assert.equal(stats.snapshots, 1);
    const cleared = rpc.waitForNotification("textDocument/publishDiagnostics", p => p.uri === handlerUri && p.diagnostics.length === 0);
    rpc.notify("tiangzProject/indexFiles", { roots: [] });
    await cleared;
    const removed = await rpc.request("tiangzProject/serverStats", null);
    assert.equal(removed.roots, 0);
    assert.equal(removed.cachedFiles, 0);
    assert.equal(removed.snapshots, 0);
    await rpc.request("shutdown", null);
    rpc.notify("exit", null);
    await rpc.waitForExit();
  } finally { rpc.dispose(); }
});

function open(rpc, uri, text, version) {
  rpc.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "typescript", version, text },
  });
}

function textHash(text) {
  return createHash("sha256").update(text.replaceAll("\r\n", "\n"), "utf8").digest("hex");
}

test("module editor rejects time waits and clears diagnostics after an owned timer rewrite", async () => {
  const rpc = new StdioRpc(serverPath);
  try {
    const rootUri = process.platform === "win32" ? "file:///C:/timer-game" : "file:///timer-game";
    await rpc.request("initialize", { processId: null, rootUri, capabilities: {}, workspaceFolders: [{ uri: rootUri, name: "timer-game" }] });
    rpc.notify("initialized", {});
    open(rpc, `${rootUri}/tiangz.project.json`, "{}", 1);
    const uri = `${rootUri}/modules/game/src/hotfix/Upgrade.ts`;
    const bad = rpc.waitForNotification("textDocument/publishDiagnostics", params => params.uri === uri && params.diagnostics.some(item => item.code === "tiangz.timer.time-wait-forbidden"));
    open(rpc, uri, "async function upgrade() { await sleep(100); }", 1);
    const diagnostics = (await bad).diagnostics;
    assert.equal(diagnostics.find(item => item.code === "tiangz.timer.time-wait-forbidden").severity, 1);
    const actionParams = { textDocument: { uri }, range: diagnostics[0].range, context: { diagnostics } };
    const actions = await rpc.request("textDocument/codeAction", actionParams);
    assert.deepEqual(actions.map(action => action.command.command), [
      "tiangzDeveloperTools.openTimerPattern", "tiangzDeveloperTools.previewTimerSkeleton",
    ]);
    assert.ok(actions.every(action => !action.edit && !action.isPreferred && !action.command.arguments));
    assert.deepEqual(await rpc.request("textDocument/codeAction", { ...actionParams, context: { diagnostics, only: ["source.fixAll"] } }), []);
    assert.deepEqual(await rpc.request("textDocument/codeAction", { ...actionParams, context: { diagnostics: [{ ...diagnostics[0], code: "unrelated" }] } }), []);
    const fixed = rpc.waitForNotification("textDocument/publishDiagnostics", params => params.uri === uri && params.diagnostics.length === 0);
    rpc.notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'class Upgrade { Start() { this.NewOnceTimer(100, "Complete"); } }' }] });
    await fixed;
    assert.deepEqual(await rpc.request("textDocument/codeAction", { ...actionParams, context: { diagnostics: [] } }), []);
    await rpc.request("shutdown", null);
    rpc.notify("exit", null);
    await rpc.waitForExit();
  } finally { rpc.dispose(); }
});

test("language server applies the same lexical timer rule to module edits", async () => {
  const rpc = new StdioRpc(serverPath);
  try {
    const rootUri = process.platform === "win32" ? "file:///C:/timer-scope-game" : "file:///timer-scope-game";
    await rpc.request("initialize", { processId: null, rootUri, capabilities: {}, workspaceFolders: [{ uri: rootUri, name: "timer-scope-game" }] });
    rpc.notify("initialized", {});
    open(rpc, `${rootUri}/tiangz.project.json`, "{}", 1);
    const uri = `${rootUri}/modules/game/src/hotfix/Upgrade.ts`;
    const source = "import { setTimeout as pause } from 'node:timers/promises';\n"
      + "async function valid(pause: () => Promise<void>) { await pause(); }\n"
      + "async function invalid() { await pause(10); }\n";
    const bad = rpc.waitForNotification("textDocument/publishDiagnostics", params => params.uri === uri && params.diagnostics.length > 0);
    open(rpc, uri, source, 1);
    const diagnostics = (await bad).diagnostics;
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, "tiangz.timer.time-wait-forbidden");
    assert.equal(diagnostics[0].severity, 1);
    assert.equal(diagnostics[0].range.start.line, 2);
    const fixed = rpc.waitForNotification("textDocument/publishDiagnostics", params => params.uri === uri && params.diagnostics.length === 0);
    rpc.notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: source.split("\n").slice(0, 2).join("\n") }] });
    await fixed;
    await rpc.request("shutdown", null);
    rpc.notify("exit", null);
    await rpc.waitForExit();
  } finally { rpc.dispose(); }
});

class StdioRpc {
  #child;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map();
  #notificationWaiters = [];
  #stderr = "";

  constructor(server) {
    this.#child = spawn(process.execPath, [server, "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    this.#child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.#child.stderr.on("data", (chunk) => { this.#stderr += chunk.toString(); });
  }

  request(method, params) {
    const id = this.#nextId++;
    const result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}. stderr=${this.#stderr}`));
      }, 5_000);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
    });
    this.#send({ jsonrpc: "2.0", id, method, params });
    return result;
  }

  notify(method, params) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  waitForNotification(method, predicate) {
    return new Promise((resolve, reject) => {
      const entry = {
        method,
        predicate,
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
      };
      const timeout = setTimeout(() => {
        this.#notificationWaiters = this.#notificationWaiters.filter((waiter) => waiter !== entry);
        reject(new Error(`Timed out waiting for ${method}. stderr=${this.#stderr}`));
      }, 5_000);
      this.#notificationWaiters.push(entry);
    });
  }

  waitForExit() {
    if (this.#child.exitCode !== null) return Promise.resolve(this.#child.exitCode);
    return new Promise((resolve) => this.#child.once("exit", resolve));
  }

  dispose() {
    if (this.#child.exitCode === null) this.#child.kill();
  }

  #send(message) {
    const json = JSON.stringify(message);
    this.#child.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  }

  #consume(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const length = Number(/Content-Length:\s*(\d+)/i.exec(this.#buffer.subarray(0, headerEnd).toString())?.[1]);
      const messageEnd = headerEnd + 4 + length;
      if (!Number.isFinite(length) || this.#buffer.length < messageEnd) return;
      const message = JSON.parse(this.#buffer.subarray(headerEnd + 4, messageEnd).toString());
      this.#buffer = this.#buffer.subarray(messageEnd);
      this.#dispatch(message);
    }
  }

  #dispatch(message) {
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    const waiter = this.#notificationWaiters.find(
      (candidate) => candidate.method === message.method && candidate.predicate(message.params),
    );
    if (!waiter) return;
    this.#notificationWaiters = this.#notificationWaiters.filter((candidate) => candidate !== waiter);
    waiter.resolve(message.params);
  }
}
