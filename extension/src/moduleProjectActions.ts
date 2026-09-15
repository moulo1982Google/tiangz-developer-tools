import path from "node:path";
import * as vscode from "vscode";

const actions = [
  { label: "检查基础环境", action: "doctor", description: "只读：宿主路径、依赖和二进制版本" },
  { label: "准备编辑器与生成物", action: "setup", description: "同步路径并生成代码，不更新协议锁" },
  { label: "检查模块", action: "check", description: "核对生成物与类型，不自动修复" },
  { label: "构建 TS 模块", action: "build", description: "生成 Model/Hotfix 与配置，不运行 Cargo" },
  { label: "编译宿主", action: "host-build", description: "首次或 Rust/宿主变化时执行，可能耗时较长" },
] as const;

/** UI chooses an action; the host owns its implementation and compatibility checks. */
export async function runModuleProjectAction(): Promise<void> {
  trusted();
  const folder = await selectFolder("选择包含 tiangz.project.json 的工程");
  if (!folder) return;
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, "tiangz.project.json"));
  const project: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!project || typeof project !== "object" || !("engineRoot" in project) || typeof project.engineRoot !== "string" || !project.engineRoot.trim()) throw new Error("tiangz.project.json 缺少 engineRoot；不会回退到主工程构建。");
  const engine = path.resolve(folder.uri.fsPath, project.engineRoot);
  const script = path.join(engine, "tools/game_project.mjs");
  await vscode.workspace.fs.stat(vscode.Uri.file(script));
  const action = await vscode.window.showQuickPick(actions, { title: "TiangZ：模块工程操作", ignoreFocusOut: true });
  if (!action) return;
  await launchTask(folder, action.label, script, [action.action, "--project", folder.uri.fsPath], engine);
}

/** Scaffold a new directory through the host; never implement a second module generator in the extension. */
export async function createModuleProject(): Promise<void> {
  trusted();
  const folder = await selectFolder("选择 TiangZ 宿主所在工作区（或配置了 engineRoot 的工作区）");
  if (!folder) return;
  const configuration = vscode.workspace.getConfiguration("tiangzDeveloperTools", folder.uri);
  let engine = path.resolve(folder.uri.fsPath, configuration.get<string>("engineRoot", "."));
  let projectBytes: Uint8Array | undefined;
  try { projectBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, "tiangz.project.json")); }
  catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "FileNotFound")) throw error; }
  if (projectBytes) {
    const project: unknown = JSON.parse(new TextDecoder().decode(projectBytes));
    if (!project || typeof project !== "object" || !("engineRoot" in project) || typeof project.engineRoot !== "string" || !project.engineRoot.trim()) throw new Error("tiangz.project.json 缺少 engineRoot；不会回退其他宿主。");
    engine = path.resolve(folder.uri.fsPath, project.engineRoot);
  }
  const script = path.join(engine, "tools/create_game_project.mjs");
  try { await vscode.workspace.fs.stat(vscode.Uri.file(script)); }
  catch { throw new Error("当前宿主没有 project:create；请设置 engineRoot 指向支持入门工程的 TiangZ 主工程。"); }
  const id = await vscode.window.showInputBox({ title: "新建 TiangZ 入门工程", prompt: "模块 ID，例如 org.example.game", value: "org.example.game", ignoreFocusOut: true,
    validateInput: value => value.trim() ? undefined : "请输入模块 ID；格式由宿主工具最终校验" });
  if (id === undefined) return;
  const target = await vscode.window.showInputBox({ title: "新工程目录", prompt: "输入尚不存在的目录；相对当前工作区解析，宿主拒绝覆盖已有目录", value: "../MyGame", ignoreFocusOut: true,
    validateInput: value => value.trim() ? undefined : "请输入新目录" });
  if (target === undefined) return;
  const destination = path.resolve(folder.uri.fsPath, target.trim());
  const confirmed = await vscode.window.showInformationMessage(`将创建计数器教学工程：${destination}。生成模块源码、初始协议锁和 TypeScript SDK，不启动游戏。`, { modal: true }, "创建");
  if (confirmed !== "创建") return;
  await launchTask(folder, "创建模块入门工程", script, ["--path", destination, "--id", id.trim()], engine);
}

async function launchTask(folder: vscode.WorkspaceFolder, label: string, script: string, args: string[], cwd: string): Promise<void> {
  const task = new vscode.Task({ type: "tiangz-module-project", operation: path.basename(script) === "create_game_project.mjs" ? "create" : args[0] }, folder, label, "TiangZ", new vscode.ProcessExecution("node", [script, ...args], { cwd }), ["$tsc", "$tiangz-module"]);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true, showReuseMessage: false };
  await vscode.tasks.executeTask(task);
}
function trusted(): void { if (!vscode.workspace.isTrusted) throw new Error("请先信任工作区，才能调用 TiangZ 开发工具。"); }
async function selectFolder(placeHolder: string): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) throw new Error("请先打开 TiangZ 或独立模块工程目录。");
  return folders.length === 1 ? folders[0] : vscode.window.showWorkspaceFolderPick({ placeHolder });
}
