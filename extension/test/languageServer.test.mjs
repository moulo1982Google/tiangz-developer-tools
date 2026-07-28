import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testRoot, "../dist/server.cjs");

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

function open(rpc, uri, text, version) {
  rpc.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "typescript", version, text },
  });
}

function textHash(text) {
  return createHash("sha256").update(text.replaceAll("\r\n", "\n"), "utf8").digest("hex");
}

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
