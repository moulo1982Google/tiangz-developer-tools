import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const output = path.join(root, "dist", "tiangz-design-mcp.cjs");

const result = await build({
  absWorkingDir: root,
  entryPoints: [path.join(root, "packages", "design-mcp", "src", "server.ts")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: true,
  logLevel: "info",
  define: { TIANGZ_DESIGN_MCP_VERSION: JSON.stringify(packageJson.version) },
  metafile: true,
});

// 只收录实际打进 bundle 的依赖及许可证；供独立插件分发复核。 / Record licenses only for dependencies actually included in the standalone bundle.
const dependencies = new Map();
for (const input of Object.keys(result.metafile.inputs).sort()) {
  const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.replaceAll("\\", "/"));
  if (!match || dependencies.has(match[1])) continue;
  const dependencyRoot = path.join(root, "node_modules", match[1]);
  const manifest = JSON.parse(readFileSync(path.join(dependencyRoot, "package.json"), "utf8"));
  const notices = readdirSync(dependencyRoot).filter(name => /^(license|licence|notice)(\..*)?$/i.test(name)).sort();
  if (notices.length === 0) throw new Error(`Missing bundled dependency license: ${match[1]}`);
  dependencies.set(match[1], { name: manifest.name, version: manifest.version, license: manifest.license,
    notices: notices.map(name => `--- ${manifest.name}/${name} ---\n${readFileSync(path.join(dependencyRoot, name), "utf8")}`).join("\n") });
}
const thirdParty = [...dependencies.values()];
const licenseFile = path.join(root, "dist", "tiangz-design-mcp.NOTICES.txt");
writeFileSync(licenseFile, thirdParty.map(item => item.notices).join("\n\n"));
const sha256 = file => createHash("sha256").update(readFileSync(file)).digest("hex");
writeFileSync(path.join(root, "dist", "tiangz-design-mcp.build-info.json"), JSON.stringify({
  formatVersion: 1, package: packageJson.name, version: packageJson.version,
  lockSha256: sha256(path.join(root, "package-lock.json")),
  bundleSha256: sha256(output), noticesSha256: sha256(licenseFile),
  dependencies: thirdParty.map(({ notices, ...identity }) => identity),
}, null, 2) + "\n");
