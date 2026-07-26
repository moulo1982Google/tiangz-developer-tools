import path from "node:path";

import ts from "typescript";

import { validateTypeScriptDependencies } from "./dependencyRules.js";
import { validateGeneratedIntegrity } from "./generatedIntegrity.js";
import { readProjectGenerators } from "./projectFiles.js";

import type {
  DeclarationKind,
  HandlerKind,
  HandlerModel,
  MessageTypeModel,
  MsgCodeModel,
  MachineConfigModel,
  ProcessConfigModel,
  ProjectDiagnostic,
  ProjectSource,
  ProtocolDescriptorModel,
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
  ["sessionRpcHandler", "sessionRpc"],
  ["sessionMessageHandler", "sessionMessage"],
  ["unitRpcHandler", "unitRpc"],
  ["unitMessageHandler", "unitMessage"],
  ["actorRpcHandler", "actorRpc"],
  ["actorMessageHandler", "actorMessage"],
]);

export function analyzeTiangZProject(sources: readonly ProjectSource[]): TiangZProjectSnapshot {
  const processes: ProcessConfigModel[] = [];
  const machines: MachineConfigModel[] = [];
  const declarations: TypeDeclarationModel[] = [];
  const messageTypes: MessageTypeModel[] = [];
  const msgcodes: MsgCodeModel[] = [];
  const protocols: ProtocolDescriptorModel[] = [];
  const handlers: HandlerModel[] = [];
  const diagnostics: ProjectDiagnostic[] = [];
  const manifestText = sources.find(
    (source) => normalizePath(source.relativePath) === "codegen.manifest.json",
  )?.text;

  for (const source of [...sources].sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"))) {
    const relativePath = normalizePath(source.relativePath);
    if (relativePath.startsWith("app/") && relativePath.endsWith(".ts")) {
      analyzeTypeScript(
        { ...source, relativePath },
        declarations,
        messageTypes,
        msgcodes,
        protocols,
        handlers,
        diagnostics,
      );
    } else if (relativePath.startsWith("configs/") && relativePath.endsWith(".json")) {
      analyzeConfig({ ...source, relativePath }, processes, machines, diagnostics);
    }
  }

  validateGeneratedIntegrity(sources, diagnostics);
  resolveProtocolCodes(protocols, msgcodes);
  validateProject(processes, machines, declarations, protocols, handlers, diagnostics);
  return {
    environments: [...new Set([
      ...processes.map((process) => process.environment),
      ...machines.map((machine) => machine.environment),
    ])].sort((left, right) => left.localeCompare(right, "en")),
    processes,
    machines,
    declarations,
    messageTypes,
    msgcodes,
    protocols,
    handlers,
    generators: readProjectGenerators(manifestText),
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
  const debug = processDebugConfig(value.process.debug);
  processes.push({
    environment,
    name: value.process.name,
    relativePath: source.relativePath,
    ...(debug ? { debug } : {}),
    scenes: sceneConfigs(value.scenes),
    knownScenes: sceneConfigs(value.knownScenes),
  });
}

function processDebugConfig(value: unknown) {
  if (!isRecord(value) || typeof value.inspectorPort !== "number") return undefined;
  return {
    inspectorIp: typeof value.inspectorIp === "string" ? value.inspectorIp : "127.0.0.1",
    inspectorPort: value.inspectorPort,
    breakOnStart: value.breakOnStart === true,
    allowRemote: value.allowRemote === true,
  };
}

function analyzeTypeScript(
  source: ProjectSource,
  declarations: TypeDeclarationModel[],
  messageTypes: MessageTypeModel[],
  msgcodes: MsgCodeModel[],
  protocols: ProtocolDescriptorModel[],
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
  analyzeGeneratedProtocol(sourceFile, source.relativePath, messageTypes, msgcodes, protocols);
  validateTypeScriptDependencies(sourceFile, source.relativePath, diagnostics);
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
  const handlerSignature = projectHandlerSignature(sourceFile, declaration);
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
        ...handlerSignature,
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
      if (decoratorName !== "rpc" && decoratorName !== "message" && decoratorName !== "handler") continue;
      handlers.push({
        kind: decoratorName === "rpc" ? "rpc" : decoratorName === "message" ? "message" : "actorMethod",
        name: `${className}.${methodName}`,
        owner: className,
        target: className,
        descriptor: call.arguments[0]?.getText(sourceFile) ?? methodName,
        ...projectMethodSignature(sourceFile, member, decoratorName),
        location: sourceLocation(sourceFile, member.name.getStart(sourceFile), relativePath),
      });
    }
    if (member.body) {
      collectProgrammaticHandlers(sourceFile, relativePath, member.body, className, methodName, handlers);
    }
  }
}

function collectProgrammaticHandlers(
  sourceFile: ts.SourceFile,
  relativePath: string,
  root: ts.Node,
  className: string,
  methodName: string,
  handlers: HandlerModel[],
): void {
  visit(root);

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
      && node.expression.name.text === "registerActorRpc") {
      const descriptor = node.arguments[0]?.getText(sourceFile);
      if (descriptor) {
        handlers.push({
          kind: "actorRpc",
          name: `${className}.${methodName}`,
          owner: className,
          target: className,
          descriptor,
          location: sourceLocation(sourceFile, node.expression.name.getStart(sourceFile), relativePath),
        });
      }
    }
    ts.forEachChild(node, visit);
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
  protocols: readonly ProtocolDescriptorModel[],
  handlers: readonly HandlerModel[],
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
  validateHandlers(protocols, handlers, diagnostics);
}

function analyzeGeneratedProtocol(
  sourceFile: ts.SourceFile,
  relativePath: string,
  messageTypes: MessageTypeModel[],
  msgcodes: MsgCodeModel[],
  protocols: ProtocolDescriptorModel[],
): void {
  const isServerProtocol = relativePath.includes("/generated/model/server/");
  if (relativePath.endsWith("/protocol/messages.ts")) {
    for (const statement of sourceFile.statements) {
      if (!ts.isInterfaceDeclaration(statement) || !statement.name) continue;
      messageTypes.push({
        name: statement.name.text,
        location: sourceLocation(sourceFile, statement.name.getStart(sourceFile), relativePath),
      });
    }
  }
  if (relativePath.endsWith("/protocol/msgcodes.ts")) {
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer ? unwrapExpression(declaration.initializer) : undefined;
        if (!initializer || !ts.isObjectLiteralExpression(initializer)) continue;
        for (const property of initializer.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isNumericLiteral(property.initializer)) continue;
          const name = propertyName(property.name);
          if (!name) continue;
          msgcodes.push({
            name,
            value: Number(property.initializer.text),
            location: sourceLocation(sourceFile, property.name.getStart(sourceFile), relativePath),
          });
        }
      }
    }
  }
  if (!isServerProtocol || (!relativePath.endsWith("/protocol/rpcs.ts")
    && !relativePath.endsWith("/protocol/messageDescriptors.ts"))) return;
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer
        || !ts.isObjectLiteralExpression(declaration.initializer)) continue;
      const group = declaration.name.text;
      for (const property of declaration.initializer.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isCallExpression(property.initializer)) continue;
        const call = property.initializer;
        const factory = expressionName(call.expression);
        if (factory !== "defineRpc" && factory !== "defineMessage") continue;
        const options = call.arguments[0];
        if (!options || !ts.isObjectLiteralExpression(options)) continue;
        const member = propertyName(property.name);
        if (!member) continue;
        const common = {
          symbol: `${group}.${member}`,
          group,
          member,
          name: objectStringProperty(options, "name") ?? `${group}.${member}`,
          routing: objectStringProperty(options, "routing"),
          expectsHandler: group !== "ClientMessages",
          location: sourceLocation(sourceFile, property.name.getStart(sourceFile), relativePath),
        };
        if (factory === "defineRpc") {
          protocols.push(compactProtocol({
            kind: "rpc",
            ...common,
            requestType: typeArgumentText(sourceFile, call, 0),
            responseType: typeArgumentText(sourceFile, call, 1),
            requestCodeName: objectQualifiedProperty(options, "requestCode"),
            responseCodeName: objectQualifiedProperty(options, "responseCode"),
          }));
        } else {
          protocols.push(compactProtocol({
            kind: "message",
            ...common,
            messageType: typeArgumentText(sourceFile, call, 0),
            msgcodeName: objectQualifiedProperty(options, "msgcode"),
          }));
        }
      }
    }
  }
}

function projectHandlerSignature(
  sourceFile: ts.SourceFile,
  declaration: ts.ClassDeclaration,
): Pick<HandlerModel, "requestType" | "responseType" | "messageType"> {
  for (const clause of declaration.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
    for (const type of clause.types) {
      const name = expressionName(type.expression);
      const args = type.typeArguments?.map((argument) => argument.getText(sourceFile)) ?? [];
      if (name === "SessionRpcHandler") {
        return compactSignature({ requestType: args[2], responseType: args[3] });
      }
      if (name === "SceneRpcHandler" || name === "UnitRpcHandler" || name === "ActorRpcHandler") {
        return compactSignature({ requestType: args[1], responseType: args[2] });
      }
      if (name === "SessionMessageHandler") {
        return compactSignature({ messageType: args[2] });
      }
      if (name === "SceneMessageHandler" || name === "UnitMessageHandler" || name === "ActorMessageHandler") {
        return compactSignature({ messageType: args[1] });
      }
    }
  }
  return {};
}

function projectMethodSignature(
  sourceFile: ts.SourceFile,
  method: ts.MethodDeclaration,
  decoratorName: string,
): Pick<HandlerModel, "requestType" | "responseType" | "messageType"> {
  const request = method.parameters[0]?.type?.getText(sourceFile);
  if (decoratorName === "handler" || decoratorName === "message") {
    return compactSignature({ messageType: request });
  }
  const response = unwrapPromiseType(method.type?.getText(sourceFile));
  return compactSignature({ requestType: request, responseType: response });
}

function validateHandlers(
  protocols: readonly ProtocolDescriptorModel[],
  handlers: readonly HandlerModel[],
  diagnostics: ProjectDiagnostic[],
): void {
  const protocolBySymbol = new Map(protocols.map((protocol) => [protocol.symbol, protocol]));
  const handlersByProtocol = new Map<string, HandlerModel[]>();
  const bindingKeys = new Map<string, HandlerModel>();
  for (const handler of handlers) {
    if (handler.kind === "actorMethod") continue;
    const symbol = normalizeDescriptorReference(handler.descriptor);
    const protocol = protocolBySymbol.get(symbol);
    if (!protocol) continue;
    const linked = handlersByProtocol.get(symbol) ?? [];
    linked.push(handler);
    handlersByProtocol.set(symbol, linked);
    const bindingKey = `${handler.target}|${symbol}`;
    const previous = bindingKeys.get(bindingKey);
    if (previous) {
      diagnostics.push({
        code: "tiangz.handler.duplicate",
        severity: "error",
        message: `${handler.target} 对协议 ${protocol.name} 重复注册 Handler：${previous.name}、${handler.name}`,
        location: handler.location,
      });
    } else {
      bindingKeys.set(bindingKey, handler);
    }
    if (protocol.kind === "rpc") {
      if (handler.requestType && protocol.requestType && !typeMatches(handler.requestType, protocol.requestType)) {
        diagnostics.push(typeMismatch(handler, protocol, "Request", protocol.requestType, handler.requestType));
      }
      if (handler.responseType && protocol.responseType && !typeMatches(handler.responseType, protocol.responseType)) {
        diagnostics.push(typeMismatch(handler, protocol, "Response", protocol.responseType, handler.responseType));
      }
    } else if (handler.messageType && protocol.messageType && !typeMatches(handler.messageType, protocol.messageType)) {
      diagnostics.push(typeMismatch(handler, protocol, "Message", protocol.messageType, handler.messageType));
    }
  }
  for (const protocol of protocols) {
    if (!protocol.expectsHandler || handlersByProtocol.has(protocol.symbol)) continue;
    diagnostics.push({
      code: "tiangz.handler.missing",
      severity: "warning",
      message: `协议 ${protocol.name}（${protocol.symbol}）没有找到 Handler`,
      location: protocol.location,
    });
  }
}

function typeMismatch(
  handler: HandlerModel,
  protocol: ProtocolDescriptorModel,
  role: string,
  expected: string,
  actual: string,
): ProjectDiagnostic {
  return {
    code: "tiangz.handler.rpc-type-mismatch",
    severity: "error",
    message: `${handler.name} 的 ${role} 类型为 ${actual}，协议 ${protocol.name} 要求 ${expected}`,
    location: handler.location,
  };
}

function resolveProtocolCodes(protocols: ProtocolDescriptorModel[], msgcodes: readonly MsgCodeModel[]): void {
  const values = new Map(msgcodes.map((code) => [code.name, code.value]));
  for (let index = 0; index < protocols.length; index += 1) {
    const protocol = protocols[index]!;
    protocols[index] = {
      ...protocol,
      ...(protocol.requestCodeName && values.has(protocol.requestCodeName)
        ? { requestCode: values.get(protocol.requestCodeName)! } : {}),
      ...(protocol.responseCodeName && values.has(protocol.responseCodeName)
        ? { responseCode: values.get(protocol.responseCodeName)! } : {}),
      ...(protocol.msgcodeName && values.has(protocol.msgcodeName)
        ? { msgcode: values.get(protocol.msgcodeName)! } : {}),
    };
  }
}

function compactProtocol(
  value: { [Key in keyof ProtocolDescriptorModel]?: ProtocolDescriptorModel[Key] | undefined },
): ProtocolDescriptorModel {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as unknown as ProtocolDescriptorModel;
}

function compactSignature(
  value: {
    requestType?: string | undefined;
    responseType?: string | undefined;
    messageType?: string | undefined;
  },
): Pick<HandlerModel, "requestType" | "responseType" | "messageType"> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function typeArgumentText(sourceFile: ts.SourceFile, call: ts.CallExpression, index: number): string | undefined {
  return call.typeArguments?.[index]?.getText(sourceFile);
}

function objectQualifiedProperty(node: ts.ObjectLiteralExpression, name: string): string | undefined {
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) || propertyName(property.name) !== name) continue;
    const text = property.initializer.getText();
    return text.startsWith("MsgCode.") ? text.slice("MsgCode.".length) : text;
  }
  return undefined;
}

function normalizeDescriptorReference(value: string): string {
  return value.endsWith(".name") ? value.slice(0, -".name".length) : value;
}

function unwrapPromiseType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Promise<(.+)>$/.exec(value);
  return match?.[1] ?? value;
}

function typeMatches(actual: string, expected: string): boolean {
  const normalizedExpected = expected.replaceAll(" ", "");
  return actual.split("|").some((candidate) => {
    const normalized = candidate.trim().replaceAll(" ", "");
    return normalized === normalizedExpected || normalized === `Promise<${normalizedExpected}>`;
  });
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)
    || ts.isParenthesizedExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression;
  }
  return current;
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
