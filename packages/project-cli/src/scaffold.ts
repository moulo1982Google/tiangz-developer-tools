import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface NewComponentOptions {
  readonly projectRoot: string;
  readonly name: string;
  readonly domain: string;
  readonly dryRun?: boolean;
}

export interface ScaffoldFile {
  readonly relativePath: string;
  readonly content: string;
}

export interface NewComponentResult {
  readonly projectRoot: string;
  readonly baseName: string;
  readonly componentName: string;
  readonly files: readonly ScaffoldFile[];
  readonly publicExport: string;
  readonly dryRun: boolean;
}

/**
 * 创建一个遵守 Model/Hotfix 分层的 Component 三件套。
 * Creates a Component scaffold that preserves the Model/Hotfix boundary.
 *
 * 副作用：会创建三个源码文件并修改 app/model/public.ts；默认拒绝覆盖已有文件。
 * Side effects: creates three source files and updates app/model/public.ts; existing files are never overwritten.
 */
export async function createComponentScaffold(
  options: NewComponentOptions,
): Promise<NewComponentResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const baseName = normalizeTypeName(options.name);
  const domain = normalizeDomain(options.domain);
  const componentName = `${baseName}Component`;
  const componentDirectory = lowerCamel(baseName);
  const publicFile = path.join(projectRoot, "app", "model", "public.ts");
  const publicText = await readProjectPublic(publicFile);
  const files = createFiles(domain, componentDirectory, componentName);
  const publicExport = `export { ${componentName} } from "./${domain}/${componentDirectory}/${componentName}";`;

  if (hasPublicExport(publicText, componentName)) {
    throw new Error(`Model public 入口已经导出了 ${componentName}，请换一个名称或手工检查现有实现`);
  }
  for (const file of files) {
    await assertAbsent(path.join(projectRoot, ...file.relativePath.split("/")), file.relativePath);
  }

  if (!options.dryRun) {
    for (const file of files) {
      const absolutePath = path.join(projectRoot, ...file.relativePath.split("/"));
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, file.content, "utf8");
    }
    await writeFile(publicFile, appendPublicExport(publicText, publicExport), "utf8");
  }

  return {
    projectRoot,
    baseName,
    componentName,
    files,
    publicExport,
    dryRun: options.dryRun === true,
  };
}

function createFiles(domain: string, componentDirectory: string, componentName: string): ScaffoldFile[] {
  return [
    {
      relativePath: `app/model/domains/${componentDirectory}/${componentName}.ts`,
      content: `import { Component, component } from "../../../core/public";

/**
 * 可复用的状态容器；不要在这里放具体游戏协议或地图查询。
 * Reusable state owner; keep game protocols and map queries out of this layer.
 */
@component()
export class ${componentName} extends Component {}
`,
    },
    {
      relativePath: `app/model/${domain}/${componentDirectory}/${componentName}.ts`,
      content: `/**
 * ${domain} 领域门面；通用状态定义位于 app/model/domains。
 * ${domain} domain facade; the reusable state definition lives in app/model/domains.
 */
export { ${componentName} } from "../../domains/${componentDirectory}/${componentName}";
`,
    },
    {
      relativePath: `app/hotfix/${domain}/${componentDirectory}/${componentName}System.ts`,
      content: `import { ${componentName}, systemFor } from "#tiangz/model";

/**
 * ${domain} 领域的可热更行为；长期状态必须回到 ${componentName}。
 * Hot-reloadable ${domain} behavior; long-lived state belongs in ${componentName}.
 */
@systemFor(${componentName})
export class ${componentName}System extends ${componentName} {}
`,
    },
  ];
}

async function readProjectPublic(publicFile: string): Promise<string> {
  try {
    const metadata = await stat(publicFile);
    if (!metadata.isFile()) throw new Error(`不是有效的 Model public 入口：${publicFile}`);
    return await readFile(publicFile, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`不是 TiangZ 工程根目录：找不到 ${path.relative(process.cwd(), publicFile)}`);
    }
    throw error;
  }
}

async function assertAbsent(file: string, relativePath: string): Promise<void> {
  try {
    await stat(file);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`目标文件已经存在，不会覆盖：${relativePath}`);
}

function hasPublicExport(text: string, componentName: string): boolean {
  const escaped = componentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*export\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`, "m").test(text);
}

function appendPublicExport(text: string, publicExport: string): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const prefix = text.length === 0 || text.endsWith("\n") ? text : `${text}${newline}`;
  return `${prefix}${publicExport}${newline}`;
}

function normalizeTypeName(value: string): string {
  const raw = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(raw)) {
    throw new Error("组件名只能包含英文字母和数字，并且必须以字母开头；例如 Inventory 或 PlayerStats");
  }
  const withoutSuffix = raw.endsWith("Component") ? raw.slice(0, -"Component".length) : raw;
  if (withoutSuffix.length === 0) throw new Error("组件名不能只有 Component");
  return `${withoutSuffix[0]!.toUpperCase()}${withoutSuffix.slice(1)}`;
}

function normalizeDomain(value: string): string {
  const raw = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(raw)) {
    throw new Error("domain 只能包含英文字母和数字，并且必须以字母开头；例如 mmorpg 或 card");
  }
  const domain = lowerCamel(raw);
  if (new Set(["core", "domains", "generated", "hotfix", "public"]).has(domain)) {
    throw new Error(`domain ${domain} 是保留目录，不能用于业务组件`);
  }
  return domain;
}

function lowerCamel(value: string): string {
  return `${value[0]!.toLowerCase()}${value.slice(1)}`;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}
