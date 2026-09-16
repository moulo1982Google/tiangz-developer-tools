import * as vscode from "vscode";

const excluded = new Set(["node_modules", ".git", "target", "dist", "out", "temp", "library", "build"]);

/** Discover only the opened directory and direct children; never execute candidate project code. */
export async function discoverProjectRoots(folder: vscode.WorkspaceFolder): Promise<vscode.WorkspaceFolder[]> {
  if (await isProject(folder.uri)) return [folder];
  const children = await vscode.workspace.fs.readDirectory(folder.uri);
  const result: vscode.WorkspaceFolder[] = [];
  for (const [name, type] of children.sort(([a], [b]) => a.localeCompare(b))) {
    if (name.startsWith(".") || excluded.has(name.toLowerCase()) || !(type & 2) || (type & 64)) continue;
    const uri = vscode.Uri.joinPath(folder.uri, name);
    if (await isProject(uri)) result.push({ uri, name: `${folder.name}/${name}`, index: folder.index });
  }
  return result.length ? result : [folder];
}

export async function discoverProjectFolders(folders: readonly vscode.WorkspaceFolder[]): Promise<vscode.WorkspaceFolder[]> {
  const candidates = (await Promise.all(folders.map(discoverProjectRoots))).flat();
  return [...new Map(candidates.map(folder => [folder.uri.toString(), folder])).values()];
}

/** A nested project has its own cwd, but VS Code tasks must belong to an actually opened workspace folder. */
export function projectTaskScope(folder: vscode.WorkspaceFolder): vscode.WorkspaceFolder {
  return vscode.workspace.getWorkspaceFolder?.(folder.uri) ?? folder;
}

export async function hasProjectFile(uri: vscode.Uri): Promise<boolean> {
  try { const info = await vscode.workspace.fs.stat(uri); return (info.type & 1) !== 0; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "FileNotFound") return false;
    throw error;
  }
}

async function isProject(uri: vscode.Uri): Promise<boolean> {
  if (await hasProjectFile(vscode.Uri.joinPath(uri, "tiangz.project.json"))) return true;
  return await hasProjectFile(vscode.Uri.joinPath(uri, "app/core/public.ts"))
    && await hasProjectFile(vscode.Uri.joinPath(uri, "package.json"));
}
