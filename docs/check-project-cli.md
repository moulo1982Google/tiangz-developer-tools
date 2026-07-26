# 工程检查 CLI

## 用途

`tiangz-check-project` 在不启动 VS Code 的情况下检查 TiangZ 工程。它与 Language Server 共用 `project-core`，因此本地 Problems 面板和 CI 不会维护两套规则。

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
| `2` | 参数错误、工程路径错误或检查器自身错误 |

CI 只需使用命令的退出码，无需解析输出文本。

## CI 示例

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
