import * as vscode from "vscode";

import type { CodegenGeneratorModel } from "../../packages/project-core/src/types.js";

export class CodegenTaskManager implements vscode.Disposable {
  private readonly running = new Set<string>();
  private disposed = false;

  async run(folder: vscode.WorkspaceFolder, generator: CodegenGeneratorModel): Promise<number> {
    if (this.disposed) throw new Error("代码生成任务管理器已经释放");
    const key = taskKey(folder, generator.id);
    if (this.running.has(key)) throw new Error(`${generatorLabel(generator.id)} 正在运行，请等待当前任务结束`);
    this.running.add(key);

    const task = new vscode.Task(
      { type: "tiangz-codegen", generator: generator.id },
      folder,
      `生成 ${generatorLabel(generator.id)}`,
      "TiangZ Codegen",
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

    try {
      const execution = await vscode.tasks.executeTask(task);
      return await waitForExit(execution);
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
    default: return id;
  }
}

function waitForExit(execution: vscode.TaskExecution): Promise<number> {
  return new Promise((resolve) => {
    const subscription = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution !== execution) return;
      subscription.dispose();
      resolve(event.exitCode ?? -1);
    });
  });
}

function taskKey(folder: vscode.WorkspaceFolder, generatorId: string): string {
  return `${folder.uri.toString()}::${generatorId}`;
}
