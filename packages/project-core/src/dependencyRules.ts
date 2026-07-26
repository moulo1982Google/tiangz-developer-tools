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

export function validateTypeScriptDependencies(
  sourceFile: ts.SourceFile,
  relativePath: string,
  diagnostics: ProjectDiagnostic[],
): void {
  const source = classifyModule(relativePath);
  if (!source) return;
  const seenOffsets = new Set<number>();
  visit(sourceFile);

  function visit(node: ts.Node): void {
    const specifier = moduleSpecifier(node);
    if (specifier && !seenOffsets.has(specifier.getStart(sourceFile))) {
      seenOffsets.add(specifier.getStart(sourceFile));
      validateSpecifier(specifier);
    }
    ts.forEachChild(node, visit);
  }

  function validateSpecifier(specifier: ts.StringLiteralLike): void {
    if (!specifier.text.startsWith(".")) {
      if (source!.layer === "hotfix" && specifier.text !== "#tiangz/model") {
        reportInvalid(specifier, `Hotfix 只能通过 #tiangz/model 导入稳定层：${relativePath} -> ${specifier.text}`);
      }
      return;
    }
    const targetPath = resolveRelativeModule(relativePath, specifier.text);
    const target = classifyModule(targetPath);
    if (!target || dependencyAllowed(source!, target)) return;
    reportInvalid(specifier, `${source!.label} 不允许依赖 ${target.label}：${relativePath} -> ${targetPath}`);
  }

  function reportInvalid(specifier: ts.StringLiteralLike, message: string): void {
    const position = sourceFile.getLineAndCharacterOfPosition(specifier.getStart(sourceFile) + 1);
    diagnostics.push({
      code: "tiangz.architecture.invalid-dependency",
      severity: "error",
      message,
      location: { relativePath, line: position.line, character: position.character },
    });
  }
}

function moduleSpecifier(node: ts.Node): ts.StringLiteralLike | undefined {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
    return node.moduleSpecifier;
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const argument = node.arguments[0];
    return argument && ts.isStringLiteralLike(argument) ? argument : undefined;
  }
  return undefined;
}

function resolveRelativeModule(importer: string, specifier: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
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
