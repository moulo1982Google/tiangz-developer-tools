# v0.16.1（套件 TiangZ 0.7.0）

TiangZ 六仓库套件 0.7.0 正式版中的 Developer Tools（GitHub Release，不上架 npm/VS Code Marketplace）。本仓库已有的 `v0.7.0` 是 2026-07 的旧包版本，不移动；本次使用自己的版本号标签 `v0.16.1`。候选标签 `v0.7.0-rc1`、`v0.7.0-rc2` 与附件保持不变。

- `@tiangz/developer-tools-core` **0.16.1**、VSIX **0.16.3**（正式包，非 pre-release）。
- 相对 v0.7.0-rc2（Core 0.16.1-rc.3）没有代码改动；其中包括共享 Hotfix 检查识别 TiangZ 0.7 的 `@httpHandler`。

TiangZ v0.7.0 的 `@tiangz/developer-tools-core` 依赖指向本仓库 `v0.16.1` 标签；AI 插件随包 MCP 用 Core 0.16.1 重新分发。

验证：本仓库 PR 的 CI（Windows/Linux 检查与打包）在合入前全部通过。以后的缺陷按小版本修补。
