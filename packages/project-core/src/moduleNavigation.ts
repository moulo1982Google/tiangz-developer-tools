/** TiangZ CLI owns discovery and analysis; this contract only validates data for presentation. */
export interface ModuleLocation { readonly file: string; readonly line: number; readonly column: number }
export interface ModuleSymbol {
  readonly name: string;
  readonly kind: string;
  readonly layer: string;
  readonly generated: boolean;
  readonly reachable: boolean;
  readonly target?: string;
  readonly descriptor?: string;
  readonly targetResolution?: "local" | "unresolved";
  readonly targetLocation?: ModuleLocation;
  readonly location: ModuleLocation;
}
export interface ModuleNavigationEntry {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly root: string;
  readonly manifest: string;
  readonly entries: { readonly model: string; readonly hotfix: string };
  readonly publicApi: string | null;
  readonly dependencies: readonly { readonly id: string }[];
  readonly declarations: readonly ModuleSymbol[];
  readonly bindings: readonly ModuleSymbol[];
  readonly diagnostics: readonly { readonly code: string; readonly message: string; readonly location: ModuleLocation }[];
}
export interface ModuleNavigationReport {
  readonly formatVersion: 1;
  readonly engineVersion: string;
  readonly modulesDirectory: string;
  readonly limitations: readonly string[];
  readonly modules: readonly ModuleNavigationEntry[];
}

/** Refuse incompatible/malformed navigation output rather than showing guessed relationships. */
export function parseModuleNavigation(text: string): ModuleNavigationReport {
  const value: unknown = JSON.parse(text);
  if (record(value) && record(value.error) && typeof value.error.message === "string") throw new Error(value.error.message);
  if (!record(value) || value.formatVersion !== 1 || typeof value.engineVersion !== "string"
    || typeof value.modulesDirectory !== "string" || !Array.isArray(value.modules)
    || !Array.isArray(value.limitations) || !value.limitations.every(item => typeof item === "string")) invalid();
  for (const item of value.modules) {
    if (!record(item) || !strings(item, ["id", "version", "description", "root"]) || !safeFile(item.manifest)
      || !record(item.entries) || !safeFile(item.entries.model) || !safeFile(item.entries.hotfix)
      || !(item.publicApi === null || safeFile(item.publicApi))
      || !Array.isArray(item.dependencies) || !item.dependencies.every(dep => record(dep) && typeof dep.id === "string")
      || !Array.isArray(item.declarations) || !Array.isArray(item.bindings) || !Array.isArray(item.diagnostics)) invalid();
    for (const symbol of [...item.declarations, ...item.bindings]) {
      if (!record(symbol) || !strings(symbol, ["name", "kind", "layer"]) || !location(symbol.location)
        || typeof symbol.generated !== "boolean" || typeof symbol.reachable !== "boolean"
        || !(symbol.target === undefined || typeof symbol.target === "string")
        || !(symbol.targetResolution === undefined || symbol.targetResolution === "local" || symbol.targetResolution === "unresolved")
        || !(symbol.targetLocation === undefined || location(symbol.targetLocation))
        || !(symbol.descriptor === undefined || typeof symbol.descriptor === "string")) invalid();
    }
    for (const diagnostic of item.diagnostics) {
      if (!record(diagnostic) || !strings(diagnostic, ["code", "message"]) || !location(diagnostic.location)) invalid();
    }
  }
  return value as unknown as ModuleNavigationReport;
}

function location(value: unknown): boolean {
  return record(value) && safeFile(value.file) && typeof value.line === "number" && Number.isSafeInteger(value.line) && value.line > 0
    && typeof value.column === "number" && Number.isSafeInteger(value.column) && value.column > 0;
}
function safeFile(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && !/[\\:\x00]/.test(value)
    && !value.startsWith("/") && value.split("/").every(part => part !== ".." && part !== "." && part.length > 0);
}
function strings(value: Record<string, unknown>, keys: string[]): boolean { return keys.every(key => typeof value[key] === "string"); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function invalid(): never { throw new Error("TiangZ 模块导航格式不兼容；请更新宿主工具或插件（需要 formatVersion 1）。"); }
