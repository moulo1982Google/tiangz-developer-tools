import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  analyzeTiangZProject,
  type HandlerModel,
  type ProjectSource,
  type ProtocolDescriptorModel,
  type SourceLocation,
  type TiangZProjectSnapshot,
} from "../../packages/project-core/src/index.js";
import {
  CodeLens,
  createConnection,
  DiagnosticSeverity,
  FileChangeType,
  MarkupKind,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
  type Definition,
  type Hover,
  type InitializeParams,
  type InitializeResult,
  type Location,
  type ReferenceParams,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

const INDEX_FILES_NOTIFICATION = "tiangzProject/indexFiles";
const SNAPSHOT_NOTIFICATION = "tiangzProject/snapshot";
const SERVER_STATS_REQUEST = "tiangzProject/serverStats";
const VALIDATION_DEBOUNCE_MS = 150;
const FILE_READ_CONCURRENCY = 8;

interface IndexedRootFiles {
  readonly rootUri: string;
  readonly uris: readonly string[];
}

interface CachedSource extends ProjectSource {
  readonly uri: string;
  readonly rootUri: string;
}

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const sources = new Map<string, CachedSource>();
const snapshots = new Map<string, TiangZProjectSnapshot>();
const publishedUris = new Set<string>();
const indexedUris = new Set<string>();
let rootUris: readonly string[] = [];
let validationTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;
let validationCount = 0;
let lastValidationMs = 0;
let maxValidationMs = 0;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  rootUris = (params.workspaceFolders ?? []).map((folder) => folder.uri);
  if (rootUris.length === 0 && params.rootUri) rootUris = [params.rootUri];
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      definitionProvider: true,
      referencesProvider: true,
      hoverProvider: true,
      codeLensProvider: { resolveProvider: false },
      workspace: { workspaceFolders: { supported: true } },
    },
  };
});

connection.onNotification(INDEX_FILES_NOTIFICATION, (value: unknown) => {
  const candidates = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.roots)
      ? value.roots
      : [];
  const groups = candidates.filter(isIndexedRootFiles);
  indexedUris.clear();
  for (const group of groups) {
    for (const uri of group.uris) indexedUris.add(uri);
  }
  for (const group of groups) {
    const nextUris = new Set(group.uris);
    for (const [uri, source] of sources) {
      if (source.rootUri === group.rootUri && !nextUris.has(uri) && !documents.get(uri)) sources.delete(uri);
    }
  }
  void loadFiles(groups);
});

connection.onDidChangeWatchedFiles((change) => {
  const changed: IndexedRootFiles[] = [];
  for (const event of change.changes) {
    if (!isProjectFile(event.uri)) continue;
    if (event.type === FileChangeType.Deleted) sources.delete(event.uri);
    else {
      const rootUri = resolveRootUri(event.uri);
      if (rootUri) changed.push({ rootUri, uris: [event.uri] });
    }
  }
  if (changed.length > 0) void loadFiles(changed);
  else scheduleValidation();
});

documents.onDidOpen((event) => updateOpenDocument(event.document));
documents.onDidChangeContent((event) => updateOpenDocument(event.document));
documents.onDidClose((event) => {
  if (!event.document.uri.startsWith("file:") || !isProjectFile(event.document.uri)) return;
  const rootUri = resolveRootUri(event.document.uri);
  if (rootUri) void loadFiles([{ rootUri, uris: [event.document.uri] }]);
});

connection.onDefinition((params): Definition | null => {
  const context = requestContext(params.textDocument.uri, params.position.line, params.position.character);
  if (!context) return null;
  const { snapshot, rootUri, expression, word, line, character } = context;
  const protocol = findProtocolAt(snapshot, expression, params.textDocument.uri, rootUri, line, character);
  if (protocol) {
    if (isAtLocation(params.textDocument.uri, rootUri, line, character, protocol.location, protocol.member.length)) {
      const handlers = linkedHandlers(snapshot, protocol);
      if (handlers.length > 0) return handlers.map((handler) => toLocation(rootUri, handler.location));
    }
    return toLocation(rootUri, protocol.location);
  }
  const messageType = snapshot.messageTypes.find((type) => type.name === word && prefersServer(type.location.relativePath));
  if (messageType) {
    if (isAtLocation(params.textDocument.uri, rootUri, line, character, messageType.location, messageType.name.length)) {
      const handlers = handlersForMessageType(snapshot, messageType.name);
      if (handlers.length > 0) return handlers.map((handler) => toLocation(rootUri, handler.location));
    }
    return toLocation(rootUri, messageType.location);
  }
  const codeName = expression.startsWith("MsgCode.") ? expression.slice("MsgCode.".length) : word;
  const msgcode = snapshot.msgcodes.find((code) => code.name === codeName && prefersServer(code.location.relativePath));
  return msgcode ? toLocation(rootUri, msgcode.location) : null;
});

connection.onReferences((params: ReferenceParams): Location[] => {
  const context = requestContext(params.textDocument.uri, params.position.line, params.position.character);
  if (!context) return [];
  const protocol = findProtocolAt(
    context.snapshot,
    context.expression,
    params.textDocument.uri,
    context.rootUri,
    context.line,
    context.character,
  );
  if (!protocol) return [];
  const locations = linkedHandlers(context.snapshot, protocol)
    .map((handler) => toLocation(context.rootUri, handler.location));
  if (params.context.includeDeclaration) locations.unshift(toLocation(context.rootUri, protocol.location));
  return locations;
});

connection.onHover((params): Hover | null => {
  const context = requestContext(params.textDocument.uri, params.position.line, params.position.character);
  if (!context) return null;
  const protocol = findProtocolAt(
    context.snapshot,
    context.expression,
    params.textDocument.uri,
    context.rootUri,
    context.line,
    context.character,
  );
  if (protocol) return markdownHover(describeProtocol(context.snapshot, protocol));
  const handler = context.snapshot.handlers.find((candidate) => isAtLocation(
    params.textDocument.uri,
    context.rootUri,
    context.line,
    context.character,
    candidate.location,
    candidate.name.split(".").at(-1)?.length ?? candidate.name.length,
  ));
  if (handler) {
    const linked = protocolForHandler(context.snapshot, handler);
    return markdownHover(describeHandler(handler, linked));
  }
  const protocols = context.snapshot.protocols.filter((candidate) => protocolUsesType(candidate, context.word));
  if (protocols.length > 0) {
    return markdownHover([
      `### 消息类型 \`${context.word}\``,
      "",
      ...protocols.map((candidate) => `- ${candidate.kind === "rpc" ? "RPC" : "Message"}：\`${candidate.symbol}\`（${candidate.name}）`),
    ].join("\n"));
  }
  const foundation = describeRuntimeFoundationSymbol(context.word, context.expression);
  if (foundation) return markdownHover(foundation);
  return null;
});

connection.onCodeLens((params): CodeLens[] => {
  const rootUri = resolveRootUri(params.textDocument.uri);
  const snapshot = rootUri ? snapshots.get(rootUri) : undefined;
  if (!rootUri || !snapshot) return [];
  const relativePath = relativePathOf(rootUri, params.textDocument.uri);
  const lenses: CodeLens[] = [];
  for (const protocol of snapshot.protocols.filter((candidate) => candidate.location.relativePath === relativePath)) {
    const handlers = linkedHandlers(snapshot, protocol);
    lenses.push({
      range: locationRange(protocol.location, protocol.member.length),
      command: handlers.length > 0 ? {
        title: `${handlers.length} 个 Handler`,
        command: "tiangzDeveloperTools.openUriLocation",
        arguments: [handlers.map((handler) => toLocation(rootUri, handler.location))],
      } : {
        title: protocol.expectsHandler ? "未找到 Handler" : "客户端下行消息",
        command: "tiangzDeveloperTools.openUriLocation",
        arguments: [[toLocation(rootUri, protocol.location)]],
      },
    });
  }
  for (const handler of snapshot.handlers.filter((candidate) => candidate.location.relativePath === relativePath)) {
    const protocol = protocolForHandler(snapshot, handler);
    if (!protocol) continue;
    lenses.push({
      range: locationRange(handler.location, handler.name.length),
      command: {
        title: `协议 ${protocol.name}`,
        command: "tiangzDeveloperTools.openUriLocation",
        arguments: [[toLocation(rootUri, protocol.location)]],
      },
    });
  }
  return lenses;
});

connection.onRequest(SERVER_STATS_REQUEST, () => ({
  roots: rootUris.length,
  cachedFiles: sources.size,
  snapshots: snapshots.size,
  protocols: [...snapshots.values()].reduce((sum, snapshot) => sum + snapshot.protocols.length, 0),
  handlers: [...snapshots.values()].reduce((sum, snapshot) => sum + snapshot.handlers.length, 0),
  validationCount,
  lastValidationMs,
  maxValidationMs,
  heapUsedBytes: process.memoryUsage().heapUsed,
}));

connection.onShutdown(() => {
  shuttingDown = true;
  if (validationTimer) clearTimeout(validationTimer);
  for (const uri of publishedUris) connection.sendDiagnostics({ uri, diagnostics: [] });
  sources.clear();
  snapshots.clear();
  indexedUris.clear();
});

documents.listen(connection);
connection.listen();

async function loadFiles(groups: readonly IndexedRootFiles[]): Promise<void> {
  const files = groups.flatMap((group) => group.uris.map((uri) => ({ rootUri: group.rootUri, uri })))
    .filter((item) => item.uri.startsWith("file:") && indexedUris.has(item.uri));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (!shuttingDown) {
      const item = files[cursor++];
      if (!item) return;
      if (documents.get(item.uri)) continue;
      try {
        const text = await readFile(fileURLToPath(item.uri), "utf8");
        sources.set(item.uri, {
          uri: item.uri,
          rootUri: item.rootUri,
          relativePath: relativePathOf(item.rootUri, item.uri),
          text,
        });
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") sources.delete(item.uri);
        else connection.console.error(`读取 ${item.uri} 失败：${errorMessage(error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FILE_READ_CONCURRENCY, files.length) }, worker));
  scheduleValidation(0);
}

function updateOpenDocument(document: TextDocument): void {
  if (!isProjectFile(document.uri)) return;
  const rootUri = resolveRootUri(document.uri);
  if (!rootUri) return;
  sources.set(document.uri, {
    uri: document.uri,
    rootUri,
    relativePath: relativePathOf(rootUri, document.uri),
    text: document.getText(),
  });
  scheduleValidation();
}

function scheduleValidation(delay = VALIDATION_DEBOUNCE_MS): void {
  if (shuttingDown) return;
  if (validationTimer) clearTimeout(validationTimer);
  validationTimer = setTimeout(() => {
    validationTimer = undefined;
    validateWorkspace();
  }, delay);
}

function validateWorkspace(): void {
  const startedAt = performance.now();
  const nextPublished = new Set<string>();
  for (const rootUri of rootUris) {
    const projectSources = [...sources.values()]
      .filter((source) => source.rootUri === rootUri)
      .map(({ relativePath, text }) => ({ relativePath, text }));
    const snapshot = analyzeTiangZProject(projectSources);
    snapshots.set(rootUri, snapshot);
    connection.sendNotification(SNAPSHOT_NOTIFICATION, { rootUri, snapshot });
    const grouped = new Map<string, ReturnType<typeof toDiagnostic>[]>();
    for (const diagnostic of snapshot.diagnostics) {
      const uri = uriForLocation(rootUri, diagnostic.location);
      const values = grouped.get(uri) ?? [];
      values.push(toDiagnostic(diagnostic));
      grouped.set(uri, values);
    }
    for (const source of projectSources) {
      const uri = uriForRelativePath(rootUri, source.relativePath);
      const values = grouped.get(uri) ?? [];
      connection.sendDiagnostics({ uri, diagnostics: values });
      nextPublished.add(uri);
    }
  }
  for (const uri of publishedUris) {
    if (!nextPublished.has(uri)) connection.sendDiagnostics({ uri, diagnostics: [] });
  }
  publishedUris.clear();
  for (const uri of nextPublished) publishedUris.add(uri);
  lastValidationMs = performance.now() - startedAt;
  maxValidationMs = Math.max(maxValidationMs, lastValidationMs);
  validationCount += 1;
  void connection.sendRequest("workspace/codeLens/refresh").catch(() => undefined);
}

function requestContext(uri: string, line: number, character: number) {
  const document = documents.get(uri);
  const rootUri = resolveRootUri(uri);
  const snapshot = rootUri ? snapshots.get(rootUri) : undefined;
  if (!document || !rootUri || !snapshot) return undefined;
  const offset = document.offsetAt({ line, character });
  const expression = qualifiedExpressionAt(document.getText(), offset);
  const word = expression.split(".").at(-1) ?? expression;
  return { document, rootUri, snapshot, expression, word, line, character };
}

function findProtocolAt(
  snapshot: TiangZProjectSnapshot,
  expression: string,
  uri: string,
  rootUri: string,
  line: number,
  character: number,
): ProtocolDescriptorModel | undefined {
  const normalized = normalizeDescriptorReference(expression);
  return snapshot.protocols.find((protocol) => protocol.symbol === normalized)
    ?? snapshot.protocols.find((protocol) => isAtLocation(uri, rootUri, line, character, protocol.location, protocol.member.length));
}

function linkedHandlers(snapshot: TiangZProjectSnapshot, protocol: ProtocolDescriptorModel): HandlerModel[] {
  return snapshot.handlers.filter((handler) => handler.kind !== "actorMethod"
    && normalizeDescriptorReference(handler.descriptor) === protocol.symbol);
}

function protocolForHandler(snapshot: TiangZProjectSnapshot, handler: HandlerModel): ProtocolDescriptorModel | undefined {
  const symbol = normalizeDescriptorReference(handler.descriptor);
  return snapshot.protocols.find((protocol) => protocol.symbol === symbol);
}

function handlersForMessageType(snapshot: TiangZProjectSnapshot, name: string): HandlerModel[] {
  const symbols = new Set(snapshot.protocols.filter((protocol) => protocolUsesType(protocol, name)).map((protocol) => protocol.symbol));
  return snapshot.handlers.filter((handler) => symbols.has(normalizeDescriptorReference(handler.descriptor)));
}

function protocolUsesType(protocol: ProtocolDescriptorModel, name: string): boolean {
  return protocol.requestType === name || protocol.responseType === name || protocol.messageType === name;
}

function describeProtocol(snapshot: TiangZProjectSnapshot, protocol: ProtocolDescriptorModel): string {
  const handlers = linkedHandlers(snapshot, protocol);
  const lines = [
    `### ${protocol.kind === "rpc" ? "RPC" : "Message"} \`${protocol.name}\``,
    "",
    `**Descriptor**：\`${protocol.symbol}\``,
  ];
  if (protocol.kind === "rpc") {
    lines.push(`**Request**：\`${protocol.requestType ?? "未知"}\`（MsgCode ${protocol.requestCode ?? "未知"}）`);
    lines.push(`**Response**：\`${protocol.responseType ?? "未知"}\`（MsgCode ${protocol.responseCode ?? "未知"}）`);
  } else {
    lines.push(`**消息类型**：\`${protocol.messageType ?? "未知"}\`（MsgCode ${protocol.msgcode ?? "未知"}）`);
  }
  if (protocol.routing) lines.push(`**路由**：\`${protocol.routing}\``);
  lines.push(`**Handler**：${handlers.length > 0 ? handlers.map((handler) => `\`${handler.name}\``).join("、") : "未找到"}`);
  return lines.join("\n\n");
}

function describeHandler(handler: HandlerModel, protocol: ProtocolDescriptorModel | undefined): string {
  return [
    `### Handler \`${handler.name}\``,
    "",
    `**类型**：\`${handler.kind}\``,
    `**目标**：\`${handler.target}\``,
    `**Descriptor**：\`${handler.descriptor}\``,
    protocol ? `**协议**：${protocol.name}` : "**协议**：未解析",
  ].join("\n\n");
}

/** 为常用运行时基础API提供中文设计提示，避免业务开发者反复翻阅Core实现。 / Provides concise Chinese design guidance for runtime-foundation APIs without requiring business developers to inspect Core internals. */
function describeRuntimeFoundationSymbol(word: string, expression: string): string | undefined {
  switch (word) {
    case "GlobalId":
      return [
        "### `GlobalId`（永久实体 ID）",
        "",
        "跨 Process、跨来源服和合服后仍保持唯一，使用 TypeScript `bigint` 表示。玩家、道具等需要持久化的 Entity 保存这个 ID。",
        "",
        "不要把它当作数组下标，也不要转换为 `number`。",
      ].join("\n");
    case "GlobalIdSystem":
      return [
        "### `GlobalIdSystem`（全局 ID 生成器）",
        "",
        "由框架根据 `process.identity.originServerId` 和 `workerId` 初始化。业务通常通过 Entity 创建流程获得 ID，不应自行拼位或复制生成算法。",
      ].join("\n");
    case "InstanceId":
      return [
        "### `InstanceId`（运行实例 ID）",
        "",
        "只在当前 Process 生命周期内有效，用于 Scene、Entity、动态地图和运行时索引。重启或反序列化后会重新生成。",
        "",
        "禁止写入数据库或持久化 Snapshot；持久化关系请保存 `GlobalId`。",
      ].join("\n");
    case "TimerId":
      return [
        "### `TimerId`（定时器句柄）",
        "",
        "创建 Timer 时返回，用于 `CancelTimer(timerId, reason)`。它只属于当前运行期，不应持久化；需要跨重启恢复时保存墙钟截止时间。",
      ].join("\n");
    case "NewOnceTimer":
      return [
        "### `NewOnceTimer`",
        "",
        "创建一次性、对象归属的 Timer，并返回唯一 `TimerId`。回调使用方法名，以便 Hotfix 后解析到新 prototype。",
        "",
        "```ts",
        "this.timerId = this.DomainScene.Time.NewOnceTimer(1000, \"Timeout\", args, { onCancelled: \"Cancelled\" });",
        "```",
      ].join("\n");
    case "NewRepeatedTimer":
      return [
        "### `NewRepeatedTimer`",
        "",
        "创建重复 Timer，并返回唯一 `TimerId`。业务销毁时应主动取消，参数会按原样传给每次回调。",
      ].join("\n");
    case "CancelTimer":
      return [
        "### `CancelTimer`",
        "",
        "主动中断 Timer。若创建时配置 `onCancelled`，框架会立即回调 `(args, context)`，其中 `context.reason` 表示中断原因。正常到期不会触发取消回调。",
      ].join("\n");
    case "Locks":
    case "RunExclusive":
      if (!expression.includes("Locks") && word === "RunExclusive") return undefined;
      return [
        "### Scene 协程锁",
        "",
        "`await scene.Locks.RunExclusive(type, key, action)` 只串行化相同 `(type, key)` 的业务；不同门派、玩家或资源键仍可并行。锁不能跨 Scene。",
        "",
        "不要在持锁期间等待不可控的外部流程，避免同一业务键长期排队。",
      ].join("\n");
    case "Events":
      return [
        "### Scene Event",
        "",
        "`scene.Events` 只能发布到当前 Scene。同步事件使用 `Publish`；异步事件使用 `await PublishAsync`。跨 Scene 协作请用 RPC、Actor 消息或 Location 路由。",
      ].join("\n");
    case "Publish":
      if (!expression.includes("Events.Publish")) return undefined;
      return "### `Events.Publish`\n\n同步发布当前 Scene 内事件；所有 Handler 必须同步返回。";
    case "PublishAsync":
      if (!expression.includes("Events.PublishAsync")) return undefined;
      return "### `Events.PublishAsync`\n\n异步发布当前 Scene 内事件；调用方必须 `await` 或直接 `return`，完成后才表示所有监听器结束。";
    case "defineSyncEvent":
      return "### `defineSyncEvent<T>`\n\n定义稳定命名的同步 Scene Event。事件描述符可放在 Model，Handler 实现放在 Hotfix。";
    case "defineAsyncEvent":
      return "### `defineAsyncEvent<T>`\n\n定义稳定命名的异步 Scene Event。发布时必须等待 `PublishAsync`。";
    default:
      return undefined;
  }
}

function markdownHover(value: string): Hover {
  return { contents: { kind: MarkupKind.Markdown, value } };
}

function qualifiedExpressionAt(text: string, offset: number): string {
  let start = offset;
  let end = offset;
  while (start > 0 && /[A-Za-z0-9_.$]/.test(text[start - 1] ?? "")) start -= 1;
  while (end < text.length && /[A-Za-z0-9_.$]/.test(text[end] ?? "")) end += 1;
  return text.slice(start, end).replace(/^\.+|\.+$/g, "");
}

function normalizeDescriptorReference(value: string): string {
  return value.endsWith(".name") ? value.slice(0, -".name".length) : value;
}

function isAtLocation(
  uri: string,
  rootUri: string,
  line: number,
  character: number,
  location: SourceLocation,
  length: number,
): boolean {
  return relativePathOf(rootUri, uri) === location.relativePath
    && line === location.line
    && character >= location.character
    && character <= location.character + length;
}

function toLocation(rootUri: string, location: SourceLocation): Location {
  return { uri: uriForLocation(rootUri, location), range: locationRange(location, 1) };
}

function locationRange(location: SourceLocation, length: number) {
  return {
    start: { line: location.line, character: location.character },
    end: { line: location.line, character: location.character + Math.max(1, length) },
  };
}

function toDiagnostic(diagnostic: TiangZProjectSnapshot["diagnostics"][number]) {
  return {
    range: locationRange(diagnostic.location, 1),
    severity: diagnostic.severity === "error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
    code: diagnostic.code,
    source: "TiangZ",
    message: diagnostic.message,
  };
}

function resolveRootUri(uri: string): string | undefined {
  if (!uri.startsWith("file:")) return undefined;
  const file = path.resolve(fileURLToPath(uri));
  return [...rootUris].sort((left, right) => right.length - left.length).find((rootUri) => {
    const root = path.resolve(fileURLToPath(rootUri));
    const relative = path.relative(root, file);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function relativePathOf(rootUri: string, uri: string): string {
  return path.relative(fileURLToPath(rootUri), fileURLToPath(uri)).replaceAll("\\", "/");
}

function uriForLocation(rootUri: string, location: SourceLocation): string {
  return uriForRelativePath(rootUri, location.relativePath);
}

function uriForRelativePath(rootUri: string, relativePath: string): string {
  return pathToFileURL(path.join(fileURLToPath(rootUri), ...relativePath.split("/"))).toString();
}

function prefersServer(relativePath: string): boolean {
  return relativePath.includes("/generated/model/server/");
}

function isProjectFile(uri: string): boolean {
  return indexedUris.has(uri) || /\.(?:ts|json|proto|native|mjs|rs|js)$/.test(uri);
}

function isIndexedRootFiles(value: unknown): value is IndexedRootFiles {
  if (!isRecord(value) || typeof value.rootUri !== "string" || !Array.isArray(value.uris)) return false;
  return value.uris.every((uri) => typeof uri === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
