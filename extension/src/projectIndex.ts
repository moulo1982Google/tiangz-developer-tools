import * as vscode from "vscode";

import {
  analyzeTiangZProject,
  type ProjectSource,
  type TiangZProjectSnapshot,
} from "../../packages/project-core/src/index.js";

const EXCLUDE = "**/{node_modules,.git,target,dist,out,temp,library}/**";

export interface IndexedProject {
  readonly folder: vscode.WorkspaceFolder;
  readonly snapshot: TiangZProjectSnapshot;
}

export async function indexWorkspaceFolder(folder: vscode.WorkspaceFolder): Promise<IndexedProject> {
  const configuration = vscode.workspace.getConfiguration("tiangzDeveloperTools", folder.uri);
  const configRoot = normalizeRoot(configuration.get<string>("configRoot", "configs"));
  const sourceRoots = configuration.get<unknown>("sourceRoots", ["app"]);
  const roots = Array.isArray(sourceRoots)
    ? sourceRoots.filter((value): value is string => typeof value === "string").map(normalizeRoot).filter(Boolean)
    : ["app"];
  const uris: vscode.Uri[] = [];
  const seen = new Set<string>();
  await collect(`${configRoot}/**/*.json`);
  for (const root of roots) await collect(`${root}/**/*.ts`);
  const decoder = new TextDecoder();
  const sources: ProjectSource[] = await Promise.all(uris.map(async (uri) => ({
    relativePath: vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/"),
    text: decoder.decode(await vscode.workspace.fs.readFile(uri)),
  })));
  return { folder, snapshot: analyzeTiangZProject(sources) };

  async function collect(pattern: string): Promise<void> {
    for (const uri of await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), EXCLUDE)) {
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
