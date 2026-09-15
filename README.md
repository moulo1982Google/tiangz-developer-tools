# TiangZ Developer Tools

TiangZ 框架的工程模型、静态检查与 VS Code 开发工具。

这个插件不替代 TypeScript，也不负责 `.native` 语言支持。它关注 TiangZ 特有的 Process、Scene、Session、Unit、Component、Handler 和启动配置之间的关系。

## 当前能力

- 新增模块入门工程向导与 doctor/setup/check/build/host-build 操作入口，调用宿主 project:create/game_project 通用工具；任务以独立参数执行，支持带空格路径。存在 `tiangz.project.json` 时优先读取其宿主路径，完整配置校验仍由宿主执行。

- 提供独立“TiangZ 模块”导航树，由所选 TiangZ 宿主 `tools/inspect_game_modules.mjs --json` 提供入口、状态类型、System/Handler 绑定、直接依赖和疑似漏加载提示；插件不复制模块解析与兼容规则。需要支持该命令的宿主（当前 0.6 开发线），不会因为版本号相同就假定工具已存在。

- 扫描 `configs/<环境>/**/*.json`，展开`knownSceneFiles`共享启动目录，建立 Environment、Machine、Process 和入口 Scene 模型。
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
- 为 Process JSON 提供 Schema 补全，包括MapHost静态/动态承载角色、`process.persistence.dbProxy`和`process.observability.nativeData`；旧根级`process.nativeData`会被拒绝。
- 按 StartMachine 实际部署集合检查 `process.identity` 缺失、范围和重复槽位。
- 检查 Timer 方法名回调、取消回调签名、同步/Veto Scene Event契约，以及运行时 ID 被误写入持久化结构。
- 检查`Unit + @actor`和`ActorUnit`遗漏`@actor`，确保普通地图实体与可路由mailbox能力显式分离。
- 识别同步通知/Veto Event Handler，并为 GlobalId、InstanceId、Timer、协程锁、Veto Event和`scene.Tasks.Spawn`提供中文 Hover。
- 为`Unit`、`ActorUnit`和`UnitComponent`提供中文Hover，说明普通怪物与玩家Actor的创建边界。
- 提供与 VS Code Problems 使用相同规则的 `tiangz-check-project` 命令，可直接接入 CI。
- 提供 `tiangz-new-component` 组件脚手架，一次生成通用 Model、领域门面和 Hotfix System，并拒绝覆盖已有业务文件。
- 在“TiangZ 工程”树和命令面板提供“TiangZ：新建 Component”，与 CLI 使用同一套生成和冲突校验逻辑。
- 在“TiangZ 工程”树和命令面板提供“TiangZ：运行快速工程检查”，调用主工程的 `npm run verify:fast`，不启动服务器、不做压力测试。
- 从工程树、命令面板或 Proto/Native 文件右键菜单定向运行 Manifest 中的生成器。
- 独立 Language Server 使用 150ms 防抖，不保留 TypeScript AST，并提供运行状态指标。
- 从工程树、原生资源管理器或命令面板运行、调试、停止和重启单个 Process。
- 将 StartMachine 的 Process 展开为独立 VS Code Task，可分别查看 PID、日志和状态。
- 自动执行 TypeScript/Cargo 构建，直接运行 Cargo 产出的 TiangZ executable。
- 自动等待 V8 Inspector 并附加 VS Code JavaScript Debugger，无需维护 `launch.json`。
- 原配置没有 `process.debug` 时，在 VS Code 工作区存储中生成并清理临时调试配置。
- 从 StartMachine 启动主工程统一的源码开发模式，保存 Hotfix 后自动构建不可变候选并 Reload。
- 对运行时状态类中显式 `any`、跨基本存储种类联合字段、`delete` 字段和 `as any` 属性写入提供黄色性能建议。
- 对 `@systemFor`、`@hotfixFor` 和网络/Event Handler 类中的字段、构造函数、静态块与静态方法提供编辑器错误诊断；行为类不保存状态，状态必须回到 Model 的 Entity/Component。
- 对 Component 公开可变 `Map/Set`、生产 Handler 直接导入 `Native*Ref` 提供黄色所有权建议，引导业务通过 Component 领域方法修改子对象。
- 提供确定性的领域设计规则库，覆盖 Item、Buff、Quest、Achievement、Numeric 及自定义系统。
- 提供“TiangZ：设计业务系统”向导和 `@tiangz /design` 聊天入口；AI 只解释规则，不改变确定性结论。
- 提供 `tiangz-design` CLI 和只读 `tiangz-design-mcp`，让终端、CI 与其他 AI 使用同一套规则。
- 提供“TiangZ：运行 Runtime Foundation 自测”命令，复用主工程 `npm run test:runtime-foundation`。
- 提供“TiangZ：查看运行时指标”命令，读取主工程已有的 `/metrics`，展示 CPU、RSS、Rust/Scene mailbox、在途 RPC、Timer 与 Native 实体摘要；这是只读观测，不新增业务 RPC。

## 本地开发

当前处于持续开发阶段，`package.json`、`package-lock.json`和插件版本号不作为冻结契约；日常使用`npm install`即可。准备发布Marketplace或正式Tag时，再由维护者统一审查版本、锁文件和兼容性。

```powershell
npm install
npm run check
npm run package:extension
```

生成的 VSIX 位于 `dist/tiangz-developer-tools-0.15.2.vsix`。
GitHub Actions 会在 Windows、Ubuntu 上执行同一套 `npm run check`，并提供可下载的 VSIX artifact。

检查任意 TiangZ 工程：

```powershell
npm run check:project -- E:\gitee\TiangZ
node dist/tiangz-check-project.cjs E:\gitee\TiangZ --format json
```

生成一个业务 Component：

```powershell
npm run new:component -- Inventory --domain mmorpg --project E:\gitee\TiangZ
```

脚手架会生成 `app/model/domains` 下的通用 Component、`app/model/mmorpg` 下的领域门面和 `app/hotfix/mmorpg` 下的 System，并更新 `app/model/public.ts`。先用 `--dry-run` 预览；生成后在 TiangZ 工程中执行 `npm run codegen:scenes && npm run typecheck && npm run verify:fast`。

在 VS Code 中也可以从“TiangZ 工程”树根节点或命令面板执行“TiangZ：新建 Component”；它会询问组件名和领域，并在生成后刷新工程索引。

在 Process 节点上执行“TiangZ：查看运行时指标”，插件会读取该配置的 `process.observability.health`：

```json
{
  "process": {
    "observability": {
      "health": { "ip": "127.0.0.1", "port": 7600 }
    }
  }
}
```

插件只访问 `GET /metrics`，并将摘要打开为只读 Markdown 文档。`0.0.0.0` 或 `::` 监听地址会按本机访问转换为回环地址；它不会执行调试 RPC、查询或修改业务实体。按 UnitId 查询、权限、限流和协议版本检查仍属于后续 Runtime Inspector 阶段。

设计一个业务系统：

```powershell
node dist/tiangz-design.cjs buff
node dist/tiangz-design.cjs quest --format json
node dist/tiangz-design.cjs --input .\DesignRequest.json
```

## 配置

新建工程的 `tiangz.project.json` 是开发路径的唯一来源，模块导航与工程操作直接调用其中宿主，无需重复设置。旧独立模块工程可设置 `tiangzDeveloperTools.engineRoot` 指向宿主目录（例如 `../TiangZ`），`tiangzDeveloperTools.modulesDirectory` 指向模块集合父目录（默认 `modules`），用于只读导航。两者均相对当前工作区解析。执行“TiangZ：读取模块结构”后，可从“TiangZ 模块”树跳转入口、状态类型和行为绑定；首次和源码改动后均显式刷新，不自动执行工作区脚本。

“TiangZ：创建模块入门工程”先展示目标目录和将生成的内容，再调用宿主生成器，拒绝覆盖由宿主保证。“TiangZ：模块工程操作”只提供有限的准备/检查/构建任务，不自行修改协议锁、不自动判断可热更，也不把任务已启动报告成已通过。宿主边界检查的行列与错误码可在 Problems 面板点击定位。

“TiangZ：启动模块开发模式”读取工程声明的宿主，通过现有开发任务管理器执行宿主 `dev_runtime.mjs --project`。需要事先编译好匹配版本的宿主二进制；构建、监听、热更和互斥锁仍由宿主管理。插件只管理一个源码开发任务；“停止源码开发模式”或终端 Ctrl+C 会先请求优雅停机，25 秒后才兜底终止本任务进程树，异常退出不会被伪装成成功。教学 smoke 仍按新工程 README 在终端执行；这里不自动附加调试器，也不启动其他 Process。

“TiangZ：新建模块 Component”列出宿主已安装模块，收集组件名和功能目录，展示宿主生成的源码预览，确认后再执行。创建 Component/System 并更新 Model/Hotfix 两个入口；不自动选 Scene/Entity 所有者或装配实例。插件以宿主 planHash 锁定预览，入口已改动会拒绝过期计划。已有文件、生成目录和动态装配的处理均由宿主决定；生成前停止开发模式，生成后检查、构建并重启。旧主工程的“新建 Component”命令与此独立模块命令分开。

模块导航只在可信工作区调用宿主 Node 工具，不启动服务器、不运行 Cargo、不改文件。静态入口可达不等于声明必定执行，type-only 导入不加载行为；动态注册无法据此确认。输出只做导航，不授予热更许可，也不替代宿主类型/构建检查。

开发模式的 Problems 匹配器按宿主 `[tiangz-dev-check] begin/end` 划分检查轮次，支持失败后的下一轮重新检查；宿主需包含这组信号。该契约按 [VS Code 持续任务规则](https://code.visualstudio.com/docs/debugtest/tasks#background-watching-tasks) 接入，检查结束不表示 Watcher/游戏已就绪，不能据此宣称自动附加调试器。真实编辑器中的刷新效果仍需人工验收。

可选真实编辑器测试入口为 `extension/test/editor/index.cjs`，不在默认 Node 单测中运行。按 [VS Code 扩展测试入口](https://code.visualstudio.com/api/working-with-extensions/testing-extension) 使用 `--extensionDevelopmentPath=<本仓库>/extension` 和 `--extensionTestsPath=<本仓库>/extension/test/editor/index.cjs`，并指定一次性教学工程、独立 `--user-data-dir`、独立 `--extensions-dir` 和 `--disable-extensions`。先由用户在该隔离配置中显式信任测试工程，再运行测试；测试不会关闭或绕过工作区信任。它验证扩展激活、真实任务诊断位置及两次错误/恢复轮次，不启动游戏或写业务源码。2026-09-16 本机尝试在信任检查处停止，因此不记为真实 Problems 刷新验收通过。

存在根目录 `tiangz.project.json` 时，“TiangZ 工程”树转为模块导航与宿主检查入口，不再用只认识 `app/` 的旧索引扫描模块配置，也不显示旧主工程 Process 启动入口。声明损坏同样不会静默回退；由宿主检查给出修复错误。旧 CLI `tiangz-check-project` 明确拒绝独立模块工程，请使用工程内 `npm run check`。模块源码的实时语义诊断未在旧 LSP 中实现；宿主检查任务仍将错误定位到 Problems 面板。

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

`tiangz.hotfix.instance-state`是错误级诊断。它覆盖直接导入、导入别名和命名空间导入，例如 `import { systemFor as bindSystem } ...` 与 `@model.systemFor(...)`；把缓存、TimerId 或其他长期状态写入行为类会在 VS Code Problems 中直接标红。请把状态放到对应的 Model Component/Entity，Handler 只保留参数校验和调用链编排。

## 领域设计助手

命令面板执行“TiangZ：设计业务系统”，可以按所有者、身份、生命周期、接收范围、变化语义、频率和持久化需求生成设计报告。Item、Buff、Quest、Achievement、Numeric 使用冻结的内置规则；自定义系统使用相同的问题模型。

聊天窗口输入 `@tiangz /design buff` 或 `@tiangz quest`。确定性规则先产生结论；只有用户主动发起聊天时，才允许当前 VS Code 模型解释这些结论。模型不能把普通业务引向 `app/core`、Rust Runtime 或 Generated，也不能虚构框架 API。

详细用法见[领域设计助手](docs/design-assistant.md)，为其他 AI 提供规则的方式见[MCP 服务](docs/mcp-server.md)。

详细说明见 [运行与调试](docs/run-and-debug.md)。

运行时指标与后续只读 Inspector 的边界见 [Runtime Inspector 协议草案](docs/runtime-inspector-protocol.md)。

目录分层与组合入口规则见[工程依赖规则](docs/dependency-rules.md)。

生成器所有权和诊断说明见[Generated 完整性检查](docs/generated-integrity.md)。

命令行参数、退出码和 CI 示例见[工程检查 CLI](docs/check-project-cli.md)。

定向生成入口、任务行为和安全边界见[定向代码生成](docs/codegen-actions.md)。

## 工程边界

`packages/project-core` 不依赖 VS Code，只接收相对路径和文件文本。VS Code 扩展负责文件发现和工程树；独立 Language Server 负责 Problems、协议导航、Hover 与 CodeLens。

`packages/project-core` 同时被 Language Server 与 CLI 调用，因此编辑器和 CI 使用同一套工程规则。运行时 Inspector 当前先复用主工程 `/metrics` 做只读观测；它不替代后续需要权限控制的实体查询协议。

详细设计见 [架构设计](docs/architecture.md)，后续顺序见 [路线图](docs/roadmap.md)。

## 开源协议

TiangZ Developer Tools 使用 [Apache License 2.0](LICENSE) 开源，版权归 2025-2026 郑昕 所有。分发或修改本项目时，请同时保留 [NOTICE](NOTICE) 中的版权与归属声明。
