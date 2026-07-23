# 路线图

## Phase 0：工程核心与可见性

- [x] 建立独立仓库结构
- [x] 实现不依赖 VS Code 的 project-core
- [x] 解析 Environment、Machine、Process 和入口 Scene 配置
- [x] 使用 TypeScript Compiler API 索引 Scene、Actor、Component 与 Handler
- [x] 增加 TiangZ 工程树、源码跳转和 Problems
- [x] 使用真实 TiangZ 工程完成零诊断验收

## Phase 1：消息与 Handler 导航

- [x] 从协议生成文件建立 Request、Response、MsgCode 和 Descriptor 索引
- [x] 从消息跳转到 Handler，从 Handler 跳转到协议
- [x] 增加重复 Handler、缺失 Handler 和 RPC 类型不匹配诊断
- [x] 增加 Handler CodeLens 与 Hover
- [x] 将编辑器能力移入独立 Language Server

## Phase 2：配置启动与调试

- [x] 选择环境和 Process 配置
- [x] 通过 VS Code Task 启动单个 Process 或 StartMachine
- [x] 附加 Deno/V8 Inspector
- [x] 显示 PID、端口、Inspector 地址和退出状态
- [x] 保证进程生命周期由 VS Code Task 管理

## Phase 3：工程规则

- [x] 检查 Core、Generated、Model、Hotfix 和 Demo 依赖方向
- [x] 检测 Generated 文件过期、缺失、遗留或被手工修改
- [x] 提供可在 CI 运行的 `check:project` CLI
- [x] 为 proto、scene、client handler 和 native 提供定向重新生成操作

## Phase 4：运行时 Inspector

- [ ] 按 UnitId 查询 Process、Scene、Gate 和 ActorLocation
- [ ] 查看 mailbox 长度、pending RPC 和定时器
- [ ] 查看 Native handle 对应的 Rust Entity 数据
- [ ] 增加权限、限流和调试协议版本检查

## Phase 5：统一安装

- [ ] 建立 TiangZ Extension Pack
- [ ] 同时安装 Developer Tools 与 Native Language
- [ ] 本地验收稳定后再决定是否发布 Marketplace
