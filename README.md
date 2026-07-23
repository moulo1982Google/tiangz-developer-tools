# TiangZ Developer Tools

TiangZ 框架的工程模型、静态检查与 VS Code 开发工具。

这个插件不替代 TypeScript，也不负责 `.native` 语言支持。它关注 TiangZ 特有的 Process、Scene、Actor、Component、Handler 和启动配置之间的关系。

## v0.3.0 能力

- 扫描 `configs/<环境>/**/*.json`，建立 Environment、Machine、Process 和入口 Scene 模型。
- 使用 TypeScript Compiler API 识别 `@entryScene`、`@scene`、`@actor` 和 `@component`。
- 从服务端生成文件索引 RPC、Message、Request、Response、MsgCode 与 Descriptor。
- 识别类 Handler、`@rpc`、`@message`、`@handler` 方法和 `registerActorRpc` 显式注册。
- 在资源管理器中显示“TiangZ 工程”树，并可跳转到配置或声明。
- 在 Handler 与协议之间双向导航，并提供中文 Hover 和 CodeLens。
- 检查配置引用、重复或缺失 Handler，以及 RPC 消息类型不匹配。
- 将工程问题同时显示在工程树与 VS Code Problems 面板。
- 独立 Language Server 使用 150ms 防抖，不保留 TypeScript AST，并提供运行状态指标。
- 从工程树、原生资源管理器或命令面板运行、调试、停止和重启单个 Process。
- 将 StartMachine 的 Process 展开为独立 VS Code Task，可分别查看 PID、日志和状态。
- 自动执行 TypeScript/Cargo 构建，直接运行 Cargo 产出的 TiangZ executable。
- 自动等待 V8 Inspector 并附加 VS Code JavaScript Debugger，无需维护 `launch.json`。
- 原配置没有 `process.debug` 时，在 VS Code 工作区存储中生成并清理临时调试配置。

## 本地开发

```powershell
npm install
npm run check
npm run package:extension
```

生成的 VSIX 位于 `dist/tiangz-developer-tools-0.3.2.vsix`。

## 配置

默认配置适用于 TiangZ 主仓库：

```json
{
  "tiangzDeveloperTools.configRoot": "configs",
  "tiangzDeveloperTools.sourceRoots": ["app"],
  "tiangzDeveloperTools.initialFileLimit": 10000,
  "tiangzDeveloperTools.maxFileSizeBytes": 2097152,
  "tiangzDeveloperTools.buildTypeScriptOnLaunch": true,
  "tiangzDeveloperTools.runBuildCommand": "npm run build",
  "tiangzDeveloperTools.debugBuildCommand": "npm run build:debug",
  "tiangzDeveloperTools.cargoBuildArgs": ["build", "--bin", "TiangZ"]
}
```

## 运行与调试

在“TiangZ 工程”树中右键 Process，或在原生资源管理器中右键 `configs/**/*.json`：

- “运行 Process”：普通构建后启动独立 Task。
- “调试 Process”：构建 debug bundle、启动 Process、等待 Inspector 并自动附加。
- “附加到 Process”：重新附加已经在调试模式运行的 Process。
- “停止/重启 Process”：管理对应的进程树和调试会话。

右键 Machine 可一次启动或停止该 Machine 引用的全部 Process。插件只在可信工作区执行构建和进程命令。

详细说明见 [运行与调试](docs/run-and-debug.md)。

## 工程边界

`packages/project-core` 不依赖 VS Code，只接收相对路径和文件文本。VS Code 扩展负责文件发现和工程树；独立 Language Server 负责 Problems、协议导航、Hover 与 CodeLens。

当前版本刻意不包含启动、Debug 和运行时 Inspector。这些能力将在静态工程模型稳定后逐步加入，避免插件一开始就同时承担索引器、进程管理器和调试器。

详细设计见 [架构设计](docs/architecture.md)，后续顺序见 [路线图](docs/roadmap.md)。
