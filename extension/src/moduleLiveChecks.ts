import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { ProjectDiagnostic, RuntimeContractProjectResult } from "../../packages/project-core/src/index.js";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
export interface ModuleOverlay { readonly file: string; readonly text: string }
type Message = Record<string, unknown>;

/** 只管理受信任宿主的只读检查进程；模块发现和规则仍属于宿主。 / Own trusted, read-only host workers, not module discovery or rules. */
export class ModuleLiveChecks {
  private readonly projects = new Map<string, ModuleWorker>();
  private readonly closing = new Set<Promise<void>>();
  private trusted = false;
  private roots = new Set<string>();
  constructor(private readonly onIdleFailure: () => void = () => undefined) {}

  configure(roots: readonly string[], trusted: boolean): void {
    this.trusted = trusted;
    this.roots = new Set(roots);
    for (const root of this.projects.keys()) if (!trusted || !roots.includes(root)) this.invalidate(root);
  }

  invalidate(root: string): void {
    const worker = this.projects.get(root);
    if (!worker) return;
    this.projects.delete(root);
    const closing = worker.dispose();
    this.closing.add(closing);
    void closing.finally(() => this.closing.delete(closing));
  }

  async analyze(root: string, overlays: readonly ModuleOverlay[]): Promise<RuntimeContractProjectResult> {
    if (!this.trusted) return unavailable("模块实时检查需要受信任的工作区；未启动宿主工具。");
    await Promise.all(this.closing);
    if (!this.trusted || !this.roots.has(root)) return unavailable("模块检查已取消。");
    let worker = this.projects.get(root);
    if (!worker) {
      if (this.projects.size + this.closing.size >= 4) return unavailable("最多同时检查四个模块工程；请关闭不再使用的工程后刷新。");
      worker = new ModuleWorker(root, this.onIdleFailure);
      this.projects.set(root, worker);
    }
    try { return await worker.analyze(overlays); }
    catch (error) {
      if (this.projects.get(root) === worker) this.invalidate(root);
      return unavailable(error instanceof Error ? error.message : String(error));
    }
  }

  get stats() {
    return { moduleWorkers: this.projects.size, closingModuleWorkers: this.closing.size,
      moduleWorkerPids: [...this.projects.values()].flatMap(worker => worker.pid ? [worker.pid] : []),
      moduleTypeFiles: [...this.projects.values()].reduce((sum, worker) => sum + worker.sourceFiles, 0) };
  }

  async dispose(): Promise<void> {
    this.configure([], false);
    await Promise.all(this.closing);
  }
}

class ModuleWorker {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private stderr = "";
  private stopped = false;
  private nextId = 0;
  private ready: Message | undefined;
  private declaration = "";
  private pending: { resolve: (message: Message) => void; reject: (error: Error) => void } | undefined;
  private closed: Promise<void> = Promise.resolve();
  sourceFiles = 0;

  constructor(private readonly root: string, private readonly onIdleFailure: () => void) {}
  get pid(): number | undefined { return this.child?.pid; }

  async analyze(overlays: readonly ModuleOverlay[]): Promise<RuntimeContractProjectResult> {
    // 配置缓冲区不能选择可执行文件或改变模块图。 / Configuration buffers never select executables or change the module graph.
    for (const overlay of overlays.filter(item => within(this.root, item.file) && isDeclaration(item.file))) {
      if (overlay.text !== await readFile(overlay.file, "utf8")) throw new Error("工程、模块声明或 tsconfig 尚未保存；保存后刷新模块实时检查。");
    }
    const descriptor = path.join(this.root, "tiangz.project.json");
    const details = await lstat(descriptor);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 2 * 1024 * 1024) throw new Error("工程声明必须是小于 2 MiB 的普通文件。");
    const text = await readFile(descriptor, "utf8");
    if (this.ready && text !== this.declaration) throw new Error("已保存的工程声明改变；请刷新模块实时检查。");
    if (!this.ready) await this.start(text);
    if (this.stopped) throw new Error("模块检查已取消。");
    const ready = this.ready!;
    const declarations = ready.declarationFiles as string[];
    for (const overlay of overlays.filter(item => declarations.some(file => path.relative(file, item.file) === ""))) {
      if (overlay.text !== await readFile(overlay.file, "utf8")) throw new Error("模块声明或 tsconfig 尚未保存；保存后刷新模块实时检查。");
    }
    const roots = ready.sourceRoots as string[];
    const sources = overlays.filter(item => item.file.endsWith(".ts") && roots.some(root => within(root, item.file)));
    if (sources.length > 256 || sources.some(item => Buffer.byteLength(item.text, "utf8") > 2 * 1024 * 1024)) throw new Error("未保存源码超过 256 个文件或单文件 2 MiB 上限；请保存部分文件后重试。");
    const id = ++this.nextId;
    const response = await this.exchange({ formatVersion: 1, id, method: "analyze", overlays: sources });
    if (response.id !== id || !["checked", "unavailable"].includes(String(response.status)) || !Array.isArray(response.diagnostics)
      || response.typescriptVersion !== ready.typescriptVersion || response.ruleSetVersion !== ready.ruleSetVersion) throw new Error("宿主检查响应身份或格式错误。");
    const diagnostics: ProjectDiagnostic[] = response.diagnostics.map(item => {
      if (!isRecord(item) || typeof item.code !== "string" || typeof item.message !== "string"
        || !["error", "warning"].includes(String(item.severity)) || (item.file !== undefined && (typeof item.file !== "string" || !path.isAbsolute(item.file)))
        || (item.line !== undefined && (!Number.isSafeInteger(item.line) || Number(item.line) < 1))
        || (item.column !== undefined && (!Number.isSafeInteger(item.column) || Number(item.column) < 1))) throw new Error("宿主检查诊断格式错误。");
      return { code: item.code, message: item.message, severity: item.severity as "error" | "warning", location: {
        relativePath: typeof item.file === "string" ? path.relative(this.root, item.file).replaceAll("\\", "/") : "tiangz.project.json",
        line: Number(item.line ?? 1) - 1, character: Number(item.column ?? 1) - 1,
      } };
    });
    this.sourceFiles = isRecord(response.cache) && Number.isSafeInteger(response.cache.sourceFiles) ? Number(response.cache.sourceFiles) : 0;
    return { status: response.status as "checked" | "unavailable", diagnostics,
      typescriptVersion: ready.typescriptVersion as string, ruleSetVersion: ready.ruleSetVersion as number };
  }

  private async start(text: string): Promise<void> {
    const data: unknown = JSON.parse(text);
    if (!isRecord(data) || data.formatVersion !== 1 || data.hostProfile !== "modules" || typeof data.engineRoot !== "string" || !data.engineRoot.trim()) throw new Error("无法读取已保存的模块工程宿主声明。");
    const engineRoot = await realpath(path.resolve(this.root, data.engineRoot));
    const script = path.join(engineRoot, "tools/module_live_worker.mjs");
    const details = await lstat(script).catch(() => { throw new Error("所选宿主不支持模块实时检查；请使用宿主检查任务或更新宿主。"); });
    if (!details.isFile() || details.isSymbolicLink() || !within(engineRoot, await realpath(script))) throw new Error("宿主实时检查入口不是宿主内的普通文件。");
    if (this.stopped) throw new Error("模块检查已取消。");
    this.declaration = text;
    // VS Code 的 process.execPath 可能是 Code.exe，显式使用与宿主任务相同的 Node。
    // VS Code's executable may be Code.exe; use Node as the existing host tasks do.
    const child = this.child = spawn("node", [script, "--project", this.root], { cwd: engineRoot, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    this.closed = new Promise(resolve => child.once("close", () => {
      this.fail(new Error(`宿主检查进程退出：${this.stderr || "无额外输出"}`));
      resolve();
    }));
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-8192); });
    child.once("error", error => this.fail(error));
    child.stdin.on("error", error => this.fail(error));
    const ready = await this.exchange();
    if (ready.event !== "ready" || typeof ready.engineRoot !== "string" || path.relative(engineRoot, ready.engineRoot) !== ""
      || typeof ready.projectRoot !== "string" || path.relative(this.root, ready.projectRoot) !== ""
      || typeof ready.typescriptVersion !== "string" || !Number.isSafeInteger(ready.ruleSetVersion)
      || !Array.isArray(ready.declarationFiles) || ready.declarationFiles.length > 256
      || !ready.declarationFiles.every(item => typeof item === "string" && path.isAbsolute(item))
      || !Array.isArray(ready.sourceRoots) || !ready.sourceRoots.length || ready.sourceRoots.length > 256
      || !ready.sourceRoots.every(item => typeof item === "string" && path.isAbsolute(item))) throw new Error("所选宿主返回了不匹配的检查环境。");
    this.ready = ready;
  }

  private exchange(request?: Message): Promise<Message> {
    if (this.stopped || this.pending) return Promise.reject(new Error("模块检查已取消或已有在途请求。"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("宿主实时检查超过 30 秒；请使用 CLI 检查此工程。")), REQUEST_TIMEOUT_MS);
      this.pending = { resolve: message => { clearTimeout(timer); resolve(message); }, reject: error => { clearTimeout(timer); reject(error); } };
      if (request) {
        const line = JSON.stringify(request) + "\n";
        if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) this.fail(new Error("模块检查请求超过 16 MiB 上限。"));
        else this.child!.stdin.write(line);
      }
    });
  }

  private consume(chunk: Buffer): void {
    if (this.stopped) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_FRAME_BYTES) { this.fail(new Error("宿主检查响应超过 16 MiB 上限。")); return; }
    for (let newline; !this.stopped && (newline = this.buffer.indexOf(10)) >= 0;) {
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      try {
        const message: unknown = JSON.parse(line.toString("utf8"));
        if (!isRecord(message) || message.formatVersion !== 1) throw new Error("宿主检查协议格式错误。");
        if (message.event === "fatal") throw new Error(String(message.message));
        const pending = this.pending;
        if (!pending) throw new Error("宿主发送了无对应请求的检查结果。");
        this.pending = undefined;
        pending.resolve(message);
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    }
  }

  private fail(error: Error, notify = true): void {
    const idleFailure = notify && !this.stopped && !this.pending;
    this.stopped = true;
    this.pending?.reject(error);
    this.pending = undefined;
    this.child?.kill();
    if (idleFailure) this.onIdleFailure();
  }

  async dispose(): Promise<void> {
    this.fail(new Error("模块检查已取消。"), false);
    this.buffer = Buffer.alloc(0);
    this.sourceFiles = 0;
    const kill = setTimeout(() => this.child?.kill("SIGKILL"), 500);
    try { await this.closed; }
    finally { clearTimeout(kill); }
  }
}

function unavailable(reason: string): RuntimeContractProjectResult {
  return { status: "unavailable", ruleSetVersion: 0, typescriptVersion: "unavailable", reason,
    diagnostics: [{ code: "tiangz.module.live-unavailable", severity: "warning", message: reason,
      location: { relativePath: "tiangz.project.json", line: 0, character: 0 } }] };
}
function isRecord(value: unknown): value is Message { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isDeclaration(file: string): boolean { return /^(?:tiangz\.(?:project|module)|tsconfig[^/]*)\.json$/.test(path.basename(file)); }
function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
