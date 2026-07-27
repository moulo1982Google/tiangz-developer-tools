import { createHash } from "node:crypto";
import path from "node:path";

import type { ProjectDiagnostic, ProjectSource } from "./types.js";

interface GeneratedManifest {
  readonly version: number;
  readonly hashAlgorithm: string;
  readonly generators: Record<string, GeneratorManifest>;
}

interface GeneratorManifest {
  readonly command: string;
  readonly contentInputs: Record<string, string>;
  readonly selections: readonly SelectionManifest[];
  readonly outputs: Record<string, string>;
  readonly outputRoots: readonly OutputRootManifest[];
}

interface SelectionManifest {
  readonly kind: string;
  readonly roots: readonly string[];
  readonly paths: readonly string[];
}

interface OutputRootManifest {
  readonly path: string;
  readonly extensions: readonly string[];
  readonly ignore?: readonly string[];
}

const MANIFEST_PATH = "codegen.manifest.json";

export function validateGeneratedIntegrity(
  sources: readonly ProjectSource[],
  diagnostics: ProjectDiagnostic[],
): void {
  const sourceByPath = new Map(sources.map((source) => [normalizePath(source.relativePath), source]));
  const manifestSource = sourceByPath.get(MANIFEST_PATH);
  if (!manifestSource) return;
  const manifest = parseManifest(manifestSource.text, diagnostics);
  if (!manifest) return;

  for (const [generatorId, generator] of Object.entries(manifest.generators)) {
    if (!isGeneratorManifest(generator)) {
      diagnostics.push({
        code: "tiangz.generated.invalid-manifest",
        severity: "error",
        message: `codegen.manifest.json 中的生成器 ${generatorId} 结构无效`,
        location: fileLocation(MANIFEST_PATH),
      });
      continue;
    }
    validateGenerator(generatorId, generator, sourceByPath, diagnostics);
  }
}

function validateGenerator(
  generatorId: string,
  generator: GeneratorManifest,
  sourceByPath: ReadonlyMap<string, ProjectSource>,
  diagnostics: ProjectDiagnostic[],
): void {
  const changedInputs = Object.entries(generator.contentInputs).flatMap(([inputPath, expectedHash]) => {
    const source = sourceByPath.get(normalizePath(inputPath));
    return !source || hashText(source.text) !== expectedHash ? [normalizePath(inputPath)] : [];
  });
  const changedSelections = generator.selections.filter((selection) => {
    const actual = selectPaths(selection, sourceByPath.keys());
    const expected = [...selection.paths].map(normalizePath).sort(comparePath);
    return actual.length !== expected.length || actual.some((value, index) => value !== expected[index]);
  });
  if (changedInputs.length > 0 || changedSelections.length > 0) {
    const details = [
      ...changedInputs,
      ...changedSelections.map((selection) => `${selection.kind} 文件集合`),
    ];
    diagnostics.push({
      code: "tiangz.generated.stale",
      severity: "error",
      message: `${generatorId} 生成结果已过期：${details.join("、")}；请执行 ${generator.command}`,
      location: fileLocation(MANIFEST_PATH),
    });
  }

  const expectedOutputs = new Set(Object.keys(generator.outputs).map(normalizePath));
  for (const [outputPath, expectedHash] of Object.entries(generator.outputs)) {
    const normalized = normalizePath(outputPath);
    const source = sourceByPath.get(normalized);
    if (!source) {
      diagnostics.push({
        code: "tiangz.generated.missing",
        severity: "error",
        message: `${generatorId} 缺少生成文件 ${normalized}；请执行 ${generator.command}`,
        location: fileLocation(MANIFEST_PATH),
      });
    } else if (hashText(source.text) !== expectedHash) {
      diagnostics.push({
        code: "tiangz.generated.modified",
        severity: "error",
        message: `${normalized} 与 ${generatorId} 记录的生成内容不一致，请勿手工修改；执行 ${generator.command} 可重新生成`,
        location: fileLocation(normalized),
      });
    }
  }

  for (const outputRoot of generator.outputRoots) {
    const root = normalizePath(outputRoot.path).replace(/\/$/, "");
    const extensions = new Set(outputRoot.extensions);
    const ignored = new Set((outputRoot.ignore ?? []).map(normalizePath));
    for (const candidate of sourceByPath.keys()) {
      if (!candidate.startsWith(`${root}/`) || !extensions.has(path.posix.extname(candidate))) continue;
      if (expectedOutputs.has(candidate) || ignored.has(candidate)) continue;
      diagnostics.push({
        code: "tiangz.generated.orphan",
        severity: "warning",
        message: `${candidate} 位于 ${generatorId} 输出目录，但不属于当前生成结果`,
        location: fileLocation(candidate),
      });
    }
  }
}

function selectPaths(selection: SelectionManifest, paths: Iterable<string>): string[] {
  const roots = selection.roots.map((root) => normalizePath(root).replace(/\/$/, ""));
  return [...paths]
    .filter((candidate) => roots.some((root) => candidate.startsWith(`${root}/`)))
    .filter((candidate) => matchesSelection(selection.kind, candidate))
    .sort(comparePath);
}

function matchesSelection(kind: string, candidate: string): boolean {
  const segments = candidate.split("/");
  const file = segments.at(-1) ?? "";
  const parent = segments.at(-2) ?? "";
  if (segments.some((segment) => ["node_modules", "dist"].includes(segment))) return false;
  switch (kind) {
    case "scene":
      return file !== "index.ts" && file.endsWith(".ts") && parent === "scenes"
        && !segments.includes("generated");
    case "handler":
    case "bench-handler":
      return file !== "index.ts" && file.endsWith(".ts") && segments.includes("handlers")
        && !segments.includes("generated");
    case "hotfix-patch":
      return file.endsWith("Hotfix.ts") && !segments.includes("generated");
    case "hotfix-system":
      return file.endsWith("System.ts") && !segments.includes("generated");
    case "protocol-rpc":
      return file === "rpcs.ts" && parent === "protocol";
    case "protocol-message":
      return file === "messageDescriptors.ts" && parent === "protocol";
    case "client-handler":
      return file.endsWith("Handler.ts")
        && segments.some((segment) => segment.toLowerCase() === "handlers")
        && !segments.some((segment) => ["generated", "node_modules", "temp", "library"].includes(segment.toLowerCase()));
    default:
      return false;
  }
}

function parseManifest(text: string, diagnostics: ProjectDiagnostic[]): GeneratedManifest | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || value.version !== 1 || value.hashAlgorithm !== "sha256-normalized-text-v1"
      || !isRecord(value.generators)) {
      throw new Error("不支持的 Manifest 结构或版本");
    }
    return value as unknown as GeneratedManifest;
  } catch (error) {
    diagnostics.push({
      code: "tiangz.generated.invalid-manifest",
      severity: "error",
      message: `codegen.manifest.json 无效：${errorMessage(error)}`,
      location: fileLocation(MANIFEST_PATH),
    });
    return undefined;
  }
}

function hashText(content: string): string {
  return createHash("sha256").update(content.replaceAll("\r\n", "\n"), "utf8").digest("hex");
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function comparePath(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function fileLocation(relativePath: string) {
  return { relativePath, line: 0, character: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGeneratorManifest(value: unknown): value is GeneratorManifest {
  if (!isRecord(value) || typeof value.command !== "string"
    || !isRecord(value.contentInputs) || !isRecord(value.outputs)
    || !Array.isArray(value.selections) || !Array.isArray(value.outputRoots)) return false;
  return Object.values(value.contentInputs).every((item) => typeof item === "string")
    && Object.values(value.outputs).every((item) => typeof item === "string")
    && value.selections.every((item) => isRecord(item) && typeof item.kind === "string"
      && stringArray(item.roots) && stringArray(item.paths))
    && value.outputRoots.every((item) => isRecord(item) && typeof item.path === "string"
      && stringArray(item.extensions) && (item.ignore === undefined || stringArray(item.ignore)));
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
