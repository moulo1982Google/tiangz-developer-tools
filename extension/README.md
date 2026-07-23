# TiangZ Developer Tools

在 VS Code 资源管理器中显示 TiangZ 的 Environment、Machine、Process、Scene、Actor、Component、协议与 Handler。

支持：

- Handler 与生成协议双向跳转。
- RPC、Message、MsgCode 与 Handler 中文 Hover。
- Handler 和协议 CodeLens。
- 重复 Handler、缺失 Handler、RPC 类型不匹配、工程依赖方向与配置错误诊断。
- Generated 过期、缺失、遗留与手工修改诊断。
- 与 `tiangz-check-project` CLI 共用工程规则，编辑器与 CI 诊断一致。
- “TiangZ：显示语言服务器状态”性能观测命令。
- 从工程树运行、调试、停止和重启 Process。
- StartMachine 进程组展开为独立 VS Code Task。
- 自动构建、等待 V8 Inspector 并附加 TypeScript 调试器。
- 无 `process.debug` 时生成临时配置，不修改正式 JSON。

详细说明与路线图位于项目仓库根目录。
