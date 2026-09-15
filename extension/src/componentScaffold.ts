import * as vscode from "vscode";
import { requireMainProject } from "./mainProjectGuard.js";

import { createComponentScaffold } from "../../packages/project-cli/src/scaffold.js";

import type { ProjectNode } from "./projectTree.js";

/**
 * 从 VS Code 工作区创建 Component 三件套。
 * Creates the Component scaffold from the active VS Code workspace.
 */
export async function createComponentFromWorkspace(
  target: ProjectNode | undefined,
  refresh: () => Promise<void>,
): Promise<void> {
  if (!vscode.workspace.isTrusted) throw new Error("请先信任当前工作区，才能生成 TiangZ 源码");
  const folder = await selectWorkspaceFolder(target);
  if (!folder) return;
  await requireMainProject(folder);

  const name = await vscode.window.showInputBox({
    title: "TiangZ：新建 Component",
    prompt: "输入 Component 名称，例如 Inventory 或 PlayerStats",
    placeHolder: "Inventory",
    ignoreFocusOut: true,
    validateInput: (value) => /^[A-Za-z][A-Za-z0-9]*$/.test(value.trim())
      ? undefined
      : "只能使用英文字母和数字，并且必须以字母开头",
  });
  if (name === undefined) return;

  const domain = await vscode.window.showInputBox({
    title: "TiangZ：选择业务领域",
    prompt: "输入领域目录，例如 mmorpg、card 或 slg",
    value: "mmorpg",
    ignoreFocusOut: true,
    validateInput: (value) => /^[A-Za-z][A-Za-z0-9]*$/.test(value.trim())
      ? undefined
      : "只能使用英文字母和数字，并且必须以字母开头",
  });
  if (domain === undefined) return;

  if (!vscode.workspace.isTrusted) throw new Error("工作区信任已撤销，不生成 TiangZ 源码");
  const result = await createComponentScaffold({
    projectRoot: folder.uri.fsPath,
    name,
    domain,
  });
  await refresh();
  const action = await vscode.window.showInformationMessage(
    `TiangZ：已创建 ${result.componentName}（${folder.name}）`,
    "打开 public.ts",
  );
  if (action === "打开 public.ts") {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, "app", "model", "public.ts"));
    await vscode.window.showTextDocument(document);
  }
}

async function selectWorkspaceFolder(target: ProjectNode | undefined): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (target?.rootUri) {
    const targetUri = vscode.Uri.parse(target.rootUri).toString();
    const targetFolder = folders.find((folder) => folder.uri.toString() === targetUri);
    if (targetFolder) return targetFolder;
  }
  if (folders.length === 0) throw new Error("没有打开 TiangZ 工作区");
  if (folders.length === 1) return folders[0];
  const picked = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
    { title: "选择要生成 Component 的 TiangZ 工程", ignoreFocusOut: true },
  );
  return picked?.folder;
}
