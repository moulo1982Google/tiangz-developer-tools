import path from "node:path";

import { checkProject } from "./projectChecker.js";

interface CliOptions {
  readonly projectRoot: string;
  readonly format: "text" | "json";
  readonly warningsAsErrors: boolean;
  readonly maxFiles: number;
}

async function runCli(args: readonly string[]): Promise<number> {
  let options: CliOptions;
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
    const result = await checkProject(options.projectRoot, { maxFiles: options.maxFiles });
    const errors = result.snapshot.diagnostics.filter((item) => item.severity === "error");
    const warnings = result.snapshot.diagnostics.filter((item) => item.severity === "warning");
    const failed = errors.length > 0 || (options.warningsAsErrors && warnings.length > 0);
    if (options.format === "json") {
      process.stdout.write(`${JSON.stringify({
        version: 1,
        projectRoot: result.projectRoot,
        passed: !failed,
        fileCount: result.fileCount,
        elapsedMs: Number(result.elapsedMs.toFixed(2)),
        errors: errors.length,
        warnings: warnings.length,
        diagnostics: result.snapshot.diagnostics,
      }, null, 2)}\n`);
    } else {
      for (const diagnostic of result.snapshot.diagnostics) {
        const location = `${diagnostic.location.relativePath}:${diagnostic.location.line + 1}:${diagnostic.location.character + 1}`;
        process.stdout.write(`${location} ${diagnostic.severity === "error" ? "错误" : "警告"} ${diagnostic.code} ${diagnostic.message}\n`);
      }
      const status = failed ? "检查失败" : "检查通过";
      process.stdout.write(`${status}：${result.fileCount} 个文件，${errors.length} 个错误，${warnings.length} 个警告，${result.elapsedMs.toFixed(1)} ms\n`);
    }
    return failed ? 1 : 0;
  } catch (error) {
    process.stderr.write(`检查器错误：${errorMessage(error)}\n`);
    return 2;
  }
}

function parseArgs(args: readonly string[]): CliOptions | "help" {
  let projectRoot: string | undefined;
  let format: "text" | "json" = "text";
  let warningsAsErrors = false;
  let maxFiles = 10_000;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--warnings-as-errors") {
      warningsAsErrors = true;
      continue;
    }
    if (arg === "--format") {
      const value = args[++index];
      if (value !== "text" && value !== "json") throw new Error("--format 只支持 text 或 json");
      format = value;
      continue;
    }
    if (arg === "--max-files") {
      const value = Number(args[++index]);
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("--max-files 必须是正整数");
      maxFiles = value;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`未知参数 ${arg}`);
    if (projectRoot) throw new Error("只能指定一个工程目录");
    projectRoot = arg;
  }
  return { projectRoot: path.resolve(projectRoot ?? "."), format, warningsAsErrors, maxFiles };
}

function helpText(): string {
  return `TiangZ 工程检查器\n\n用法：\n  tiangz-check-project [工程目录] [选项]\n\n选项：\n  --format text|json       输出格式，默认 text\n  --warnings-as-errors     将警告视为检查失败\n  --max-files <数量>       最大扫描文件数，默认 10000\n  -h, --help               显示帮助\n\n退出码：\n  0  检查通过\n  1  存在工程诊断\n  2  参数、路径或检查器自身错误\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void runCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
