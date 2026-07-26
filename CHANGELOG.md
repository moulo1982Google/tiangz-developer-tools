# 更新记录

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
