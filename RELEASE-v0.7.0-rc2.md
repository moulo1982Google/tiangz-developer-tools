# v0.7.0-rc2

六仓库统一套件标签 v0.7.0-rc2 的预发行版本（GitHub prerelease，不上架 npm/VS Code Marketplace）。rc1 标签 `v0.7.0-rc1`（06ba894）与其附件保持不变。

## 本仓库改动

- 共享 Hotfix 检查识别 TiangZ 0.7 的 `@httpHandler`（Scene HTTP 入口）：与 RPC Handler 一样禁止字段、构造函数与 static 成员；支持别名与 namespace，不误判同名业务装饰器或旧宿主声明（提交 198afe8，rc1 后发布在 `release/v0.7.0-rc1` 分支，本次合入主线）。
- 版本：`@tiangz/developer-tools-core` 0.16.1-rc.2 → **0.16.1-rc.3**；VSIX 内含 Core，0.16.2 → **0.16.3**。

TiangZ v0.7.0-rc2 的 `@tiangz/developer-tools-core` 依赖改为本仓库 `v0.7.0-rc2` 标签；AI 插件随包 MCP 用 Core 0.16.1-rc.3 重新分发。

验证：本仓库 PR 的 CI（Windows/Linux 检查与打包）在合入前全部通过；发布附件为该源码打包的 0.16.3 预发行 VSIX 与 Core 包。
