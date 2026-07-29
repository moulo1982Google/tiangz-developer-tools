# TiangZ Developer Tools

TiangZ 框架的工程模型、静态检查与 VS Code 开发工具。

这个插件不替代 TypeScript，也不负责 `.native` 语言支持。它关注 TiangZ 特有的 Process、Scene、Session、Unit、Component、Handler 和启动配置之间的关系。

## 当前能力

- 扫描 `configs/<环境>/**/*.json`，建立 Environment、Machine、Process 和入口 Scene 模型。
- 使用 TypeScript Compiler API 识别 `@entryScene`、`@scene`、`@component`，并兼容旧版 `@actor`。
- 从服务端生成文件索引 RPC、Message、Request、Response、MsgCode 与 Descriptor。
- 识别 Scene、Session、Unit 类 Handler，以及 `@rpc`、`@message`、`@handler` 方法；兼容旧版 Actor Handler 与 `registerActorRpc`。
- 在资源管理器中显示“TiangZ 工程”树，并可跳转到配置或声明。
- 在 Handler 与协议之间双向导航，并提供中文 Hover 和 CodeLens。
- 检查配置引用、重复或缺失 Handler，以及 RPC 消息类型不匹配。
- 将工程问题同时显示在工程树与 VS Code Problems 面板。
- 检查 Core、Generated/Model、Model、Hotfix、Game 与业务目录的依赖方向。
- 根据 `codegen.manifest.json` 检测生成文件过期、缺失、遗留或被手工修改。
- 识别 `@systemFor` 与 `*System.ts`，跟踪 TiangZ 自动生成的 Model 方法声明。
- 校验`@lifecycle`与`@transferable()`声明，缺少System、同步生命周期方法或迁移方法时在编辑器和CI中报错。
- 为 Process JSON 提供 Schema 补全，并按 StartMachine 实际部署集合检查 `process.identity` 缺失、范围和重复槽位。
- 检查 Timer 方法名回调、取消回调签名、未等待的异步 Scene Event，以及运行时 ID 被误写入持久化结构。
- 识别同步/异步 Scene Event Handler，并为 GlobalId、InstanceId、Timer、协程锁和 Scene Event 提供中文 Hover。
- 提供与 VS Code Problems 使用相同规则的 `tiangz-check-project` 命令，可直接接入 CI。
- 从工程树、命令面板或 Proto/Native 文件右键菜单定向运行 Manifest 中的生成器。
- 独立 Language Server 使用 150ms 防抖，不保留 TypeScript AST，并提供运行状态指标。
- 从工程树、原生资源管理器或命令面板运行、调试、停止和重启单个 Process。
- 将 StartMachine 的 Process 展开为独立 VS Code Task，可分别查看 PID、日志和状态。
- 自动执行 TypeScript/Cargo 构建，直接运行 Cargo 产出的 TiangZ executable。
- 自动等待 V8 Inspector 并附加 VS Code JavaScript Debugger，无需维护 `launch.json`。
- 原配置没有 `process.debug` 时，在 VS Code 工作区存储中生成并清理临时调试配置。
- 从 StartMachine 启动主工程统一的源码开发模式，保存 Hotfix 后自动构建不可变候选并 Reload。
- 对运行时状态类中显式 `any`、跨基本存储种类联合字段、`delete` 字段和 `as any` 属性写入提供黄色性能建议。
- 对 Component 公开可变 `Map/Set`、生产 Handler 直接导入 `Native*Ref` 提供黄色所有权建议，引导业务通过 Component 领域方法修改子对象。
- 提供确定性的领域设计规则库，覆盖 Item、Buff、Quest、Achievement、Numeric 及自定义系统。
- 提供“TiangZ：设计业务系统”向导和 `@tiangz /design` 聊天入口；AI 只解释规则，不改变确定性结论。
- 提供 `tiangz-design` CLI 和只读 `tiangz-design-mcp`，让终端、CI 与其他 AI 使用同一套规则。
- 提供“TiangZ：运行 Runtime Foundation 自测”命令，复用主工程 `npm run test:runtime-foundation`。

## 本地开发

```powershell
npm install
npm run check
npm run package:extension
```

生成的 VSIX 位于 `dist/tiangz-developer-tools-0.15.0.vsix`。

检查任意 TiangZ 工程：

```powershell
npm run check:project -- E:\gitee\TiangZ
node dist/tiangz-check-project.cjs E:\gitee\TiangZ --format json
```

设计一个业务系统：

```powershell
node dist/tiangz-design.cjs buff
node dist/tiangz-design.cjs quest --format json
node dist/tiangz-design.cjs --input .\DesignRequest.json
```

## 配置

默认配置适用于 TiangZ 主仓库：

```json
{
  "tiangzDeveloperTools.configRoot": "configs",
  "tiangzDeveloperTools.sourceRoots": ["app"],
  "tiangzDeveloperTools.initialFileLimit": 10000,
  "tiangzDeveloperTools.maxFileSizeBytes": 2097152,
  "tiangzDeveloperTools.buildTypeScriptOnLaunch": true,
  "tiangzDeveloperTools.runBuildCommand": "npm run build",
  "tiangzDeveloperTools.debugBuildCommand": "npm run build:debug",
  "tiangzDeveloperTools.cargoBuildArgs": ["build", "--bin", "TiangZ"]
}
```

## 运行与调试

在“TiangZ 工程”树中右键 Process，或在原生资源管理器中右键 `configs/**/*.json`：

- “运行 Process”：普通构建后启动独立 Task。
- “调试 Process”：构建 debug bundle、启动 Process、等待 Inspector 并自动附加。
- “附加到 Process”：重新附加已经在调试模式运行的 Process。
- “停止/重启 Process”：管理对应的进程树和调试会话。

右键 Machine 可一次启动或停止该 Machine 引用的全部 Process。插件只在可信工作区执行构建和进程命令。

右键 StartMachine 选择“启动源码开发模式”，会调用主工程的`npm run dev -- <StartMachine.json>`。插件不自行实现第二套监听器或Reload状态机；停止任务时由主工程开发宿主请求Watcher优雅停机。

`tiangz.performance.unstable-shape`只扫描Model/Hotfix业务运行时类并排除Bench。它是可选的黄色性能建议，不会让普通`tiangz-check-project`失败；CI只有显式传入`--warnings-as-errors`时才提升警告。

`tiangz.architecture.component-public-collection`与`tiangz.architecture.native-ref-in-handler`同样是低噪音黄色建议。前者防止业务绕过 Component 的集合所有权，后者防止 Handler 泄漏可变 Native 句柄；所属 System 和 Bench 仍可按需要直接使用底层能力。

`tiangz.timer.*`、`tiangz.event.*`与`tiangz.persistence.runtime-id`只检查能从单文件语法树确定的问题。插件不会创建第二套工程级 TypeScript 类型检查器，也不会阻止合法的动态业务代码。

## 领域设计助手

命令面板执行“TiangZ：设计业务系统”，可以按所有者、身份、生命周期、接收范围、变化语义、频率和持久化需求生成设计报告。Item、Buff、Quest、Achievement、Numeric 使用冻结的内置规则；自定义系统使用相同的问题模型。

聊天窗口输入 `@tiangz /design buff` 或 `@tiangz quest`。确定性规则先产生结论；只有用户主动发起聊天时，才允许当前 VS Code 模型解释这些结论。模型不能把普通业务引向 `app/core`、Rust Runtime 或 Generated，也不能虚构框架 API。

详细用法见[领域设计助手](docs/design-assistant.md)，为其他 AI 提供规则的方式见[MCP 服务](docs/mcp-server.md)。

详细说明见 [运行与调试](docs/run-and-debug.md)。

目录分层与组合入口规则见[工程依赖规则](docs/dependency-rules.md)。

生成器所有权和诊断说明见[Generated 完整性检查](docs/generated-integrity.md)。

命令行参数、退出码和 CI 示例见[工程检查 CLI](docs/check-project-cli.md)。

定向生成入口、任务行为和安全边界见[定向代码生成](docs/codegen-actions.md)。

## 工程边界

`packages/project-core` 不依赖 VS Code，只接收相对路径和文件文本。VS Code 扩展负责文件发现和工程树；独立 Language Server 负责 Problems、协议导航、Hover 与 CodeLens。

`packages/project-core` 同时被 Language Server 与 CLI 调用，因此编辑器和 CI 使用同一套工程规则。运行时 Inspector 尚未实现，后续会作为独立阶段推进。

详细设计见 [架构设计](docs/architecture.md)，后续顺序见 [路线图](docs/roadmap.md)。
