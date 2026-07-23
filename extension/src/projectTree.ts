import * as vscode from "vscode";

import type {
  HandlerModel,
  ProjectDiagnostic,
  SourceLocation,
  TiangZProjectSnapshot,
  TypeDeclarationModel,
} from "../../packages/project-core/src/index.js";

import type { IndexedProject } from "./projectIndex.js";

export class ProjectTreeProvider implements vscode.TreeDataProvider<ProjectNode> {
  private readonly changed = new vscode.EventEmitter<ProjectNode | undefined>();
  private projects: readonly IndexedProject[] = [];

  readonly onDidChangeTreeData = this.changed.event;

  setProjects(projects: readonly IndexedProject[]): void {
    this.projects = projects;
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
    if (element.location) {
      item.contextValue = "tiangzLocation";
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
    return this.projects.map((project) => projectNode(project, this.projects.length > 1));
  }
}

export interface ProjectNode {
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly icon: string;
  readonly location?: SourceLocation;
  readonly children: readonly ProjectNode[];
}

function projectNode(project: IndexedProject, showFolder: boolean): ProjectNode {
  const snapshot = project.snapshot;
  const categories = [
    environmentsNode(snapshot),
    declarationsNode("入口 Scene", "server-process", "entryScene", snapshot),
    declarationsNode("动态 Scene", "symbol-namespace", "scene", snapshot),
    declarationsNode("Actor", "symbol-class", "actor", snapshot),
    declarationsNode("Component", "extensions", "component", snapshot),
    handlersNode(snapshot.handlers),
    diagnosticsNode(snapshot.diagnostics),
  ];
  return {
    label: showFolder ? project.folder.name : "TiangZ",
    description: `${snapshot.processes.length} Process / ${snapshot.handlers.length} Handler`,
    icon: "project",
    children: categories,
  };
}

function environmentsNode(snapshot: TiangZProjectSnapshot): ProjectNode {
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
          children: machine.processes.map((process) => ({
            label: process,
            icon: "file-code",
            children: [],
          })),
        })),
        ...snapshot.processes.filter((process) => process.environment === environment).map((process) => ({
          label: process.name,
          description: process.relativePath.split("/").at(-1) ?? process.relativePath,
          icon: "server-process",
          location: { relativePath: process.relativePath, line: 0, character: 0 },
          children: process.scenes.map((scene) => ({
            label: scene.name,
            description: `${scene.sceneType}${scene.ip ? `  ${scene.ip}:${scene.port ?? 0}` : ""}`,
            icon: "symbol-namespace",
            location: { relativePath: process.relativePath, line: 0, character: 0 },
            children: [],
          })),
        })),
      ],
    })),
  };
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
