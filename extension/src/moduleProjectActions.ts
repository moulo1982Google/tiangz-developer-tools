import path from "node:path";
import { execFile } from "node:child_process";
import * as vscode from "vscode";
import type { DevSourceManager } from "./devSourceManager.js";

const actions = [
  { label: "检查基础环境", action: "doctor", description: "只读：宿主路径、依赖和二进制版本" },
  { label: "准备编辑器与生成物", action: "setup", description: "同步路径并生成代码，不更新协议锁" },
  { label: "检查模块", action: "check", description: "核对生成物与类型，不自动修复" },
  { label: "构建 TS 模块", action: "build", description: "生成 Model/Hotfix 与配置，不运行 Cargo" },
  { label: "编译宿主", action: "host-build", description: "首次或 Rust/宿主变化时执行，可能耗时较长" },
] as const;

/** Reuse the existing task owner; the host remains responsible for build, watch, reload and locking. */
export async function startModuleDevelopment(manager: DevSourceManager): Promise<void> {
  trusted();
  const folder = await selectFolder("选择要启动开发模式的独立模块工程");
  if (!folder) return;
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, "tiangz.project.json"));
  const project: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!project || typeof project !== "object" || !("engineRoot" in project) || typeof project.engineRoot !== "string" || !project.engineRoot.trim()) throw new Error("tiangz.project.json 缺少 engineRoot；不会回退到主工程开发模式。");
  const engine = path.resolve(folder.uri.fsPath, project.engineRoot);
  await vscode.workspace.fs.stat(vscode.Uri.file(path.join(engine, "tools/dev_runtime.mjs")));
  await manager.start({ folder, configRelativePath: "tiangz.project.json", machineName: folder.name, moduleEngineRoot: engine });
}

/** Ask the host for a concrete preview; do not copy source templates or AST rewriting into the extension. */
export async function createModuleComponent(): Promise<void> {
  trusted();
  const folder = await selectFolder("选择要新增组件的独立模块工程");
  if (!folder) return;
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, "tiangz.project.json"));
  const project: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!project || typeof project !== "object" || !("engineRoot" in project) || typeof project.engineRoot !== "string" || !project.engineRoot.trim()) throw new Error("tiangz.project.json 缺少 engineRoot；不会回退到主工程组件生成器。");
  const engine = path.resolve(folder.uri.fsPath, project.engineRoot);
  const script = path.join(engine, "tools/create_module_component.mjs");
  await vscode.workspace.fs.stat(vscode.Uri.file(script));
  const catalog = await hostJson(engine, "game_project.mjs", ["inspect", "--project", folder.uri.fsPath, "--json"]);
  if (!catalog || catalog.formatVersion !== 1 || !Array.isArray(catalog.modules)) throw new Error("宿主返回了不支持的模块列表格式");
  const options: { label: string }[] = catalog.modules.map((module: { id?: unknown }) => {
    if (typeof module.id !== "string") throw new Error("宿主模块 ID 格式无效");
    return { label: module.id };
  });
  const module = await vscode.window.showQuickPick(options, { title: "选择组件所属模块", ignoreFocusOut: true });
  if (!module) return;
  const name = await vscode.window.showInputBox({ title: "组件名称", prompt: "例如 Inventory；宿主生成 InventoryComponent 和对应 System", ignoreFocusOut: true });
  if (name === undefined) return;
  const feature = await vscode.window.showInputBox({ title: "功能目录", prompt: "例如 inventory；Model/Hotfix 使用相同功能目录", ignoreFocusOut: true });
  if (feature === undefined) return;
  const args = ["--project", folder.uri.fsPath, "--module", module.label, "--name", name.trim(), "--feature", feature.trim()];
  const preview = await hostJson(engine, "create_module_component.mjs", [...args, "--dry-run", "--json"]);
  if (!preview || preview.formatVersion !== 1 || preview.dryRun !== true || !Array.isArray(preview.changes) || !preview.changes.length) throw new Error("宿主没有返回有效的只读生成预览");
  if (typeof preview.planHash !== "string" || !/^[a-f0-9]{64}$/.test(preview.planHash)) throw new Error("宿主没有返回可校验的生成计划指纹");
  const sections = preview.changes.map((change: { file?: unknown; content?: unknown; operation?: unknown }) => {
    if (typeof change.file !== "string" || typeof change.content !== "string" || !["create", "update"].includes(String(change.operation))) throw new Error("宿主生成预览内容不完整");
    return `--- ${change.operation}: ${change.file} ---\n${change.content}`;
  });
  const document = await vscode.workspace.openTextDocument({ language: "plaintext", content: `TiangZ 模块组件预览（尚未写入）\n未自动装配到 Scene/Entity，也未启动服务。\n\n${sections.join("\n\n")}` });
  await vscode.window.showTextDocument(document, { preview: true });
  const confirmed = await vscode.window.showInformationMessage("确认按宿主规则创建模块组件并更新 Model/Hotfix 入口？已有文件不会覆盖；动态入口需手工修改。请先停止本工程开发模式。", { modal: true }, "创建组件");
  if (confirmed !== "创建组件") return;
  await launchTask(folder, "创建模块组件", script, [...args, "--expect-plan", preview.planHash], engine);
}

function hostJson(engine: string, script: string, args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    execFile("node", [path.join(engine, "tools", script), ...args], { cwd: engine, windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      let value;
      try { value = JSON.parse(stdout); } catch { reject(new Error(stderr.trim() || error?.message || "宿主没有输出有效 JSON")); return; }
      if (error || value?.error) reject(new Error(value?.error?.message || stderr.trim() || error?.message || "宿主工具失败"));
      else if (value && typeof value === "object" && !Array.isArray(value)) resolve(value);
      else reject(new Error("宿主 JSON 结果不是对象"));
    });
  });
}

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
  const operation = path.basename(script) === "create_game_project.mjs" ? "create" : path.basename(script) === "create_module_component.mjs" ? "new-component" : args[0];
  const task = new vscode.Task({ type: "tiangz-module-project", operation }, folder, label, "TiangZ", new vscode.ProcessExecution("node", [script, ...args], { cwd }), ["$tsc", "$tiangz-module"]);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true, showReuseMessage: false };
  await vscode.tasks.executeTask(task);
}
function trusted(): void { if (!vscode.workspace.isTrusted) throw new Error("请先信任工作区，才能调用 TiangZ 开发工具。"); }
async function selectFolder(placeHolder: string): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) throw new Error("请先打开 TiangZ 或独立模块工程目录。");
  return folders.length === 1 ? folders[0] : vscode.window.showWorkspaceFolderPick({ placeHolder });
}
