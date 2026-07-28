# 领域设计助手

领域设计助手解决的是“这个 MMORPG 系统应该由谁拥有、数据是什么形态、什么时候同步、发给谁”这类设计问题。它不生成业务代码，也不代替项目检查器和测试。

## 设计顺序

助手固定按下面的顺序给出结论：

1. 所有者：玩家、地图、Scene 还是 Session。
2. 数据形态：普通值、Component、本地 ChildEntity，还是可独立寻址的 Actor。
3. 生命周期：由谁创建、移除、保存和清理 Timer。
4. 网络范围：自己、队伍、AOI 或全局。
5. 变化语义：Snapshot、可覆盖 Latest、不可丢 Event，或不需要网络同步。
6. 数据位置：默认 TypeScript；只有明确的批量扫描、编码或权威收益才建议 Native。

报告中的 `ownership.*`、`entity.*`、`audience.*`、`sync.*` 等编号来自确定性规则库。相同输入必须得到相同结论。

## VS Code 向导

在命令面板或“TiangZ 工程”视图标题栏执行“TiangZ：设计业务系统”。内置类型可直接选择 Item、Buff、Quest、Achievement 或 Numeric；自定义系统会继续询问身份、生命周期、接收范围、变更语义、频率与持久化需求。

向导只打开一份未保存的 Markdown 报告，不创建或修改工程文件。

## 聊天入口

在 VS Code Chat 中使用：

```text
@tiangz /design buff
@tiangz quest
```

已知类型先由 `design-core` 生成确定性报告。只有用户主动发送聊天请求时，插件才把这份报告交给当前选择的 VS Code 模型，要求它用中文解释。模型不得改变报告结论、引导普通业务修改 Core/Rust/Generated，也不得虚构不存在的 API。

没有可用模型时，插件仍返回确定性报告。自定义需求建议先运行向导，把关键维度说清楚。

## CLI

```powershell
npm run build:design-cli
node dist/tiangz-design.cjs item
node dist/tiangz-design.cjs quest --format json
node dist/tiangz-design.cjs --input .\DesignRequest.json
```

安装 npm 包后也可以直接执行 `tiangz-design`。CLI 不读取 TiangZ 工程，不调用 AI，适合脚本、评审和 CI 留档。

## 规则边界

- Buff 创建和移除是 Event；普通 Tick 只执行 Action，不广播剩余时间或通用 Dirty Delta。
- Quest 进行中实例是本地 ChildEntity，完成历史保存稳定配置 ID；进度默认只发本人，需要时才发队伍摘要。
- Item、Quest、Buff 等子对象只有需要独立身份和生命周期时才使用 ChildEntity；不会被单独寻址时不升级为 Actor。
- Audience 和同步语义分开决定。“发给队伍”不等于“每帧发全量”。
- 助手输出是设计建议；当前代码、项目检查器、生成器锁和测试仍是验收权威。
