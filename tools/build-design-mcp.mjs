import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [path.join(root, "packages", "design-mcp", "src", "server.ts")],
  outfile: path.join(root, "dist", "tiangz-design-mcp.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: true,
  logLevel: "info",
});
