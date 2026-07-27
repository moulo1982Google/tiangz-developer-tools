import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const extensionRoot = path.resolve(import.meta.dirname, "..", "extension");
const repositoryRoot = path.resolve(extensionRoot, "..");
const packageJson = JSON.parse(
  await readFile(path.join(extensionRoot, "package.json"), "utf8"),
);
const output = path.resolve(
  extensionRoot,
  "..",
  "dist",
  `${packageJson.name}-${packageJson.version}.vsix`,
);
const vsceCli = path.join(repositoryRoot, "node_modules", "@vscode", "vsce", "vsce");

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    vsceCli,
    "package",
    "--no-dependencies",
    "--out",
    output,
  ], {
    cwd: extensionRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`vsce exited with code ${code ?? "unknown"}`));
  });
});
