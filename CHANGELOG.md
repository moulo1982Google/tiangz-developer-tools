# Changelog

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
