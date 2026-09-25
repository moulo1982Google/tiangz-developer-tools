# 生命周期与 Timer 类型契约

唯一规则源为 `packages/project-core/src/runtimeContractRules.ts`，`RUNTIME_CONTRACT_RULESET_VERSION = 1`。`runtimeContractDiagnostics(program, { typescript, projectRoot, coreRoot, sourceFiles })` 在调用者已有 Program 上返回零基位置、稳定代码和等级。调用者必须传创建该 Program 的 TypeScript API；不能拿插件的 SyntaxKind 解释另一版本创建的节点。

| 诊断码 | 等级 | 范围 |
| --- | --- | --- |
| `tiangz.lifecycle.async-method` | error | 当前 Core Entity/Component 继承体系或明确 IDeserialize/ITransfer 的实例钩子返回 Promise/可调用 then，含推导返回值；Singleton 的 OnDestroy |
| `tiangz.lifecycle.unverifiable` | warning | 生命周期返回 any、unknown 或尚未实例化的泛型，不能证明同步 |
| `tiangz.timer.target-missing` | error | 当前 Core 方法名 Timer 的实际接收者缺少目标；名称/接收者联合的每个候选均须成立 |
| `tiangz.timer.not-callable` | error | 目标明确存在但不可调用 |
| `tiangz.timer.argument-mismatch` | error | 一次回调传 args，取消回调传 args 与当前 Core 的 TimerCancelledContext，所有重载都不匹配 |
| `tiangz.timer.unverifiable` | warning | 动态名称、any、未实例化泛型、无法识别接收者或复杂中间 rest 等不能静态证明的情况 |
| `tiangz.contract.project-unavailable` | warning | 已配置工程的类型环境/缓存容量不足，类型契约没有完成检查 |

按当前宿主 Core 声明来源识别，支持继承、别名和 namespace 导入。同名普通工具类与其他宿主的 Core 不当作当前框架类型。Core 自身实现和 `.d.ts` 不作为业务诊断目标，声明文件仍完整参与类型解析。只含数值 `then` 的 DTO 不被当作 Promise。类方法和函数属性的生命周期实现受检，静态方法不受检。

Timer 使用调用的实际 receiver，允许类外调用、`super`、生成 System 的模块增补。字面量常量/字面量联合可验证；宽泛 string 只能给未证明提示。接收者自定义并覆盖的工厂、任意动态反射和工厂经 call/bind 再转发不在完整证明范围。回调可以忽略参数，也可以声明额外可选参数；必填位、数组 rest 和固定元组按运行时实参数量检查。取消上下文从当前 Core public 导出解析，业务同名接口不能替代它。内联 options 以最后一次属性写入为准，后续 spread 不能沿用早先字面量作证明。

主工程 CLI 和 Language Server 共用 `RuntimeContractProject`。按本工程 `tsconfig.json` 创建一个 LanguageService，源码 overlay 优先于磁盘；相同文本复用 snapshot，不逐次启动 tsc 进程。普通 TS 错误同样显示，不能因缺失导入未命中规则就报告完整成功。现有 AST 生命周期存在性检查保留，Program 生效时不再重复 AST async 判断。

LSP 最多保留 4 个工程类型缓存；每个缓存最多 10000 文件、128 MiB 源文本，超出后明确标记不可用并释放服务。这是缓存输入预算，不是 TypeScript 整体堆内存上限。工程关闭/替换、服务 shutdown 都 dispose。统计请求提供 cachedTypeProjects/cachedTypeFiles。变更检查有原有 150ms debounce；依赖图与 tsconfig 中的范围决定参与的类型文件。未保存的既有文件参与检查，untitled 和不在 Program 的文件不属于此次类型验证。

VSIX 带与其编译器同版本的标准库与授权文本，`build-info.json` 记录版本及每份标准库哈希。不能只验证仓库内运行成功而遗漏实际安装包。

独立模块仍由明确声明的宿主 `check` / `modules:typecheck` 提供 Program，强制当前宿主的 Core 和生成声明；旧 CLI 不猜测模块宿主。模块编辑器已有的宿主任务把确定错误定位到 Problems；模块源码的完整实时 Program 检查尚未接入旧 LSP，不把主工程 overlay 验证当作模块实时验收。

CLI 普通运行只因 error 失败；`--warnings-as-errors` 可提升 warning。宿主 CLI 同样区分错误与未证明提示。CI 必须调用这些本地命令，普通 `tsc` 不自动运行自定义规则。JSON 的 runtimeContracts 标明是否检查及 TS/规则版本；没有完整工程环境时文本明确显示“类型契约未检查”。

验证包含正反例的 Core 测试、真实 CLI/LSP 对同一工程逐诊断比较、未保存修改与项目关闭；宿主用自己的 TS 6 Program 验证当前 Core、旧宿主隔离、生成方法、同名取消上下文与 warning 的退出语义。
