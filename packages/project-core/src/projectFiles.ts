import type { CodegenGeneratorModel } from "./types.js";

export interface ProjectFileTree {
  readonly root: string;
  readonly extensions: readonly string[];
}

export interface ProjectFilePlan {
  readonly exactPaths: readonly string[];
  readonly trees: readonly ProjectFileTree[];
}

const MANIFEST_PATH = "codegen.manifest.json";

export function createProjectFilePlan(manifestText?: string): ProjectFilePlan {
  const exactPaths = new Set<string>([MANIFEST_PATH]);
  const trees = new Map<string, Set<string>>([
    ["configs", new Set([".json"])],
    ["app", new Set([".ts"])],
  ]);
  if (!manifestText) return freezePlan(exactPaths, trees);

  const manifest = parseManifest(manifestText);
  if (!isRecord(manifest) || !isRecord(manifest.generators)) return freezePlan(exactPaths, trees);

  for (const generator of Object.values(manifest.generators)) {
    if (!isRecord(generator)) continue;
    addRecordKeys(exactPaths, generator.contentInputs);
    addRecordKeys(exactPaths, generator.outputs);
    if (Array.isArray(generator.selections)) {
      for (const selection of generator.selections) {
        if (!isRecord(selection) || !Array.isArray(selection.roots)) continue;
        for (const root of stringValues(selection.roots)) addTree(trees, root, [".ts"]);
      }
    }
    if (Array.isArray(generator.outputRoots)) {
      for (const outputRoot of generator.outputRoots) {
        if (!isRecord(outputRoot) || typeof outputRoot.path !== "string" || !Array.isArray(outputRoot.extensions)) continue;
        addTree(trees, outputRoot.path, stringValues(outputRoot.extensions));
      }
    }
  }
  return freezePlan(exactPaths, trees);
}

export function readProjectGenerators(manifestText?: string): readonly CodegenGeneratorModel[] {
  const manifest = parseManifest(manifestText);
  if (!isRecord(manifest) || !isRecord(manifest.generators)) return [];
  return Object.entries(manifest.generators)
    .flatMap(([id, value]) => isRecord(value) && typeof value.command === "string" && value.command.trim()
      ? [{ id, command: value.command.trim() }]
      : [])
    .sort((left, right) => comparePath(left.id, right.id));
}

function parseManifest(manifestText?: string): unknown {
  if (!manifestText) return undefined;
  try {
    return JSON.parse(manifestText);
  } catch {
    return undefined;
  }
}

function addRecordKeys(target: Set<string>, value: unknown): void {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) target.add(normalizePath(key));
}

function addTree(target: Map<string, Set<string>>, root: string, extensions: readonly string[]): void {
  const normalized = normalizePath(root).replace(/\/$/, "");
  if (!normalized) return;
  const values = target.get(normalized) ?? new Set<string>();
  for (const extension of extensions) {
    if (extension.startsWith(".")) values.add(extension.toLowerCase());
  }
  if (values.size > 0) target.set(normalized, values);
}

function freezePlan(exactPaths: Set<string>, trees: Map<string, Set<string>>): ProjectFilePlan {
  return {
    exactPaths: [...exactPaths].sort(comparePath),
    trees: [...trees]
      .map(([root, extensions]) => ({ root, extensions: [...extensions].sort(comparePath) }))
      .sort((left, right) => comparePath(left.root, right.root)),
  };
}

function stringValues(value: readonly unknown[]): string[] {
  return value.filter((item): item is string => typeof item === "string");
}

function normalizePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function comparePath(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
