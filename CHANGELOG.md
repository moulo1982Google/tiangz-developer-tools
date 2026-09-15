# 更新记录

## 未发布

- 新增“TiangZ 模块”导航树：复用宿主只读 `modules:inspect --json`，呈现入口、公开 API、依赖、状态类型、行为绑定和疑似漏加载提示。支持独立工程配置 engineRoot/modulesDirectory；可信工作区、显式刷新、超时/取消与源位置校验，不启动游戏或复制热更规则。

- 增加 `tiangz-new-component` 组件脚手架：一次生成可复用 Model、领域门面和 Hotfix System，并自动追加 `app/model/public.ts` 导出。
- 组件脚手架默认拒绝覆盖已有文件，校验工程根目录和保留领域名，并支持 `--dry-run` 预览。
- VS Code 增加“TiangZ：新建 Component”命令，与 CLI 复用同一套模板、工程校验和冲突保护。
- VS Code 增加“TiangZ：运行快速工程检查”命令，复用主工程 `verify:fast` 并通过独立 Task 展示结果。
- VS Code 增加“TiangZ：查看运行时指标”命令，复用主工程只读 `/metrics`，展示 Process、Scene mailbox、pending RPC、Timer 和 Native Entity 摘要。
- Process 工程模型索引 `process.observability.health`，并将 `0.0.0.0`/`::` 监听地址安全转换为本机回环访问。
- 新增 Runtime Inspector 协议草案，冻结只读、版本化、认证、超时、限流和响应大小边界；当前仍不宣称实体查询已经接入 Runtime。
- 新增 `tiangz.hotfix.instance-state` 编辑器诊断：禁止 `@systemFor`、`@hotfixFor`、网络 Handler 和 Scene Event Handler 声明字段、构造函数或静态执行状态。
- 诊断支持 TiangZ Model 装饰器的直接导入、别名导入和命名空间导入，并复用 Language Server 的 Problems 发布链路。
- Process JSON补全增加Rust正式配置`process.observability.nativeData`及阈值约束，并明确拒绝旧根级`process.nativeData`。
- Process JSON补全增加`persistence.dbProxy.failoverEndpoints`，提示有序备用内网地址及“仅网络不可用时切换”的运行语义。

## 0.15.1

- 跟随TiangZ Unit/Actor能力拆分，增加普通`Unit`误声明`@actor`和`ActorUnit`遗漏`@actor`的错误诊断，并补充相关中文Hover。
- 跟随TiangZ Core移除异步Scene Event，新增`vetoEventHandler`索引、同步返回值与稳定`id`检查。
- 增加`Events.Check`、`defineVetoEvent`和`scene.Tasks.Spawn`中文Hover，对遗留`PublishAsync`和Update内Spawn给出迁移诊断。
- Process/Scene配置补全和工程索引支持`bindIp`、`innerIp`、`outerIp`与`outerPort`，并兼容旧`ip`；明确监听地址、服务间路由地址和客户端地址不能混用。
- 支持`knownSceneFiles`共享稳定Scene目录，工程索引与Runtime采用一致的相对路径、去重和冲突检查语义，并为`*.known-scenes.json`提供独立Schema。
- Process JSON补全增加`staticMapIds`、`acceptDynamicMaps`、`protocol`与`audience`，明确同一种MapHost的静态、动态和混合承载角色。
- Process JSON补全增加`process.persistence.dbProxy`，约束端点、连接池、超时和帧大小，并要求认证令牌通过环境变量提供。

## 0.15.0

- 增加`process.identity` JSON补全与静态检查：按每份StartMachine真实引用的部署集合检查缺失、范围错误和重复ID槽位。
- 增加Timer高置信诊断：检查方法名回调、取消回调签名、旧`RemoveTimer`用法，并识别`TimerId`误入持久化结构。
- 增加Scene Event索引与契约检查：识别同步/异步Handler，检查`Handle`返回语义，并禁止遗漏`await PublishAsync`。
- 为`GlobalId`、`InstanceId`、Timer、协程锁和Scene Event提供中文Hover。
- 增加“TiangZ：运行 Runtime Foundation 自测”命令，直接调用主工程统一自测入口。

## 0.14.0

- 增加Model生命周期契约诊断：`@lifecycle`声明缺少对应`@systemFor`、缺少`Awake/OnDestroy/Deserialize`或错误使用`async`时直接报错。
- 增加`@transferable()`契约诊断，要求Model自身或对应System提供同步`CaptureTransfer/RestoreTransfer`。
- 修复索引通知顶层数组被JSON-RPC解释为位置参数，以及Language Server丢弃Manifest中Excel、XML、配置和DLL输入的问题；Manifest已索引文件不再受源码扩展名白名单限制。

## 0.13.0

- 增加不依赖 VS Code 的领域设计规则库，冻结 Item、Buff、Quest、Achievement、Numeric 与自定义系统的核心语义。
- 增加“TiangZ：设计业务系统”向导和 `@tiangz` 聊天参与者；AI 只在用户主动请求时解释确定性报告。
- 增加 `tiangz-design` CLI，支持 Markdown、JSON 和输入文件。
- 增加只读 `tiangz-design-mcp`，向其他 AI 暴露规则查询、类型推断和系统设计工具。
- 增加 Buff、Quest、Item 与自定义 ChildEntity/Actor 决策回归测试。

## 0.12.0

- Model长期状态类中的`any`、可选字段、基本类型与`undefined`联合、跨基本类型联合、`delete`字段和`as any`写入升级为错误诊断。
- 保留对象`T | null`、判别联合、显式Map/Record和普通DTO，检查继续使用单文件语法树，避免额外TypeScript Program占用。

## 0.11.1

- 增加 Component 公共可变 `Map/Set` 黄色诊断，避免业务绕过集合所有者。
- 增加生产 Handler 直接导入 `Native*Ref` 黄色诊断，引导通过 Component 领域方法修改子对象。
- 两项检查只使用单文件语法树，排除 Bench 并允许所属 System 直接使用 Native 句柄。

## 0.10.0

- 增加“启动/停止源码开发模式”，复用主工程`npm run dev`与Watcher Reload，不在插件中复制构建状态机。
- 增加`tiangz.performance.unstable-shape`黄色诊断，检查运行时状态类中的显式`any`、跨基本存储种类联合字段、`delete`字段和`as any`属性写入。
- 性能诊断只使用语法树并排除Bench、普通DTO、空值联合、判别联合和显式字典，避免创建第二套工程级TypeScript Program。

## 0.8.1

- 将 `app/bench` 识别为非生产基准测试层，允许它复用真实业务 API，同时继续禁止业务代码反向依赖 Bench。
- 将 `app/main.<用途>.ts` 识别为应用组合入口，支持独立的正式、Bench 和调试装配入口。

## 0.8.0

- 识别 `sessionRpcHandler`、`sessionMessageHandler`、`unitRpcHandler` 和 `unitMessageHandler`。
- 按 Scene、Session、Unit Handler 的真实泛型位置校验 Request、Response 与 Message 类型。
- 修复 TiangZ 切换到 Scene、Session、Unit 消息模型后协议被误报为“没有找到 Handler”的问题。
- 保留旧版 Actor Handler 与 `registerActorRpc` 的兼容识别。

## 0.7.0

- 在工程树增加“代码生成”，显示 Manifest 中声明的生成器及其真实命令。
- 增加 Proto、Native、Scene/服务端 Handler 和客户端 Handler 定向生成命令。
- 使用独立 VS Code Task 运行生成器，提供终端输出、退出码、取消和重复执行保护。
- 生成成功后自动刷新工程索引，错误时保留任务终端用于排查。

## 0.6.0

- 增加可在本地和 CI 运行的 `tiangz-check-project` 命令。
- 支持中文文本与 JSON 输出、警告升级为错误以及稳定退出码。
- 将 Manifest 文件发现规则下沉到 project-core，Language Server 与 CLI 共用同一实现。
- 使用真实 TiangZ 工程完成零诊断验收。

## 0.5.0

- 读取 `codegen.manifest.json`，检查内容输入、Scene/Handler 文件集合与生成输出。
- 增加 Generated 过期、手改、缺失、遗留和无效 Manifest 诊断。
- 按 Manifest 动态发现 Proto、Native、Cocos 与 Rust 生成文件，不把客户端 TS 混入服务端语义索引。

## 0.4.0

- 使用 TypeScript AST 检查 Core、Generated/Model、Model、Hotfix、Game 和业务目录的依赖方向。
- 区分纯生成模型与负责 Scene/Handler 装配的 Generated/Hotfix 入口。
- 违规依赖以 Error 级别发布到 VS Code Problems，并指向具体模块路径。

## 0.3.3

- 修复错误的全局 sourcemap 路径覆盖导致 TypeScript 断点无法绑定的问题。
- 调试会话明确使用工程目录与 `dist/**/*.js` 输出范围。

## 0.3.2

- 移除 Windows 下无法稳定命中的资源管理器 `resourcePath` 正则条件，由命令执行阶段校验配置归属。

## 0.3.1

- 在 VS Code 原生资源管理器的 TiangZ 配置文件右键菜单中提供 Process 和 Machine 启停、调试命令。
- 右键命令直接定位所选配置文件，不再退回到全局 Process 选择列表。

## 0.3.0

- 增加单 Process 运行、调试、附加、停止和重启命令。
- 使用 VS Code CustomExecution Task 管理真实 TiangZ PID、Terminal 与进程树生命周期。
- 自动执行普通/debug TypeScript 构建和 Cargo 构建。
- 自动等待 V8 Inspector 并附加 VS Code JavaScript Debugger。
- 原配置没有 `process.debug` 时生成临时调试配置并自动选择空闲端口。
- 将 Machine 进程组展开为独立 Task，支持整组启动和停止。
- 工程树显示 Process 状态、PID、配置、Inspector 与 Scene 端口。

## 0.2.0

- 建立 RPC、Message、Request、Response、MsgCode 与 Descriptor 语义索引。
- 支持装饰器 Handler、方法 Handler 与 `registerActorRpc` 显式注册。
- 增加协议与 Handler 双向导航、中文 Hover 和 CodeLens。
- 增加重复 Handler、缺失 Handler 和 RPC 类型不匹配诊断。
- 将 Problems 与编辑器能力迁移到独立 Language Server。
- 增加文件数量、文件大小边界与语言服务器性能状态。

## 0.1.0

- 建立独立 project-core 和 VS Code 扩展。
- 增加 Environment、Machine、Process、Scene、Actor、Component 与 Handler 索引。
- 增加 TiangZ 工程树、源码跳转、手动刷新和工程摘要。
- 增加入口 Scene 与 StartMachine 配置诊断。
- 使用真实 TiangZ 工程完成首轮兼容性验证。
