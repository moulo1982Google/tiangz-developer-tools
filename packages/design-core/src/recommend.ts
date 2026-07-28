import { getDesignRule } from "./rules.js";
import type {
  ChangeSemantics,
  DesignAudience,
  DesignDecision,
  DesignOwner,
  DesignRecommendation,
  DesignRequest,
  SystemArchetype,
} from "./types.js";

const ARCHETYPE_KEYWORDS: Readonly<Record<Exclude<SystemArchetype, "custom">, readonly string[]>> = {
  item: ["item", "道具", "背包", "装备"],
  buff: ["buff", "状态效果", "光环"],
  quest: ["quest", "任务", "主线", "支线"],
  achievement: ["achievement", "成就"],
  numeric: ["numeric", "数值", "属性", "血量"],
};

export function inferSystemArchetype(text: string): SystemArchetype {
  const normalized = text.toLocaleLowerCase();
  for (const [archetype, keywords] of Object.entries(ARCHETYPE_KEYWORDS)) {
    if (keywords.some((keyword) => normalized.includes(keyword))) return archetype as SystemArchetype;
  }
  return "custom";
}

export function recommendSystemDesign(request: DesignRequest): DesignRecommendation {
  switch (request.archetype) {
    case "item": return itemRecommendation(request.name);
    case "buff": return buffRecommendation(request.name);
    case "quest": return questRecommendation(request.name);
    case "achievement": return achievementRecommendation(request.name);
    case "numeric": return numericRecommendation(request.name);
    case "custom": return customRecommendation(request);
  }
}

export function formatDesignRecommendation(
  result: DesignRecommendation,
  documentLink: (relativePath: string) => string = (relativePath) => relativePath,
): string {
  return [
    `# ${result.title}`,
    "",
    result.summary,
    "",
    "## 核心决定",
    "",
    ...result.decisions.map((item) => `- **${item.label}**：${item.value}。${item.reason}`),
    "",
    "## 生命周期",
    "",
    ...result.lifecycle.map((item) => `1. ${item}`),
    "",
    "## 同步与受众",
    "",
    ...result.synchronization.map((item) => `- ${item}`),
    "",
    "## 推荐落点",
    "",
    ...result.implementation.map((item) => `- ${item}`),
    "",
    "## 避免",
    "",
    ...result.avoid.map((item) => `- ${item}`),
    "",
    "## 依据",
    "",
    ...result.ruleIds.map((id) => {
      const rule = getDesignRule(id);
      return `- \`${rule.id}\`：${rule.recommendation}`;
    }),
    "",
    "相关文档：",
    ...result.documents.map((document) => `- [${document}](${documentLink(document)})`),
    "",
  ].join("\n");
}

function itemRecommendation(name = "Item系统"): DesignRecommendation {
  return recommendation("item", name, "道具是玩家拥有的独立实例；集合变化由ItemComponent协调，单件道具规则留在Item。", [
    decision("所有者", "PlayerUnit.ItemComponent", "背包是玩家聚合边界。"),
    decision("运行时对象", "Item ChildEntity", "道具有稳定ItemId和独立创建、销毁、强化等生命周期。"),
    decision("默认受众", "Self", "库存默认是玩家私有数据。"),
    decision("同步", "Snapshot + Event", "登录发送快照，使用、获得、删除等事实不可覆盖。"),
    decision("数据位置", "先TypeScript；有实测批处理收益时使用Native", "ChildEntity不自动意味着Rust下沉。"),
  ], [
    "创建或加载时由ItemComponent.AddChild创建Item。",
    "使用、拆分、合并和转移由ItemComponent统一校验。",
    "删除时RemoveChild，Core级联释放Timer与Native handle。",
  ], [
    "登录或重连向本人发送背包Snapshot。",
    "获得、消耗、删除和交易结果使用不可覆盖Event。",
    "装备外观若对他人可见，由外观系统向AOI广播，不公开完整背包。",
  ], [
    "Model定义Item、ItemComponent和稳定字段。",
    "Hotfix的ItemSystem实现单件规则，ItemComponentSystem实现集合规则。",
    "Handler只做协议适配并调用ItemComponent领域方法。",
  ], [
    "公开可变Map或NativeItemRef给Handler。",
    "把每件道具做成Actor或网络消息目标。",
    "因为当前Item样例使用Native就让所有道具系统强制下沉Rust。",
  ], ["ownership.single-owner", "entity.local-child", "audience.self", "sync.snapshot", "sync.event", "data.native-measure-first"]);
}

function buffRecommendation(name = "Buff系统"): DesignRecommendation {
  return recommendation("buff", name, "Buff是Unit拥有的本地生命周期实例；创建和删除广播，Tick只执行Action。", [
    decision("所有者", "Unit.BuffComponent", "玩家、怪物和NPC使用同一Buff组合能力。"),
    decision("运行时对象", "Buff ChildEntity", "每个Buff有来源、层数、起止时间和独立生命周期，但不需要mailbox。"),
    decision("默认受众", "AOI", "Buff图标和可见战斗状态通常需要周围观察者知道。"),
    decision("同步", "BuffAdded/BuffRemoved Event + Unit Snapshot", "Buff本身不是每Tick变化的复制状态。"),
    decision("Tick", "执行Action，不广播Buff", "Numeric、Move等结果由对应领域已有机制同步。"),
  ], [
    "AddChild创建Buff并向当前AOI发送BuffAdded。",
    "Timer到点调用Buff Action；大量Buff由BuffComponent合并调度。",
    "到期、驱散或覆盖时RemoveChild并发送BuffRemoved。",
  ], [
    "观察者进入AOI时，Buff列表随Unit整体Snapshot发送。",
    "观察者离开AOI时只删除Unit，不逐个发送BuffRemoved。",
    "Buff Tick不产生Buff dirty或剩余时间Delta。",
  ], [
    "Model定义Buff、BuffComponent和持久化字段。",
    "Hotfix实现Buff Action与BuffComponent集合规则。",
    "客户端根据开始/结束时间自行显示剩余时间。",
  ], [
    "每Tick广播Buff剩余时间。",
    "扫描EntityRoot收集Buff。",
    "因为Buff对AOI可见就给每个Buff创建mailbox。",
  ], ["ownership.single-owner", "entity.local-child", "audience.aoi", "sync.event", "sync.snapshot", "sync.none", "execution.action-delegation", "execution.coalesced-timer"]);
}

function questRecommendation(name = "Quest系统"): DesignRecommendation {
  return recommendation("quest", name, "QuestComponent只持有进行中Quest；完成后删除实例并记录稳定配置ID。", [
    decision("所有者", "PlayerUnit.QuestComponent", "任务状态属于玩家聚合。"),
    decision("运行时对象", "Active Quest ChildEntity", "只有进行中的任务具有进度和生命周期。"),
    decision("完成记录", "Set/Bitmap<QuestConfigId>", "历史完成事实不需要保留运行时Entity。"),
    decision("默认受众", "Self；共享任务可选Party", "任务默认私有，队友只需要共享摘要。"),
    decision("同步", "本人进度通知 + 登录Snapshot + Party摘要", "任务变化低频，不需要通用dirty mask。"),
  ], [
    "QuestComponent初始可以没有Quest子Entity。",
    "接受任务时AddChild创建活动Quest。",
    "完成时统一结算奖励、记录配置ID、RemoveChild并发送完成通知。",
    "放弃任务只RemoveChild，不写入完成集合。",
  ], [
    "进度变化默认只通知任务拥有者。",
    "共享任务只向附近Party成员发送必要摘要。",
    "队友进入AOI时，共享摘要可随Unit整体Snapshot发送；普通观察者不包含Quest。",
    "离开AOI时只删除Unit。",
  ], [
    "不可重复任务可用配置ID作为Quest Id。",
    "允许并存的重复任务使用独立实例ID，并单独保存configId。",
    "登录或重连向本人发送活动任务和已完成摘要。",
  ], [
    "为每个历史已完成任务保留空Quest Entity。",
    "把完整Quest广播给地图AOI或所有队友。",
    "在Handler中分别修改奖励、完成集合和活动Quest，破坏领域原子性。",
  ], ["ownership.single-owner", "entity.local-child", "lifecycle.active-instance", "persistence.stable-id", "audience.self", "audience.party", "sync.snapshot", "sync.event"]);
}

function achievementRecommendation(name = "Achievement系统"): DesignRecommendation {
  return recommendation("achievement", name, "AchievementComponent拥有活动进度；是否创建ChildEntity取决于是否存在独立实例生命周期。", [
    decision("所有者", "PlayerUnit.AchievementComponent", "成就进度是玩家私有状态。"),
    decision("对象形态", "默认Map状态；复杂活动成就使用ChildEntity", "大量静态配置进度不应无条件创建对象。"),
    decision("默认受众", "Self", "他人通常只看展示栏摘要。"),
    decision("同步", "登录Snapshot + 进度/完成通知", "完成事实不可丢，普通进度可按业务节流。"),
  ], [
    "首次产生进度时创建状态或活动实例。",
    "完成时记录配置ID和完成时间，并清理不再需要的活动实例。",
    "展示栏从已完成记录选择摘要，不泄漏完整进度。",
  ], [
    "本人收到进度和完成通知。",
    "公开展示只同步选中的成就摘要。",
  ], [
    "先使用TypeScript Map/Set；只有独立计时、重复实例等需求时使用ChildEntity。",
    "完成历史保存稳定配置ID和时间戳。",
  ], [
    "为配置表中的每个成就预创建Entity。",
    "向AOI广播玩家完整成就集合。",
  ], ["ownership.single-owner", "entity.value-state", "entity.local-child", "audience.self", "sync.snapshot", "sync.event", "data.ts-default"]);
}

function numericRecommendation(name = "Numeric系统"): DesignRecommendation {
  return recommendation("numeric", name, "Numeric是Unit上的整数键值状态，不为每个数值创建Entity。", [
    decision("所有者", "Unit.NumericComponent", "属性共同组成Unit权威数值状态。"),
    decision("对象形态", "NumericType -> number字典", "数值没有独立身份和生命周期。"),
    decision("同步", "dirty latest + FrameFlush", "同帧多次修改只需要最终值。"),
    decision("受众", "由Numeric类型决定Self或AOI", "私有货币与公开HP不能使用同一固定受众。"),
  ], [
    "Unit创建时挂载NumericComponent。",
    "领域Action通过Numeric API修改值并自动置dirty。",
    "帧尾按NumericType合并并在成功排队后Ack。",
  ], [
    "登录和进入视野发送观察者有权看到的Snapshot。",
    "变化使用latest Delta，不为每次加减发送Event。",
  ], [
    "使用稳定整数NumericType。",
    "公开与私有Numeric在生成Audience时过滤。",
  ], [
    "每个属性创建一个Entity。",
    "同帧每次加减都立即广播。",
  ], ["entity.value-state", "sync.latest", "sync.snapshot", "data.native-measure-first"]);
}

function customRecommendation(request: DesignRequest): DesignRecommendation {
  const owner = request.owner ?? "player";
  const identity = request.independentIdentity ?? false;
  const lifecycle = request.independentLifecycle ?? identity;
  const networkTarget = request.networkTarget ?? false;
  const audiences: readonly DesignAudience[] = unique<DesignAudience>(
    request.audiences ?? ["self"],
  );
  const semantics = request.changeSemantics ?? "event";
  const rules = ["ownership.single-owner", "data.ts-default"];
  const objectShape = networkTarget
    ? "Scene、Session或Unit中的一种明确Actor目标"
    : identity && lifecycle
      ? "所属Component下的ChildEntity"
      : "所属Component内部字段、Map、数组或Set";
  rules.push(networkTarget ? "entity.actor-target" : identity && lifecycle ? "entity.local-child" : "entity.value-state");
  for (const audience of audiences) if (audience !== "none") rules.push(`audience.${audience}`);
  rules.push(`sync.${semantics}`);
  const frequency = request.changeFrequency ?? "low";
  const ownerText = ownerLabel(owner);
  const sync = synchronizationFor(audiences, semantics);
  return recommendation("custom", request.name ?? "自定义业务系统", "这是根据当前答案生成的初步设计；业务事实不明确时应先确认所有权和受众，再生成代码。", [
    decision("所有者", ownerText, "所有状态变化必须从一个明确聚合边界进入。"),
    decision("对象形态", objectShape, networkTarget ? "该对象需要独立消息串行与寻址。" : identity && lifecycle ? "它有独立身份和生命周期但不需要网络路由。" : "它不需要额外Entity身份。"),
    decision("变化语义", semanticsLabel(semantics), "由连续变化能否覆盖决定。"),
    decision("频率", frequencyLabel(frequency), "频率用于决定是否帧尾合并和是否值得性能测量。"),
    decision("持久化", request.persistent === false ? "不持久化" : "保存稳定业务字段", "绝不保存InstanceId和TimerId。"),
  ], [
    "由所有者创建和删除状态。",
    lifecycle ? "所有者销毁时级联清理对象、Timer和句柄。" : "状态随所属Component生命周期存在。",
    request.persistent === false ? "重启后从业务默认值重建。" : "加载持久化记录后重建运行时对象。",
  ], sync, [
    "Model保存稳定类型、字段和所有权结构。",
    "Hotfix保存Handler、流程编排和领域方法。",
    frequency === "high" ? "先建立业务基准，再决定是否使用Native或Rust批处理。" : "默认留在TypeScript，不提前下沉Rust。",
  ], [
    "没有明确受众就广播给AOI或全服。",
    "仅因为对象有多个实例就给它创建mailbox。",
    "绕过所有者Component直接修改集合。",
  ], unique(rules));
}

function recommendation(
  archetype: SystemArchetype,
  title: string,
  summary: string,
  decisions: readonly DesignDecision[],
  lifecycle: readonly string[],
  synchronization: readonly string[],
  implementation: readonly string[],
  avoid: readonly string[],
  ruleIds: readonly string[],
): DesignRecommendation {
  const documents = unique(ruleIds.map((id) => getDesignRule(id).document));
  return { version: 1, archetype, title, summary, decisions, lifecycle, synchronization, implementation, avoid, ruleIds, documents };
}

function decision(label: string, value: string, reason: string): DesignDecision {
  return { label, value, reason };
}

function ownerLabel(owner: DesignOwner): string {
  return ({ player: "PlayerUnit上的业务Component", map: "MapScene上的业务Component", scene: "EntryScene上的业务Component", session: "Session上的连接Component" })[owner];
}

function semanticsLabel(value: ChangeSemantics): string {
  return ({ none: "不产生网络同步", latest: "可覆盖Latest/Delta", event: "不可覆盖Event" })[value];
}

function frequencyLabel(value: "low" | "medium" | "high"): string {
  return ({ low: "低频，直接领域通知", medium: "中频，按语义决定合并", high: "高频，必须建立基准并批处理" })[value];
}

function synchronizationFor(audiences: readonly DesignAudience[], semantics: ChangeSemantics): string[] {
  if (semantics === "none" || audiences.includes("none")) return ["该过程不直接产生网络同步；由被修改领域自行决定。"];
  const audienceText = audiences.map((item) => ({ self: "本人", party: "队伍", aoi: "AOI", global: "全局", none: "无" })[item]).join("、");
  return [
    `变化发送给：${audienceText}。`,
    semantics === "latest" ? "同一key连续变化在帧尾合并，只发送最终状态。" : "每次变化都是不可覆盖事实，使用Event可靠排队。",
    "登录、重连或新观察关系建立时，按权限提供Snapshot。",
  ];
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
