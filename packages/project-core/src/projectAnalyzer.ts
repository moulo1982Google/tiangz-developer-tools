import path from "node:path";

import ts from "typescript";

import type {
  DeclarationKind,
  HandlerKind,
  HandlerModel,
  MachineConfigModel,
  ProcessConfigModel,
  ProjectDiagnostic,
  ProjectSource,
  SceneConfigModel,
  SourceLocation,
  TiangZProjectSnapshot,
  TypeDeclarationModel,
} from "./types.js";

const CLASS_DECORATORS = new Map<string, DeclarationKind>([
  ["entryScene", "entryScene"],
  ["scene", "scene"],
  ["actor", "actor"],
  ["component", "component"],
]);

const CLASS_HANDLER_DECORATORS = new Map<string, HandlerKind>([
  ["rpcHandler", "rpc"],
  ["messageHandler", "message"],
  ["actorRpcHandler", "actorRpc"],
  ["actorMessageHandler", "actorMessage"],
]);

export function analyzeTiangZProject(sources: readonly ProjectSource[]): TiangZProjectSnapshot {
  const processes: ProcessConfigModel[] = [];
  const machines: MachineConfigModel[] = [];
  const declarations: TypeDeclarationModel[] = [];
  const handlers: HandlerModel[] = [];
  const diagnostics: ProjectDiagnostic[] = [];

  for (const source of [...sources].sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"))) {
    const relativePath = normalizePath(source.relativePath);
    if (relativePath.endsWith(".ts")) {
      analyzeTypeScript({ ...source, relativePath }, declarations, handlers, diagnostics);
    } else if (relativePath.startsWith("configs/") && relativePath.endsWith(".json")) {
      analyzeConfig({ ...source, relativePath }, processes, machines, diagnostics);
    }
  }

  validateProject(processes, machines, declarations, diagnostics);
  return {
    environments: [...new Set([
      ...processes.map((process) => process.environment),
      ...machines.map((machine) => machine.environment),
    ])].sort((left, right) => left.localeCompare(right, "en")),
    processes,
    machines,
    declarations,
    handlers,
    diagnostics,
  };
}

function analyzeConfig(
  source: ProjectSource,
  processes: ProcessConfigModel[],
  machines: MachineConfigModel[],
  diagnostics: ProjectDiagnostic[],
): void {
  const segments = source.relativePath.split("/");
  const environment = segments.length >= 3 ? segments[1]! : "default";
  let value: unknown;
  try {
    value = JSON.parse(source.text);
  } catch (error) {
    diagnostics.push({
      code: "tiangz.config.invalid-json",
      severity: "error",
      message: `配置不是有效 JSON：${errorMessage(error)}`,
      location: fileLocation(source.relativePath),
    });
    return;
  }
  if (!isRecord(value)) return;
  if (path.posix.basename(source.relativePath).toLowerCase() === "startmachine.json") {
    const rawMachines = Array.isArray(value.machines) ? value.machines : [];
    for (const rawMachine of rawMachines) {
      if (!isRecord(rawMachine) || typeof rawMachine.name !== "string") continue;
      machines.push({
        environment,
        name: rawMachine.name,
        innerIp: typeof rawMachine.innerIp === "string" ? rawMachine.innerIp : "",
        processes: stringArray(rawMachine.processes),
        relativePath: source.relativePath,
      });
    }
    return;
  }
  if (!isRecord(value.process) || typeof value.process.name !== "string") return;
  processes.push({
    environment,
    name: value.process.name,
    relativePath: source.relativePath,
    scenes: sceneConfigs(value.scenes),
    knownScenes: sceneConfigs(value.knownScenes),
  });
}

function analyzeTypeScript(
  source: ProjectSource,
  declarations: TypeDeclarationModel[],
  handlers: HandlerModel[],
  diagnostics: ProjectDiagnostic[],
): void {
  const sourceFile = ts.createSourceFile(
    source.relativePath,
    source.text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const parseDiagnostics = (sourceFile as ts.SourceFile & {
    readonly parseDiagnostics?: readonly ts.Diagnostic[];
  }).parseDiagnostics ?? [];
  for (const diagnostic of parseDiagnostics) {
    const location = sourceLocation(sourceFile, diagnostic.start ?? 0, source.relativePath);
    diagnostics.push({
      code: "tiangz.typescript.syntax",
      severity: "error",
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      location,
    });
  }
  visit(sourceFile);

  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node) && node.name) analyzeClass(sourceFile, source.relativePath, node, declarations, handlers);
    ts.forEachChild(node, visit);
  }
}

function analyzeClass(
  sourceFile: ts.SourceFile,
  relativePath: string,
  declaration: ts.ClassDeclaration,
  declarations: TypeDeclarationModel[],
  handlers: HandlerModel[],
): void {
  const className = declaration.name!.text;
  for (const decorator of decoratorsOf(declaration)) {
    const call = decoratorCall(decorator);
    const decoratorName = call ? expressionName(call.expression) : expressionName(decorator.expression);
    const kind = CLASS_DECORATORS.get(decoratorName);
    if (kind) {
      const projected = projectDeclaration(sourceFile, relativePath, declaration, call, kind, className);
      declarations.push(projected);
    }
    const handlerKind = CLASS_HANDLER_DECORATORS.get(decoratorName);
    if (handlerKind && call) {
      handlers.push({
        kind: handlerKind,
        name: className,
        owner: className,
        target: call.arguments[0]?.getText(sourceFile) ?? "unknown",
        descriptor: call.arguments[1]?.getText(sourceFile) ?? "unknown",
        location: sourceLocation(sourceFile, declaration.name!.getStart(sourceFile), relativePath),
      });
    }
  }
  for (const member of declaration.members) {
    if (!ts.isMethodDeclaration(member) || !member.name) continue;
    const methodName = member.name.getText(sourceFile);
    for (const decorator of decoratorsOf(member)) {
      const call = decoratorCall(decorator);
      if (!call) continue;
      const decoratorName = expressionName(call.expression);
      if (decoratorName !== "rpc" && decoratorName !== "handler") continue;
      handlers.push({
        kind: decoratorName === "rpc" ? "rpc" : "actorMethod",
        name: `${className}.${methodName}`,
        owner: className,
        target: className,
        descriptor: call.arguments[0]?.getText(sourceFile) ?? methodName,
        location: sourceLocation(sourceFile, member.name.getStart(sourceFile), relativePath),
      });
    }
  }
}

function projectDeclaration(
  sourceFile: ts.SourceFile,
  relativePath: string,
  declaration: ts.ClassDeclaration,
  call: ts.CallExpression | undefined,
  kind: DeclarationKind,
  className: string,
): TypeDeclarationModel {
  let runtimeType: string | undefined;
  let mailbox: string | undefined;
  if (kind === "entryScene") {
    runtimeType = stringLiteral(call?.arguments[0]) ?? defaultSceneType(className);
  } else if (kind === "scene" || kind === "actor") {
    const options = call?.arguments[0];
    runtimeType = objectStringProperty(options, "sceneType");
    mailbox = objectStringProperty(options, "mailbox");
  }
  return {
    kind,
    name: className,
    ...(runtimeType ? { runtimeType } : {}),
    ...(mailbox ? { mailbox } : {}),
    location: sourceLocation(sourceFile, declaration.name!.getStart(sourceFile), relativePath),
  };
}

function validateProject(
  processes: readonly ProcessConfigModel[],
  machines: readonly MachineConfigModel[],
  declarations: readonly TypeDeclarationModel[],
  diagnostics: ProjectDiagnostic[],
): void {
  const entryScenes = declarations.filter((declaration) => declaration.kind === "entryScene");
  const entryByType = new Map<string, TypeDeclarationModel>();
  for (const declaration of entryScenes) {
    const runtimeType = declaration.runtimeType;
    if (!runtimeType) continue;
    const previous = entryByType.get(runtimeType);
    if (previous) {
      diagnostics.push({
        code: "tiangz.scene.duplicate-entry-type",
        severity: "error",
        message: `入口 Scene 类型 ${runtimeType} 同时由 ${previous.name} 和 ${declaration.name} 声明`,
        location: declaration.location,
      });
    } else {
      entryByType.set(runtimeType, declaration);
    }
  }
  for (const process of processes) {
    for (const scene of process.scenes) {
      if (entryByType.has(scene.sceneType)) continue;
      diagnostics.push({
        code: "tiangz.config.unknown-entry-scene",
        severity: "warning",
        message: `${process.name} 配置了未找到 @entryScene 声明的 sceneType：${scene.sceneType}`,
        location: fileLocation(process.relativePath),
      });
    }
  }
  const processFiles = new Set(processes.map((process) => `${process.environment}/${path.posix.basename(process.relativePath)}`));
  for (const machine of machines) {
    for (const processFile of machine.processes) {
      if (processFiles.has(`${machine.environment}/${processFile}`)) continue;
      diagnostics.push({
        code: "tiangz.machine.missing-process-config",
        severity: "error",
        message: `Machine ${machine.name} 引用了不存在的进程配置：${processFile}`,
        location: fileLocation(machine.relativePath),
      });
    }
  }
}

function sceneConfigs(value: unknown): SceneConfigModel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.sceneType !== "string") return [];
    return [{
      name: item.name,
      sceneType: item.sceneType,
      ...(typeof item.ip === "string" ? { ip: item.ip } : {}),
      ...(typeof item.port === "number" ? { port: item.port } : {}),
    }];
  });
}

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
}

function decoratorCall(decorator: ts.Decorator): ts.CallExpression | undefined {
  return ts.isCallExpression(decorator.expression) ? decorator.expression : undefined;
}

function expressionName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return "";
}

function stringLiteral(node: ts.Expression | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function objectStringProperty(node: ts.Expression | undefined, name: string): string | undefined {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const propertyName = property.name.getText().replace(/^['"]|['"]$/g, "");
    if (propertyName === name) return stringLiteral(property.initializer);
  }
  return undefined;
}

function sourceLocation(sourceFile: ts.SourceFile, offset: number, relativePath: string): SourceLocation {
  const position = sourceFile.getLineAndCharacterOfPosition(offset);
  return { relativePath, line: position.line, character: position.character };
}

function fileLocation(relativePath: string): SourceLocation {
  return { relativePath, line: 0, character: 0 };
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function defaultSceneType(className: string): string {
  return className.endsWith("Scene") ? className.slice(0, -"Scene".length) : className;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
