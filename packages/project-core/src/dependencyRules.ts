import path from "node:path";

import ts from "typescript";

import type { ProjectDiagnostic } from "./types.js";

type DependencyLayer =
  | "root"
  | "core"
  | "generatedModel"
  | "generatedBootstrap"
  | "generatedHotfix"
  | "model"
  | "hotfix"
  | "game"
  | "benchmark"
  | "business";

interface ClassifiedModule {
  readonly layer: DependencyLayer;
  readonly domain?: string;
  readonly label: string;
}

export const DEPENDENCY_RULESET_VERSION = 1;

export interface ModuleDependencyContext {
  readonly modelRoots: readonly string[];
  readonly hotfixRoots: readonly string[];
  readonly modelEntry: string;
  readonly coreRoot: string;
  readonly protocolRoot?: string;
  /** 宿主验证直接依赖、版本与公开入口；禁止以路径猜测替代。 / The host verifies direct dependency, version and public entry. */
  readonly resolvePublicApi: (specifier: string) => string | undefined;
}

export interface DependencyRuleOptions {
  readonly typescript?: typeof ts;
  readonly projectRoot?: string;
  readonly relativePath?: string;
  readonly module?: ModuleDependencyContext;
  /** Program 可补充路径别名的实际目标，纯文本检查不能假装已解析别名。 / A Program supplies resolved alias targets; text-only analysis cannot prove them. */
  readonly resolveTarget?: (specifier: ts.StringLiteralLike) => string | undefined;
}

/** 使用调用方 Program 的解析结果识别别名，语义仍由同一 AST 规则维护。 / Resolve aliases through the caller's Program while sharing the same AST policy. */
export function programDependencyDiagnostics(program: ts.Program, options: DependencyRuleOptions & { readonly sourceFiles?: readonly ts.SourceFile[] }): ProjectDiagnostic[] {
  const api = options.typescript ?? ts;
  const checker = program.getTypeChecker();
  return (options.sourceFiles ?? program.getSourceFiles()).flatMap(source => dependencyDiagnostics(source, {
    ...options,
    resolveTarget: specifier => program.getSourceFile(source.fileName) === source
      ? checker.getSymbolAtLocation(specifier)?.declarations?.find(api.isSourceFile)?.fileName : undefined,
  }));
}

/** 共用 AST 依赖规则，不创建 Program、不读取文件或执行模块。 / Shared AST dependency rules without creating a Program, reading files or executing modules. */
export function dependencyDiagnostics(sourceFile: ts.SourceFile, options: DependencyRuleOptions = {}): ProjectDiagnostic[] {
  const api = options.typescript ?? ts;
  const root = path.resolve(options.projectRoot ?? ".");
  const file = path.resolve(root, options.relativePath ?? sourceFile.fileName);
  const relativePath = path.relative(root, file).replaceAll("\\", "/");
  const context = options.module;
  const source = context ? undefined : classifyModule(relativePath);
  const hotfix = context?.hotfixRoots.some(directory => within(directory, file)) ?? source?.layer === "hotfix";
  if (context ? !hotfix && !context.modelRoots.some(directory => within(directory, file)) : !source) return [];
  const diagnostics: ProjectDiagnostic[] = [];
  const seen = new Set<number>();
  visit(sourceFile);
  return diagnostics;

  function visit(node: ts.Node): void {
    let specifier: ts.Node | undefined;
    if (api.isImportDeclaration(node) || api.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    else if (api.isCallExpression(node) && node.expression.kind === api.SyntaxKind.ImportKeyword) specifier = node.arguments[0];
    else if (api.isImportTypeNode(node) && api.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
    else if (api.isImportEqualsDeclaration(node) && api.isExternalModuleReference(node.moduleReference)) specifier = node.moduleReference.expression;
    else if (api.isModuleDeclaration(node) && api.isStringLiteral(node.name) && /^(\.|#tiangz\/)/.test(node.name.text)) specifier = node.name;
    if (specifier && !seen.has(specifier.getStart(sourceFile))) {
      seen.add(specifier.getStart(sourceFile));
      if (api.isStringLiteralLike(specifier)) validate(specifier);
      else report(specifier, "动态导入目标无法静态证明，需核对 Model/Hotfix/Stable 依赖边界。", true);
    }
    api.forEachChild(node, visit);
  }

  function validate(specifier: ts.StringLiteralLike): void {
    const value = specifier.text;
    const resolved = options.resolveTarget?.(specifier);
    const target = resolved ? path.resolve(resolved) : value.startsWith(".") ? path.resolve(path.dirname(file), value) : undefined;
    const reject = (message: string) => report(specifier, `${message}：${relativePath} -> ${value}`);
    if (context) {
      if (value.startsWith("#tiangz/modules/")) {
        try {
          const entry = context.resolvePublicApi(value);
          if (!entry || (resolved && !sameModule(resolved, entry))) reject("模块公共入口无法验证");
        } catch (error) { reject(error instanceof Error ? error.message : String(error)); }
        return;
      }
      const core = path.resolve(context.coreRoot);
      const stable = new Map(hotfix
        ? [["#tiangz/model", path.resolve(core, "../model/public")], ["#tiangz/module", stripExtension(context.modelEntry)]]
        : [["#tiangz/core", path.join(core, "public")], ["#tiangz/model", path.resolve(core, "../model/public")], ["#tiangz/domains", path.resolve(core, "../model/domains/public")]]);
      if (stable.has(value)) {
        if (resolved && !sameModule(resolved, stable.get(value)!)) reject("Stable 入口未解析到当前宿主声明");
        return;
      }
      if (target && !hotfix) {
        const generated = sourceFile.text.startsWith("// Generated by tools/codegen_");
        if (generated && context.protocolRoot && within(context.protocolRoot, file)
          && sourceFile.text.startsWith("// Generated by tools/codegen_proto.mjs.")
          && ["protocol/binary", "protocol/message", "protocol/rpc", "broadcast/index"].some(name => sameModule(target, path.join(core, name)))) return;
        if (generated && /\/generated\/bootstrap\/systems\/[^/]+System\.d\.ts$/.test(file.replaceAll("\\", "/"))
          && sourceFile.text.startsWith("// Generated by tools/codegen_module_systems.mjs.")
          && within(path.resolve(core, "../model/domains"), target)) return;
      }
      const roots = hotfix ? context.hotfixRoots : context.modelRoots;
      if (!value.startsWith(".") || !target || !roots.some(directory => within(directory, target))) reject(`游戏模块 ${hotfix ? "Hotfix" : "Model"} 只能使用允许的稳定入口或同层相对导入`);
      return;
    }

    const aliases = new Map([["#tiangz/core", "app/core/public"], ["#tiangz/model", "app/model/public"], ["#tiangz/domains", "app/model/domains/public"]]);
    const alias = aliases.get(value);
    if (alias && resolved && !sameModule(resolved, path.resolve(root, alias))) return reject("Stable 入口未解析到当前宿主声明");
    if (hotfix && value === "#tiangz/model") return;
    if (hotfix && !value.startsWith(".")) return reject("Hotfix 只能通过 #tiangz/model 导入稳定层");
    if (source!.layer === "model" && value === "#tiangz/model") return reject("Model 不能通过聚合别名导入自身");
    if (value.startsWith("#tiangz/") && !alias) return reject("未声明的框架入口");
    const targetPath = target ? path.relative(root, target).replaceAll("\\", "/") : alias;
    if (!targetPath) return;
    const targetLayer = classifyModule(targetPath);
    if (hotfix && !targetLayer) return reject("Hotfix 相对导入越过声明边界");
    if (!targetLayer) return;
    if (source!.layer === "model" && targetLayer.layer === "core"
      && stripExtension(targetPath) !== "app/core/public"
      && !["app/model/main.ts", "app/model/public.ts", "app/model/bench/bootstrap.ts"].includes(relativePath)) return reject("Model 必须使用 Stable Core 入口");
    if (relativePath.startsWith("app/model/domains/") && (targetPath.startsWith("app/model/mmorpg/") || targetPath.startsWith("app/generated/"))) return reject("通用领域 Model 不能依赖 MMORPG 适配或生成契约");
    if (!dependencyAllowed(source!, targetLayer)) reject(`${source!.label} 不允许依赖 ${targetLayer.label}`);
  }

  function report(node: ts.Node, message: string, warning = false): void {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile) + (api.isStringLiteralLike(node) ? 1 : 0));
    diagnostics.push({ code: `tiangz.architecture.${warning ? "unverifiable-dependency" : "invalid-dependency"}`,
      severity: warning ? "warning" : "error", message, location: { relativePath, line: position.line, character: position.character } });
  }
}

/** 保留主工程索引器适配入口；所有判断交给同一规则。 / Preserve the indexer adapter while delegating every rule decision. */
export function validateTypeScriptDependencies(sourceFile: ts.SourceFile, relativePath: string, diagnostics: ProjectDiagnostic[]): void {
  diagnostics.push(...dependencyDiagnostics(sourceFile, { relativePath }));
}

function within(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function stripExtension(file: string): string {
  return file.replace(/(?:\.d)?\.[cm]?[jt]sx?$/, "");
}

function sameModule(left: string, right: string): boolean {
  return path.relative(stripExtension(left), stripExtension(right)) === "";
}

function classifyModule(relativePath: string): ClassifiedModule | undefined {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (/^app\/main(?:\.[^/]+)?\.ts$/.test(normalized)) {
    return { layer: "root", label: "应用组合入口" };
  }
  const segments = normalized.split("/");
  if (segments[0] !== "app" || !segments[1]) return undefined;
  const top = segments[1];
  if (top === "core") return { layer: "core", label: "Core" };
  if (top === "generated") {
    if (segments[2] === "bootstrap") return { layer: "generatedBootstrap", label: "Generated/Bootstrap" };
    if (segments[2] === "model") return { layer: "generatedModel", label: "Generated/Model" };
    if (segments[2] === "hotfix") return { layer: "generatedHotfix", label: "Generated/Hotfix" };
    return { layer: "generatedModel", label: "Generated" };
  }
  if (top === "model") return { layer: "model", label: "Model" };
  if (top === "hotfix") return { layer: "hotfix", label: "Hotfix" };
  if (top === "game") return { layer: "game", label: "Game" };
  if (top === "bench") return { layer: "benchmark", label: "Bench" };
  return { layer: "business", domain: top, label: `业务目录 ${top}` };
}

function dependencyAllowed(source: ClassifiedModule, target: ClassifiedModule): boolean {
  if (source.layer === "root") return true;
  if (target.layer === "root") return false;
  switch (source.layer) {
    case "core":
      return target.layer === "core";
    case "generatedModel":
      return target.layer === "core" || target.layer === "generatedModel";
    case "generatedBootstrap":
      return target.layer === "core" || target.layer === "generatedModel"
        || target.layer === "model" || target.layer === "generatedBootstrap";
    case "model":
      return target.layer === "core" || target.layer === "generatedModel"
        || target.layer === "generatedBootstrap" || target.layer === "model";
    case "game":
      return target.layer === "core" || target.layer === "generatedModel"
        || target.layer === "model" || target.layer === "game";
    case "hotfix":
      return target.layer === "hotfix" || target.layer === "generatedHotfix";
    case "generatedHotfix":
      return target.layer === "hotfix" || target.layer === "generatedHotfix";
    case "benchmark":
      return target.layer === "core" || target.layer === "generatedModel"
        || target.layer === "model" || target.layer === "game" || target.layer === "hotfix"
        || target.layer === "benchmark" || target.layer === "business";
    case "business":
      return target.layer === "core" || target.layer === "generatedModel"
        || target.layer === "model" || target.layer === "game"
        || (target.layer === "business" && source.domain === target.domain);
  }
}
