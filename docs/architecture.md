# 架构设计

## 工程模型

```text
configs/**/*.json -----> project-core -----> TiangZProjectSnapshot
app/**/*.ts -----------/                         |
                                                 |-> 工程树
                                                 |-> Language Server
                                                 |    |-> Problems
                                                 |    |-> 定义/引用
                                                 |    |-> Hover/CodeLens
                                                 |    `-> Snapshot -> 工程树
                                                 |-> CLI/CI（后续）
```

`project-core` 使用 TypeScript Compiler API 读取装饰器和类声明，不使用正则解释 TypeScript。它不读取文件系统、不依赖 VS Code，也不启动 TiangZ 进程。

## 当前索引

- 配置：Environment、StartMachine、Process、`scenes`、`knownScenes`。
- 类型：EntryScene、动态 Scene、Actor、Component。
- 协议：服务端生成的 RPC、Message、Request、Response、MsgCode 与 Descriptor。
- Handler：`rpcHandler`、`messageHandler`、`actorRpcHandler`、`actorMessageHandler`、`rpc`、`message`、`handler` 和 `registerActorRpc`。
- 诊断：配置错误、重复入口 Scene、重复或缺失 Handler、RPC 类型不匹配、工程依赖方向、JSON/TypeScript 语法错误。

工程依赖规则由 project-core 基于 TypeScript AST 检查，`Generated/Model` 与负责装配业务的 `Generated/Hotfix` 使用不同边界。完整矩阵见[工程依赖规则](dependency-rules.md)。

## 性能边界

- 文件读取使用 VS Code 异步文件系统 API。
- 连续文件事件使用 150ms 防抖，只保留最后一次刷新。
- 默认最多索引 10000 个文件，单文件不超过 2 MiB。
- 每次分析创建不可变快照，不在全局集合中永久保留旧 AST。
- project-core 只在分析期间持有 TypeScript AST，返回模型不保存 AST 或完整源码。
- project-core 只在独立 Language Server 中运行；VS Code Extension Host 仅接收序列化快照，不加载 TypeScript 编译器。
- “TiangZ：显示语言服务器状态”可查看缓存文件、协议、Handler、校验耗时和堆内存。

工作区增长到需要增量索引时，缓存应放在独立索引层，并以 URI 和文档版本为键；不能把缓存塞进语义模型。

## 插件关系

TiangZ Developer Tools 与 TiangZ Native Language 是两个独立扩展。前者理解整个工程，后者只理解 `.native`。未来可以通过 TiangZ Extension Pack 一键安装，但两个扩展不互相控制生命周期。

## 启动与调试

```text
ProcessConfig -----> Build Coordinator -----> Cargo executable
      |                                        |
      |                                        `-> VS Code CustomExecution Task
      `-> debug / 临时 debug 配置                         |
                                                       |-> Terminal
                                                       |-> PID/退出状态
                                                       `-> V8 Inspector -> VS Code Debugger
```

- 构建发生在启动 Task 之前；Machine 内多个 Process 共享一次构建结果。
- Task 直接启动 Cargo `compiler-artifact.executable`，状态中的 PID 是 TiangZ，而不是 Cargo。
- Machine 配置会展开为多个独立 Task，以便分别查看日志、停止和重启。
- 调试优先使用配置中的 `process.debug`；缺失时在 VS Code 工作区存储目录生成临时配置。
- 调试器断开不会自动停止 Process；Process 退出会终止对应调试会话。
- 工作区关闭、插件卸载或 Task 停止时会终止仍由插件管理的进程树。
