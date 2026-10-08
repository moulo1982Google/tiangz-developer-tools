import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  analyzeTiangZProject,
  createProjectFilePlan,
  RuntimeContractProject,
  type ProjectSource,
  type TiangZProjectSnapshot,
} from "../../project-core/src/index.js";

const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".git", "target", "dist", "out", "temp", "library"]);

export interface CheckProjectOptions {
  readonly maxFiles?: number;
  readonly maxFileSizeBytes?: number;
}

export interface CheckProjectResult {
  readonly projectRoot: string;
  readonly fileCount: number;
  readonly elapsedMs: number;
  readonly snapshot: TiangZProjectSnapshot;
}

export async function checkProject(
  projectRoot: string,
  options: CheckProjectOptions = {},
): Promise<CheckProjectResult> {
  const startedAt = performance.now();
  const root = path.resolve(projectRoot);
  const metadata = await stat(root);
  if (!metadata.isDirectory()) throw new Error(`工程路径不是目录：${root}`);
  if (await isFile(path.join(root, "tiangz.project.json"))) {
    throw new Error("这是独立模块工程，旧工程检查器不适用。请在该工程运行 npm run check（声明宿主 tools/tiangz.mjs check），或使用 VS Code 模块工程检查命令。");
  }

  const maxFiles = options.maxFiles ?? 10_000;
  const maxFileSizeBytes = options.maxFileSizeBytes ?? 2 * 1024 * 1024;
  const manifestText = await readOptionalText(path.join(root, "codegen.manifest.json"), maxFileSizeBytes);
  const plan = createProjectFilePlan(manifestText);
  const relativePaths = new Set<string>();

  for (const tree of plan.trees) {
    await collectTree(root, tree.root, new Set(tree.extensions), relativePaths, maxFiles);
  }
  for (const relativePath of plan.exactPaths) {
    if (await isFile(path.join(root, ...relativePath.split("/")))) relativePaths.add(relativePath);
  }
  if (relativePaths.size > maxFiles) throw new Error(`工程文件超过上限 ${maxFiles}，请缩小扫描范围或提高 --max-files`);

  const sources: ProjectSource[] = [];
  for (const relativePath of [...relativePaths].sort(comparePath)) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const metadata = await stat(absolutePath);
    if (metadata.size > maxFileSizeBytes) continue;
    sources.push({ relativePath, text: await readFile(absolutePath, "utf8") });
  }
  const contracts = new RuntimeContractProject(root);
  try {
    const snapshot = analyzeTiangZProject(sources, contracts.analyze(sources));
    return { projectRoot: root, fileCount: sources.length, elapsedMs: performance.now() - startedAt, snapshot };
  } finally {
    contracts.dispose();
  }
}

async function collectTree(
  projectRoot: string,
  relativeRoot: string,
  extensions: ReadonlySet<string>,
  results: Set<string>,
  maxFiles: number,
): Promise<void> {
  const absoluteRoot = path.join(projectRoot, ...relativeRoot.split("/"));
  if (!await isDirectory(absoluteRoot)) return;
  const pending = [{ absolute: absoluteRoot, relative: normalizePath(relativeRoot) }];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory.absolute, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) {
          pending.push({
            absolute: path.join(directory.absolute, entry.name),
            relative: `${directory.relative}/${entry.name}`,
          });
        }
      } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        results.add(`${directory.relative}/${entry.name}`);
        if (results.size > maxFiles) return;
      }
    }
  }
}

async function readOptionalText(file: string, maxFileSizeBytes: number): Promise<string | undefined> {
  try {
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size > maxFileSizeBytes) return undefined;
    return await readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function isDirectory(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isDirectory();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function comparePath(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}
