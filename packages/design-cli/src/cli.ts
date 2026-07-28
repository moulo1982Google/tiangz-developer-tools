import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  formatDesignRecommendation,
  recommendSystemDesign,
  type DesignRequest,
  type SystemArchetype,
} from "../../design-core/src/index.js";

interface CliOptions {
  readonly request: DesignRequest;
  readonly format: "markdown" | "json";
}

async function run(args: readonly string[]): Promise<number> {
  try {
    const options = await parseArgs(args);
    if (options === "help") {
      process.stdout.write(helpText());
      return 0;
    }
    const result = recommendSystemDesign(options.request);
    process.stdout.write(options.format === "json"
      ? `${JSON.stringify(result, null, 2)}\n`
      : formatDesignRecommendation(result));
    return 0;
  } catch (error) {
    process.stderr.write(`设计参数错误：${errorMessage(error)}\n\n${helpText()}`);
    return 2;
  }
}

async function parseArgs(args: readonly string[]): Promise<CliOptions | "help"> {
  let archetype: SystemArchetype | undefined;
  let name: string | undefined;
  let input: string | undefined;
  let format: "markdown" | "json" = "markdown";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--format") {
      const value = args[++index];
      if (value !== "markdown" && value !== "json") throw new Error("--format只支持markdown或json");
      format = value;
      continue;
    }
    if (arg === "--name") {
      name = requiredValue(args[++index], "--name");
      continue;
    }
    if (arg === "--input") {
      input = requiredValue(args[++index], "--input");
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`未知参数${arg}`);
    if (archetype) throw new Error("只能指定一个系统类型");
    archetype = parseArchetype(arg);
  }

  if (input) {
    if (archetype || name) throw new Error("--input不能和系统类型或--name同时使用");
    const parsed = JSON.parse(await readFile(path.resolve(input), "utf8")) as unknown;
    return { request: parseRequest(parsed), format };
  }
  if (!archetype) throw new Error("缺少系统类型");
  return { request: name ? { archetype, name } : { archetype }, format };
}

function parseRequest(value: unknown): DesignRequest {
  if (!isRecord(value)) throw new Error("设计请求必须是JSON对象");
  const archetype = parseArchetype(value.archetype);
  const optional = <T>(key: string, check: (input: unknown) => input is T): T | undefined => {
    const candidate = value[key];
    if (candidate === undefined) return undefined;
    if (!check(candidate)) throw new Error(`${key}字段无效`);
    return candidate;
  };
  const name = optional("name", (input): input is string => typeof input === "string" && input.trim().length > 0);
  const owner = optional("owner", oneOf("player", "map", "scene", "session"));
  const independentIdentity = optional("independentIdentity", isBoolean);
  const independentLifecycle = optional("independentLifecycle", isBoolean);
  const networkTarget = optional("networkTarget", isBoolean);
  const audiences = optional("audiences", (input): input is DesignRequest["audiences"] =>
    Array.isArray(input) && input.every(oneOf("none", "self", "party", "aoi", "global")));
  const changeSemantics = optional("changeSemantics", oneOf("none", "latest", "event"));
  const changeFrequency = optional("changeFrequency", oneOf("low", "medium", "high"));
  const persistent = optional("persistent", isBoolean);
  return {
    archetype,
    ...(name ? { name } : {}),
    ...(owner ? { owner } : {}),
    ...(independentIdentity !== undefined ? { independentIdentity } : {}),
    ...(independentLifecycle !== undefined ? { independentLifecycle } : {}),
    ...(networkTarget !== undefined ? { networkTarget } : {}),
    ...(audiences ? { audiences } : {}),
    ...(changeSemantics ? { changeSemantics } : {}),
    ...(changeFrequency ? { changeFrequency } : {}),
    ...(persistent !== undefined ? { persistent } : {}),
  };
}

function parseArchetype(value: unknown): SystemArchetype {
  if (typeof value !== "string" || !["item", "buff", "quest", "achievement", "numeric", "custom"].includes(value)) {
    throw new Error(`未知系统类型${String(value)}`);
  }
  return value as SystemArchetype;
}

function helpText(): string {
  return `TiangZ领域设计命令\n\n用法：\n  tiangz-design <item|buff|quest|achievement|numeric> [--name 名称]\n  tiangz-design --input <DesignRequest.json>\n\n选项：\n  --format markdown|json   输出格式，默认markdown\n  --name <名称>            报告中的业务系统名称\n  --input <文件>           读取完整DesignRequest，适用于custom系统\n  -h, --help               显示帮助\n`;
}

function requiredValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag}缺少值`);
  return value;
}

function oneOf<const T extends readonly string[]>(...values: T): (input: unknown) => input is T[number] {
  return (input: unknown): input is T[number] => typeof input === "string" && values.includes(input);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void run(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
