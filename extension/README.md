# TiangZ Developer Tools

0.7 配套候选继续使用 Developer Tools 自身的 0.15.2 版本序列。实际包内 `dist/build-info.json` 记录扩展/Core 版本与运行 bundle 哈希；工作树名称不代表插件版本，也不代表已经安装。Process Schema 新增完整 network 字段及 0.7 的 writeTimeoutMs、maxAcceptedConnections、maxPendingHandshakes 提示，包含 Rust 同步的整数范围与默认值；这些字段不适用于 0.6.x 宿主，不会自动写入旧工程配置。入站连接与握手额度由当前 Process 全部业务 listener 共享，不代表帧字节或 KCP 未确认缓存上限。

打开 TiangZ 主工程的上层目录也可以使用工程树和“TiangZ：创建模块入门工程”：插件识别当前目录及直属子目录，不扫描更深层或缓存目录；多个宿主会要求选择。创建确认框显示宿主和目标目录，目标相对当前打开的目录解析。已有 engineRoot 配置或 tiangz.project.json 声明优先，不会在配置错误时暗中切换宿主。独立模块的实时语义检查仍由宿主工具负责。

## 独立模块导航

新工程若包含 `tiangz.project.json`，导航自动调用其中宿主，不需要重复配置 engineRoot。“创建模块入门工程”向导复用宿主生成器；“模块工程操作”提供 doctor/setup/check/build/host-build 任务，完整规则由宿主维护。生成前展示目标位置和初始协议锁/SDK 写入范围；任务开始不等于验收通过，结果见终端及 Problems 面板。

“启动模块开发模式”复用既有开发任务管理器，直接调用声明宿主的 `dev_runtime.mjs --project`，不复制 watcher。需提前编译匹配版本的宿主；停止命令或 Ctrl+C 先请求优雅停机，25 秒后才终止本任务进程树。异常退出保留失败状态；不自动附加调试器。教学 smoke 仍使用工程自己的终端命令。

“新建模块 Component”复用宿主四文件预览与 planHash 检查，再创建 Model/Hotfix 配套文件和入口登记；不复制模板、不自动装配到 Scene/Entity。先停止开发模式，创建后检查、构建并重启。预览过期、已有文件或动态入口会由宿主拒绝。

在可信工作区执行“TiangZ：读取模块结构”，即可从“TiangZ 模块”树查看入口、直接依赖、公开 API、状态类型与行为绑定，并跳转源码。独立工程请设置 `tiangzDeveloperTools.engineRoot` 指向 TiangZ 宿主，`tiangzDeveloperTools.modulesDirectory` 默认为 `modules`（均相对当前工作区）。宿主须提供 `tools/inspect_game_modules.mjs`。

模块导航只呈现宿主通用工具的静态结果；不会运行游戏、Cargo、代码生成或自动修复。首次和源码变化后请显式刷新。未静态加载提示不等于运行错误，动态注册需另行验证。发现根目录 `tiangz.project.json` 后，原工程树改为模块导航与宿主检查入口，旧 app/ 索引不再误报入口 Scene 缺失。已打开的标准 `src/model`/`src/hotfix` 文件新增时间等待实时错误，其余模块语义与自定义源码根仍运行宿主 check 并查看 Problems。

### 禁止 await 时间

0.7 配套候选修正别名遮蔽：导入的 pause 与函数参数 pause、不同函数的局部别名分别解析；块、catch、循环作用域也独立。编辑器与 CLI 共用词法规则，合法数据库/RPC 回调不因同名被拦截；外层真实时间调用仍报错。它不是跨文件或可变别名的数据流分析，动态封装仍需审查。

`tiangz.timer.time-wait-forbidden` 是错误级诊断：禁止业务用 `sleep/delay/TimerSystem.WaitAsync`、原生计时器或计时 Promise 实现延迟；`.then`、导入改名和常见局部别名也检查。请使用所有者 `NewOnceTimer/NewRepeatedTimer` 与方法名回调。数据库、RPC、锁等结果等待不受此禁令禁止。宿主模块构建复用同一规则，未打开文件也不能借构建发布；须同步更新宿主所依赖的 Developer Tools core。任意动态/跨文件封装仍需代码审查。

在 VS Code 资源管理器中显示 TiangZ 的 Environment、Machine、Process、Scene、Session、Unit、Component、协议与 Handler。

支持：

- Scene、Session、Unit Handler 与生成协议双向跳转，并兼容旧版 Actor Handler。
- RPC、Message、MsgCode 与 Handler 中文 Hover。
- Handler 和协议 CodeLens。
- 重复 Handler、缺失 Handler、RPC 类型不匹配、工程依赖方向与配置错误诊断。
- Generated 过期、缺失、遗留与手工修改诊断。
- Model声明的生命周期与迁移能力缺失System、方法或同步实现时发布错误诊断。
- 主工程生命周期/方法名 Timer 由共享 Program 规则检查实际 Core 类型、接收者和回调参数；CLI 与宿主模块检查复用规则。动态无法证明的写法给 warning。类型服务复用缓存，工程关闭时释放，匹配的 TypeScript 标准库随 VSIX 分发。模块完整实时 Program 检查仍由现有宿主检查任务承接，不能把未保存模块修改当作已经验证。
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

## Rust 扩展模板

“新建模块入门工程”可选择 **TypeScript + Rust 扩展**。插件将 `--with-rust` 传给 TiangZ 宿主脚手架；需要支持该选项的宿主及 Cargo/rustfmt。生成独立 Rust crate、Native 接口、TS 调用示例和 RUST.md，不启动服务、不自动编译 Rust。

在生成工程执行 `npm run setup`、`npm run host-build`、`npm run build`、`npm run smoke`。Rust 修改需要重新编译重启；当前自动 dev 入口不支持 Native 工程。默认 TypeScript 模板不变。

## 延迟业务辅助入口

在 `tiangz.timer.time-wait-forbidden` 错误处按 `Ctrl+.`，可“查看延迟业务范式”或“生成定时器方法骨架”；命令面板也可调用。指南随 VSIX 离线分发，骨架只打开未保存 TypeScript 草稿，不改原文件、不自动搬动业务、不清除诊断。先适配所有者、Model 字段与现有 Hotfix System，再实现 TODO 结算/恢复。维护资源位于 `extension/guides/`，须与宿主 `docs/patterns/timer-update-and-action.md` 同步。
