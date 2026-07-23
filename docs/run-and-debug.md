# 运行与调试

## 单 Process

在资源管理器的“TiangZ 工程”树中找到 Process，或者直接右键原生文件树中的 `configs/**/*.json`，可以选择：

- “运行 Process”执行普通 TypeScript 构建和 Cargo 构建，然后启动服务器。
- “调试 Process”执行带内联 sourcemap 的构建，启动服务器并自动附加 V8 Inspector。
- “停止 Process”终止该 Task 管理的进程树。
- “重启 Process”保留原来的普通或调试模式。

也可以从命令面板执行相同命令，再从 QuickPick 选择 Process。

服务器 stdout/stderr 位于名为 `TiangZ` 的专用 Terminal；构建输出位于“TiangZ 启动与构建”Output Channel。

## 调试配置

配置已有 `process.debug` 时直接使用：

```json
{
  "process": {
    "name": "map1",
    "debug": {
      "inspectorIp": "127.0.0.1",
      "inspectorPort": 9231,
      "breakOnStart": true
    }
  }
}
```

配置没有 `debug` 时，插件从 `tiangzDeveloperTools.debugPortBase` 开始选择空闲端口，在 VS Code 工作区存储目录生成临时 JSON。正式配置不会被修改，临时文件随 Process 退出清理。

调试命令会等待 `/json/list` 出现 V8 target，再调用 VS Code 内置 JavaScript Debugger。开发者直接在 `app/**/*.ts` 设置断点，不需要创建 `.vscode/launch.json`。

## Machine 进程组

右键 StartMachine 下的 Machine，或直接右键原生文件树中的 `StartMachine.json`，选择“启动 Machine 进程组”。插件读取该 Machine 的 `processes`，构建一次，然后为每个 Process 创建独立 Task。

这与把 `StartMachine.json` 交给 Watcher 的业务结果相同，但保留了每个 Process 的 PID、Terminal、停止和重启能力。“停止 Machine 进程组”只停止该 Machine 引用且由插件管理的 Process。

## 构建设置

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `buildTypeScriptOnLaunch` | `true` | 启动前是否构建 TS |
| `runBuildCommand` | `npm run build` | 普通模式 TS 构建 |
| `debugBuildCommand` | `npm run build:debug` | 调试模式 TS 构建 |
| `cargoCommand` | `cargo` | Cargo 可执行命令 |
| `cargoBuildArgs` | `build --bin TiangZ` | Cargo 构建参数 |
| `debugPortBase` | `9230` | 临时 Inspector 端口起点 |
| `inspectorConnectTimeoutMs` | `15000` | 自动附加超时 |

KCP 构建可以设置：

```json
{
  "tiangzDeveloperTools.cargoBuildArgs": [
    "build",
    "--bin",
    "TiangZ",
    "--features",
    "kcp"
  ]
}
```

## 生命周期

- 调试器断开只结束调试会话，不停止服务器。
- Process 退出会结束与它关联的调试会话。
- 停止 Task、关闭工作区或停用插件会清理插件管理的进程。
- 插件不接管从外部终端启动的 TiangZ Process。
- 所有构建和启动能力只在可信工作区启用。
