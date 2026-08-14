export interface PrometheusSample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: string;
}

/**
 * 解析 Runtime 的只读 Prometheus 文本；不执行表达式，也不接受任何写操作。
 * Parses the read-only Prometheus text emitted by Runtime; it evaluates nothing and performs no writes.
 */
export function parsePrometheusText(text: string): readonly PrometheusSample[] {
  const samples: PrometheusSample[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?<name>[a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(?<labels>[^}]*)\})?\s+(?<value>\S+)(?:\s+#.*)?$/.exec(trimmed);
    if (!match?.groups?.name || !match.groups.value) continue;
    samples.push({
      name: match.groups.name,
      labels: parseLabels(match.groups.labels ?? ""),
      value: match.groups.value,
    });
  }
  return samples;
}

export interface RuntimeMetricsDocumentOptions {
  readonly processName: string;
  readonly endpoint: string;
  readonly fetchedAt: string;
  readonly body: string;
}

const INSPECTOR_METRICS = [
  "tiangz_process_cpu_percent",
  "tiangz_process_rss_bytes",
  "tiangz_process_v8_heap_used_bytes",
  "tiangz_process_rust_queue_depth",
  "tiangz_process_rust_queue_capacity",
  "tiangz_process_rust_queue_max_depth",
  "tiangz_process_remote_transport_pending_calls",
  "tiangz_process_actor_mailbox_queued_depth",
  "tiangz_process_actor_mailbox_max_queued_depth",
  "tiangz_scene_async_in_flight",
  "tiangz_scene_mailbox_queued_depth",
  "tiangz_scene_mailbox_max_queued_depth",
  "tiangz_game_timers_total",
  "tiangz_native_live_entities",
  "tiangz_native_live_units",
  "tiangz_native_live_items",
] as const;

/**
 * 生成适合 VS Code 阅读的运行时摘要；原始端点仍是唯一数据来源。
 * Builds a VS Code-readable runtime summary; the Runtime endpoint remains the only data source.
 */
export function formatRuntimeMetricsMarkdown(options: RuntimeMetricsDocumentOptions): string {
  const samples = parsePrometheusText(options.body);
  const rows = samples.filter((sample) => INSPECTOR_METRICS.includes(sample.name as typeof INSPECTOR_METRICS[number]));
  const grouped = new Map<string, PrometheusSample[]>();
  for (const row of rows) {
    const group = row.name.startsWith("tiangz_scene_")
      ? "Scene 与 mailbox"
      : row.name.startsWith("tiangz_native_")
        ? "Native 数据"
        : row.name.startsWith("tiangz_game_")
          ? "Game.Update"
          : "Process 与传输";
    const current = grouped.get(group) ?? [];
    current.push(row);
    grouped.set(group, current);
  }
  const sections = [...grouped.entries()].map(([title, groupRows]) => [
    `### ${title}`,
    "",
    "| 指标 | 标签 | 当前值 |",
    "| --- | --- | ---: |",
    ...groupRows.map((row) => `| \`${row.name}\` | ${formatLabels(row.labels)} | ${row.value} |`),
    "",
  ].join("\n"));
  const missing = INSPECTOR_METRICS.filter((name) => !rows.some((row) => row.name === name));
  return [
    `# TiangZ Runtime 指标：${options.processName}`,
    "",
    `- 端点：\`${options.endpoint}\``,
    `- 读取时间：${options.fetchedAt}`,
    "- 访问方式：只读 `/metrics`；插件不会调用业务 RPC 或修改进程状态。",
    "",
    ...(sections.length > 0 ? sections : ["当前端点没有可识别的指标样本。", ""]),
    ...(missing.length > 0 ? ["### 未出现的标准指标", "", ...missing.map((name) => `- \`${name}\``), ""] : []),
  ].join("\n");
}

function parseLabels(value: string): Readonly<Record<string, string>> {
  const labels: Record<string, string> = {};
  const pattern = /(?<name>[a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"(?<value>(?:\\.|[^"])*)"/g;
  for (const match of value.matchAll(pattern)) {
    const name = match.groups?.name;
    const raw = match.groups?.value;
    if (!name || raw === undefined) continue;
    labels[name] = raw.replaceAll('\\"', '"').replaceAll('\\\\', '\\').replaceAll('\\n', "\n");
  }
  return labels;
}

function formatLabels(labels: Readonly<Record<string, string>>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "-";
  return entries.map(([name, value]) => `${name}=${value}`).join(", ");
}
