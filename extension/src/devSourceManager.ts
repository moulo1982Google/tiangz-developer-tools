import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

import * as vscode from "vscode";

interface DevSourceLaunchSpec {
  readonly folder: vscode.WorkspaceFolder;
  readonly configRelativePath: string;
  readonly machineName: string;
  readonly moduleEngineRoot?: string;
}

/** 管理唯一的源码开发任务，并确保停止操作先进入Watcher优雅停机协议。 / Manages the single source-development task and ensures stop first enters the Watcher graceful-shutdown protocol. */
export class DevSourceManager implements vscode.Disposable {
  private active: DevSourceTerminal | undefined;
  private disposed = false;

  public async start(spec: DevSourceLaunchSpec): Promise<void> {
    const acquireTerminal = () => {
      if (this.disposed) throw new Error("开发任务管理器已关闭，请重新加载插件");
      if (!vscode.workspace.isTrusted) throw new Error("请先信任工作区，才能启动开发模式");
      if (this.active) throw new Error("源码开发模式已经运行；请先停止现有任务");
      const created = new DevSourceTerminal(spec, () => {
        if (this.active === created) this.active = undefined;
      });
      this.active = created;
      return created;
    };
    let terminal = acquireTerminal();
    let invoked = false;
    const task = new vscode.Task(
      { type: "tiangz-dev-source", config: spec.configRelativePath },
      spec.folder,
      `源码开发模式 (${spec.machineName})`,
      "TiangZ",
      new vscode.CustomExecution(async () => {
        if (invoked) terminal = acquireTerminal();
        invoked = true;
        return terminal;
      }),
      ["$tsc", "$tiangz-module"],
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
      terminal.stop();
      throw error;
    }
  }

  /** 请求当前开发宿主优雅停止；没有活动任务时保持幂等。 / Requests graceful shutdown of the active development host and remains idempotent when none is active. */
  public stop(): void {
    this.active?.stop();
  }

  public dispose(): void {
    this.disposed = true;
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
  private input = "";
  private inputOverflow = false;
  private lastInputWasCR = false;

  public readonly onDidWrite = this.written.event;
  public readonly onDidClose = this.closed.event;

  public constructor(
    private readonly spec: DevSourceLaunchSpec,
    private readonly onFinished: () => void,
  ) {}

  public open(): void {
    if (this.finished) return;
    if (this.stopping) { this.finish(0); return; }
    if (!vscode.workspace.isTrusted) {
      this.written.fire("[TiangZ] 工作区信任已撤销，未启动开发进程。\r\n");
      this.finish(1);
      return;
    }
    this.written.fire(`TiangZ 源码开发模式：${this.spec.machineName}\r\n`);
    this.written.fire(`Config: ${this.spec.configRelativePath}\r\n\r\n`);
    const engine = this.spec.moduleEngineRoot;
    this.child = spawn(engine ? "node" : "npm", engine
      ? [path.join(engine, "tools/dev_runtime.mjs"), "--project", this.spec.folder.uri.fsPath]
      : ["run", "dev", "--", this.spec.configRelativePath], {
      cwd: engine ?? this.spec.folder.uri.fsPath,
      env: process.env,
      shell: !engine && process.platform === "win32",
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.writeChunk(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => this.writeChunk(chunk));
    this.child.stdin.on("error", (error) => {
      if (!this.finished && !this.stopping) this.written.fire(`[TiangZ] 控制通道已关闭：${error.message}\r\n`);
    });
    this.child.once("error", (error) => {
      this.written.fire(`启动源码开发模式失败：${error.message}\r\n`);
      this.finish(-1);
    });
    this.child.once("exit", (code) => this.finish(code ?? -1));
  }

  /** 回显并按完整行提交控制命令，停止操作不会拼接到未完成输入。 / Echo and submit complete command lines so shutdown cannot append to partial input. */
  public handleInput(data: string): void {
    if (this.stopping || !this.child?.stdin.writable) return;
    for (const character of data.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")) {
      if (character === "\u0003" || character === "\u0004") {
        this.input = "";
        this.written.fire(character === "\u0003" ? "^C\r\n" : "^D\r\n");
        this.stop(); return;
      }
      if (character === "\n" && this.lastInputWasCR) { this.lastInputWasCR = false; continue; }
      this.lastInputWasCR = character === "\r";
      if (character === "\r" || character === "\n") {
        const command = this.input;
        this.input = "";
        this.written.fire("\r\n");
        if (this.inputOverflow) { this.inputOverflow = false; continue; }
        if (command.trim() === "shutdown") { this.stop(); return; }
        if (command.trim()) this.child.stdin.write(`${command}\n`);
      } else if (character === "\u007f" || character === "\b") {
        if (this.input && !this.inputOverflow) {
          this.input = Array.from(this.input).slice(0, -1).join("");
          this.written.fire("\b \b");
        }
      } else if (character >= " " && !this.inputOverflow) {
        if (this.input.length >= 8192) {
          this.input = ""; this.inputOverflow = true;
          this.written.fire("\r\n[TiangZ] 命令超过 8192 字符，已丢弃本行；回车后重新输入。\r\n");
        } else { this.input += character; this.written.fire(character); }
      }
    }
  }

  public close(): void {
    this.stop();
  }

  /** 先写入shutdown并等待宿主清理，超时后才终止本任务进程树。 / Allows host cleanup before terminating this task's process tree on timeout. */
  public stop(): void {
    if (this.finished || this.stopping) return;
    this.stopping = true;
    this.written.fire("\r\n[TiangZ] 正在优雅停止源码开发模式...\r\n");
    const child = this.child;
    if (!child) {
      // 任务可能尚未注册终端事件；open 时再发退出事件，防止排队取消后悬挂。 / Terminal listeners may not exist yet; emit exit on open so queued cancellation cannot hang.
      this.onFinished();
      return;
    }
    if (child.stdin.writable) child.stdin.write("shutdown\n");
    this.stopTimer = setTimeout(() => {
      this.written.fire("[TiangZ] 优雅停机超时，正在终止本任务进程树。\r\n");
      terminateProcessTree(child);
    }, 25_000);
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
    this.closed.fire(exitCode);
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
