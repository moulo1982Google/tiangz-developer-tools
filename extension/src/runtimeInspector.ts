import { formatRuntimeMetricsMarkdown } from "../../packages/project-core/src/runtimeMetrics.js";
import type { ProcessConfigModel } from "../../packages/project-core/src/types.js";

/**
 * 从 Process 的 health 配置读取只读指标，并在编辑器中打开摘要。
 * Reads read-only metrics from the Process health configuration and opens a summary in the editor.
 */
export async function openRuntimeMetrics(
  vscodeApi: typeof import("vscode"),
  process: ProcessConfigModel,
): Promise<void> {
  const health = process.observability?.health;
  if (!health) {
    throw new Error(`${process.name} 没有配置 process.observability.health，无法定位 /metrics`);
  }
  if (!Number.isInteger(health.port) || health.port < 1 || health.port > 65535) {
    throw new Error(`${process.name} 的 health.port 无效：${health.port}`);
  }
  const host = normalizeHealthHost(health.ip);
  const endpoint = `http://${formatHost(host)}:${health.port}/metrics`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  let response: Response;
  try {
    response = await fetch(endpoint, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${process.name} 的 /metrics 请求超时：${endpoint}`);
    throw new Error(`${process.name} 的 /metrics 请求失败：${errorMessage(error)}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`${process.name} 的 /metrics 返回 HTTP ${response.status}`);
  const body = await response.text();
  const content = formatRuntimeMetricsMarkdown({
    processName: process.name,
    endpoint,
    fetchedAt: new Date().toISOString(),
    body,
  });
  const document = await vscodeApi.workspace.openTextDocument({ content, language: "markdown" });
  await vscodeApi.window.showTextDocument(document, { preview: false, viewColumn: vscodeApi.ViewColumn.Active });
}

function normalizeHealthHost(value: string): string {
  const host = value.trim();
  if (host === "0.0.0.0" || host === "::" || host === "") return "127.0.0.1";
  if (!/^[a-zA-Z0-9:._-]+$/.test(host)) throw new Error(`health.ip 含有不支持的字符：${value}`);
  return host;
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
