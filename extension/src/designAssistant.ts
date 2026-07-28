import * as vscode from "vscode";

import {
  formatDesignRecommendation,
  inferSystemArchetype,
  recommendSystemDesign,
  type ChangeFrequency,
  type ChangeSemantics,
  type DesignAudience,
  type DesignOwner,
  type DesignRequest,
  type DesignRecommendation,
  type SystemArchetype,
} from "../../packages/design-core/src/index.js";

const PARTICIPANT_ID = "tiangz-developer-tools.design";

interface Choice<T> extends vscode.QuickPickItem {
  readonly value: T;
}

/** 注册确定性设计向导和可选模型解释层；只有用户显式发起Chat请求时才调用所选模型。 / Registers the deterministic design wizard and optional model explanation layer; the selected model is called only for an explicit chat request. */
export function registerDesignAssistant(
  context: vscode.ExtensionContext,
): readonly vscode.Disposable[] {
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handleChatRequest);
  participant.followupProvider = {
    provideFollowups: () => [
      { prompt: "设计一个Buff系统", label: "设计Buff系统", command: "design" },
      { prompt: "设计一个任务系统", label: "设计Quest系统", command: "design" },
    ],
  };
  return [
    participant,
    vscode.commands.registerCommand(
      "tiangzDeveloperTools.designSystem",
      () => runDesignWizard(),
    ),
  ];
}

/** 通过少量明确问题生成设计报告，不读取或修改业务文件。 / Generates a design report from a small set of explicit questions without reading or modifying business files. */
async function runDesignWizard(): Promise<void> {
  const projectRoot = await selectProjectRoot();
  if (!projectRoot) return;
  const archetype = await pick<SystemArchetype>("选择最接近的业务系统", [
    choice("Buff系统", "Unit下的生命周期状态与Action", "buff"),
    choice("Quest任务系统", "活动任务与完成记录", "quest"),
    choice("Item道具系统", "背包集合与独立道具实例", "item"),
    choice("Achievement成就系统", "进度、完成记录与展示摘要", "achievement"),
    choice("Numeric数值系统", "整数键值属性与帧尾同步", "numeric"),
    choice("自定义系统", "按身份、受众和变化语义推导", "custom"),
  ]);
  if (!archetype) return;
  const name = await vscode.window.showInputBox({
    title: "TiangZ 业务系统设计",
    prompt: "系统名称（可留空使用默认名称）",
    ignoreFocusOut: true,
  });
  if (name === undefined) return;
  const request = archetype === "custom"
    ? await collectCustomRequest(name.trim() || undefined)
    : withOptionalName({ archetype }, name);
  if (!request) return;
  await showRecommendation(recommendSystemDesign(request), projectRoot);
}

async function collectCustomRequest(name: string | undefined): Promise<DesignRequest | undefined> {
  const owner = await pick<DesignOwner>("权威状态归谁所有？", [
    choice("PlayerUnit", "玩家自身能力或私有状态", "player"),
    choice("MapScene", "地图规则、地图集合或副本状态", "map"),
    choice("EntryScene", "全局业务域或可寻址服务", "scene"),
    choice("Session", "只与当前网络连接同生命周期", "session"),
  ]);
  if (!owner) return undefined;
  const independentIdentity = await pickBoolean("集合中的每个对象是否有稳定业务ID？");
  if (independentIdentity === undefined) return undefined;
  const independentLifecycle = await pickBoolean("对象是否需要独立创建、删除、计时或持久化生命周期？");
  if (independentLifecycle === undefined) return undefined;
  const networkTarget = await pickBoolean("其他Scene或客户端是否需要按该对象地址直接发送消息？");
  if (networkTarget === undefined) return undefined;
  const audiences = await pickMany<DesignAudience>("谁需要收到它的变化？", [
    choice("仅本人", "玩家私有状态", "self"),
    choice("队伍成员", "只发送业务所需摘要", "party"),
    choice("AOI观察者", "地图外观或战斗状态", "aoi"),
    choice("全局", "全服广播或订阅", "global"),
    choice("无需网络同步", "纯服务端过程", "none"),
  ]);
  if (!audiences) return undefined;
  const changeSemantics = await pick<ChangeSemantics>("连续变化应该怎样处理？", [
    choice("不可覆盖Event", "每次发生都必须保留", "event"),
    choice("可覆盖Latest", "只需要最终状态", "latest"),
    choice("不产生网络同步", "结果由其他领域同步", "none"),
  ]);
  if (!changeSemantics) return undefined;
  const changeFrequency = await pick<ChangeFrequency>("预计变化频率？", [
    choice("低频", "任务、道具、生命周期事件", "low"),
    choice("中频", "战斗状态或阶段性更新", "medium"),
    choice("高频", "位置、数值批处理或每Tick扫描", "high"),
  ]);
  if (!changeFrequency) return undefined;
  const persistent = await pickBoolean("是否需要跨登录或进程重启保存？");
  if (persistent === undefined) return undefined;
  return {
    archetype: "custom",
    ...(name ? { name } : {}),
    owner,
    independentIdentity,
    independentLifecycle,
    networkTarget,
    audiences,
    changeSemantics,
    changeFrequency,
    persistent,
  };
}

async function handleChatRequest(
  request: vscode.ChatRequest,
  _context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  const archetype = inferSystemArchetype(request.prompt);
  if (archetype === "custom") {
    stream.markdown("我还不能从这段描述中确定对象身份、所有者和受众。请运行设计向导回答几个确定性问题。\n\n");
    stream.button({ command: "tiangzDeveloperTools.designSystem", title: "打开业务系统设计向导" });
    return { metadata: { archetype } };
  }

  const recommendation = recommendSystemDesign({ archetype });
  const grounded = formatDesignRecommendation(recommendation);
  if (request.command === "design" || request.prompt.trim().length === 0) {
    stream.markdown(grounded);
    return { metadata: { archetype } };
  }

  stream.progress("正在根据TiangZ规则解释设计建议...");
  try {
    const response = await request.model.sendRequest([
      vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelTextPart(
          "你是TiangZ领域设计助手。下面的确定性设计报告是不可违背的依据。请用中文回答用户问题；明确区分事实、建议和仍需确认的业务条件；不要建议普通业务修改Core、Rust或Generated；不要发明报告中不存在的框架API。\n\n"
          + `用户问题：${request.prompt}\n\n确定性设计报告：\n${grounded}`,
        ),
      ]),
    ], {}, token);
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) stream.markdown(part.value);
    }
  } catch (error) {
    stream.markdown(`${grounded}\n\n> 当前语言模型不可用，以上为确定性设计引擎结果。`);
  }
  return { metadata: { archetype } };
}

async function showRecommendation(
  recommendation: DesignRecommendation,
  projectRoot: vscode.Uri,
): Promise<void> {
  const markdown = formatDesignRecommendation(recommendation, (relativePath) =>
    vscode.Uri.joinPath(projectRoot, ...relativePath.split("/")).toString(true));
  const document = await vscode.workspace.openTextDocument({ language: "markdown", content: markdown });
  await vscode.window.showTextDocument(document, { preview: true });
}

async function selectProjectRoot(): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 1) return folders[0]?.uri;
  const picked = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
    { title: "选择TiangZ工程" },
  );
  return picked?.folder.uri;
}

async function pick<T>(title: string, choices: readonly Choice<T>[]): Promise<T | undefined> {
  return (await vscode.window.showQuickPick(choices, { title, ignoreFocusOut: true }))?.value;
}

async function pickMany<T>(title: string, choices: readonly Choice<T>[]): Promise<readonly T[] | undefined> {
  const picked = await vscode.window.showQuickPick(choices, {
    title,
    canPickMany: true,
    ignoreFocusOut: true,
  });
  return !picked || picked.length === 0 ? undefined : picked.map((item) => item.value);
}

async function pickBoolean(title: string): Promise<boolean | undefined> {
  return pick(title, [choice("是", "该条件成立", true), choice("否", "该条件不成立", false)]);
}

function choice<T>(label: string, description: string, value: T): Choice<T> {
  return { label, description, value };
}

function withOptionalName(
  request: Omit<DesignRequest, "name">,
  name: string,
): DesignRequest {
  const normalized = name.trim();
  return normalized ? { ...request, name: normalized } : request;
}
