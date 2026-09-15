# 工程检查 CLI

## 用途

`tiangz-check-project` 在不启动 VS Code 的情况下检查采用 `app/` 目录组织的 TiangZ 主工程。它与旧 Language Server 共用 `project-core`，因此这部分本地诊断和 CI 不会维护两套规则。

根目录包含 `tiangz.project.json` 的独立模块工程不使用这个检查器，应在该工程运行 `npm run check`，由声明的 TiangZ 宿主执行模块检查。旧 CLI 会明确拒绝并返回退出码 2；即使声明 JSON 损坏，也不会回退到旧索引并报告“零错误”。插件中使用“TiangZ：模块工程操作”的检查入口。当前旧 LSP 尚未提供独立模块的实时语义诊断，宿主检查任务的 Problems 定位与之不同。

检查范围包括：

- Process、StartMachine 与入口 Scene 配置引用。
- Scene、Session、Unit、Component、协议与 Handler 关系。
- Core、Generated、Model、Hotfix、Demo 等目录的依赖方向。
- `codegen.manifest.json` 记录的生成文件完整性。

CLI 只读取工程，不执行 codegen，也不修改任何文件。

## 使用

在 Developer Tools 仓库中检查指定工程：

```powershell
npm run check:project -- E:\gitee\TiangZ
```

安装本包后可以直接调用：

```powershell
tiangz-check-project E:\gitee\TiangZ
```

不传工程目录时检查当前目录：

```powershell
tiangz-check-project
```

## 参数

| 参数 | 作用 |
| --- | --- |
| `--format text\|json` | 选择中文文本或机器可读 JSON，默认 `text` |
| `--warnings-as-errors` | 让警告也导致检查失败 |
| `--max-files <数量>` | 设置最大扫描文件数，默认 `10000` |
| `-h`、`--help` | 显示帮助 |

文本输出适合开发人员阅读：

```text
检查通过：159 个文件，0 个错误，0 个警告，76.3 ms
```

JSON 输出包含版本、工程路径、结果、文件数、耗时、错误/警告数量和完整诊断数组：

```powershell
tiangz-check-project . --format json
```

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 工程检查通过 |
| `1` | 存在错误，或启用 `--warnings-as-errors` 后存在警告 |
| `2` | 参数错误、工程路径错误、不适用的独立模块工程或检查器自身错误 |

CI 只需使用命令的退出码，无需解析输出文本。

## CI 示例

以下示例仅适用于 TiangZ 主工程；独立模块工程应先按自身 README 准备宿主依赖和生成物，再在游戏目录执行 `npm run check`。不要用旧 CLI 的扫描结果替代宿主模块检查。

安装依赖后运行：

```yaml
- name: 检查 TiangZ 工程
  run: npx tiangz-check-project . --format json
```

如需严格禁止 Generated 遗留文件：

```yaml
- name: 严格检查 TiangZ 工程
  run: npx tiangz-check-project . --warnings-as-errors
```

当前包尚未发布到 npm，主工程可以先通过固定 Git Tag 的开发依赖安装。发布后命令和退出码保持不变。
