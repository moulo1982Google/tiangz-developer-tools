import path from "node:path";
import { fileURLToPath } from "node:url";

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
