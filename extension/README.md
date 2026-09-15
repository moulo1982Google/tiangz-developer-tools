# TiangZ Developer Tools

## 独立模块导航

新工程若包含 `tiangz.project.json`，导航自动调用其中宿主，不需要重复配置 engineRoot。“创建模块入门工程”向导复用宿主生成器；“模块工程操作”提供 doctor/setup/check/build/host-build 任务，完整规则由宿主维护。生成前展示目标位置和初始协议锁/SDK 写入范围；任务开始不等于验收通过，结果见终端及 Problems 面板。

“启动模块开发模式”复用既有开发任务管理器，直接调用声明宿主的 `dev_runtime.mjs --project`，不复制 watcher。需提前编译匹配版本的宿主；停止命令或 Ctrl+C 先请求优雅停机，25 秒后才终止本任务进程树。异常退出保留失败状态；不自动附加调试器。教学 smoke 仍使用工程自己的终端命令。

“新建模块 Component”复用宿主四文件预览与 planHash 检查，再创建 Model/Hotfix 配套文件和入口登记；不复制模板、不自动装配到 Scene/Entity。先停止开发模式，创建后检查、构建并重启。预览过期、已有文件或动态入口会由宿主拒绝。

在可信工作区执行“TiangZ：读取模块结构”，即可从“TiangZ 模块”树查看入口、直接依赖、公开 API、状态类型与行为绑定，并跳转源码。独立工程请设置 `tiangzDeveloperTools.engineRoot` 指向 TiangZ 宿主，`tiangzDeveloperTools.modulesDirectory` 默认为 `modules`（均相对当前工作区）。宿主须提供 `tools/inspect_game_modules.mjs`。

模块导航只呈现宿主通用工具的静态结果；不会运行游戏、Cargo、代码生成或自动修复。首次和源码变化后请显式刷新。未静态加载提示不等于运行错误，动态注册需另行验证。发现根目录 `tiangz.project.json` 后，原工程树改为模块导航与宿主检查入口，旧 app/ 索引不再误报入口 Scene 缺失；模块实时语义诊断尚未接入旧 LSP，请运行宿主 check 并查看 Problems。

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
