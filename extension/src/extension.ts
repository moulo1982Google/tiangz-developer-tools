import path from "node:path";

import * as vscode from "vscode";
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

import { resolveMachineProcessPaths } from "../../packages/project-core/src/launch.js";
import type {
  CodegenGeneratorModel,
  ProcessConfigModel,
  TiangZProjectSnapshot,
} from "../../packages/project-core/src/types.js";
import { CodegenTaskManager, generatorLabel } from "./codegenTaskManager.js";
import { createComponentFromWorkspace } from "./componentScaffold.js";
import { attachDebugger, prepareDebugLaunch } from "./debugSession.js";
import { DevSourceManager } from "./devSourceManager.js";
import { registerDesignAssistant } from "./designAssistant.js";
import {
  discoverWorkspaceFolder,
  type DiscoveredProject,
  type IndexedProject,
} from "./projectIndex.js";
import { ProjectTreeProvider, type ProjectNode } from "./projectTree.js";
import { discoverProjectFolders } from "./projectRoots.js";
import { TiangZProcessManager } from "./processManager.js";
import { openRuntimeMetrics } from "./runtimeInspector.js";
import { ModuleExplorer, openModuleLocation } from "./moduleExplorer.js";
import { createModuleProject, runModuleProjectAction, startModuleDevelopment, createModuleComponent } from "./moduleProjectActions.js";

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
  const moduleExplorer = new ModuleExplorer();
  context.subscriptions.push(
    moduleExplorer,
    vscode.commands.registerCommand("tiangzDeveloperTools.openTimerPattern", () => runCommand(async () => {
      await vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.joinPath(context.extensionUri, "guides", "delayed-business.md"));
    })),
    vscode.commands.registerCommand("tiangzDeveloperTools.previewTimerSkeleton", () => runCommand(async () => {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, "guides", "delayed-owner.ts.txt"));
      const document = await vscode.workspace.openTextDocument({ language: "typescript", content: Buffer.from(bytes).toString("utf8") });
      await vscode.window.showTextDocument(document, { preview: false });
    })),
    vscode.window.createTreeView("tiangzModules", { treeDataProvider: moduleExplorer, showCollapseAll: true }),
    vscode.commands.registerCommand("tiangzDeveloperTools.inspectModules", () => moduleExplorer.refresh()),
    vscode.commands.registerCommand("tiangzDeveloperTools.openModuleLocation", openModuleLocation),
    vscode.commands.registerCommand("tiangzDeveloperTools.createModuleProject", () => runCommand(createModuleProject)),
    vscode.commands.registerCommand("tiangzDeveloperTools.createModuleComponent", () => runCommand(createModuleComponent)),
    vscode.commands.registerCommand("tiangzDeveloperTools.moduleProjectAction", () => runCommand(runModuleProjectAction)),
  );
  const tree = new ProjectTreeProvider();
  const processManager = new TiangZProcessManager(vscode.window.createOutputChannel("TiangZ 启动与构建"));
  const codegenTaskManager = new CodegenTaskManager();
  const devSourceManager = new DevSourceManager();
  context.subscriptions.push(vscode.commands.registerCommand("tiangzDeveloperTools.startModuleDevelopment", () => runCommand(() => startModuleDevelopment(devSourceManager))));
  const debugSessions = new Map<string, vscode.DebugSession>();
  const view = vscode.window.createTreeView("tiangzProject", { treeDataProvider: tree, showCollapseAll: true });
  let projects: readonly IndexedProject[] = [];
  let discoveries: readonly DiscoveredProject[] = [];
  let refreshTimer: NodeJS.Timeout | undefined;
  const debugConfigStorage = context.storageUri ?? context.globalStorageUri;
  const designAssistantSubscriptions = registerDesignAssistant(context);

  const refresh = async (): Promise<void> => {
    const folders = await discoverProjectFolders(vscode.workspace.workspaceFolders ?? []);
    discoveries = await Promise.all(folders.map(discoverWorkspaceFolder));
    const activeRoots = new Set(discoveries.map((project) => project.folder.uri.toString()));
    projects = projects.filter((project) => activeRoots.has(project.folder.uri.toString()));
    tree.setProjects(projects);
    if (client) {
      await client.sendNotification(INDEX_FILES_NOTIFICATION, {
        roots: discoveries.map((project) => ({
          rootUri: project.folder.uri.toString(),
          uris: project.sourceUris.map((uri) => uri.toString()),
        })),
      });
    }
  };
  const scheduleRefresh = (): void => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refresh().catch(showError), 150);
  };

  const watchers = [
    vscode.workspace.createFileSystemWatcher("**/tiangz.project.json"),
    vscode.workspace.createFileSystemWatcher("**/configs/**/*.json"),
    vscode.workspace.createFileSystemWatcher("**/app/**/*.ts"),
    vscode.workspace.createFileSystemWatcher("**/codegen.manifest.json"),
    vscode.workspace.createFileSystemWatcher("**/codegen.config.json"),
    vscode.workspace.createFileSystemWatcher("**/package.json"),
    vscode.workspace.createFileSystemWatcher("**/proto/**/*.proto"),
    vscode.workspace.createFileSystemWatcher("**/native_data/**/*.native"),
    vscode.workspace.createFileSystemWatcher("**/tools/codegen_*.mjs"),
    vscode.workspace.createFileSystemWatcher("**/client_demo/cocos_client2D/assets/scripts/**/*.ts"),
    vscode.workspace.createFileSystemWatcher("**/src/generated/**/*.{rs,js}"),
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
  const processStateSubscription = processManager.onDidChange(() => {
    tree.setProcessStatuses(processManager.getStatuses());
    for (const [key, session] of debugSessions) {
      const status = [...processManager.getStatuses().values()].find((candidate) => candidate.key === key);
      if (status && (status.state === "stopped" || status.state === "failed")) {
        void vscode.debug.stopDebugging(session);
      }
    }
  });
  context.subscriptions.push(
    view,
    processManager,
    codegenTaskManager,
    devSourceManager,
    processStateSubscription,
    ...watchers,
    snapshotSubscription,
    ...designAssistantSubscriptions,
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleRefresh),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("tiangzDeveloperTools")) scheduleRefresh();
    }),
    vscode.commands.registerCommand("tiangzDeveloperTools.refreshProject", () => refresh().catch(showError)),
    vscode.commands.registerCommand("tiangzDeveloperTools.openLocation", (node: ProjectNode) => openLocation(node, projects)),
    vscode.commands.registerCommand("tiangzDeveloperTools.openUriLocation", openUriLocation),
    vscode.commands.registerCommand("tiangzDeveloperTools.showProjectSummary", () => showSummary(projects)),
    vscode.commands.registerCommand("tiangzDeveloperTools.showServerStats", showServerStats),
    vscode.commands.registerCommand("tiangzDeveloperTools.newComponent", (node?: ProjectNode) => runCommand(
      () => createComponentFromWorkspace(node, refresh),
    )),
    vscode.commands.registerCommand("tiangzDeveloperTools.verifyFast", () => runCommand(
      () => verifyFast(projects, codegenTaskManager),
    )),
    vscode.commands.registerCommand("tiangzDeveloperTools.showRuntimeMetrics", (node?: ProjectNode | vscode.Uri) => runCommand(
      () => showRuntimeMetrics(node, projects),
    )),
    vscode.commands.registerCommand("tiangzDeveloperTools.testRuntimeFoundation", () => runCommand(
      () => testRuntimeFoundation(projects, codegenTaskManager),
    )),
    vscode.commands.registerCommand("tiangzDeveloperTools.runCodegen", (node?: ProjectNode | vscode.Uri) => runCommand(
      () => runCodegen(node, undefined, projects, codegenTaskManager, refresh),
    )),
    vscode.commands.registerCommand("tiangzDeveloperTools.regenerateProto", (uri?: vscode.Uri) => runCommand(
      () => runCodegen(uri, "proto", projects, codegenTaskManager, refresh),
    )),
    vscode.commands.registerCommand("tiangzDeveloperTools.regenerateNativeData", (uri?: vscode.Uri) => runCommand(
      () => runCodegen(uri, "native-data", projects, codegenTaskManager, refresh),
    )),
    vscode.commands.registerCommand("tiangzDeveloperTools.regenerateScenes", () => runCommand(
      () => runCodegen(undefined, "scenes", projects, codegenTaskManager, refresh),
    )),
    vscode.commands.registerCommand("tiangzDeveloperTools.regenerateClientHandlers", () => runCommand(
      () => runCodegen(undefined, "client-handlers", projects, codegenTaskManager, refresh),
    )),
    vscode.commands.registerCommand("tiangzDeveloperTools.runProcess", (node?: ProjectNode) => runCommand(
      () => launchProcess(node, projects, processManager, debugSessions, debugConfigStorage, "run"),
    )),
    vscode.commands.registerCommand("tiangzDeveloperTools.debugProcess", (node?: ProjectNode) => runCommand(
      () => launchProcess(node, projects, processManager, debugSessions, debugConfigStorage, "debug"),
    )),
    vscode.commands.registerCommand("tiangzDeveloperTools.attachProcess", (node?: ProjectNode) => runCommand(
      () => attachProcess(node, projects, processManager, debugSessions),
    )),
    vscode.commands.registerCommand("tiangzDeveloperTools.stopProcess", (node?: ProjectNode) => runCommand(
      () => stopProcess(node, projects, processManager),
    )),
    vscode.commands.registerCommand("tiangzDeveloperTools.runMachine", (node?: ProjectNode) => runCommand(
      () => launchMachine(node, projects, processManager),
    )),
    vscode.commands.registerCommand("tiangzDeveloperTools.startDevSourceMode", (node?: ProjectNode | vscode.Uri) => runCommand(
      () => startDevSourceMode(node, projects, devSourceManager),
    )),
    vscode.commands.registerCommand("tiangzDeveloperTools.stopDevSourceMode", () => runCommand(
      async () => devSourceManager.stop(),
    )),
    vscode.commands.registerCommand("tiangzDeveloperTools.stopMachine", (node?: ProjectNode) => runCommand(
      () => stopMachine(node, projects, processManager),
    )),
    vscode.commands.registerCommand("tiangzDeveloperTools.restartProcess", (node?: ProjectNode) => runCommand(
      () => restartProcess(node, projects, processManager, debugSessions, debugConfigStorage),
    )),
    vscode.commands.registerCommand("tiangzDeveloperTools.stopAllProcesses", () => runCommand(
      () => processManager.stopAll(),
    )),
    vscode.debug.onDidStartDebugSession((session) => {
      const key = debugProcessKey(session);
      if (key) debugSessions.set(key, session);
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      const key = debugProcessKey(session);
      if (key && debugSessions.get(key) === session) debugSessions.delete(key);
    }),
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

type SelectedProcess = { readonly project: IndexedProject; readonly process: ProcessConfigModel };
type SelectedGenerator = { readonly project: IndexedProject; readonly generator: CodegenGeneratorModel };
type CommandTarget = ProjectNode | vscode.Uri;
interface ProcessQuickPickItem extends vscode.QuickPickItem {
  readonly project: IndexedProject;
  readonly process: ProcessConfigModel;
}

async function runCodegen(
  target: ProjectNode | vscode.Uri | undefined,
  generatorId: string | undefined,
  projects: readonly IndexedProject[],
  manager: CodegenTaskManager,
  refresh: () => Promise<void>,
): Promise<void> {
  ensureTrustedWorkspace();
  const selected = await selectGenerator(target, generatorId, projects);
  if (!selected) return;
  const exitCode = await manager.run(selected.project.folder, selected.generator);
  if (exitCode !== 0) throw new Error(`${generatorLabel(selected.generator.id)}生成失败，退出码 ${exitCode}；请查看任务终端`);
  await refresh();
  void vscode.window.showInformationMessage(`TiangZ：${generatorLabel(selected.generator.id)}生成完成`);
}

/** 运行主工程提供的运行时基础自测，不把测试命令混入代码生成清单。 / Runs the runtime-foundation self-test exposed by the project without mixing it into codegen metadata. */
async function testRuntimeFoundation(
  projects: readonly IndexedProject[],
  manager: CodegenTaskManager,
): Promise<void> {
  ensureTrustedWorkspace();
  const project = await selectProject(projects, "选择要运行 Runtime Foundation 自测的 TiangZ 工程");
  if (!project) return;
  const exitCode = await manager.run(project.folder, {
    id: "runtime-foundation",
    command: "npm run test:runtime-foundation",
  });
  if (exitCode !== 0) throw new Error(`Runtime Foundation 自测失败，退出码 ${exitCode}；请查看任务终端`);
  void vscode.window.showInformationMessage("TiangZ：Runtime Foundation 自测通过");
}

/** 运行主工程的秒级日常门禁；只检查代码和边界，不启动服务器或执行压力测试。 / Runs the project's fast daily gate without starting servers or pressure tests. */
async function verifyFast(
  projects: readonly IndexedProject[],
  manager: CodegenTaskManager,
): Promise<void> {
  ensureTrustedWorkspace();
  const project = await selectProject(projects, "选择要运行快速检查的 TiangZ 工程");
  if (!project) return;
  const exitCode = await manager.run(project.folder, {
    id: "verify-fast",
    command: "npm run verify:fast",
  });
  if (exitCode !== 0) throw new Error(`快速工程检查失败，退出码 ${exitCode}；请查看任务终端`);
  void vscode.window.showInformationMessage("TiangZ：快速工程检查通过");
}

/** 打开主工程已有的只读 /metrics 摘要，不新增调试 RPC。 / Opens the existing read-only /metrics summary without adding a debug RPC. */
async function showRuntimeMetrics(
  target: ProjectNode | vscode.Uri | undefined,
  projects: readonly IndexedProject[],
): Promise<void> {
  ensureTrustedWorkspace();
  const selected = await selectProcess(target, projects);
  if (!selected) return;
  await openRuntimeMetrics(vscode, selected.process);
}

async function selectProject(
  projects: readonly IndexedProject[],
  placeHolder: string,
): Promise<IndexedProject | undefined> {
  if (projects.length === 1) return projects[0];
  const picked = await vscode.window.showQuickPick(
    projects.map((candidate) => ({ label: candidate.folder.name, project: candidate })),
    { placeHolder },
  );
  return picked?.project;
}

async function selectGenerator(
  target: ProjectNode | vscode.Uri | undefined,
  generatorId: string | undefined,
  projects: readonly IndexedProject[],
): Promise<SelectedGenerator | undefined> {
  let project: IndexedProject | undefined;
  if (target && isProjectNode(target) && target.rootUri) {
    project = projects.find((candidate) => candidate.folder.uri.toString() === target.rootUri);
    if (project && !generatorId && target.generator) return { project, generator: target.generator };
  } else if (target && isUri(target)) {
    project = locateConfig(target, projects)?.project;
  }
  if (!project) {
    if (projects.length === 1) project = projects[0];
    else {
      const picked = await vscode.window.showQuickPick(
        projects.map((candidate) => ({ label: candidate.folder.name, project: candidate })),
        { placeHolder: "选择要执行代码生成的 TiangZ 工程" },
      );
      project = picked?.project;
    }
  }
  if (!project) return undefined;
  if (generatorId) {
    const generator = project.snapshot.generators.find((candidate) => candidate.id === generatorId);
    if (!generator) throw new Error(`工程 ${project.folder.name} 的 codegen.manifest.json 未定义生成器 ${generatorId}`);
    return { project, generator };
  }
  const picked = await vscode.window.showQuickPick(
    project.snapshot.generators.map((generator) => ({
      label: generatorLabel(generator.id),
      description: generator.command,
      generator,
    })),
    { placeHolder: "选择要运行的代码生成器" },
  );
  return picked ? { project, generator: picked.generator } : undefined;
}

async function launchProcess(
  target: CommandTarget | undefined,
  projects: readonly IndexedProject[],
  manager: TiangZProcessManager,
  debugSessions: ReadonlyMap<string, vscode.DebugSession>,
  debugConfigStorage: vscode.Uri,
  mode: "run" | "debug",
): Promise<void> {
  ensureTrustedWorkspace();
  const selected = await selectProcess(target, projects);
  if (!selected) return;
  const { project, process } = selected;
  if (mode === "run") {
    const configUri = vscode.Uri.joinPath(project.folder.uri, ...process.relativePath.split("/"));
    await manager.launch({ folder: project.folder, process, configUri, mode: "run" });
    return;
  }
  const existing = manager.getStatus(project.folder.uri.toString(), process.relativePath);
  if (existing?.state === "running") {
    if (existing.mode !== "debug" || !existing.debug) {
      throw new Error(`${process.name} 正在普通模式运行；请先停止，再使用“调试 Process”启动`);
    }
    if (debugSessions.has(existing.key)) {
      void vscode.window.showInformationMessage(`${process.name} 已经附加调试器`);
      return;
    }
    await attachDebugger(project.folder, process, existing.debug, existing.key);
    return;
  }
  const spec = await prepareDebugLaunch(project.folder, process, debugConfigStorage);
  try {
    await manager.launch(spec);
  } catch (error) {
    if (spec.cleanupConfigUri) await vscode.workspace.fs.delete(spec.cleanupConfigUri).then(undefined, () => undefined);
    throw error;
  }
  const status = await manager.waitUntilRunning(project.folder.uri.toString(), process.relativePath);
  if (!spec.debug) throw new Error(`${process.name} 没有 Inspector 配置`);
  const attached = await attachDebugger(project.folder, process, spec.debug, status.key);
  if (!attached) throw new Error(`VS Code 未能附加到 ${process.name} Inspector`);
}

async function attachProcess(
  target: CommandTarget | undefined,
  projects: readonly IndexedProject[],
  manager: TiangZProcessManager,
  debugSessions: ReadonlyMap<string, vscode.DebugSession>,
): Promise<void> {
  ensureTrustedWorkspace();
  const selected = await selectProcess(target, projects);
  if (!selected) return;
  const status = manager.getStatus(selected.project.folder.uri.toString(), selected.process.relativePath);
  if (!status || status.state !== "running") throw new Error(`${selected.process.name} 当前没有运行`);
  if (!status.debug) throw new Error(`${selected.process.name} 不是以调试模式启动的`);
  if (debugSessions.has(status.key)) {
    void vscode.window.showInformationMessage(`${selected.process.name} 已经附加调试器`);
    return;
  }
  const attached = await attachDebugger(selected.project.folder, selected.process, status.debug, status.key);
  if (!attached) throw new Error(`VS Code 未能附加到 ${selected.process.name} Inspector`);
}

async function stopProcess(
  target: CommandTarget | undefined,
  projects: readonly IndexedProject[],
  manager: TiangZProcessManager,
): Promise<void> {
  const selected = await selectProcess(target, projects, true, manager);
  if (!selected) return;
  await manager.stop(selected.project.folder.uri.toString(), selected.process.relativePath);
}

async function launchMachine(
  target: CommandTarget | undefined,
  projects: readonly IndexedProject[],
  manager: TiangZProcessManager,
): Promise<void> {
  ensureTrustedWorkspace();
  const selected = await selectMachine(target, projects);
  if (!selected) return;
  const processPaths = new Set(resolveMachineProcessPaths(selected.machine));
  const processes = selected.project.snapshot.processes.filter((process) => processPaths.has(process.relativePath));
  if (processes.length !== processPaths.size) {
    const missing = [...processPaths].filter((relativePath) => !processes.some((process) => process.relativePath === relativePath));
    throw new Error(`StartMachine 引用的 Process 配置未找到：${missing.join("、")}`);
  }
  await manager.launchMany(processes.map((process) => ({
    folder: selected.project.folder,
    process,
    configUri: vscode.Uri.joinPath(selected.project.folder.uri, ...process.relativePath.split("/")),
    mode: "run" as const,
  })));
}

/**
 * 通过主工程的统一开发宿主启动 Watcher，避免插件复制 Hotfix 监听和 Reload 状态机。
 * Starts the Watcher through the main project's unified development host, avoiding duplicated Hotfix watch and Reload state machines in the extension.
 */
async function startDevSourceMode(
  target: CommandTarget | undefined,
  projects: readonly IndexedProject[],
  manager: DevSourceManager,
): Promise<void> {
  ensureTrustedWorkspace();
  const selected = await selectMachine(target, projects);
  if (!selected) return;
  await manager.start({
    folder: selected.project.folder,
    configRelativePath: selected.machine.relativePath,
    machineName: selected.machine.name,
  });
}

async function stopMachine(
  target: CommandTarget | undefined,
  projects: readonly IndexedProject[],
  manager: TiangZProcessManager,
): Promise<void> {
  const selected = await selectMachine(target, projects);
  if (!selected) return;
  const processPaths = resolveMachineProcessPaths(selected.machine);
  await Promise.all(processPaths.map((relativePath) => manager.stop(selected.project.folder.uri.toString(), relativePath)));
}

async function restartProcess(
  target: CommandTarget | undefined,
  projects: readonly IndexedProject[],
  manager: TiangZProcessManager,
  debugSessions: ReadonlyMap<string, vscode.DebugSession>,
  debugConfigStorage: vscode.Uri,
): Promise<void> {
  const selected = await selectProcess(target, projects);
  if (!selected) return;
  const rootUri = selected.project.folder.uri.toString();
  const status = manager.getStatus(rootUri, selected.process.relativePath);
  const mode = status?.mode ?? "run";
  if (status && ["starting", "running", "stopping"].includes(status.state)) {
    await manager.stop(rootUri, selected.process.relativePath);
    await manager.waitUntilStopped(rootUri, selected.process.relativePath);
  }
  await launchProcess(
    {
      label: selected.process.name,
      icon: "server-process",
      rootUri,
      process: selected.process,
      children: [],
    },
    projects,
    manager,
    debugSessions,
    debugConfigStorage,
    mode,
  );
}

async function selectProcess(
  target: CommandTarget | undefined,
  projects: readonly IndexedProject[],
  runningOnly = false,
  manager?: TiangZProcessManager,
): Promise<SelectedProcess | undefined> {
  if (isProjectNode(target) && target.process && target.rootUri) {
    const project = projects.find((candidate) => candidate.folder.uri.toString() === target.rootUri);
    if (project) return { project, process: target.process };
  }
  if (isUri(target)) {
    const located = locateConfig(target, projects);
    const process = located?.project.snapshot.processes.find(
      (candidate) => candidate.relativePath === located.relativePath,
    );
    if (located && process) return { project: located.project, process };
    throw new Error(`${vscode.workspace.asRelativePath(target, false)} 不是 TiangZ Process 配置`);
  }
  const choices: ProcessQuickPickItem[] = projects.flatMap((project) => project.snapshot.processes.flatMap((process) => {
    const status = manager?.getStatus(project.folder.uri.toString(), process.relativePath);
    if (runningOnly && (!status || !["starting", "running", "stopping"].includes(status.state))) return [];
    return [{
      label: process.name,
      description: `${process.environment} / ${process.relativePath}`,
      ...(status ? { detail: `${status.state}${status.pid ? ` / PID ${status.pid}` : ""}` } : {}),
      project,
      process,
    } satisfies ProcessQuickPickItem];
  }));
  const selected = await vscode.window.showQuickPick(choices, {
    placeHolder: runningOnly ? "选择要停止的 TiangZ Process" : "选择 TiangZ Process",
  });
  return selected ? { project: selected.project, process: selected.process } : undefined;
}

async function selectMachine(target: CommandTarget | undefined, projects: readonly IndexedProject[]) {
  if (isProjectNode(target) && target.machine && target.rootUri) {
    const project = projects.find((candidate) => candidate.folder.uri.toString() === target.rootUri);
    if (project) return { project, machine: target.machine };
  }
  if (isUri(target)) {
    const located = locateConfig(target, projects);
    const machine = located?.project.snapshot.machines.find(
      (candidate) => candidate.relativePath === located.relativePath,
    );
    if (located && machine) return { project: located.project, machine };
    throw new Error(`${vscode.workspace.asRelativePath(target, false)} 不是 TiangZ StartMachine 配置`);
  }
  const choices = projects.flatMap((project) => project.snapshot.machines.map((machine) => ({
    label: machine.name,
    description: `${machine.environment} / ${machine.innerIp}`,
    project,
    machine,
  })));
  return vscode.window.showQuickPick(choices, { placeHolder: "选择要启动的 StartMachine 机器配置" });
}

function locateConfig(
  uri: vscode.Uri,
  projects: readonly IndexedProject[],
): { readonly project: IndexedProject; readonly relativePath: string } | undefined {
  const project = [...projects].sort((a, b) => b.folder.uri.fsPath.length - a.folder.uri.fsPath.length).find(candidate => {
    const relative = path.relative(candidate.folder.uri.fsPath, uri.fsPath);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
  if (!project) return undefined;
  const relativePath = path.relative(project.folder.uri.fsPath, uri.fsPath).replaceAll("\\", "/");
  return { project, relativePath };
}

function isUri(value: CommandTarget | undefined): value is vscode.Uri {
  return value !== undefined
    && "scheme" in value
    && "fsPath" in value
    && "path" in value;
}

function isProjectNode(value: CommandTarget | undefined): value is ProjectNode {
  return value !== undefined && !isUri(value);
}

function ensureTrustedWorkspace(): void {
  if (!vscode.workspace.isTrusted) throw new Error("执行 TiangZ 工程命令前，请先信任当前工作区");
}

async function runCommand(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    void vscode.window.showErrorMessage(`TiangZ：${errorMessage(error)}`);
  }
}

function debugProcessKey(session: vscode.DebugSession): string | undefined {
  const value: unknown = session.configuration.__tiangzProcessKey;
  return typeof value === "string" ? value : undefined;
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
  const delegatedCount = projects.filter((project) => project.snapshot.analysisMode === "host-delegated").length;
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
      + `${totals.protocols} 个协议，${totals.handlers} Handler，${totals.diagnostics} 个工程问题`
      + (delegatedCount ? `；另有 ${delegatedCount} 个独立模块工程未在此检查，请运行宿主 check` : ""),
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
  void vscode.window.showErrorMessage(`TiangZ 工程索引失败：${errorMessage(error)}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
