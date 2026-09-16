import * as vscode from "vscode";
import { requireMainProject } from "./mainProjectGuard.js";
import { projectTaskScope } from "./projectRoots.js";

import type { CodegenGeneratorModel } from "../../packages/project-core/src/types.js";

export class CodegenTaskManager implements vscode.Disposable {
  private readonly running = new Set<string>();
  private disposed = false;

  async run(folder: vscode.WorkspaceFolder, generator: CodegenGeneratorModel): Promise<number> {
    if (this.disposed) throw new Error("代码生成任务管理器已经释放");
    await requireMainProject(folder);
    if (this.disposed) throw new Error("代码生成任务管理器已经释放");
    if (!vscode.workspace.isTrusted) throw new Error("请先信任当前工作区，才能运行 TiangZ 主工程任务");
    const key = taskKey(folder, generator.id);
    if (this.running.has(key)) throw new Error(`${generatorLabel(generator.id)} 正在运行，请等待当前任务结束`);

    const task = new vscode.Task(
      { type: "tiangz-codegen", generator: generator.id },
      projectTaskScope(folder),
      generator.id === "runtime-foundation" ? generatorLabel(generator.id) : `生成 ${generatorLabel(generator.id)}`,
      generator.id === "runtime-foundation" ? "TiangZ Test" : "TiangZ Codegen",
      new vscode.ShellExecution(generator.command, { cwd: folder.uri.fsPath }),
      [],
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      clear: true,
      showReuseMessage: false,
      focus: false,
    };

    this.running.add(key);
    try {
      return await executeAndWaitForExit(task);
    } finally {
      this.running.delete(key);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.running.clear();
  }
}

export function generatorLabel(id: string): string {
  switch (id) {
    case "proto": return "Proto 协议";
    case "native-data": return "Native 数据";
    case "scenes": return "Scene 与服务端 Handler";
    case "client-handlers": return "客户端 Handler";
    case "runtime-foundation": return "Runtime Foundation 自测";
    case "verify-fast": return "快速工程检查";
    default: return id;
  }
}

async function executeAndWaitForExit(task: vscode.Task): Promise<number> {
  // 先监听后启动：极速结束及未创建 Process 的排队取消都必须释放调用者。 / Subscribe before launch, including queued cancellation.
  let execution: vscode.TaskExecution | undefined;
  const finished = new Map<vscode.TaskExecution, number>();
  let resolveExit!: (code: number) => void;
  const result = new Promise<number>((resolve) => { resolveExit = resolve; });
  const remember = (ended: vscode.TaskExecution, code: number): void => {
    if (execution && ended !== execution) return;
    if (!finished.has(ended)) finished.set(ended, code);
    if (ended === execution) resolveExit(finished.get(ended)!);
  };
  const processEnd = vscode.tasks.onDidEndTaskProcess((event) => remember(event.execution, event.exitCode ?? -1));
  const taskEnd = vscode.tasks.onDidEndTask((event) => remember(event.execution, -1));
  try {
    execution = await vscode.tasks.executeTask(task);
    const earlyCode = finished.get(execution);
    finished.clear();
    if (earlyCode !== undefined) resolveExit(earlyCode);
    return await result;
  } finally {
    processEnd.dispose();
    taskEnd.dispose();
    finished.clear();
  }
}

function taskKey(folder: vscode.WorkspaceFolder, generatorId: string): string {
  return `${folder.uri.toString()}::${generatorId}`;
}
