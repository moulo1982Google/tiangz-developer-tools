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
  ["syncEventHandler", "syncEvent"],
  ["asyncEventHandler", "asyncEvent"],
]);

interface LifecycleModelContract {
  readonly name: string;
  readonly requiredMethods: readonly string[];
  readonly transferMethods: readonly string[];
  readonly ownMethods: ReadonlySet<string>;
  readonly ownAsyncMethods: ReadonlySet<string>;
  readonly location: SourceLocation;
}

interface LifecycleSystemContract {
  readonly target: string;
  readonly methods: ReadonlyMap<string, { readonly async: boolean; readonly location: SourceLocation }>;
  readonly location: SourceLocation;
}

export function analyzeTiangZProject(sources: readonly ProjectSource[]): TiangZProjectSnapshot {
  const processes: ProcessConfigModel[] = [];
  const machines: MachineConfigModel[] = [];
  const declarations: TypeDeclarationModel[] = [];
  const messageTypes: MessageTypeModel[] = [];
  const msgcodes: MsgCodeModel[] = [];
  const protocols: ProtocolDescriptorModel[] = [];
  const handlers: HandlerModel[] = [];
  const diagnostics: ProjectDiagnostic[] = [];
  const lifecycleModels: LifecycleModelContract[] = [];
  const lifecycleSystems: LifecycleSystemContract[] = [];
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
        lifecycleModels,
        lifecycleSystems,
      );
    } else if (relativePath.startsWith("configs/") && relativePath.endsWith(".json")) {
      analyzeConfig({ ...source, relativePath }, processes, machines, diagnostics);
    }
  }

  resolveKnownSceneFiles(sources, processes, diagnostics);

  validateGeneratedIntegrity(sources, diagnostics);
  validateLifecycleContracts(lifecycleModels, lifecycleSystems, diagnostics);
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
  const identity = processIdentityConfig(value.process.identity);
  processes.push({
    environment,
    name: value.process.name,
    relativePath: source.relativePath,
    ...(identity ? { identity } : {}),
    ...(debug ? { debug } : {}),
    scenes: sceneConfigs(value.scenes),
    knownSceneFiles: stringArray(value.knownSceneFiles),
    knownScenes: sceneConfigs(value.knownScenes),
  });
}

/** 展开共享Scene目录，并复用Runtime的同名、同端点冲突语义。 / Expands shared Scene catalogs using the Runtime's name and endpoint conflict rules. */
function resolveKnownSceneFiles(
  sources: readonly ProjectSource[],
  processes: ProcessConfigModel[],
  diagnostics: ProjectDiagnostic[],
): void {
  const sourcesByPath = new Map(
    sources.map((source) => [normalizePath(source.relativePath), source]),
  );
  for (let index = 0; index < processes.length; index += 1) {
    const process = processes[index]!;
    const merged = [...process.scenes];
    for (const knownSceneFile of process.knownSceneFiles) {
      const sharedPath = path.posix.normalize(path.posix.join(
        path.posix.dirname(process.relativePath),
        knownSceneFile.replaceAll("\\", "/"),
      ));
      const source = sourcesByPath.get(sharedPath);
      if (!source) {
        diagnostics.push({
          code: "tiangz.config.missing-known-scene-file",
          severity: "error",
          message: `${process.name}引用的共享Scene目录不存在：${knownSceneFile}`,
          location: fileLocation(process.relativePath),
        });
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(source.text);
      } catch {
        // analyzeConfig已经为这份JSON生成精确诊断，避免重复报告。
        continue;
      }
      if (!isRecord(value) || !Array.isArray(value.knownScenes)) {
        diagnostics.push({
          code: "tiangz.config.invalid-known-scene-file",
          severity: "error",
          message: `共享Scene目录必须包含knownScenes数组：${knownSceneFile}`,
          location: fileLocation(sharedPath),
        });
        continue;
      }
      mergeKnownScenes(merged, sceneConfigs(value.knownScenes), sharedPath, process, diagnostics);
    }
    mergeKnownScenes(merged, process.knownScenes, process.relativePath, process, diagnostics);
    processes[index] = { ...process, knownScenes: merged };
  }
}

function mergeKnownScenes(
  merged: SceneConfigModel[],
  additions: readonly SceneConfigModel[],
  sourcePath: string,
  process: ProcessConfigModel,
  diagnostics: ProjectDiagnostic[],
): void {
  for (const addition of additions) {
    const sameName = merged.find((scene) => scene.name === addition.name);
    if (sameName) {
      if (sameSceneRoute(sameName, addition)) continue;
      diagnostics.push({
        code: "tiangz.config.conflicting-known-scene",
        severity: "error",
        message: `${process.name}合并${sourcePath}时，Scene ${addition.name}与已有路由冲突`,
        location: fileLocation(process.relativePath),
      });
      continue;
    }
    const sameEndpoint = addition.ip !== undefined && addition.port !== undefined
      ? merged.find((scene) => scene.ip === addition.ip && scene.port === addition.port)
      : undefined;
    if (sameEndpoint) {
      diagnostics.push({
        code: "tiangz.config.duplicate-known-scene-endpoint",
        severity: "error",
        message: `${process.name}合并${sourcePath}时，${addition.name}复用了${sameEndpoint.name}的端点${addition.ip}:${addition.port}`,
        location: fileLocation(process.relativePath),
      });
      continue;
    }
    merged.push(addition);
  }
}

function sameSceneRoute(left: SceneConfigModel, right: SceneConfigModel): boolean {
  return left.name === right.name
    && left.sceneType === right.sceneType
    && left.ip === right.ip
    && left.port === right.port
    && (left.protocol ?? "auto") === (right.protocol ?? "auto")
    && (left.audience ?? "mixed") === (right.audience ?? "mixed");
}

function processIdentityConfig(value: unknown) {
  if (!isRecord(value)) return undefined;
  if (typeof value.originServerId !== "number" || typeof value.workerId !== "number") return undefined;
  return {
    originServerId: value.originServerId,
    workerId: value.workerId,
  };
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
  lifecycleModels: LifecycleModelContract[],
  lifecycleSystems: LifecycleSystemContract[],
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
  validateRuntimeShapeStability(sourceFile, source.relativePath, diagnostics);
  validateOwnedComponentBoundaries(sourceFile, source.relativePath, diagnostics);
  validateRuntimeFoundationUsage(sourceFile, source.relativePath, diagnostics);
  visit(sourceFile);

  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node) && node.name) {
      analyzeClass(sourceFile, source.relativePath, node, declarations, handlers);
      collectLifecycleContract(
        sourceFile,
        source.relativePath,
        node,
        lifecycleModels,
        lifecycleSystems,
        diagnostics,
      );
    }
    ts.forEachChild(node, visit);
  }
}

/** 收集Model声明与System实现，不创建TypeScript Program。 / Collects Model declarations and System implementations without creating a TypeScript Program. */
function collectLifecycleContract(
  sourceFile: ts.SourceFile,
  relativePath: string,
  declaration: ts.ClassDeclaration,
  models: LifecycleModelContract[],
  systems: LifecycleSystemContract[],
  diagnostics: ProjectDiagnostic[],
): void {
  const normalized = normalizePath(relativePath);
  const decorators = decoratorsOf(declaration);
  const systemDecorator = decorators.find((decorator) => {
    const call = decoratorCall(decorator);
    return expressionName(call?.expression ?? decorator.expression) === "systemFor";
  });
  if (normalized.startsWith("app/hotfix/") && systemDecorator) {
    const call = decoratorCall(systemDecorator);
    const target = call?.arguments[0];
    if (!target || !ts.isIdentifier(target)) return;
    const methods = new Map<string, { async: boolean; location: SourceLocation }>();
    for (const member of declaration.members) {
      if (!ts.isMethodDeclaration(member) || !member.name) continue;
      const name = member.name.getText(sourceFile);
      methods.set(name, {
        async: ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false,
        location: sourceLocation(sourceFile, member.name.getStart(sourceFile), relativePath),
      });
    }
    systems.push({
      target: target.text,
      methods,
      location: sourceLocation(sourceFile, declaration.name!.getStart(sourceFile), relativePath),
    });
    return;
  }
  if (!normalized.startsWith("app/model/")) return;

  const requiredMethods: string[] = [];
  const lifecycleDecorator = decorators.find((decorator) => {
    const call = decoratorCall(decorator);
    return expressionName(call?.expression ?? decorator.expression) === "lifecycle";
  });
  if (lifecycleDecorator) {
    const options = decoratorCall(lifecycleDecorator)?.arguments[0];
    if (options && ts.isObjectLiteralExpression(options)) {
      const names = new Map([["awake", "Awake"], ["destroy", "OnDestroy"], ["deserialize", "Deserialize"]]);
      for (const property of options.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)
          || property.initializer.kind !== ts.SyntaxKind.TrueKeyword) continue;
        const method = names.get(property.name.text);
        if (method) requiredMethods.push(method);
      }
    } else {
      diagnostics.push({
        code: "tiangz.lifecycle.invalid-declaration",
        severity: "error",
        message: "@lifecycle必须使用对象字面量，并且只把需要的awake、destroy、deserialize设为true。",
        location: sourceLocation(sourceFile, lifecycleDecorator.getStart(sourceFile), relativePath),
      });
    }
  }
  const transferable = decorators.some((decorator) => {
    const call = decoratorCall(decorator);
    return expressionName(call?.expression ?? decorator.expression) === "transferable";
  });
  if (!lifecycleDecorator && !transferable) return;
  const ownMethods = new Set<string>();
  const ownAsyncMethods = new Set<string>();
  for (const member of declaration.members) {
    if (!ts.isMethodDeclaration(member) || !member.name) continue;
    const name = member.name.getText(sourceFile);
    ownMethods.add(name);
    if (ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
      ownAsyncMethods.add(name);
    }
  }
  models.push({
    name: declaration.name!.text,
    requiredMethods,
    transferMethods: transferable ? ["CaptureTransfer", "RestoreTransfer"] : [],
    ownMethods,
    ownAsyncMethods,
    location: sourceLocation(sourceFile, declaration.name!.getStart(sourceFile), relativePath),
  });
}

/** 校验声明过的能力一定有同步实现。 / Validates that every declared capability has a synchronous implementation. */
function validateLifecycleContracts(
  models: readonly LifecycleModelContract[],
  systems: readonly LifecycleSystemContract[],
  diagnostics: ProjectDiagnostic[],
): void {
  for (const model of models) {
    const matches = systems.filter((system) => system.target === model.name);
    const system = matches.length === 1 ? matches[0] : undefined;
    if (model.requiredMethods.length > 0 && !system) {
      diagnostics.push({
        code: "tiangz.lifecycle.missing-system",
        severity: "error",
        message: `${model.name}声明了Hotfix生命周期，但没有找到唯一的@systemFor(${model.name})实现。`,
        location: model.location,
      });
      continue;
    }
    for (const method of model.requiredMethods) validateMethod(model, system, method, false);
    for (const method of model.transferMethods) {
      if (model.ownMethods.has(method)) {
        if (model.ownAsyncMethods.has(method)) {
          diagnostics.push({
            code: "tiangz.lifecycle.async-method",
            severity: "error",
            message: `${model.name}.${method}是迁移生命周期方法，不能声明为async。`,
            location: model.location,
          });
        }
        continue;
      }
      validateMethod(model, system, method, true);
    }
  }

  function validateMethod(
    model: LifecycleModelContract,
    system: LifecycleSystemContract | undefined,
    method: string,
    transfer: boolean,
  ): void {
    const implementation = system?.methods.get(method);
    if (!implementation) {
      diagnostics.push({
        code: "tiangz.lifecycle.missing-method",
        severity: "error",
        message: `${model.name}${transfer ? "使用了@transferable" : "声明了生命周期"}，但缺少同步方法${method}。`,
        location: system?.location ?? model.location,
      });
      return;
    }
    if (implementation.async) {
      diagnostics.push({
        code: "tiangz.lifecycle.async-method",
        severity: "error",
        message: `${model.name}.${method}是生命周期方法，不能声明为async。`,
        location: implementation.location,
      });
    }
  }
}

/**
 * 检查Component集合所有权和Handler的Native句柄边界，只报告可以从单文件语法确定的问题。
 * Checks Component collection ownership and Handler Native-handle boundaries,
 * reporting only issues that can be determined from single-file syntax.
 */
function validateOwnedComponentBoundaries(
  sourceFile: ts.SourceFile,
  relativePath: string,
  diagnostics: ProjectDiagnostic[],
): void {
  if (!isBusinessRuntimeSource(relativePath)) return;

  if (normalizePath(relativePath).includes("/handlers/")) {
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings
        || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
      for (const element of statement.importClause.namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (!/^Native[A-Za-z0-9_]*Ref$/.test(importedName)) continue;
        report(
          element.name,
          "tiangz.architecture.native-ref-in-handler",
          "Handler不应直接依赖可变Native Ref；请通过所属Component执行修改，查询时使用只读View或Snapshot。",
        );
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || !isComponentClass(statement)) continue;
    for (const member of statement.members) {
      if (!ts.isPropertyDeclaration(member) || !member.name || hasStaticModifier(member)) continue;
      if (hasNonPublicModifier(member) || !isMutableCollectionProperty(member)) continue;
      report(
        member.name,
        "tiangz.architecture.component-public-collection",
        "Component不应公开可变Map或Set；请将集合设为private/protected，并通过查询和领域方法维护所有权。",
      );
    }
  }

  function report(node: ts.Node, code: string, message: string): void {
    diagnostics.push({
      code,
      severity: "warning",
      message,
      location: sourceLocation(sourceFile, node.getStart(sourceFile), relativePath),
    });
  }
}

/** 校验Timer、Scene Event和持久化运行时ID的高置信用法。 / Validates high-confidence Timer, Scene Event, and persisted runtime-ID usage. */
function validateRuntimeFoundationUsage(
  sourceFile: ts.SourceFile,
  relativePath: string,
  diagnostics: ProjectDiagnostic[],
): void {
  if (!isBusinessRuntimeSource(relativePath)) return;

  for (const statement of sourceFile.statements) {
    if (ts.isClassDeclaration(statement) && statement.name) validateClass(statement);
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      validatePersistenceShape(statement);
    }
  }

  function validateClass(declaration: ts.ClassDeclaration): void {
    const methods = new Map<string, ts.MethodDeclaration>();
    for (const member of declaration.members) {
      if (!ts.isMethodDeclaration(member) || !member.name) continue;
      methods.set(propertyName(member.name) ?? member.name.getText(sourceFile), member);
    }

    const eventDecorator = decoratorsOf(declaration).map((decorator) => {
      const call = decoratorCall(decorator);
      return expressionName(call?.expression ?? decorator.expression);
    }).find((name) => name === "syncEventHandler" || name === "asyncEventHandler");
    if (eventDecorator) validateEventHandler(declaration, methods.get("Handle"), eventDecorator);

    for (const member of declaration.members) {
      if (ts.isMethodDeclaration(member) && member.body) visit(member.body);
    }

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const callName = node.expression.name.text;
        if (callName === "NewOnceTimer" || callName === "NewRepeatedTimer") {
          validateOwnedTimerCall(node, methods);
        } else if (callName === "RemoveTimer") {
          report(
            node.expression.name,
            "tiangz.timer.legacy-remove",
            "RemoveTimer仅保留兼容语义；新业务请使用CancelTimer(timerId, reason)，明确正常结束与主动中断。",
            "warning",
          );
        } else if (callName === "PublishAsync" && !isAwaitedOrReturned(node)) {
          report(
            node.expression.name,
            "tiangz.event.unawaited-async",
            "异步Scene Event必须await或直接return，避免发布方在监听器完成前继续执行。",
            "error",
          );
        }
      }
      ts.forEachChild(node, visit);
    }
  }

  function validateOwnedTimerCall(
    call: ts.CallExpression,
    methods: ReadonlyMap<string, ts.MethodDeclaration>,
  ): void {
    const callbackName = stringLiteral(call.arguments[1]);
    if (callbackName && !methods.has(callbackName)) {
      report(
        call.arguments[1]!,
        "tiangz.timer.missing-method",
        `当前文件未找到Timer方法${callbackName}；请确认它能由当前Hotfix prototype或继承链解析。`,
        "warning",
      );
    }
    const options = call.arguments[3];
    if (!options || !ts.isObjectLiteralExpression(options)) return;
    const cancellation = options.properties.find((property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && propertyName(property.name) === "onCancelled"
    );
    const cancellationInitializer = cancellation?.initializer;
    const cancellationName = cancellationInitializer ? stringLiteral(cancellationInitializer) : undefined;
    if (!cancellationName) return;
    const method = methods.get(cancellationName);
    if (!method) {
      report(
        cancellationInitializer!,
        "tiangz.timer.missing-cancel-method",
        `当前文件未找到Timer取消回调${cancellationName}；请确认它能由当前Hotfix prototype或继承链解析。`,
        "warning",
      );
    } else if (method.parameters.length < 2) {
      report(
        method.name,
        "tiangz.timer.invalid-cancel-method",
        `${cancellationName}必须接收(args, context)两个参数，context用于区分取消原因。`,
        "error",
      );
    }
  }

  function validateEventHandler(
    declaration: ts.ClassDeclaration,
    handle: ts.MethodDeclaration | undefined,
    decoratorName: string,
  ): void {
    if (!handle) {
      report(
        declaration.name!,
        "tiangz.event.missing-handle",
        `${decoratorName}类必须实现Handle方法。`,
        "error",
      );
      return;
    }
    const asyncModifier = ts.getModifiers(handle)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
    const promiseReturn = handle.type?.getText(sourceFile).replaceAll(" ", "").startsWith("Promise<") ?? false;
    if (decoratorName === "syncEventHandler" && (asyncModifier || promiseReturn)) {
      report(
        handle.name,
        "tiangz.event.sync-handler-async",
        "同步Scene Event Handler必须返回void，不能声明为async或Promise。",
        "error",
      );
    }
    if (decoratorName === "asyncEventHandler" && !asyncModifier && !promiseReturn) {
      report(
        handle.name,
        "tiangz.event.async-handler-sync",
        "异步Scene Event Handler必须声明async或显式返回Promise<void>。",
        "error",
      );
    }
  }

  function validatePersistenceShape(declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration): void {
    if (!/(?:Persistence|Persistent|Database|DB)/.test(declaration.name.text)) return;
    const members = ts.isInterfaceDeclaration(declaration)
      ? declaration.members
      : ts.isTypeLiteralNode(declaration.type) ? declaration.type.members : [];
    for (const member of members) {
      if (!ts.isPropertySignature(member) || !member.type || !member.name) continue;
      const type = member.type.getText(sourceFile);
      if (type !== "InstanceId" && type !== "TimerId") continue;
      report(
        member.name,
        "tiangz.persistence.runtime-id",
        `${type}只在当前Process生命周期内有效，不能写入持久化Snapshot。请保存稳定业务Id或墙钟deadline。`,
        "error",
      );
    }
  }

  function report(
    node: ts.Node,
    code: string,
    message: string,
    severity: "error" | "warning",
  ): void {
    diagnostics.push({
      code,
      severity,
      message,
      location: sourceLocation(sourceFile, node.getStart(sourceFile), relativePath),
    });
  }
}

/** PublishAsync只有被await或作为当前函数结果返回时才有完成语义。 / PublishAsync has completion semantics only when awaited or returned. */
function isAwaitedOrReturned(call: ts.CallExpression): boolean {
  let parent: ts.Node = call.parent;
  while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
  return ts.isAwaitExpression(parent)
    || ts.isReturnStatement(parent)
    || ts.isVariableDeclaration(parent)
    || (ts.isArrowFunction(parent) && parent.body === call);
}

/** 判断类是否为Component状态或其System行为类。 / Determines whether a class is a Component state or System behavior class. */
function isComponentClass(declaration: ts.ClassDeclaration): boolean {
  if (decoratorsOf(declaration).some((decorator) => {
    const call = decoratorCall(decorator);
    return expressionName(call?.expression ?? decorator.expression) === "component";
  })) return true;
  const heritage = declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
  return /Component$/.test(heritage?.types[0]?.expression.getText() ?? "");
}

/** 检查字段是否声明或初始化为可变Map/Set。 / Checks whether a field is declared or initialized as a mutable Map/Set. */
function isMutableCollectionProperty(property: ts.PropertyDeclaration): boolean {
  if (property.type && ts.isTypeReferenceNode(property.type)) {
    const name = property.type.typeName.getText();
    if (name === "Map" || name === "Set") return true;
  }
  return !!property.initializer
    && ts.isNewExpression(property.initializer)
    && (property.initializer.expression.getText() === "Map" || property.initializer.expression.getText() === "Set");
}

/** private/protected字段由Component内部拥有，不属于公共可变集合。 / Private/protected fields remain owned by the Component and are not public mutable collections. */
function hasNonPublicModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword
      || modifier.kind === ts.SyntaxKind.ProtectedKeyword,
  ) ?? false;
}

/**
 * 对业务运行时类执行高置信、低噪音的 V8 对象形状检查。
 * Performs high-confidence, low-noise V8 object-shape checks for business runtime classes.
 *
 * 这里只使用语法树，不创建第二套 TypeScript Program，避免语言服务器重复占用工程级类型检查内存。
 * This intentionally uses syntax only and does not create a second TypeScript Program, avoiding duplicate project-wide type-checker memory in the language server.
 */
function validateRuntimeShapeStability(
  sourceFile: ts.SourceFile,
  relativePath: string,
  diagnostics: ProjectDiagnostic[],
): void {
  if (!isBusinessRuntimeSource(relativePath)) return;
  visit(sourceFile, false);

  function visit(node: ts.Node, insideRuntimeClass: boolean): void {
    const runtimeClass = ts.isClassDeclaration(node) && isRuntimeStateClass(node);
    const inside = insideRuntimeClass || runtimeClass;
    if (runtimeClass) validateRuntimeClassFields(node);
    if (inside && ts.isDeleteExpression(node)) report(
      node,
      "delete 会改变对象字段布局，可能让 V8 热点属性访问退化；请保留字段并写入稳定的空值。",
    );
    if (inside && ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)
      && writesThroughAnyAssertion(node.left)) {
      report(
        node.left,
        "通过 as any 写入字段会绕过类型约束，并可能改变对象形状或字段存储种类。",
      );
    }
    ts.forEachChild(node, (child) => visit(child, inside));
  }

  function validateRuntimeClassFields(declaration: ts.ClassDeclaration): void {
    for (const member of declaration.members) {
      if (!ts.isPropertyDeclaration(member) || !member.name || hasStaticModifier(member)) continue;
      if (member.questionToken) {
        report(member.name, "长期状态字段不能使用可选属性；请给出稳定默认值，或使用显式对象空值表达业务状态。");
        continue;
      }
      if (member.type && containsAnyType(member.type)) {
        report(member.name, "运行时状态字段不应使用 any；请声明稳定类型，动态键值请显式使用 Map 或 Record。");
        continue;
      }
      if (member.type && hasMixedPrimitiveUnion(member.type)) {
        report(
          member.name,
          "该字段的联合类型跨越不同运行时存储种类，热点写入可能反复改变 V8 类型反馈；建议拆分字段。",
        );
        continue;
      }
      if (member.type && hasPrimitiveUndefinedUnion(member.type)) {
        report(
          member.name,
          "基本类型状态字段不能包含 undefined；请让 number/string/boolean 等字段在整个生命周期保持同一种类型。",
        );
      }
    }
  }

  function report(node: ts.Node, message: string): void {
    diagnostics.push({
      code: "tiangz.performance.unstable-shape",
      severity: normalizePath(relativePath).startsWith("app/model/") ? "error" : "warning",
      message,
      location: sourceLocation(sourceFile, node.getStart(sourceFile), relativePath),
    });
  }
}

/** 检查基本类型字段是否允许写入 undefined；这会破坏长期状态的固定类型约束。 / Checks whether a primitive state field admits undefined, which breaks its stable lifetime type. */
function hasPrimitiveUndefinedUnion(type: ts.TypeNode): boolean {
  if (!ts.isUnionTypeNode(type)) return false;
  const hasUndefined = type.types.some((part) => part.kind === ts.SyntaxKind.UndefinedKeyword);
  return hasUndefined && type.types.some((part) => primitiveTypeCategory(part) !== undefined);
}

/** 判断源码是否属于需要性能建议的业务 Model/Hotfix，压测代码不参与。 / Determines whether a source belongs to business Model/Hotfix code that should receive performance advice; benchmark code is excluded. */
function isBusinessRuntimeSource(relativePath: string): boolean {
  const normalized = normalizePath(relativePath);
  return (normalized.startsWith("app/model/") || normalized.startsWith("app/hotfix/"))
    && !normalized.includes("/bench/");
}

/** 识别承载长期状态或其 Hotfix 行为的 Scene、Entity、Unit、Actor 与 Component 类。 / Recognizes Scene, Entity, Unit, Actor, and Component classes that carry long-lived state or Hotfix behavior. */
function isRuntimeStateClass(declaration: ts.ClassDeclaration): boolean {
  const runtimeDecorators = new Set([
    "entryScene",
    "scene",
    "actor",
    "component",
    "hotfixFor",
    "systemFor",
  ]);
  if (decoratorsOf(declaration).some((decorator) => {
    const call = decoratorCall(decorator);
    return runtimeDecorators.has(expressionName(call?.expression ?? decorator.expression));
  })) return true;
  const heritage = declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
  const baseName = heritage?.types[0]?.expression.getText() ?? "";
  return /(?:Scene|Entity|Unit|Actor|Component)$/.test(baseName);
}

/** 检查字段类型树中是否显式包含 any。 / Checks whether a field type tree explicitly contains any. */
function containsAnyType(type: ts.TypeNode): boolean {
  if (type.kind === ts.SyntaxKind.AnyKeyword) return true;
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) return type.types.some(containsAnyType);
  if (ts.isArrayTypeNode(type)) return containsAnyType(type.elementType);
  if (ts.isParenthesizedTypeNode(type)) return containsAnyType(type.type);
  return false;
}

/** 只将 number/string/boolean/bigint/symbol 之间的跨种类联合视为不稳定，保留空值和业务判别联合。 / Treats only unions across number/string/boolean/bigint/symbol as unstable, preserving nullability and business discriminated unions. */
function hasMixedPrimitiveUnion(type: ts.TypeNode): boolean {
  if (!ts.isUnionTypeNode(type)) return false;
  const categories = new Set(type.types.map(primitiveTypeCategory).filter((value): value is string => value !== undefined));
  return categories.size > 1;
}

/** 将语法类型映射为 V8 可观察的基本存储种类。 / Maps a syntax type to a primitive storage category observable by V8. */
function primitiveTypeCategory(type: ts.TypeNode): string | undefined {
  switch (type.kind) {
    case ts.SyntaxKind.NumberKeyword: return "number";
    case ts.SyntaxKind.StringKeyword: return "string";
    case ts.SyntaxKind.BooleanKeyword: return "boolean";
    case ts.SyntaxKind.BigIntKeyword: return "bigint";
    case ts.SyntaxKind.SymbolKeyword: return "symbol";
    default:
      if (!ts.isLiteralTypeNode(type)) return undefined;
      if (ts.isStringLiteral(type.literal)) return "string";
      if (ts.isNumericLiteral(type.literal)) return "number";
      if (type.literal.kind === ts.SyntaxKind.TrueKeyword || type.literal.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
      return undefined;
  }
}

/** 判断赋值左侧的接收者是否通过 any 断言绕开了字段声明。 / Determines whether an assignment receiver bypasses field declarations through an any assertion. */
function writesThroughAnyAssertion(left: ts.Expression): boolean {
  const target = unwrapParentheses(left);
  if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return false;
  return hasAnyAssertion(target.expression);
}

/** 穿透括号寻找接收者上的 as any 或 <any> 断言。 / Walks through parentheses to find an as any or <any> assertion on the receiver. */
function hasAnyAssertion(expression: ts.Expression): boolean {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current))
    && current.type.kind === ts.SyntaxKind.AnyKeyword;
}

/** 去除赋值目标外层括号但保留类型断言供后续检查。 / Removes outer assignment-target parentheses while preserving type assertions for later inspection. */
function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/** 判断运算符是否会写回左值。 / Determines whether an operator writes back to its left-hand side. */
function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/** 判断类字段是否为静态字段，静态注册表不属于实例对象形状。 / Determines whether a class field is static; static registries do not affect instance object shape. */
function hasStaticModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false);
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
  validateProcessIdentities(processes, machines, diagnostics);
  validateHandlers(protocols, handlers, diagnostics);
}

/** 按每份StartMachine的真实引用集合检查全局ID槽位，备用配置不会被误判为并发部署。 / Validates global-ID slots using each StartMachine's referenced deployment set, excluding unused alternatives. */
function validateProcessIdentities(
  processes: readonly ProcessConfigModel[],
  machines: readonly MachineConfigModel[],
  diagnostics: ProjectDiagnostic[],
): void {
  const processByPath = new Map(processes.map((process) => [normalizePath(process.relativePath), process]));
  const startMachines = new Map<string, MachineConfigModel[]>();
  for (const machine of machines) {
    const group = startMachines.get(machine.relativePath) ?? [];
    group.push(machine);
    startMachines.set(machine.relativePath, group);
  }
  for (const [startMachinePath, group] of startMachines) {
    const slots = new Map<string, ProcessConfigModel>();
    for (const machine of group) {
      const directory = path.posix.dirname(machine.relativePath);
      for (const processFile of machine.processes) {
        const processPath = path.posix.normalize(path.posix.join(directory, processFile.replaceAll("\\", "/")));
        const process = processByPath.get(processPath);
        if (!process) continue;
        if (!process.identity) {
          diagnostics.push({
            code: "tiangz.config.missing-process-identity",
            severity: "error",
            message: `${process.name}由${path.posix.basename(startMachinePath)}启动，但缺少process.identity；请显式配置originServerId和workerId。`,
            location: fileLocation(process.relativePath),
          });
          continue;
        }
        const { originServerId, workerId } = process.identity;
        if (!Number.isInteger(originServerId) || originServerId < 1 || originServerId > 16_383
          || !Number.isInteger(workerId) || workerId < 0 || workerId > 127) {
          diagnostics.push({
            code: "tiangz.config.invalid-process-identity",
            severity: "error",
            message: `${process.name}的process.identity无效：originServerId范围1..16383，workerId范围0..127。`,
            location: fileLocation(process.relativePath),
          });
          continue;
        }
        const key = `${originServerId}:${workerId}`;
        const previous = slots.get(key);
        if (previous && previous.relativePath !== process.relativePath) {
          diagnostics.push({
            code: "tiangz.config.duplicate-process-identity",
            severity: "error",
            message: `${process.name}与${previous.name}在同一StartMachine复用了originServerId=${originServerId}、workerId=${workerId}。`,
            location: fileLocation(process.relativePath),
          });
        } else {
          slots.set(key, process);
        }
      }
    }
  }
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
      if (name === "SyncSceneEventHandler" || name === "AsyncSceneEventHandler") {
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
    if (handler.kind === "actorMethod" || handler.kind === "syncEvent" || handler.kind === "asyncEvent") continue;
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
      ...(typeof item.protocol === "string" ? { protocol: item.protocol } : {}),
      ...(typeof item.audience === "string" ? { audience: item.audience } : {}),
      staticMapIds: numberArray(item.staticMapIds),
      acceptDynamicMaps: item.acceptDynamicMaps === true,
    }];
  });
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : [];
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
