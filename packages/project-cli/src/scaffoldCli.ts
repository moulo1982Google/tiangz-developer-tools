import path from "node:path";

import { createComponentScaffold } from "./scaffold.js";

interface ScaffoldCliOptions {
  readonly name: string;
  readonly domain: string;
  readonly projectRoot: string;
  readonly dryRun: boolean;
}

async function run(args: readonly string[]): Promise<number> {
  let options: ScaffoldCliOptions;
  try {
    const parsed = parseArgs(args);
    if (parsed === "help") {
      process.stdout.write(helpText());
      return 0;
    }
    options = parsed;
  } catch (error) {
    process.stderr.write(`参数错误：${errorMessage(error)}\n\n${helpText()}`);
    return 2;
  }

  try {
    const result = await createComponentScaffold(options);
    const action = result.dryRun ? "将创建" : "已创建";
    process.stdout.write(`${action} ${result.componentName}：\n`);
    for (const file of result.files) process.stdout.write(`  ${file.relativePath}\n`);
    process.stdout.write(`  app/model/public.ts（追加 ${result.publicExport}）\n`);
    process.stdout.write(`工程目录：${result.projectRoot}\n`);
    if (!result.dryRun) {
      process.stdout.write("下一步：npm run codegen:scenes && npm run typecheck && npm run verify:fast\n");
    }
    return 0;
  } catch (error) {
    process.stderr.write(`创建组件失败：${errorMessage(error)}\n`);
    return 1;
  }
}

function parseArgs(args: readonly string[]): ScaffoldCliOptions | "help" {
  let name: string | undefined;
  let domain: string | undefined;
  let projectRoot = ".";
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--domain") {
      domain = requireValue(args, ++index, "--domain");
      continue;
    }
    if (arg === "--project") {
      projectRoot = requireValue(args, ++index, "--project");
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`未知参数 ${arg}`);
    if (name) throw new Error("只能指定一个组件名");
    name = arg;
  }
  if (!name) throw new Error("缺少组件名，例如：tiangz-new-component Inventory --domain mmorpg");
  if (!domain) throw new Error("缺少 --domain，例如：--domain mmorpg");
  return { name, domain, projectRoot: path.resolve(projectRoot), dryRun };
}

function requireValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("-")) throw new Error(`${option} 后面必须提供值`);
  return value;
}

function helpText(): string {
  return `TiangZ Component 脚手架

用法：
  tiangz-new-component <组件名> --domain <领域> [选项]

示例：
  tiangz-new-component Inventory --domain mmorpg --project E:\\gitee\\TiangZ

选项：
  --domain <名称>    目标领域目录，例如 mmorpg、card、slg
  --project <目录>   TiangZ 工程根目录，默认当前目录
  --dry-run          只预览文件，不写入磁盘
  -h, --help         显示帮助
`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void run(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
