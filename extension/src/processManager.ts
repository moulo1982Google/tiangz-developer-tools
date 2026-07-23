import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

import * as vscode from "vscode";

import type { ProcessConfigModel, ProcessDebugConfigModel } from "../../packages/project-core/src/types.js";

export type ProcessRunMode = "run" | "debug";
export type ManagedProcessState = "starting" | "running" | "stopping" | "stopped" | "failed";

export interface ProcessLaunchSpec {
  readonly folder: vscode.WorkspaceFolder;
  readonly process: ProcessConfigModel;
  readonly configUri: vscode.Uri;
  readonly cleanupConfigUri?: vscode.Uri;
  readonly mode: ProcessRunMode;
  readonly debug?: ProcessDebugConfigModel;
}

export interface ManagedProcessStatus {
  readonly key: string;
  readonly rootUri: string;
  readonly processName: string;
  readonly configRelativePath: string;
  readonly mode: ProcessRunMode;
  readonly state: ManagedProcessState;
  readonly pid?: number;
  readonly startedAt?: number;
  readonly exitCode?: number;
  readonly inspector?: string;
  readonly debug?: ProcessDebugConfigModel;
}

interface ActiveProcess {
  readonly terminal: RuntimePseudoterminal;
  execution?: vscode.TaskExecution;
}

export class TiangZProcessManager implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly statuses = new Map<string, ManagedProcessStatus>();
  private readonly active = new Map<string, ActiveProcess>();
  private readonly buildChildren = new Set<ChildProcessWithoutNullStreams>();
  private disposed = false;

  public readonly onDidChange = this.changed.event;

  public constructor(private readonly output: vscode.OutputChannel) {}

  public getStatuses(): ReadonlyMap<string, ManagedProcessStatus> {
    return this.statuses;
  }

  public getStatus(rootUri: string, relativePath: string): ManagedProcessStatus | undefined {
    return this.statuses.get(processKey(rootUri, relativePath));
  }

  public waitUntilRunning(rootUri: string, relativePath: string, timeoutMs = 30_000): Promise<ManagedProcessStatus> {
    const key = processKey(rootUri, relativePath);
    const current = this.statuses.get(key);
    if (current?.state === "running") return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        subscription.dispose();
        reject(new Error(`等待 ${relativePath} 启动超时`));
      }, timeoutMs);
      const subscription = this.onDidChange(() => {
        const status = this.statuses.get(key);
        if (!status) return;
        if (status.state === "running") {
          clearTimeout(timeout);
          subscription.dispose();
          resolve(status);
        } else if (status.state === "failed" || status.state === "stopped") {
          clearTimeout(timeout);
          subscription.dispose();
          reject(new Error(`${status.processName} 启动失败，exitCode=${status.exitCode ?? "未知"}`));
        }
      });
    });
  }

  public waitUntilStopped(rootUri: string, relativePath: string, timeoutMs = 10_000): Promise<void> {
    const key = processKey(rootUri, relativePath);
    const current = this.statuses.get(key);
    if (!current || current.state === "stopped" || current.state === "failed") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        subscription.dispose();
        reject(new Error(`等待 ${relativePath} 停止超时`));
      }, timeoutMs);
      const subscription = this.onDidChange(() => {
        const status = this.statuses.get(key);
        if (status && status.state !== "stopped" && status.state !== "failed") return;
        clearTimeout(timeout);
        subscription.dispose();
        resolve();
      });
    });
  }

  public async launch(spec: ProcessLaunchSpec): Promise<void> {
    await this.launchMany([spec]);
  }

  public async launchMany(specs: readonly ProcessLaunchSpec[]): Promise<void> {
    if (specs.length === 0) return;
    const launchable = specs.filter((spec) => !this.active.has(processKey(spec.folder.uri.toString(), spec.process.relativePath)));
    if (launchable.length !== specs.length) {
      const skipped = specs.length - launchable.length;
      void vscode.window.showWarningMessage(`${skipped} 个 TiangZ Process 已在运行，已跳过重复启动`);
    }
    if (launchable.length === 0) return;
    const folder = launchable[0]!.folder;
    if (launchable.some((spec) => spec.folder.uri.toString() !== folder.uri.toString())) {
      throw new Error("一次启动只能包含同一个工作区中的 Process");
    }
    const mode = launchable.some((spec) => spec.mode === "debug") ? "debug" : "run";
    const executable = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `TiangZ：准备${mode === "debug" ? "调试" : "运行"} ${launchable.length} 个 Process`,
      cancellable: false,
    }, () => this.build(folder, mode));
    for (const spec of launchable) await this.startTask(spec, executable);
  }

  public async stop(rootUri: string, relativePath: string): Promise<void> {
    const key = processKey(rootUri, relativePath);
    const entry = this.active.get(key);
    if (!entry) return;
    entry.terminal.stop();
    entry.execution?.terminate();
  }

  public async stopAll(): Promise<void> {
    for (const child of this.buildChildren) terminateProcessTree(child);
    await Promise.all([...this.active.keys()].map(async (key) => {
      const entry = this.active.get(key);
      if (!entry) return;
      entry.terminal.stop();
      entry.execution?.terminate();
    }));
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const child of this.buildChildren) terminateProcessTree(child);
    this.buildChildren.clear();
    for (const entry of this.active.values()) entry.terminal.stop();
    this.active.clear();
    this.changed.dispose();
    this.output.dispose();
  }

  private async startTask(spec: ProcessLaunchSpec, executable: string): Promise<void> {
    const rootUri = spec.folder.uri.toString();
    const key = processKey(rootUri, spec.process.relativePath);
    this.setStatus({
      key,
      rootUri,
      processName: spec.process.name,
      configRelativePath: spec.process.relativePath,
      mode: spec.mode,
      state: "starting",
      ...(spec.debug ? { inspector: inspectorLabel(spec.debug) } : {}),
      ...(spec.debug ? { debug: spec.debug } : {}),
    });
    const terminal = new RuntimePseudoterminal(executable, spec, {
      onSpawn: (pid) => {
        const previous = this.statuses.get(key);
        if (!previous) return;
        this.setStatus({ ...previous, state: "running", pid, startedAt: Date.now() });
      },
      onStopping: () => {
        const previous = this.statuses.get(key);
        if (previous && previous.state === "running") this.setStatus({ ...previous, state: "stopping" });
      },
      onExit: (exitCode, stopped) => {
        this.active.delete(key);
        const previous = this.statuses.get(key);
        if (previous) {
          this.setStatus({
            ...previous,
            state: stopped || exitCode === 0 ? "stopped" : "failed",
            exitCode,
          });
        }
        if (spec.cleanupConfigUri) void vscode.workspace.fs.delete(spec.cleanupConfigUri).then(undefined, () => undefined);
      },
    });
    const task = new vscode.Task(
      { type: "tiangz-process", process: spec.process.name, config: spec.process.relativePath, mode: spec.mode },
      spec.folder,
      `${spec.process.name} (${spec.mode === "debug" ? "调试" : "运行"})`,
      "TiangZ",
      new vscode.CustomExecution(async () => terminal),
      [],
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      clear: true,
      showReuseMessage: false,
    };
    const active: ActiveProcess = { terminal };
    this.active.set(key, active);
    try {
      active.execution = await vscode.tasks.executeTask(task);
    } catch (error) {
      this.active.delete(key);
      const previous = this.statuses.get(key);
      if (previous) this.setStatus({ ...previous, state: "failed", exitCode: -1 });
      throw error;
    }
  }

  private async build(folder: vscode.WorkspaceFolder, mode: ProcessRunMode): Promise<string> {
    const configuration = vscode.workspace.getConfiguration("tiangzDeveloperTools", folder.uri);
    const shouldBuildTypeScript = configuration.get<boolean>("buildTypeScriptOnLaunch", true);
    const buildCommand = configuration.get<string>(
      mode === "debug" ? "debugBuildCommand" : "runBuildCommand",
      mode === "debug" ? "npm run build:debug" : "npm run build",
    ).trim();
    this.output.show(true);
    this.output.appendLine(`[TiangZ] 工作目录：${folder.uri.fsPath}`);
    if (shouldBuildTypeScript && buildCommand) {
      this.output.appendLine(`[TiangZ] ${buildCommand}`);
      await runShellCommand(buildCommand, folder.uri.fsPath, this.output, (child) => this.trackBuildChild(child));
    }
    const cargoCommand = configuration.get<string>("cargoCommand", "cargo").trim() || "cargo";
    const configuredArgs = configuration.get<unknown>("cargoBuildArgs", ["build", "--bin", "TiangZ"]);
    const cargoArgs = Array.isArray(configuredArgs)
      ? configuredArgs.filter((value): value is string => typeof value === "string" && value.length > 0)
      : ["build", "--bin", "TiangZ"];
    this.output.appendLine(`[TiangZ] ${cargoCommand} ${cargoArgs.join(" ")}`);
    return buildTiangZExecutable(
      cargoCommand,
      cargoArgs,
      folder.uri.fsPath,
      this.output,
      (child) => this.trackBuildChild(child),
    );
  }

  private setStatus(status: ManagedProcessStatus): void {
    this.statuses.set(status.key, status);
    this.changed.fire();
  }

  private trackBuildChild(child: ChildProcessWithoutNullStreams): void {
    this.buildChildren.add(child);
    child.once("close", () => this.buildChildren.delete(child));
  }
}

interface RuntimeTerminalEvents {
  readonly onSpawn: (pid: number) => void;
  readonly onStopping: () => void;
  readonly onExit: (exitCode: number, stopped: boolean) => void;
}

class RuntimePseudoterminal implements vscode.Pseudoterminal {
  private readonly written = new vscode.EventEmitter<string>();
  private readonly closed = new vscode.EventEmitter<number>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private stopping = false;
  private finished = false;

  public readonly onDidWrite = this.written.event;
  public readonly onDidClose = this.closed.event;

  public constructor(
    private readonly executable: string,
    private readonly spec: ProcessLaunchSpec,
    private readonly events: RuntimeTerminalEvents,
  ) {}

  public open(): void {
    const root = this.spec.folder.uri.fsPath;
    const configPath = path.relative(root, this.spec.configUri.fsPath) || this.spec.configUri.fsPath;
    this.written.fire(`TiangZ Process: ${this.spec.process.name}\r\n`);
    this.written.fire(`Config: ${configPath}\r\n`);
    if (this.spec.debug) this.written.fire(`Inspector: ${inspectorLabel(this.spec.debug)}\r\n`);
    this.written.fire(`Executable: ${this.executable}\r\n\r\n`);
    try {
      this.child = spawn(this.executable, [configPath], {
        cwd: root,
        env: process.env,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      this.written.fire(`启动失败：${errorMessage(error)}\r\n`);
      this.finish(-1);
      return;
    }
    if (this.child.pid) this.events.onSpawn(this.child.pid);
    this.child.stdout.on("data", (chunk: Buffer) => this.writeChunk(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => this.writeChunk(chunk));
    this.child.on("error", (error) => {
      this.written.fire(`Process 错误：${error.message}\r\n`);
      this.finish(-1);
    });
    this.child.on("exit", (code) => this.finish(code ?? -1));
  }

  public close(): void {
    this.stop();
  }

  public stop(): void {
    if (this.finished || this.stopping) return;
    this.stopping = true;
    this.events.onStopping();
    const child = this.child;
    if (!child?.pid) {
      this.finish(0);
      return;
    }
    this.written.fire("\r\n[TiangZ] 正在停止 Process...\r\n");
    terminateProcessTree(child);
  }

  private writeChunk(chunk: Buffer): void {
    this.written.fire(chunk.toString("utf8").replace(/\r?\n/g, "\r\n"));
  }

  private finish(exitCode: number): void {
    if (this.finished) return;
    this.finished = true;
    this.events.onExit(exitCode, this.stopping);
    this.written.fire(`\r\n[TiangZ] Process 已退出，exitCode=${exitCode}\r\n`);
    this.closed.fire(exitCode);
    this.written.dispose();
    this.closed.dispose();
  }
}

export function processKey(rootUri: string, relativePath: string): string {
  return `${rootUri}|${relativePath.replaceAll("\\", "/")}`;
}

async function runShellCommand(
  command: string,
  cwd: string,
  output: vscode.OutputChannel,
  track: (child: ChildProcessWithoutNullStreams) => void,
): Promise<void> {
  const child = spawn(command, { cwd, env: process.env, shell: true, windowsHide: true });
  track(child);
  await runChild(child, output, false);
}

async function buildTiangZExecutable(
  cargoCommand: string,
  configuredArgs: readonly string[],
  cwd: string,
  output: vscode.OutputChannel,
  track: (child: ChildProcessWithoutNullStreams) => void,
): Promise<string> {
  const args = configuredArgs.some((value) => value.startsWith("--message-format"))
    ? [...configuredArgs]
    : [...configuredArgs, "--message-format=json-render-diagnostics"];
  const child = spawn(cargoCommand, args, {
    cwd,
    env: process.env,
    windowsHide: true,
  });
  track(child);
  let executable: string | undefined;
  let pending = "";
  child.stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    while (true) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as CargoMessage;
        if (message.reason === "compiler-message" && message.message?.rendered) output.append(message.message.rendered);
        if (message.reason === "compiler-artifact" && typeof message.executable === "string"
          && message.target?.kind?.includes("bin")) executable = message.executable;
      } catch {
        output.appendLine(line);
      }
    }
  });
  await runChild(child, output, true);
  const fallback = path.join(cwd, "target", "debug", process.platform === "win32" ? "TiangZ.exe" : "TiangZ");
  const resolved = executable ?? fallback;
  await access(resolved);
  output.appendLine(`[TiangZ] executable：${resolved}`);
  return resolved;
}

interface CargoMessage {
  readonly reason?: string;
  readonly executable?: string | null;
  readonly target?: { readonly kind?: readonly string[] };
  readonly message?: { readonly rendered?: string };
}

async function runChild(
  child: ChildProcessWithoutNullStreams,
  output: vscode.OutputChannel,
  stdoutHandled: boolean,
): Promise<void> {
  if (!stdoutHandled) child.stdout.on("data", (chunk: Buffer) => output.append(chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => output.append(chunk.toString("utf8")));
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value) => resolve(value ?? -1));
  });
  if (code !== 0) throw new Error(`命令执行失败，exitCode=${code}`);
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    killer.once("error", () => child.kill());
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function inspectorLabel(debug: ProcessDebugConfigModel): string {
  return `${debug.inspectorIp}:${debug.inspectorPort}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
