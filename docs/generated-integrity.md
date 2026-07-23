# Generated 完整性检查

## 设计目标

TiangZ 的生成器在根目录维护 `codegen.manifest.json`。Developer Tools 只读取 Manifest 与其引用的文件，不会为了检查而执行 codegen，也不会修改工作区。

Manifest 使用 `sha256-normalized-text-v1`：计算哈希前将 CRLF 统一为 LF，因此同一份生成代码在 Windows 与 Linux 之间不会产生换行误报。

## 生成器所有权

| 生成器 | 命令 | 主要输出 |
| --- | --- | --- |
| `proto` | `npm run codegen:proto` | 服务端协议、客户端协议、Cocos 协议 |
| `native-data` | `npm run codegen:native-data` | Native TS Handle 与 Rust Entity/Ops |
| `scenes` | `npm run codegen:scenes` | 服务端 Scene/Handler 导入表 |
| `client-handlers` | `npm run codegen:client-handlers` | Cocos Handler 导入表 |

Proto 生成器只清理自己拥有的协议 `.ts` 文件，不删除 Native Handle 或 Cocos `.meta`。`src/generated/mod.rs` 是手工维护的模块入口，在 Native 输出根中被显式忽略。

## 诊断

| 代码 | 含义 | 处理方式 |
| --- | --- | --- |
| `tiangz.generated.stale` | 内容输入或参与生成的文件集合变化 | 执行诊断中给出的 codegen 命令 |
| `tiangz.generated.modified` | 生成文件内容与 Manifest 不一致 | 不保留手改，重新生成 |
| `tiangz.generated.missing` | Manifest 中的生成文件不存在 | 重新生成 |
| `tiangz.generated.orphan` | 输出目录存在不属于当前结果的旧文件 | 确认后删除旧文件 |
| `tiangz.generated.invalid-manifest` | Manifest 结构或版本无效 | 执行完整 `npm run codegen` |

Scene 和 Handler 使用“文件路径集合”作为输入。新增、删除或移动 Handler 会提示过期；只修改 Handler 方法体不会要求重新生成。

## 开发流程

修改 Proto、Native Schema、Scene 或 Handler 结构后执行：

```powershell
npm run codegen
```

生成器成功写完全部输出后才更新自己的 Manifest 记录。Manifest 应与生成文件一同提交。
