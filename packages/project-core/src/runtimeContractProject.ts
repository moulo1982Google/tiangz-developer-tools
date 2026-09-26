import path from "node:path";
import ts from "typescript";
import { runtimeContractDiagnostics, RUNTIME_CONTRACT_RULESET_VERSION } from "./runtimeContractRules.js";
import type { ProjectDiagnostic, ProjectSource } from "./types.js";
import { programDependencyDiagnostics } from "./dependencyRules.js";

export interface RuntimeContractProjectResult {
  readonly status: "checked" | "unavailable";
  readonly ruleSetVersion: number;
  readonly typescriptVersion: string;
  readonly diagnostics: readonly ProjectDiagnostic[];
  readonly reason?: string;
  readonly dependencyCheckedFiles?: readonly string[];
}

interface CachedScript {
  readonly text: string;
  readonly snapshot: ts.IScriptSnapshot;
  readonly version: string;
}

const MAX_FILES = 10_000;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;

/** 一个工程复用一个 LanguageService，关闭时释放，不启动编译器子进程。 / Reuse one service per project and dispose it on close. */
export class RuntimeContractProject {
  private service: ts.LanguageService | undefined;
  private readonly scripts = new Map<string, CachedScript>();
  private readonly overlays = new Map<string, string>();
  private rootNames: string[] = [];
  private options: ts.CompilerOptions = {};
  private revision = 0;
  private bytes = 0;
  private readonly root: string;

  /** 主工程明确使用自身的 Core；模块由声明宿主提供 Program。 / Main projects own Core; modules delegate their Program to the host. */
  constructor(projectRoot: string, private readonly api: typeof ts = ts) {
    this.root = path.resolve(projectRoot);
  }

  /** 同步磁盘与未保存内容，保留未变化的 AST/类型缓存。 / Synchronize disk and unsaved content while preserving unchanged syntax caches. */
  analyze(sources: readonly ProjectSource[]): RuntimeContractProjectResult {
    this.overlays.clear();
    for (const source of sources) this.overlays.set(this.key(path.resolve(this.root, source.relativePath)), source.text);
    const project = path.join(this.root, "tsconfig.json");
    const unavailable = (reason: string, report = true): RuntimeContractProjectResult => {
      this.dispose();
      return { status: "unavailable", ruleSetVersion: RUNTIME_CONTRACT_RULESET_VERSION, typescriptVersion: this.api.version,
        diagnostics: report ? [{ code: "tiangz.contract.project-unavailable", severity: "warning", message: reason, location: { relativePath: "tsconfig.json", line: 0, character: 0 } }] : [], reason };
    };
    if (this.read(path.join(this.root, "tiangz.project.json")) !== undefined) return unavailable("Independent modules require the Program from their declared host.", false);
    if (this.read(project) === undefined) return unavailable("tsconfig.json is missing; type-based runtime contracts were not checked.", this.read(path.join(this.root, "app/core/public.ts")) !== undefined);
    if (this.read(path.join(this.root, "app/core/public.ts")) === undefined) return unavailable("Current host app/core/public.ts is missing; runtime contracts were not checked.");
    try {
      const config = this.api.readConfigFile(project, file => this.read(file));
      const parsed = this.api.parseJsonConfigFileContent(config.config ?? {}, { ...this.api.sys, readFile: file => this.read(file) }, this.root, undefined, project);
      const errors = [...(config.error ? [config.error] : []), ...parsed.errors];
      if (errors.length) return unavailable(errors.map(item => this.api.flattenDiagnosticMessageText(item.messageText, "\n")).join("\n"));
      if (parsed.fileNames.length > MAX_FILES) return unavailable(`Type project exceeds ${MAX_FILES} root files.`);
      this.rootNames = parsed.fileNames;
      this.options = { ...parsed.options, noEmit: true };
      this.revision += 1;
      if (!this.service) this.service = this.createService();
      const program = this.service.getProgram();
      if (!program) return unavailable("TypeScript did not produce a Program.");
      const retained = new Set(program.getSourceFiles().map(source => this.key(source.fileName)));
      for (const [key, cached] of this.scripts) {
        if (!retained.has(key)) {
          this.scripts.delete(key);
          this.bytes -= Buffer.byteLength(cached.text, "utf8");
        }
      }
      const files = program.getSourceFiles().filter(source => this.within(path.join(this.root, "app"), source.fileName));
      const diagnostics = runtimeContractDiagnostics(program, { typescript: this.api, projectRoot: this.root, coreRoot: path.join(this.root, "app/core"), sourceFiles: files });
      diagnostics.push(...programDependencyDiagnostics(program, { typescript: this.api, projectRoot: this.root, sourceFiles: files }));
      // 不完整的导入/类型环境必须可见，不把没有命中的规则冒充完整检查。
      // Surface incomplete type environments instead of calling an empty rule result a complete check.
      const typeErrors = this.api.getPreEmitDiagnostics(program).filter(item => item.category === this.api.DiagnosticCategory.Error);
      for (const item of typeErrors) {
        const source = item.file;
        const position = source?.getLineAndCharacterOfPosition(item.start ?? 0);
        diagnostics.push({ code: `TS${item.code}`, severity: "error", message: this.api.flattenDiagnosticMessageText(item.messageText, "\n"), location: {
          relativePath: source ? path.relative(this.root, source.fileName).replaceAll("\\", "/") : "tsconfig.json",
          line: position?.line ?? 0, character: position?.character ?? 0,
        } });
      }
      return { status: "checked", ruleSetVersion: RUNTIME_CONTRACT_RULESET_VERSION, typescriptVersion: this.api.version, diagnostics,
        dependencyCheckedFiles: files.map(source => path.relative(this.root, source.fileName).replaceAll("\\", "/")) };
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : String(error));
    }
  }

  /** 释放所有项目内容和编译服务，不保留历史版本。 / Release compiler state and source history. */
  dispose(): void {
    this.service?.dispose();
    this.service = undefined;
    this.scripts.clear();
    this.overlays.clear();
    this.rootNames = [];
    this.options = {};
    this.bytes = 0;
  }

  /** 暴露有限缓存计数，便于实际 LSP 释放验证。 / Expose bounded cache counts for LSP lifetime tests. */
  get cachedFileCount(): number { return this.scripts.size; }

  /** compiler host 始终读取当前 overlay；版本由文本决定。 / The compiler host reads the current overlay with content-based versions. */
  private createService(): ts.LanguageService {
    const api = this.api;
    return api.createLanguageService({
      getCompilationSettings: () => this.options,
      getScriptFileNames: () => this.rootNames,
      getScriptVersion: file => this.script(file)?.version ?? "missing",
      getScriptSnapshot: file => this.script(file)?.snapshot,
      getProjectVersion: () => String(this.revision),
      getCurrentDirectory: () => this.root,
      getDefaultLibFileName: options => api.getDefaultLibFilePath(options),
      fileExists: file => this.overlays.has(this.key(file)) || api.sys.fileExists(file),
      readFile: file => this.read(file),
      readDirectory: api.sys.readDirectory,
      directoryExists: api.sys.directoryExists,
      getDirectories: api.sys.getDirectories,
      useCaseSensitiveFileNames: () => api.sys.useCaseSensitiveFileNames,
    });
  }

  /** 缓存仅包含当前依赖图，读取超限时明确停止类型检查。 / Bound the current dependency graph and report exhausted capacity. */
  private script(file: string): CachedScript | undefined {
    const key = this.key(file);
    const text = this.read(file);
    const cached = this.scripts.get(key);
    if (text === undefined) {
      if (cached) this.bytes -= Buffer.byteLength(cached.text, "utf8");
      this.scripts.delete(key);
      return undefined;
    }
    if (cached?.text === text) return cached;
    const nextBytes = this.bytes + Buffer.byteLength(text, "utf8") - (cached ? Buffer.byteLength(cached.text, "utf8") : 0);
    if ((!cached && this.scripts.size >= MAX_FILES) || nextBytes > MAX_SOURCE_BYTES) throw new Error("Runtime contract type cache capacity exceeded; narrow tsconfig include.");
    const next = { text, snapshot: this.api.ScriptSnapshot.fromString(text), version: String(this.revision) };
    this.scripts.set(key, next);
    this.bytes = nextBytes;
    return next;
  }

  /** 文件键跟随操作系统大小写约定。 / Canonicalize file identity using host case sensitivity. */
  private key(file: string): string {
    const absolute = path.resolve(file);
    return this.api.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
  }

  /** 未保存文本优先于磁盘。 / Unsaved content takes precedence over disk. */
  private read(file: string): string | undefined { return this.overlays.get(this.key(file)) ?? this.api.sys.readFile(file); }

  /** 按路径段限定业务范围。 / Constrain sources by path segments. */
  private within(root: string, file: string): boolean {
    const relative = path.relative(root, file);
    return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }
}
