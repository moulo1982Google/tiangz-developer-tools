# Changelog

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
