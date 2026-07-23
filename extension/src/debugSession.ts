import net from "node:net";
import path from "node:path";

import * as vscode from "vscode";

import { createDebugConfig } from "../../packages/project-core/src/launch.js";
import type { ProcessConfigModel, ProcessDebugConfigModel } from "../../packages/project-core/src/types.js";
import type { ProcessLaunchSpec } from "./processManager.js";

export async function prepareDebugLaunch(
  folder: vscode.WorkspaceFolder,
  process: ProcessConfigModel,
  storageUri: vscode.Uri,
): Promise<ProcessLaunchSpec> {
  const configUri = vscode.Uri.joinPath(folder.uri, ...process.relativePath.split("/"));
  if (process.debug) {
    await assertInspectorPortAvailable(process.debug);
    return { folder, process, configUri, mode: "debug", debug: process.debug };
  }
  const configuration = vscode.workspace.getConfiguration("tiangzDeveloperTools", folder.uri);
  const basePort = configuration.get<number>("debugPortBase", 9230);
  const inspectorPort = await findAvailablePort(basePort, 100);
  const original = new TextDecoder().decode(await vscode.workspace.fs.readFile(configUri));
  const generated = createDebugConfig(original, {
    inspectorIp: "127.0.0.1",
    inspectorPort,
    breakOnStart: true,
    allowRemote: false,
  });
  const tempDirectory = vscode.Uri.joinPath(storageUri, "run", folder.name, process.environment);
  await vscode.workspace.fs.createDirectory(tempDirectory);
  const stem = path.posix.basename(process.relativePath, ".json");
  const temporaryUri = vscode.Uri.joinPath(tempDirectory, `${stem}.${inspectorPort}.debug.json`);
  await vscode.workspace.fs.writeFile(temporaryUri, new TextEncoder().encode(generated.text));
  return {
    folder,
    process,
    configUri: temporaryUri,
    cleanupConfigUri: temporaryUri,
    mode: "debug",
    debug: generated.debug,
  };
}

export async function attachDebugger(
  folder: vscode.WorkspaceFolder,
  process: ProcessConfigModel,
  debug: ProcessDebugConfigModel,
  processKey: string,
): Promise<boolean> {
  const configuration = vscode.workspace.getConfiguration("tiangzDeveloperTools", folder.uri);
  const timeoutMs = configuration.get<number>("inspectorConnectTimeoutMs", 15_000);
  const address = inspectorConnectAddress(debug.inspectorIp);
  await waitForInspector(address, debug.inspectorPort, timeoutMs);
  const workspacePath = folder.uri.fsPath;
  return vscode.debug.startDebugging(folder, {
    type: "node",
    request: "attach",
    name: `TiangZ：${process.name}`,
    address,
    port: debug.inspectorPort,
    cwd: workspacePath,
    sourceMaps: true,
    outFiles: [path.join(workspacePath, "dist", "**", "*.js")],
    __tiangzProcessKey: processKey,
  });
}

export async function waitForInspector(address: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "Inspector 尚未响应";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${formatHttpHost(address)}:${port}/json/list`, {
        signal: AbortSignal.timeout(750),
      });
      if (response.ok) {
        const targets: unknown = await response.json();
        if (Array.isArray(targets) && targets.length > 0) return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = errorMessage(error);
    }
    await delay(100);
  }
  throw new Error(`等待 Inspector ${address}:${port} 超时：${lastError}`);
}

async function assertInspectorPortAvailable(debug: ProcessDebugConfigModel): Promise<void> {
  const address = inspectorBindAddress(debug.inspectorIp);
  if (!await canListen(address, debug.inspectorPort)) {
    throw new Error(`Inspector 端口 ${debug.inspectorIp}:${debug.inspectorPort} 已被占用`);
  }
}

async function findAvailablePort(start: number, attempts: number): Promise<number> {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = start + offset;
    if (port > 65_535) break;
    if (await canListen("127.0.0.1", port)) return port;
  }
  throw new Error(`从 ${start} 开始的 ${attempts} 个 Inspector 端口均不可用`);
}

function canListen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

function inspectorBindAddress(value: string): string {
  return value === "localhost" ? "127.0.0.1" : value;
}

function inspectorConnectAddress(value: string): string {
  if (value === "0.0.0.0" || value === "::") return "127.0.0.1";
  return value;
}

function formatHttpHost(value: string): string {
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
