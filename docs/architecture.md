# 架构设计

## 工程模型

```text
configs/**/*.json ---------\
app/**/*.ts ---------------> project-core -----> TiangZProjectSnapshot
codegen.manifest.json -----/                         |
                                                 |-> 工程树
                                                 |-> Language Server
                                                 |    |-> Problems
                                                 |    |-> 定义/引用
                                                 |    |-> Hover/CodeLens
                                                 |    `-> Snapshot -> 工程树
                                                 |-> CLI/CI
                                                 `-> Codegen Task
```

`project-core` 使用 TypeScript Compiler API 读取装饰器和类声明，不使用正则解释 TypeScript。它不读取文件系统、不依赖 VS Code，也不启动 TiangZ 进程。

领域设计能力使用另一条纯函数链路：

```text
TiangZ领域规则 -----> design-core -----> VS Code向导
                         |              |-> @tiangz聊天解释
                         |              |-> tiangz-design CLI
                         `--------------`-> tiangz-design-mcp
```

`design-core`不读取工程、不调用模型、不修改代码。它根据明确输入返回稳定规则编号、所有权、Entity形态、同步语义、生命周期和风险提示。VS Code聊天只能在用户主动请求后调用当前选择的模型，并将确定性报告作为不可改写的约束；CLI与MCP不需要模型也能得到相同结论。

## 当前索引

- 配置：Environment、StartMachine、Process、`scenes`、`knownScenes`。
- 类型：EntryScene、动态 Scene、Session、Unit、Component；兼容旧版 Actor 声明。
- 协议：服务端生成的 RPC、Message、Request、Response、MsgCode 与 Descriptor。
- Handler：Scene 使用 `rpcHandler`、`messageHandler`；Session 使用 `sessionRpcHandler`、`sessionMessageHandler`；Unit 使用 `unitRpcHandler`、`unitMessageHandler`；同时识别 `rpc`、`message`、`handler` 和旧版 Actor API。
- 诊断：配置错误、重复入口 Scene、重复或缺失 Handler、RPC 类型不匹配、工程依赖方向、Component 子对象所有权、JSON/TypeScript 语法错误。

工程依赖规则由 project-core 基于 TypeScript AST 检查，`Generated/Model` 与负责装配业务的 `Generated/Hotfix` 使用不同边界。完整矩阵见[工程依赖规则](dependency-rules.md)。

Generated 完整性由根目录 `codegen.manifest.json` 描述。Language Server 比对内容输入、文件集合与输出哈希，不启动生成器。详见[Generated 完整性检查](generated-integrity.md)。

代码生成命令同样来自 Manifest。扩展只负责把所选命令放入独立 VS Code Task，不在插件内维护另一份 npm script 映射。详见[定向代码生成](codegen-actions.md)。

## 性能边界

- 文件读取使用 VS Code 异步文件系统 API。
- 连续文件事件使用 150ms 防抖，只保留最后一次刷新。
- 默认最多索引 10000 个文件，单文件不超过 2 MiB。
- 每次分析创建不可变快照，不在全局集合中永久保留旧 AST。
- project-core 只在分析期间持有 TypeScript AST，返回模型不保存 AST 或完整源码。
- project-core 只在独立 Language Server 中运行；VS Code Extension Host 仅接收序列化快照，不加载 TypeScript 编译器。
- “TiangZ：显示语言服务器状态”可查看缓存文件、协议、Handler、校验耗时和堆内存。

Component 所有权检查只分析单文件语法：公共可变 `Map/Set` 和生产 Handler 导入 `Native*Ref` 产生黄色建议；它不创建 TypeChecker，不追踪跨文件数据流，也不限制所属 System 或 Bench 使用 Native 句柄。

`design-core`只维护少量不可变规则对象，每次请求创建一份短生命周期结果；不扫描工作区、不持有AST，也不在后台调用模型。MCP服务使用stdio，标准输出只承载协议帧。

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
