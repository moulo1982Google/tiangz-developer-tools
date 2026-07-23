import path from "node:path";

import * as vscode from "vscode";
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

import type { TiangZProjectSnapshot } from "../../packages/project-core/src/index.js";
import {
  discoverWorkspaceFolder,
  type DiscoveredProject,
  type IndexedProject,
} from "./projectIndex.js";
import { ProjectTreeProvider, type ProjectNode } from "./projectTree.js";

const INDEX_FILES_NOTIFICATION = "tiangzProject/indexFiles";
const SNAPSHOT_NOTIFICATION = "tiangzProject/snapshot";

interface LspLocation {
  readonly uri: string;
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
  };
}

interface ServerStats {
  readonly cachedFiles: number;
  readonly protocols: number;
  readonly handlers: number;
  readonly validationCount: number;
  readonly lastValidationMs: number;
  readonly maxValidationMs: number;
  readonly heapUsedBytes: number;
}

interface SnapshotNotification {
  readonly rootUri: string;
  readonly snapshot: TiangZProjectSnapshot;
}

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const tree = new ProjectTreeProvider();
  const view = vscode.window.createTreeView("tiangzProject", { treeDataProvider: tree, showCollapseAll: true });
  let projects: readonly IndexedProject[] = [];
  let discoveries: readonly DiscoveredProject[] = [];
  let refreshTimer: NodeJS.Timeout | undefined;

  const refresh = async (): Promise<void> => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    discoveries = await Promise.all(folders.map(discoverWorkspaceFolder));
    const activeRoots = new Set(discoveries.map((project) => project.folder.uri.toString()));
    projects = projects.filter((project) => activeRoots.has(project.folder.uri.toString()));
    tree.setProjects(projects);
    if (client) {
      await client.sendNotification(INDEX_FILES_NOTIFICATION, discoveries.map((project) => ({
        rootUri: project.folder.uri.toString(),
        uris: project.sourceUris.map((uri) => uri.toString()),
      })));
    }
  };
  const scheduleRefresh = (): void => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refresh().catch(showError), 150);
  };

  const watchers = [
    vscode.workspace.createFileSystemWatcher("**/configs/**/*.json"),
    vscode.workspace.createFileSystemWatcher("**/app/**/*.ts"),
  ];
  const serverModule = context.asAbsolutePath(path.join("dist", "server.cjs"));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ["--nolazy", "--inspect=6012"] },
    },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "typescript" }],
    synchronize: { fileEvents: watchers },
    outputChannelName: "TiangZ 工程语言服务器",
  };
  client = new LanguageClient(
    "tiangzProjectLanguageServer",
    "TiangZ 工程语言服务器",
    serverOptions,
    clientOptions,
  );
  const snapshotSubscription = client.onNotification(
    SNAPSHOT_NOTIFICATION,
    ({ rootUri, snapshot }: SnapshotNotification) => {
      const discovery = discoveries.find((project) => project.folder.uri.toString() === rootUri);
      if (!discovery) return;
      projects = [
        ...projects.filter((project) => project.folder.uri.toString() !== rootUri),
        { folder: discovery.folder, sourceUris: discovery.sourceUris, snapshot },
      ].sort((left, right) => left.folder.index - right.folder.index);
      tree.setProjects(projects);
    },
  );
  for (const watcher of watchers) {
    watcher.onDidCreate(scheduleRefresh, undefined, context.subscriptions);
    watcher.onDidChange(scheduleRefresh, undefined, context.subscriptions);
    watcher.onDidDelete(scheduleRefresh, undefined, context.subscriptions);
  }
  context.subscriptions.push(
    view,
    ...watchers,
    snapshotSubscription,
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleRefresh),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("tiangzDeveloperTools")) scheduleRefresh();
    }),
    vscode.commands.registerCommand("tiangzDeveloperTools.refreshProject", () => refresh().catch(showError)),
    vscode.commands.registerCommand("tiangzDeveloperTools.openLocation", (node: ProjectNode) => openLocation(node, projects)),
    vscode.commands.registerCommand("tiangzDeveloperTools.openUriLocation", openUriLocation),
    vscode.commands.registerCommand("tiangzDeveloperTools.showProjectSummary", () => showSummary(projects)),
    vscode.commands.registerCommand("tiangzDeveloperTools.showServerStats", showServerStats),
    {
      dispose: () => {
        if (refreshTimer) clearTimeout(refreshTimer);
        const activeClient = client;
        client = undefined;
        if (activeClient) void activeClient.stop();
      },
    },
  );
  await client.start();
  await refresh();
}

export async function deactivate(): Promise<void> {
  const activeClient = client;
  client = undefined;
  if (activeClient) await activeClient.stop();
}

async function openLocation(node: ProjectNode, projects: readonly IndexedProject[]): Promise<void> {
  if (!node.location) return;
  const project = projects.find((candidate) => node.location?.relativePath.startsWith("configs/")
    ? candidate.snapshot.processes.some((process) => process.relativePath === node.location?.relativePath)
      || candidate.snapshot.machines.some((machine) => machine.relativePath === node.location?.relativePath)
    : candidate.snapshot.declarations.some((declaration) => declaration.location.relativePath === node.location?.relativePath)
      || candidate.snapshot.handlers.some((handler) => handler.location.relativePath === node.location?.relativePath)
      || candidate.snapshot.protocols.some((protocol) => protocol.location.relativePath === node.location?.relativePath))
    ?? projects[0];
  if (!project) return;
  const uri = vscode.Uri.joinPath(project.folder.uri, ...node.location.relativePath.split("/"));
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);
  const position = new vscode.Position(node.location.line, node.location.character);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function openUriLocation(value: LspLocation | readonly LspLocation[]): Promise<void> {
  const locations = Array.isArray(value) ? value : [value];
  if (locations.length === 0) return;
  const location = locations.length === 1 ? locations[0] : (await vscode.window.showQuickPick(
    locations.map((candidate) => ({
      label: vscode.Uri.parse(candidate.uri).path.split("/").at(-1) ?? candidate.uri,
      description: `${vscode.workspace.asRelativePath(vscode.Uri.parse(candidate.uri), false)}:${candidate.range.start.line + 1}`,
      location: candidate,
    })),
    { placeHolder: "选择要打开的 Handler" },
  ))?.location;
  if (!location) return;
  const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(location.uri));
  const editor = await vscode.window.showTextDocument(document);
  const position = new vscode.Position(location.range.start.line, location.range.start.character);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function showSummary(projects: readonly IndexedProject[]): void {
  const totals = projects.reduce((sum, project) => ({
    processes: sum.processes + project.snapshot.processes.length,
    scenes: sum.scenes + project.snapshot.declarations.filter((value) => value.kind === "entryScene" || value.kind === "scene").length,
    components: sum.components + project.snapshot.declarations.filter((value) => value.kind === "component").length,
    handlers: sum.handlers + project.snapshot.handlers.length,
    protocols: sum.protocols + project.snapshot.protocols.length,
    diagnostics: sum.diagnostics + project.snapshot.diagnostics.length,
  }), { processes: 0, scenes: 0, components: 0, protocols: 0, handlers: 0, diagnostics: 0 });
  void vscode.window.showInformationMessage(
    `TiangZ：${totals.processes} Process，${totals.scenes} Scene，${totals.components} Component，`
      + `${totals.protocols} 个协议，${totals.handlers} Handler，${totals.diagnostics} 个工程问题`,
  );
}

async function showServerStats(): Promise<void> {
  if (!client) return;
  const stats = await client.sendRequest<ServerStats>("tiangzProject/serverStats");
  void vscode.window.showInformationMessage(
    `TiangZ 语言服务器：缓存 ${stats.cachedFiles} 个文件，${stats.protocols} 个协议，${stats.handlers} 个 Handler；`
      + `最近校验 ${stats.lastValidationMs.toFixed(2)} ms，最大 ${stats.maxValidationMs.toFixed(2)} ms，`
      + `累计 ${stats.validationCount} 次，堆内存 ${(stats.heapUsedBytes / 1024 / 1024).toFixed(1)} MB`,
  );
}

function showError(error: unknown): void {
  void vscode.window.showErrorMessage(`TiangZ 工程索引失败：${error instanceof Error ? error.message : String(error)}`);
}
