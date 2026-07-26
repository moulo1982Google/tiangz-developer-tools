# 工程依赖规则

## 目标

依赖检查用于防止框架层逐渐反向引用演示业务，也防止不可热更的 Model 依赖 Hotfix。规则位于不依赖 VS Code 的 `project-core`，因此编辑器诊断与后续 CI 命令会使用同一套结果。

## 默认分层

| 源目录 | 允许依赖 |
| --- | --- |
| `app/core` | `app/core` |
| `app/generated/model` | `app/core`、`app/generated/model` |
| `app/generated/bootstrap` | Core、Generated/Model、Model；只负责不可热更Model的生成装配 |
| `app/model` | Core、Generated/Model、Model |
| `app/game` | Core、Generated/Model、Model、Game |
| `app/hotfix` | 只能相对依赖Hotfix/Generated Hotfix；稳定层统一使用`#tiangz/model` |
| `app/demo` | Core、Generated/Model、Model、Game、Demo |
| `app/bench` | Core、Generated/Model、Model、Game、Hotfix、Bench、所有业务目录 |
| 其他 `app/<game>` 业务目录 | Core、Generated/Model、Model、Game、同名业务目录 |

`app/main.ts`、`app/main.bench.ts` 等 `app/main.<用途>.ts` 是应用组合入口，允许导入所有层。`app/bench` 只用于压测和自测，可以调用真实业务 API；业务目录不能反向依赖 Bench。

`app/generated/hotfix`是codegen生成的Handler/行为补丁组合入口，只允许导入`app/hotfix`；它不等同于纯数据代码`app/generated/model`。

`app/generated/bootstrap` 是 Model 启动装配入口，可以导入稳定 Model Scene；它属于不可热更 Bundle，不能引用 `app/hotfix`。`app/hotfix/main*.ts` 可以导入 `app/generated/hotfix` 完成候选 generation 注册。

Hotfix中的非相对import只允许精确的`#tiangz/model`。第三方库如果需要成为Hotfix依赖，应先在Model公共入口封装并冻结版本，不能让候选Bundle自行引入不受兼容指纹约束的新运行时依赖。

## 检查范围

当前检查以下相对模块引用：

- `import ... from "..."`
- `import "..."`
- `export ... from "..."`
- 使用字符串常量的 `import("...")`

npm 包等非相对模块不参与目录分层检查。诊断代码为 `tiangz.architecture.invalid-dependency`，严重级别是 Error，位置指向发生违规的模块路径。

## 示例

Core 不能引用 Demo：

```ts
// app/core/runtime/host.ts
import { PlayerUnit } from "../../demo/map/PlayerUnit";
```

业务代码可以使用 Core 与生成协议：

```ts
// app/demo/scenes/LoginScene.ts
import { EntryScene } from "../../core/process/types";
import { LoginProtocol } from "../../generated/model/server/demo/protocol/rpcs";
```

Generated/Hotfix 可以装配业务模块：

```ts
// app/generated/hotfix/scenes.ts，由 codegen 写入
import "../../demo/scenes/LoginScene";
```

不要通过改成动态导入绕开规则；静态字符串形式的 `import()` 同样会被检查。
