import assert from "node:assert/strict";
import test from "node:test";

import { formatRuntimeMetricsMarkdown, parsePrometheusText } from "../dist/index.js";

test("parses Prometheus samples and escaped labels", () => {
  const samples = parsePrometheusText(`# HELP ignored\n# TYPE ignored gauge\ntiangz_scene_mailbox_queued_depth{process="all",scene="map_1",scene_type="MapHost"} 3\ntiangz_process_cpu_percent{process="all"} 12.5  # trailing comment\n`);
  assert.deepEqual(samples, [
    {
      name: "tiangz_scene_mailbox_queued_depth",
      labels: { process: "all", scene: "map_1", scene_type: "MapHost" },
      value: "3",
    },
    {
      name: "tiangz_process_cpu_percent",
      labels: { process: "all" },
      value: "12.5",
    },
  ]);
});

test("formats a small runtime inspection document", () => {
  const markdown = formatRuntimeMetricsMarkdown({
    processName: "all",
    endpoint: "http://127.0.0.1:7600/metrics",
    fetchedAt: "2026-08-14T00:00:00.000Z",
    body: [
      'tiangz_process_cpu_percent{process="all"} 4.5',
      'tiangz_process_rust_queue_depth{process="all"} 2',
      'tiangz_scene_mailbox_queued_depth{process="all",scene="map_1",scene_type="MapHost"} 1',
      'tiangz_game_timers_total{process="all"} 7',
    ].join("\n"),
  });
  assert.match(markdown, /# TiangZ Runtime 指标：all/);
  assert.match(markdown, /tiangz_process_rust_queue_depth/);
  assert.match(markdown, /Scene 与 mailbox/);
  assert.match(markdown, /tiangz_game_timers_total/);
  assert.match(markdown, /未出现的标准指标/);
});
