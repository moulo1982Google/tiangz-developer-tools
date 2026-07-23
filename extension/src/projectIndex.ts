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
  await collectManifestFiles();
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

  async function collectManifestFiles(): Promise<void> {
    const manifestUri = vscode.Uri.joinPath(folder.uri, "codegen.manifest.json");
    let manifest: unknown;
    try {
      const content = await vscode.workspace.fs.readFile(manifestUri);
      manifest = JSON.parse(new TextDecoder().decode(content));
      addUri(manifestUri);
    } catch (error) {
      if (isFileNotFound(error)) return;
      addUri(manifestUri);
      return;
    }
    if (!isRecord(manifest) || !isRecord(manifest.generators)) return;
    for (const generator of Object.values(manifest.generators)) {
      if (!isRecord(generator)) continue;
      for (const file of [...recordKeys(generator.contentInputs), ...recordKeys(generator.outputs)]) {
        await addExisting(file);
      }
      if (Array.isArray(generator.selections)) {
        for (const selection of generator.selections) {
          if (!isRecord(selection) || !Array.isArray(selection.roots)) continue;
          for (const root of selection.roots.filter((value): value is string => typeof value === "string")) {
            await collect(`${normalizeRoot(root)}/**/*.ts`);
          }
        }
      }
      if (Array.isArray(generator.outputRoots)) {
        for (const outputRoot of generator.outputRoots) {
          if (!isRecord(outputRoot) || typeof outputRoot.path !== "string" || !Array.isArray(outputRoot.extensions)) continue;
          for (const extension of outputRoot.extensions.filter((value): value is string => typeof value === "string")) {
            await collect(`${normalizeRoot(outputRoot.path)}/**/*${extension}`);
          }
        }
      }
    }
  }

  async function addExisting(relativePath: string): Promise<void> {
    const uri = vscode.Uri.joinPath(folder.uri, ...normalizeRoot(relativePath).split("/"));
    try {
      await vscode.workspace.fs.stat(uri);
      addUri(uri);
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }
  }

  function addUri(uri: vscode.Uri): void {
    if (uris.length >= initialFileLimit) return;
    const key = uri.toString();
    if (seen.has(key)) return;
    seen.add(key);
    uris.push(uri);
  }
}

function normalizeRoot(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function recordKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "FileNotFound";
}
