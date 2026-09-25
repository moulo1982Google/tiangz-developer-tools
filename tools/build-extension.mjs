import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(root, "extension");
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  logLevel: "info",
};

await Promise.all([
  build({
    ...common,
    entryPoints: [path.join(extensionRoot, "src", "extension.ts")],
    outfile: path.join(extensionRoot, "dist", "extension.cjs"),
    external: ["vscode"],
  }),
  build({
    ...common,
    entryPoints: [path.join(extensionRoot, "src", "server.ts")],
    outfile: path.join(extensionRoot, "dist", "server.cjs"),
  }),
]);

const extensionManifest = JSON.parse(await readFile(path.join(extensionRoot, "package.json"), "utf8"));
const coreManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const bundles = {};
for (const name of ["extension.cjs", "server.cjs"]) {
  bundles[name] = createHash("sha256").update(await readFile(path.join(extensionRoot, "dist", name))).digest("hex");
}
await writeFile(path.join(extensionRoot, "dist", "build-info.json"), `${JSON.stringify({
  formatVersion: 1,
  extension: { name: extensionManifest.name, version: extensionManifest.version },
  core: { name: coreManifest.name, version: coreManifest.version },
  bundles,
}, null, 2)}\n`);
