# 定向代码生成

## 入口

Developer Tools 从工程根目录的 `codegen.manifest.json` 读取生成器 ID 和命令。当前 TiangZ 工程提供：

| 生成器 | 作用 |
| --- | --- |
| `proto` | 生成服务端、通用客户端与 Cocos 协议 |
| `native-data` | 生成 Rust Entity/Ops 与 TypeScript Native Handle |
| `scenes` | 生成 Scene 和服务端 Handler 导入表 |
| `client-handlers` | 生成 Cocos 客户端 Handler 导入表 |

可以从以下位置执行：

- “TiangZ 工程”树中的“代码生成”节点，点击生成器右侧运行图标。
- 工程树标题栏的工具图标，从列表选择生成器。
- 命令面板中的四条“TiangZ：重新生成...”命令。
- `.proto` 文件右键菜单中的“重新生成 Proto 协议”。
- `.native` 文件右键菜单中的“重新生成 Native 数据”。
- `codegen.manifest.json` 右键菜单中的“运行代码生成器...”。

## 任务行为

每次生成都是独立的 VS Code Task：

- 工作目录固定为所选 TiangZ 工作区根目录。
- 命令直接取自 Manifest 的 `command` 字段。
- 终端显示生成器的完整标准输出和错误输出。
- 可以使用 VS Code 的“终止任务”停止生成。
- 同一工程中的同一生成器不能重复并发启动。
- 退出码非零时显示错误，并保留任务终端。
- 成功后自动刷新文件发现、Problems 和工程树。

多根工作区中，从文件或工程树执行会自动定位所属工程；从命令面板执行会先要求选择工程。

## 安全边界

Manifest 中的命令属于仓库代码的一部分，可能执行本机程序。因此插件只允许在可信工作区运行代码生成任务。打开来源不明的工程时，应先审查 `codegen.manifest.json` 和对应 npm scripts，再信任工作区。

插件不会根据诊断自动执行生成器。Generated 过期、缺失或被修改时，开发人员仍需明确选择生成操作，避免保存文件时触发不可预期的大范围覆盖。
