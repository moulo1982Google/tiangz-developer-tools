import path from "node:path";
import { execFile } from "node:child_process";
import * as vscode from "vscode";
import { parseModuleNavigation, type ModuleLocation, type ModuleNavigationEntry, type ModuleNavigationReport, type ModuleSymbol } from "../../packages/project-core/src/moduleNavigation.js";

interface NavigationNode {
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly icon: string;
  readonly uri?: vscode.Uri;
  readonly line?: number;
  readonly column?: number;
  readonly children?: readonly NavigationNode[];
}

/** User-triggered module navigation delegates all analysis to the selected TiangZ host. */
export class ModuleExplorer implements vscode.TreeDataProvider<NavigationNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<NavigationNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private nodes: readonly NavigationNode[] = [];
  private readonly output = vscode.window.createOutputChannel("TiangZ 模块导航");
  private refreshing = false;

  getTreeItem(node: NavigationNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.children?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(node.icon);
    if (node.description !== undefined) item.description = node.description;
    item.tooltip = node.tooltip ?? node.label;
    if (node.uri) item.command = { command: "tiangzDeveloperTools.openModuleLocation", title: "打开模块源码", arguments: [node] };
    return item;
  }
  getChildren(node?: NavigationNode): NavigationNode[] { return [...(node ? node.children ?? [] : this.nodes)]; }

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      if (!vscode.workspace.isTrusted) throw new Error("请先信任工作区；模块导航会调用所选 TiangZ 宿主的只读工具。");
      const folders = vscode.workspace.workspaceFolders ?? [];
      const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: "选择模块所在的游戏工程" });
      if (!folder) return;
      const config = vscode.workspace.getConfiguration("tiangzDeveloperTools", folder.uri);
      let engineRoot = path.resolve(folder.uri.fsPath, config.get<string>("engineRoot", "."));
      let invocation = ["--modules-dir", path.resolve(folder.uri.fsPath, config.get<string>("modulesDirectory", "modules")), "--json"];
      let scriptName = "inspect_game_modules.mjs";
      let projectBytes: Uint8Array | undefined;
      try { projectBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, "tiangz.project.json")); }
      catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "FileNotFound")) throw error; }
      if (projectBytes) {
        const project: unknown = JSON.parse(new TextDecoder().decode(projectBytes));
        if (!project || typeof project !== "object" || !("engineRoot" in project) || typeof project.engineRoot !== "string" || !project.engineRoot.trim()) throw new Error("tiangz.project.json 缺少 engineRoot；请修复工程声明，不回退其他宿主。");
        engineRoot = path.resolve(folder.uri.fsPath, project.engineRoot);
        invocation = ["inspect", "--project", folder.uri.fsPath, "--json"];
        scriptName = "game_project.mjs";
      }
      const script = path.join(engineRoot, "tools", scriptName);
      try { await vscode.workspace.fs.stat(vscode.Uri.file(script)); }
      catch { throw new Error(`找不到模块导航工具：${script}\n请在此工作区设置 tiangzDeveloperTools.engineRoot 指向 TiangZ 主工程，并使用支持 modules:inspect 的宿主。`); }
      // Clear stale data immediately; a failed inspection must not leave a healthy-looking old tree.
      this.nodes = [{ label: "正在读取模块结构…", icon: "loading~spin" }];
      this.changed.fire(undefined);
      const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "TiangZ：读取模块结构", cancellable: true }, async (_, token) => {
        const text = await new Promise<string>((resolve, reject) => {
          const child = execFile("node", [script, ...invocation], { cwd: engineRoot, windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
            cancellation.dispose();
            if (token.isCancellationRequested) { reject(new Error("已取消模块导航。")); return; }
            if (error) {
              try { parseModuleNavigation(stdout); } catch (reportError) {
                if (stdout.trim().startsWith("{")) { reject(reportError); return; }
              }
              reject(new Error(`模块导航失败：${stderr.trim() || error.message}`));
            } else resolve(stdout);
          });
          const cancellation = token.onCancellationRequested(() => child.kill());
          if (token.isCancellationRequested) child.kill();
        });
        return parseModuleNavigation(text);
      });
      this.nodes = reportNodes(report, folder.name);
      this.output.clear();
      this.output.appendLine(`宿主：${engineRoot}\n模块目录：${report.modulesDirectory}\n${report.limitations.join("\n")}`);
      this.changed.fire(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.nodes = [{ label: "模块导航未完成", tooltip: message, icon: "error" }];
      this.changed.fire(undefined);
      this.output.appendLine(message);
      this.output.show(true);
      void vscode.window.showErrorMessage(message);
    } finally { this.refreshing = false; }
  }
  dispose(): void { this.changed.dispose(); this.output.dispose(); }
}

export async function openModuleLocation(node: NavigationNode): Promise<void> {
  if (!node.uri) return;
  const document = await vscode.workspace.openTextDocument(node.uri);
  const position = new vscode.Position(Math.max(0, (node.line ?? 1) - 1), Math.max(0, (node.column ?? 1) - 1));
  await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position) });
}

function reportNodes(report: ModuleNavigationReport, folder: string): NavigationNode[] {
  return [{ label: `${folder} · TiangZ ${report.engineVersion}`, description: `${report.modules.length} 模块`, icon: "project", children: [
    { label: "静态导航边界", tooltip: report.limitations.join("\n"), icon: "info" },
    ...report.modules.map(moduleNode),
    ...(report.modules.length ? [] : [{ label: "目录中没有模块；请核对 modulesDirectory 设置", icon: "info" }]),
  ] }];
}
function moduleNode(module: ModuleNavigationEntry): NavigationNode {
  const source = (label: string, file: string): NavigationNode => ({ label, description: file, icon: "file-code", uri: vscode.Uri.file(path.join(module.root, file)) });
  const symbol = (item: ModuleSymbol): NavigationNode => ({
    label: item.name, description: `${item.kind}${item.target ? ` → ${item.target}` : ""}${item.reachable ? "" : " · 未静态加载"}`,
    tooltip: `${item.location.file}:${item.location.line}${item.descriptor ? `\n协议绑定：${item.descriptor}` : ""}${item.targetResolution === "unresolved" ? "\n目标未静态定位，不按同名类型猜测。" : ""}`,
    icon: item.reachable ? "symbol-class" : "warning", ...at(module, item.location),
    ...(item.targetLocation ? { children: [{ label: "打开目标状态定义", icon: "go-to-file", ...at(module, item.targetLocation) }] } : {}),
  });
  return { label: module.id, description: module.version, tooltip: module.description, icon: "package", children: [
    source("模块声明与依赖", module.manifest),
    source("Model 入口 / 运行时导出", module.entries.model),
    source("Hotfix 入口 / 显式加载", module.entries.hotfix),
    ...(module.publicApi ? [source("跨模块公开 API", module.publicApi)] : [{ label: "未声明跨模块公开 API", icon: "lock" }]),
    { label: "直接依赖", icon: "references", children: module.dependencies.map(dep => ({ label: dep.id, icon: "package" })) },
    { label: "状态与身份", icon: "symbol-namespace", children: module.declarations.filter(item => !item.generated).map(item => ({ ...symbol(item), children: module.bindings.filter(binding => binding.targetLocation?.file === item.location.file && binding.targetLocation.line === item.location.line && binding.targetLocation.column === item.location.column).map(symbol) })) },
    { label: "行为与消息入口", icon: "symbol-method", children: module.bindings.filter(item => !item.generated).map(symbol) },
    { label: "导航提示", description: String(module.diagnostics.length), icon: "warning", children: module.diagnostics.map(item => ({ label: item.code, tooltip: item.message, icon: "warning", ...at(module, item.location) })) },
  ] };
}
function at(module: ModuleNavigationEntry, location: ModuleLocation): Pick<NavigationNode, "uri" | "line" | "column"> {
  return { uri: vscode.Uri.file(path.join(module.root, location.file)), line: location.line, column: location.column };
}
