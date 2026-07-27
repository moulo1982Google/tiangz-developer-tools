import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import * as vscode from "vscode";

interface DevSourceLaunchSpec {
  readonly folder: vscode.WorkspaceFolder;
  readonly configRelativePath: string;
  readonly machineName: string;
}

/** 管理唯一的源码开发任务，并确保停止操作先进入Watcher优雅停机协议。 / Manages the single source-development task and ensures stop first enters the Watcher graceful-shutdown protocol. */
export class DevSourceManager implements vscode.Disposable {
  private active: DevSourceTerminal | undefined;

  public async start(spec: DevSourceLaunchSpec): Promise<void> {
    if (this.active) throw new Error("源码开发模式已经运行；请先停止现有任务");
    const terminal = new DevSourceTerminal(spec, () => {
      if (this.active === terminal) this.active = undefined;
    });
    this.active = terminal;
    const task = new vscode.Task(
      { type: "tiangz-dev-source", config: spec.configRelativePath },
      spec.folder,
      `源码开发模式 (${spec.machineName})`,
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
    try {
      await vscode.tasks.executeTask(task);
    } catch (error) {
      if (this.active === terminal) this.active = undefined;
      throw error;
    }
  }

  /** 请求当前开发宿主优雅停止；没有活动任务时保持幂等。 / Requests graceful shutdown of the active development host and remains idempotent when none is active. */
  public stop(): void {
    this.active?.stop();
  }

  public dispose(): void {
    this.active?.stop();
    this.active = undefined;
  }
}

class DevSourceTerminal implements vscode.Pseudoterminal {
  private readonly written = new vscode.EventEmitter<string>();
  private readonly closed = new vscode.EventEmitter<number>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private stopTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private finished = false;

  public readonly onDidWrite = this.written.event;
  public readonly onDidClose = this.closed.event;

  public constructor(
    private readonly spec: DevSourceLaunchSpec,
    private readonly onFinished: () => void,
  ) {}

  public open(): void {
    this.written.fire(`TiangZ 源码开发模式：${this.spec.machineName}\r\n`);
    this.written.fire(`Config: ${this.spec.configRelativePath}\r\n\r\n`);
    this.child = spawn("npm", ["run", "dev", "--", this.spec.configRelativePath], {
      cwd: this.spec.folder.uri.fsPath,
      env: process.env,
      shell: process.platform === "win32",
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.writeChunk(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => this.writeChunk(chunk));
    this.child.once("error", (error) => {
      this.written.fire(`启动源码开发模式失败：${error.message}\r\n`);
      this.finish(-1);
    });
    this.child.once("exit", (code) => this.finish(code ?? -1));
  }

  /** 将任务终端输入交给开发宿主，因此仍可手工执行Watcher的reload或shutdown命令。 / Forwards task-terminal input to the development host so manual Watcher reload or shutdown commands remain available. */
  public handleInput(data: string): void {
    if (!this.stopping && this.child?.stdin.writable) this.child.stdin.write(data);
  }

  public close(): void {
    this.stop();
  }

  /** 先写入shutdown并等待15秒，只有宿主失去响应时才终止进程树。 / Writes shutdown and waits 15 seconds before terminating the process tree only if the host stops responding. */
  public stop(): void {
    if (this.finished || this.stopping) return;
    this.stopping = true;
    this.written.fire("\r\n[TiangZ] 正在优雅停止源码开发模式...\r\n");
    const child = this.child;
    if (!child) {
      this.finish(0);
      return;
    }
    if (child.stdin.writable) child.stdin.write("shutdown\n");
    this.stopTimer = setTimeout(() => terminateProcessTree(child), 15_000);
  }

  private writeChunk(chunk: Buffer): void {
    this.written.fire(chunk.toString("utf8").replace(/\r?\n/g, "\r\n"));
  }

  private finish(exitCode: number): void {
    if (this.finished) return;
    this.finished = true;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.onFinished();
    this.written.fire(`\r\n[TiangZ] 源码开发模式已退出，exitCode=${exitCode}\r\n`);
    this.closed.fire(this.stopping && exitCode !== 0 ? 0 : exitCode);
    this.written.dispose();
    this.closed.dispose();
  }
}

/** 仅作为失去响应后的兜底终止整个子进程树。 / Terminates the entire child process tree only as an unresponsive-host fallback. */
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
