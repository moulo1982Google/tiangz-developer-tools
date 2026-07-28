import type { DesignRule } from "./types.js";

export const DESIGN_RULES: readonly DesignRule[] = [
  rule("ownership.single-owner", "唯一所有者", "每个运行时对象只有一个直接所有者，集合增删经过所有者Component。", "docs/patterns/ownership-and-entity.md"),
  rule("entity.actor-target", "Actor消息目标", "只有需要mailbox和网络寻址的Scene、Session、Unit成为Actor目标。", "docs/patterns/ownership-and-entity.md"),
  rule("entity.local-child", "本地子Entity", "有稳定身份和独立生命周期、但不接收网络消息的对象使用ChildEntity。", "docs/patterns/ownership-and-entity.md"),
  rule("entity.value-state", "值状态", "没有独立身份的数据使用字段、Map、数组、Set或Numeric。", "docs/patterns/ownership-and-entity.md"),
  rule("audience.self", "本人受众", "玩家私有状态只发送给拥有者连接。", "docs/patterns/audience.md"),
  rule("audience.party", "队伍受众", "只向符合业务条件的队伍成员发送必要摘要。", "docs/patterns/audience.md"),
  rule("audience.aoi", "AOI受众", "地图外观或战斗事实发送给当前AOI观察者。", "docs/patterns/audience.md"),
  rule("audience.global", "全局受众", "全服事件经过专门广播或订阅边界。", "docs/patterns/audience.md"),
  rule("sync.snapshot", "全量快照", "登录、重连、进入AOI时发送观察者有权看到的完整当前状态。", "docs/patterns/state-replication.md"),
  rule("sync.latest", "可覆盖状态", "连续变化只需最终值时使用Latest/Delta并在帧尾合并。", "docs/patterns/state-replication.md"),
  rule("sync.event", "不可覆盖事件", "每次发生都不可丢时使用Event立即可靠排队。", "docs/patterns/state-replication.md"),
  rule("sync.none", "无网络同步", "纯服务端过程不产生网络同步，结果由被修改领域自行同步。", "docs/patterns/state-replication.md"),
  rule("lifecycle.owner-cascade", "所有权级联", "所有者销毁时自动销毁子Entity、组件、Timer和Native handle。", "docs/patterns/lifecycle-and-persistence.md"),
  rule("lifecycle.active-instance", "活动实例", "只为当前存在且有行为的实例创建ChildEntity。", "docs/patterns/lifecycle-and-persistence.md"),
  rule("persistence.stable-id", "稳定持久化身份", "持久化业务ID和时间戳，不保存InstanceId或TimerId。", "docs/patterns/lifecycle-and-persistence.md"),
  rule("execution.timer", "稀疏Timer", "稀疏到期和周期触发使用Timer。", "docs/patterns/timer-update-and-action.md"),
  rule("execution.coalesced-timer", "合并Timer", "同一所有者下大量定时对象使用最近到期Timer统一调度。", "docs/patterns/timer-update-and-action.md"),
  rule("execution.action-delegation", "Action领域委托", "Action修改哪个领域，就调用哪个领域能力并复用其同步机制。", "docs/patterns/timer-update-and-action.md"),
  rule("data.ts-default", "TypeScript优先", "普通业务状态和行为默认留在Model/Hotfix TypeScript。", "docs/patterns/data-placement.md"),
  rule("data.native-measure-first", "Native先测量", "只有实测收益支持时才把高频权威数据下沉Rust。", "docs/patterns/data-placement.md"),
] as const;

const RULES_BY_ID = new Map(DESIGN_RULES.map((item) => [item.id, item]));

export function getDesignRule(id: string): DesignRule {
  const result = RULES_BY_ID.get(id);
  if (!result) throw new Error(`unknown TiangZ design rule: ${id}`);
  return result;
}

function rule(id: string, title: string, recommendation: string, document: string): DesignRule {
  return { id, title, recommendation, document };
}
