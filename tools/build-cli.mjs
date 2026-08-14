import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["typescript"],
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: true,
  logLevel: "info",
};

await Promise.all([
  build({
    ...common,
    entryPoints: [path.join(root, "packages", "project-cli", "src", "cli.ts")],
    outfile: path.join(root, "dist", "tiangz-check-project.cjs"),
  }),
  build({
    ...common,
    entryPoints: [path.join(root, "packages", "project-cli", "src", "scaffoldCli.ts")],
    outfile: path.join(root, "dist", "tiangz-new-component.cjs"),
  }),
]);
