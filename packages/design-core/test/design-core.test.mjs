import assert from "node:assert/strict";
import test from "node:test";

import {
  DESIGN_RULES,
  formatDesignRecommendation,
  inferSystemArchetype,
  recommendSystemDesign,
} from "../dist/index.js";

test("稳定规则目录没有重复并覆盖全部领域文档编号", () => {
  const ids = DESIGN_RULES.map((rule) => rule.id);
  assert.equal(ids.length, 24);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes("persistence.record"));
  assert.ok(ids.includes("execution.update"));
  assert.ok(ids.includes("data.coarse-op"));
  assert.ok(ids.includes("data.generated-boundary"));
});

test("Buff只同步生命周期事件，Tick结果委托给对应领域", () => {
  const result = recommendSystemDesign({ archetype: "buff" });
  const text = formatDesignRecommendation(result);
  assert.match(text, /BuffAdded\/BuffRemoved Event/);
  assert.match(text, /Tick不产生Buff dirty/);
  assert.match(text, /Numeric、Move等结果由对应领域/);
  assert.match(text, /客户端根据开始\/结束时间自行显示剩余时间/);
});

test("Quest只为活动任务创建子Entity并按受众隔离", () => {
  const result = recommendSystemDesign({ archetype: "quest" });
  const text = formatDesignRecommendation(result);
  assert.match(text, /Active Quest ChildEntity/);
  assert.match(text, /Set\/Bitmap<QuestConfigId>/);
  assert.match(text, /共享任务只向附近Party成员发送必要摘要/);
  assert.match(text, /放弃任务只RemoveChild/);
});

test("Item集合规则与单件规则分开", () => {
  const result = recommendSystemDesign({ archetype: "item" });
  const text = formatDesignRecommendation(result);
  assert.match(text, /PlayerUnit\.ItemComponent/);
  assert.match(text, /ItemSystem实现单件规则/);
  assert.match(text, /ItemComponentSystem实现集合规则/);
});

test("自定义系统根据身份、mailbox和变化语义选择形态", () => {
  const local = recommendSystemDesign({
    archetype: "custom",
    name: "Pet系统",
    owner: "player",
    independentIdentity: true,
    independentLifecycle: true,
    networkTarget: false,
    audiences: ["self", "aoi"],
    changeSemantics: "latest",
    changeFrequency: "high",
    persistent: true,
  });
  assert.equal(local.decisions[1]?.value, "所属Component下的ChildEntity");
  assert.ok(local.ruleIds.includes("entity.local-child"));
  assert.ok(local.ruleIds.includes("sync.latest"));

  const actor = recommendSystemDesign({
    archetype: "custom",
    networkTarget: true,
  });
  assert.equal(actor.decisions[1]?.value, "Scene、Session或Unit中的一种明确Actor目标");
});

test("自然语言只做低成本类型识别", () => {
  assert.equal(inferSystemArchetype("设计一个任务和主线系统"), "quest");
  assert.equal(inferSystemArchetype("Buff tick执行Action"), "buff");
  assert.equal(inferSystemArchetype("宠物养成"), "custom");
});
