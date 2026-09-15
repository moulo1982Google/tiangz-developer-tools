import * as vscode from "vscode";

/** Main-project actions must not silently reinterpret an independent module workspace. */
export async function requireMainProject(folder: vscode.WorkspaceFolder): Promise<void> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, "tiangz.project.json"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "FileNotFound") return;
    throw error;
  }
  throw new Error("当前是独立模块工程；请使用“模块工程操作”“启动模块开发模式”或“新建模块 Component”，不执行主工程命令。");
}
