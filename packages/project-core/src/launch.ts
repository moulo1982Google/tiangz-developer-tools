import path from "node:path";

import type { MachineConfigModel, ProcessDebugConfigModel } from "./types.js";

export interface DebugConfigOverride {
  readonly inspectorIp: string;
  readonly inspectorPort: number;
  readonly breakOnStart: boolean;
  readonly allowRemote: boolean;
}

export interface GeneratedDebugConfig {
  readonly text: string;
  readonly debug: ProcessDebugConfigModel;
}

export function createDebugConfig(
  configText: string,
  override: DebugConfigOverride,
): GeneratedDebugConfig {
  const value: unknown = JSON.parse(configText);
  if (!isRecord(value) || !isRecord(value.process)) {
    throw new Error("Process 配置缺少 process 对象");
  }
  const debug: ProcessDebugConfigModel = {
    inspectorIp: override.inspectorIp,
    inspectorPort: override.inspectorPort,
    breakOnStart: override.breakOnStart,
    allowRemote: override.allowRemote,
  };
  const generated = {
    ...value,
    process: {
      ...value.process,
      debug,
    },
  };
  return { text: `${JSON.stringify(generated, null, 2)}\n`, debug };
}

export function resolveMachineProcessPaths(machine: MachineConfigModel): readonly string[] {
  const directory = path.posix.dirname(machine.relativePath);
  return machine.processes.map((processFile) => path.posix.normalize(
    path.posix.join(directory, processFile.replaceAll("\\", "/")),
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
