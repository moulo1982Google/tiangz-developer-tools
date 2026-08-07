# TiangZ Developer Tools

在 VS Code 资源管理器中显示 TiangZ 的 Environment、Machine、Process、Scene、Session、Unit、Component、协议与 Handler。

支持：

- Scene、Session、Unit Handler 与生成协议双向跳转，并兼容旧版 Actor Handler。
- RPC、Message、MsgCode 与 Handler 中文 Hover。
- Handler 和协议 CodeLens。
- 重复 Handler、缺失 Handler、RPC 类型不匹配、工程依赖方向与配置错误诊断。
- Generated 过期、缺失、遗留与手工修改诊断。
- Model声明的生命周期与迁移能力缺失System、方法或同步实现时发布错误诊断。
- Process配置JSON补全，以及StartMachine部署集合内`process.identity`唯一性诊断。
- Timer回调、取消语义、同步/Veto Scene Event契约和持久化运行时ID诊断。
- 普通`Unit`误加`@actor`、`ActorUnit`遗漏`@actor`的错误诊断。
- GlobalId、InstanceId、Timer、协程锁、Veto Event与`scene.Tasks.Spawn`中文Hover。
- `Unit`、`ActorUnit`与`UnitComponent`的创建、路由和mailbox边界Hover。
- 与 `tiangz-check-project` CLI 共用工程规则，编辑器与 CI 诊断一致。
- 从工程树、命令面板或文件右键菜单定向生成 Proto、Native、Scene 和客户端 Handler。
- “TiangZ：显示语言服务器状态”性能观测命令。
- 从工程树运行、调试、停止和重启 Process。
- StartMachine 进程组展开为独立 VS Code Task。
- 自动构建、等待 V8 Inspector 并附加 TypeScript 调试器。
- 无 `process.debug` 时生成临时配置，不修改正式 JSON。
- 从 StartMachine 启动/停止源码开发模式，保存 Hotfix 后由主工程自动构建候选并 Reload。
- 对高置信的运行时字段类型和对象形状不稳定写法发布黄色性能建议。
- 使用“TiangZ：设计业务系统”向导生成 Item、Buff、Quest、Achievement、Numeric 或自定义系统设计。
- 在聊天窗口使用 `@tiangz /design buff`；确定性规则负责结论，当前模型只负责中文解释。
- 使用“TiangZ：运行 Runtime Foundation 自测”调用主工程统一自测入口。

详细说明、CLI、MCP 接入方式与路线图位于项目仓库根目录。
