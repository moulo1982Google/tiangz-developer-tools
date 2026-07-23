import * as vscode from "vscode";

import { indexWorkspaceFolder, type IndexedProject } from "./projectIndex.js";
import { ProjectTreeProvider, type ProjectNode } from "./projectTree.js";

const DIAGNOSTIC_OWNER = "tiangz-project";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const tree = new ProjectTreeProvider();
  const diagnostics = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_OWNER);
  const view = vscode.window.createTreeView("tiangzProject", { treeDataProvider: tree, showCollapseAll: true });
  let projects: readonly IndexedProject[] = [];
  let refreshTimer: NodeJS.Timeout | undefined;

  const refresh = async (): Promise<void> => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    projects = await Promise.all(folders.map(indexWorkspaceFolder));
    tree.setProjects(projects);
    publishDiagnostics(projects, diagnostics);
  };
  const scheduleRefresh = (): void => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refresh().catch(showError), 150);
  };

  const watchers = [
    vscode.workspace.createFileSystemWatcher("**/configs/**/*.json"),
    vscode.workspace.createFileSystemWatcher("**/app/**/*.ts"),
  ];
  for (const watcher of watchers) {
    watcher.onDidCreate(scheduleRefresh, undefined, context.subscriptions);
    watcher.onDidChange(scheduleRefresh, undefined, context.subscriptions);
    watcher.onDidDelete(scheduleRefresh, undefined, context.subscriptions);
  }
  context.subscriptions.push(
    view,
    diagnostics,
    ...watchers,
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleRefresh),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("tiangzDeveloperTools")) scheduleRefresh();
    }),
    vscode.commands.registerCommand("tiangzDeveloperTools.refreshProject", () => refresh().catch(showError)),
    vscode.commands.registerCommand("tiangzDeveloperTools.openLocation", (node: ProjectNode) => openLocation(node, projects)),
    vscode.commands.registerCommand("tiangzDeveloperTools.showProjectSummary", () => showSummary(projects)),
    { dispose: () => { if (refreshTimer) clearTimeout(refreshTimer); } },
  );
  await refresh();
}

export function deactivate(): void {}

async function openLocation(node: ProjectNode, projects: readonly IndexedProject[]): Promise<void> {
  if (!node.location) return;
  const project = projects.find((candidate) => node.location?.relativePath.startsWith("configs/")
    ? candidate.snapshot.processes.some((process) => process.relativePath === node.location?.relativePath)
      || candidate.snapshot.machines.some((machine) => machine.relativePath === node.location?.relativePath)
    : candidate.snapshot.declarations.some((declaration) => declaration.location.relativePath === node.location?.relativePath)
      || candidate.snapshot.handlers.some((handler) => handler.location.relativePath === node.location?.relativePath))
    ?? projects[0];
  if (!project) return;
  const uri = vscode.Uri.joinPath(project.folder.uri, ...node.location.relativePath.split("/"));
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);
  const position = new vscode.Position(node.location.line, node.location.character);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function publishDiagnostics(
  projects: readonly IndexedProject[],
  collection: vscode.DiagnosticCollection,
): void {
  collection.clear();
  for (const project of projects) {
    const grouped = new Map<string, vscode.Diagnostic[]>();
    for (const diagnostic of project.snapshot.diagnostics) {
      const values = grouped.get(diagnostic.location.relativePath) ?? [];
      const position = new vscode.Position(diagnostic.location.line, diagnostic.location.character);
      const value = new vscode.Diagnostic(
        new vscode.Range(position, position),
        diagnostic.message,
        diagnostic.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
      );
      value.code = diagnostic.code;
      value.source = "TiangZ";
      values.push(value);
      grouped.set(diagnostic.location.relativePath, values);
    }
    for (const [relativePath, values] of grouped) {
      collection.set(vscode.Uri.joinPath(project.folder.uri, ...relativePath.split("/")), values);
    }
  }
}

function showSummary(projects: readonly IndexedProject[]): void {
  const totals = projects.reduce((sum, project) => ({
    processes: sum.processes + project.snapshot.processes.length,
    scenes: sum.scenes + project.snapshot.declarations.filter((value) => value.kind === "entryScene" || value.kind === "scene").length,
    components: sum.components + project.snapshot.declarations.filter((value) => value.kind === "component").length,
    handlers: sum.handlers + project.snapshot.handlers.length,
    diagnostics: sum.diagnostics + project.snapshot.diagnostics.length,
  }), { processes: 0, scenes: 0, components: 0, handlers: 0, diagnostics: 0 });
  void vscode.window.showInformationMessage(
    `TiangZ：${totals.processes} Process，${totals.scenes} Scene，${totals.components} Component，`
      + `${totals.handlers} Handler，${totals.diagnostics} 个工程问题`,
  );
}

function showError(error: unknown): void {
  void vscode.window.showErrorMessage(`TiangZ 工程索引失败：${error instanceof Error ? error.message : String(error)}`);
}
