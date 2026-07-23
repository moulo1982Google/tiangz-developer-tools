# 架构设计

## 工程模型

```text
configs/**/*.json -----> project-core -----> TiangZProjectSnapshot
app/**/*.ts -----------/                         |
                                                 |-> 工程树
                                                 |-> Problems
                                                 |-> CLI/CI（后续）
                                                 |-> Language Server（后续）
```

`project-core` 使用 TypeScript Compiler API 读取装饰器和类声明，不使用正则解释 TypeScript。它不读取文件系统、不依赖 VS Code，也不启动 TiangZ 进程。

## 当前索引

- 配置：Environment、StartMachine、Process、`scenes`、`knownScenes`。
- 类型：EntryScene、动态 Scene、Actor、Component。
- Handler：`rpcHandler`、`messageHandler`、`actorRpcHandler`、`actorMessageHandler`、`rpc`、`handler`。
- 诊断：未知入口 Scene、StartMachine 缺失进程配置、重复入口 Scene 类型、JSON/TypeScript 语法错误。

## 性能边界

- 文件读取使用 VS Code 异步文件系统 API。
- 连续文件事件使用 150ms 防抖，只保留最后一次刷新。
- 每次分析创建不可变快照，不在全局集合中永久保留旧 AST。
- project-core 只在分析期间持有 TypeScript AST，返回模型不保存 AST 或完整源码。

工作区增长到需要增量索引时，缓存应放在独立索引层，并以 URI 和文档版本为键；不能把缓存塞进语义模型。

## 插件关系

TiangZ Developer Tools 与 TiangZ Native Language 是两个独立扩展。前者理解整个工程，后者只理解 `.native`。未来可以通过 TiangZ Extension Pack 一键安装，但两个扩展不互相控制生命周期。
