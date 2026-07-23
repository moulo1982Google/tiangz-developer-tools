import * as vscode from "vscode";

import type { TiangZProjectSnapshot } from "../../packages/project-core/src/types.js";

const EXCLUDE = "**/{node_modules,.git,target,dist,out,temp,library}/**";

export interface IndexedProject {
  readonly folder: vscode.WorkspaceFolder;
  readonly sourceUris: readonly vscode.Uri[];
  readonly snapshot: TiangZProjectSnapshot;
}

export interface DiscoveredProject {
  readonly folder: vscode.WorkspaceFolder;
  readonly sourceUris: readonly vscode.Uri[];
}

export async function discoverWorkspaceFolder(folder: vscode.WorkspaceFolder): Promise<DiscoveredProject> {
  const configuration = vscode.workspace.getConfiguration("tiangzDeveloperTools", folder.uri);
  const configRoot = normalizeRoot(configuration.get<string>("configRoot", "configs"));
  const initialFileLimit = configuration.get<number>("initialFileLimit", 10_000);
  const maxFileSizeBytes = configuration.get<number>("maxFileSizeBytes", 2 * 1024 * 1024);
  const sourceRoots = configuration.get<unknown>("sourceRoots", ["app"]);
  const roots = Array.isArray(sourceRoots)
    ? sourceRoots.filter((value): value is string => typeof value === "string").map(normalizeRoot).filter(Boolean)
    : ["app"];
  const uris: vscode.Uri[] = [];
  const seen = new Set<string>();
  await collect(`${configRoot}/**/*.json`);
  for (const root of roots) await collect(`${root}/**/*.ts`);
  const loaded = await Promise.all(uris.map(async (uri) => {
    const metadata = await vscode.workspace.fs.stat(uri);
    if (metadata.size > maxFileSizeBytes) return undefined;
    return uri;
  }));
  const accepted = loaded.filter((value): value is NonNullable<typeof value> => value !== undefined);
  return { folder, sourceUris: accepted };

  async function collect(pattern: string): Promise<void> {
    const remaining = Math.max(0, initialFileLimit - uris.length);
    if (remaining === 0) return;
    for (const uri of await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), EXCLUDE, remaining)) {
      const key = uri.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      uris.push(uri);
    }
  }
}

function normalizeRoot(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}
