import * as vscode from "vscode";

import type {
  CodegenGeneratorModel,
  HandlerModel,
  MachineConfigModel,
  ProcessConfigModel,
  ProjectDiagnostic,
  ProtocolDescriptorModel,
  SourceLocation,
  TiangZProjectSnapshot,
  TypeDeclarationModel,
} from "../../packages/project-core/src/types.js";

import type { IndexedProject } from "./projectIndex.js";
import { generatorLabel } from "./codegenTaskManager.js";
import { processKey, type ManagedProcessStatus } from "./processManager.js";

export class ProjectTreeProvider implements vscode.TreeDataProvider<ProjectNode> {
  private readonly changed = new vscode.EventEmitter<ProjectNode | undefined>();
  private projects: readonly IndexedProject[] = [];
  private processStatuses: ReadonlyMap<string, ManagedProcessStatus> = new Map();

  readonly onDidChangeTreeData = this.changed.event;

  setProjects(projects: readonly IndexedProject[]): void {
    this.projects = projects;
    this.changed.fire(undefined);
  }

  setProcessStatuses(statuses: ReadonlyMap<string, ManagedProcessStatus>): void {
    this.processStatuses = statuses;
    this.changed.fire(undefined);
  }

  getTreeItem(element: ProjectNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.label,
      element.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    if (element.description !== undefined) item.description = element.description;
    item.tooltip = element.tooltip ?? element.label;
    item.iconPath = new vscode.ThemeIcon(element.icon);
    if (element.contextValue) item.contextValue = element.contextValue;
    else if (element.location) item.contextValue = "tiangzLocation";
    if (element.location) {
      item.command = {
        command: "tiangzDeveloperTools.openLocation",
        title: "打开声明",
        arguments: [element],
      };
    }
    return item;
  }

  getChildren(element?: ProjectNode): ProjectNode[] {
    if (element) return [...element.children];
    return this.projects.map((project) => projectNode(project, this.projects.length > 1, this.processStatuses));
  }
}

export interface ProjectNode {
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly icon: string;
  readonly location?: SourceLocation;
  readonly contextValue?: string;
  readonly rootUri?: string;
  readonly process?: ProcessConfigModel;
  readonly machine?: MachineConfigModel;
  readonly generator?: CodegenGeneratorModel;
  readonly children: readonly ProjectNode[];
}

function projectNode(
  project: IndexedProject,
  showFolder: boolean,
  statuses: ReadonlyMap<string, ManagedProcessStatus>,
): ProjectNode {
  const snapshot = project.snapshot;
  const rootUri = project.folder.uri.toString();
  const categories = [
    environmentsNode(snapshot, rootUri, statuses),
    generatorsNode(snapshot.generators, rootUri),
    declarationsNode("入口 Scene", "server-process", "entryScene", snapshot),
    declarationsNode("动态 Scene", "symbol-namespace", "scene", snapshot),
    declarationsNode("Actor", "symbol-class", "actor", snapshot),
    declarationsNode("Component", "extensions", "component", snapshot),
    protocolsNode(snapshot),
    handlersNode(snapshot.handlers),
    diagnosticsNode(snapshot.diagnostics),
  ];
  return {
    label: showFolder ? project.folder.name : "TiangZ",
    description: `${snapshot.processes.length} Process / ${snapshot.handlers.length} Handler`,
    icon: "project",
    contextValue: "tiangzProject",
    rootUri,
    children: categories,
  };
}

function generatorsNode(generators: readonly CodegenGeneratorModel[], rootUri: string): ProjectNode {
  return {
    label: "代码生成",
    description: String(generators.length),
    icon: "tools",
    children: generators.map((generator) => ({
      label: generatorLabel(generator.id),
      description: generator.command,
      tooltip: `${generator.id}\n${generator.command}`,
      icon: "run",
      contextValue: "tiangzCodegenGenerator",
      rootUri,
      generator,
      children: [],
    })),
  };
}

function protocolsNode(snapshot: TiangZProjectSnapshot): ProjectNode {
  return {
    label: "协议",
    description: String(snapshot.protocols.length),
    icon: "symbol-interface",
    children: snapshot.protocols.map((protocol) => protocolNode(protocol, snapshot.handlers)),
  };
}

function protocolNode(protocol: ProtocolDescriptorModel, handlers: readonly HandlerModel[]): ProjectNode {
  const linked = handlers.filter((handler) => handler.kind !== "actorMethod"
    && normalizeDescriptorReference(handler.descriptor) === protocol.symbol);
  const code = protocol.kind === "rpc"
    ? `${protocol.requestCode ?? "?"} -> ${protocol.responseCode ?? "?"}`
    : String(protocol.msgcode ?? "?");
  return {
    label: protocol.name,
    description: `${code} / ${linked.length} Handler`,
    tooltip: [
      protocol.kind === "rpc" ? "RPC" : "Message",
      `Descriptor：${protocol.symbol}`,
      protocol.requestType ? `Request：${protocol.requestType}` : undefined,
      protocol.responseType ? `Response：${protocol.responseType}` : undefined,
      protocol.messageType ? `消息：${protocol.messageType}` : undefined,
      protocol.routing ? `路由：${protocol.routing}` : undefined,
    ].filter(Boolean).join("\n"),
    icon: protocol.kind === "rpc" ? "symbol-method" : "symbol-event",
    location: protocol.location,
    children: linked.map((handler) => ({
      label: handler.name,
      description: handler.target,
      icon: "references",
      location: handler.location,
      children: [],
    })),
  };
}

function environmentsNode(
  snapshot: TiangZProjectSnapshot,
  rootUri: string,
  statuses: ReadonlyMap<string, ManagedProcessStatus>,
): ProjectNode {
  return {
    label: "运行环境",
    description: String(snapshot.environments.length),
    icon: "server-environment",
    children: snapshot.environments.map((environment) => ({
      label: environment,
      icon: "server",
      children: [
        ...snapshot.machines.filter((machine) => machine.environment === environment).map((machine) => ({
          label: machine.name,
          description: machine.innerIp,
          tooltip: `Machine ${machine.name}\n${machine.processes.join("\n")}`,
          icon: "vm",
          location: { relativePath: machine.relativePath, line: 0, character: 0 },
          contextValue: "tiangzMachineConfig",
          rootUri,
          machine,
          children: resolveMachineProcesses(snapshot, machine).map((process) => processNode(process, rootUri, statuses)),
        })),
        ...snapshot.processes.filter((process) => process.environment === environment)
          .map((process) => processNode(process, rootUri, statuses)),
      ],
    })),
  };
}

function processNode(
  process: ProcessConfigModel,
  rootUri: string,
  statuses: ReadonlyMap<string, ManagedProcessStatus>,
): ProjectNode {
  const status = statuses.get(processKey(rootUri, process.relativePath));
  const file = process.relativePath.split("/").at(-1) ?? process.relativePath;
  return {
    label: process.name,
    description: status ? `${statusLabel(status)} / ${file}` : file,
    tooltip: [
      process.relativePath,
      status ? `状态：${status.state}` : "状态：未启动",
      status?.pid ? `PID：${status.pid}` : undefined,
      status?.inspector ? `Inspector：${status.inspector}` : process.debug ? `Inspector：${process.debug.inspectorIp}:${process.debug.inspectorPort}` : undefined,
      process.observability?.health ? `Metrics：http://${process.observability.health.ip}:${process.observability.health.port}/metrics` : undefined,
    ].filter(Boolean).join("\n"),
    icon: processIcon(status),
    location: { relativePath: process.relativePath, line: 0, character: 0 },
    contextValue: status && (status.state === "starting" || status.state === "running" || status.state === "stopping")
      ? "tiangzRunningProcessConfig"
      : "tiangzStoppedProcessConfig",
    rootUri,
    process,
    children: process.scenes.map((scene) => ({
      label: scene.name,
      description: `${scene.sceneType}${(scene.innerIp ?? scene.ip) ? `  ${scene.innerIp ?? scene.ip}:${scene.port ?? 0}` : ""}`,
      icon: "symbol-namespace",
      location: { relativePath: process.relativePath, line: 0, character: 0 },
      children: [],
    })),
  };
}

function resolveMachineProcesses(
  snapshot: TiangZProjectSnapshot,
  machine: MachineConfigModel,
): ProcessConfigModel[] {
  const directory = machine.relativePath.slice(0, machine.relativePath.lastIndexOf("/") + 1);
  return machine.processes.flatMap((file) => {
    const relativePath = `${directory}${file.replaceAll("\\", "/")}`.replace(/\/+/g, "/");
    const process = snapshot.processes.find((candidate) => candidate.relativePath === relativePath);
    return process ? [process] : [];
  });
}

function statusLabel(status: ManagedProcessStatus): string {
  switch (status.state) {
    case "starting": return "正在启动";
    case "running": return status.pid ? `运行中 PID ${status.pid}` : "运行中";
    case "stopping": return "正在停止";
    case "failed": return `失败 (${status.exitCode ?? "?"})`;
    case "stopped": return "已停止";
  }
}

function processIcon(status: ManagedProcessStatus | undefined): string {
  if (!status || status.state === "stopped") return "server-process";
  if (status.state === "failed") return "error";
  if (status.state === "starting" || status.state === "stopping") return "loading~spin";
  return status.mode === "debug" ? "debug-alt" : "play-circle";
}

function declarationsNode(
  label: string,
  icon: string,
  kind: TypeDeclarationModel["kind"],
  snapshot: TiangZProjectSnapshot,
): ProjectNode {
  const declarations = snapshot.declarations.filter((declaration) => declaration.kind === kind);
  return {
    label,
    description: String(declarations.length),
    icon,
    children: declarations.map((declaration) => ({
      label: declaration.name,
      ...(declaration.runtimeType ? { description: declaration.runtimeType } : {}),
      tooltip: declarationTooltip(declaration),
      icon,
      location: declaration.location,
      children: [],
    })),
  };
}

function handlersNode(handlers: readonly HandlerModel[]): ProjectNode {
  return {
    label: "Handler",
    description: String(handlers.length),
    icon: "symbol-event",
    children: handlers.map((handler) => ({
      label: handler.name,
      description: handler.descriptor,
      tooltip: `${handler.kind}\n目标：${handler.target}\n协议：${handler.descriptor}`,
      icon: handler.kind.includes("Rpc") || handler.kind === "rpc" ? "symbol-method" : "symbol-event",
      location: handler.location,
      children: [],
    })),
  };
}

function diagnosticsNode(diagnostics: readonly ProjectDiagnostic[]): ProjectNode {
  return {
    label: "工程问题",
    description: String(diagnostics.length),
    icon: diagnostics.length > 0 ? "warning" : "pass",
    children: diagnostics.map((diagnostic) => ({
      label: diagnostic.message,
      description: diagnostic.code,
      icon: diagnostic.severity === "error" ? "error" : "warning",
      location: diagnostic.location,
      children: [],
    })),
  };
}

function declarationTooltip(declaration: TypeDeclarationModel): string {
  return [
    declaration.kind,
    declaration.runtimeType ? `运行时类型：${declaration.runtimeType}` : undefined,
    declaration.mailbox ? `Mailbox：${declaration.mailbox}` : undefined,
    declaration.location.relativePath,
  ].filter(Boolean).join("\n");
}

function normalizeDescriptorReference(value: string): string {
  return value.endsWith(".name") ? value.slice(0, -".name".length) : value;
}
