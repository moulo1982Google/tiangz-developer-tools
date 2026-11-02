# v0.16.6（套件 TiangZ 0.7.8）

TiangZ 套件中的 Developer Tools（GitHub Release，不上架 npm）。之前的标签与附件保持不变。

- Core **0.16.6**、VSIX **0.16.6**（正式包）。版本号统一到标签：上一个标签 `v0.16.5` 只升了 VSIX，Core 仍是 0.16.3，本版不再沿用两套编号。
- 依赖安全补丁：`@modelcontextprotocol/server` 2.0.0 → 2.4.0（GHSA-jm63-cq47-j5jp、GHSA-46jr-4wx8-v453、GHSA-rvq5-wwqv-78pq）、`zod` 4.4.3 → 4.6.7（GHSA-mrhx-c7xc-m3w5），`package.json` 下限同步改为 `^2.4.0` / `^4.6.7`，下游工程按自己的锁文件安装时也不会再解析到旧版本；打包工具 `@vscode/vsce` 带入的 `@azure/identity` 升到 4.14.1（含修复后的 `@azure/msal-node`）。
- 审计结果：全部依赖 0 high、3 moderate，生产依赖 0 high、2 moderate。剩下的都是 `minimatch` 的拒绝服务公告：来自扩展的 `vscode-languageclient` 与打包用的 `@vscode/vsce`，上游还没有可用的修复版本（npm 给出的唯一“修复”是把 `vscode-languageclient` 降到 6.x 的破坏性降级），本版照实记录、不加例外。
- 功能不变：设计规则仍是 Core 0.16.3 的 29 条，MCP/CLI 工具名称与请求/响应结构不变。VSIX 的 118 个文件与 0.16.5 一一对应、大小相同，只有包内版本号变化；商店上的扩展不需要因本版更新。

验证：本机 `npm run check` 通过（Core、设计规则、设计 CLI、设计 MCP、CLI、语言服务器与打包清单）；本仓库 PR 的 CI（Windows/Linux 检查与打包）在合入前通过。
