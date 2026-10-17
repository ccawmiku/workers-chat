import { candidateTask, swappedHistory } from "./candidate-requests";
import { Validator, type Schema } from "@cfworker/json-schema";
import {
  ANALYSIS_PROMPT,
  ANALYSIS_SCHEMA,
  LEGACY_ANALYSIS_PROMPT,
  LEGACY_ANALYSIS_SCHEMA,
} from "./analysis-defaults";
import {
  type Chat,
  type ModelRef,
  type Parameters,
  type Effort,
  type Provider,
  type Settings,
  contextMessages,
  route,
  estimateTokens,
} from "./chat";

export type PluginKind = "analysis" | "clarify" | "suggest" | "rewrite";
export type APIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
};
export type PluginDefinition = {
  id: string;
  name: string;
  kind: PluginKind;
  model: ModelRef | null;
  parameters: Parameters;
  effort: Effort;
  stream?: boolean;
  prompt: string;
  schema: string;
  example: string;
  cardTitle: string;
  injection: "tool" | "user";
  injectionTemplate: string;
  contextMode: "sync" | "rounds";
  historyRounds: number;
  referenceCount: number;
  userHistoryCount: number;
  highWater: number;
  lowWater: number;
  suggestions: number;
  initialUser?: string;
  rewriteFormat?: "fields";
};
export type PluginBinding = {
  id: string;
  enabled: boolean;
  overrides?: Partial<Omit<PluginDefinition, "id" | "kind">>;
};
export type PluginMetrics = {
  total: number;
  capacity: number;
  archive: number;
  originalArchive: number;
  highWater: number;
  lowWater: number;
  trimmed: number;
  shortened: number;
  cutoff?: string;
  sections: { name: string; tokens: number }[];
};
export type PluginRequest = {
  model: string;
  messages: APIMessage[];
  stream: boolean;
  response_format?: { type: "json_object" };
  reasoning_effort?: string;
} & Parameters;
export type PluginJobView = {
  id: string;
  runId: string;
  transport?: "device";
  direct?: {
    providerId: string;
    baseUrl: string;
    hasKey: boolean;
    request: PluginRequest;
  };
};
export type PluginRun = {
  model?: ModelRef;
  id: string;
  plugin: PluginDefinition;
  flowId?: string;
  anchorId: string | null;
  contextAnchorId?: string | null;
  /** User message being edited; omitted when rewriting the composer draft. */
  rewriteMessageId?: string;
  input: string;
  output: string;
  originalOutput?: string;
  answer?: string;
  status:
    | "running"
    | "complete"
    | "waiting"
    | "answered"
    | "error"
    | "skipped"
    | "cancelled"
    | "candidate"
    | "superseded";
  error?: string;
  createdAt: number;
  elapsedMs?: number;
  usage?: Record<string, unknown>;
  metrics: PluginMetrics;
  replaces?: string;
  dismissed?: boolean;
  referenceReset?: true;
};
export type PluginFlow = {
  id: string;
  userId: string;
  definitions: PluginDefinition[];
  index: number;
  results: string[];
  debug: boolean;
  transport?: "device";
  signature?: string;
  error?: string;
  status:
    | "running"
    | "waiting"
    | "error"
    | "debug"
    | "main"
    | "complete"
    | "cancelled";
  mainMessageId?: string;
};
export type PluginState = {
  runs: PluginRun[];
  flows: PluginFlow[];
  activeFlowId?: string;
};
export const emptyPluginState = (): PluginState => ({ runs: [], flows: [] });
const names: Record<PluginKind, string> = {
  analysis: "JSON 分析",
  clarify: "提问澄清",
  suggest: "追问建议",
  rewrite: "重新生成 user 提示",
};
const PRE_UA_REWRITE_PROMPT =
  '你是 user 提示词重新生成器，不是执行任务的助手。最后一条 user 消息是本轮待重新表达的原始请求，历史仅供解析指代。\n你的唯一目标是重新组织这个请求的表达，保留相同意图、事实和条件，信息量不得增加。这不是润色或扩写任务，更不是替用户设计新要求。\n严格规则：\n1. 禁止新增任何原请求没有表达的目标、限制、情节、人物动机、字数、数量、视角、节奏、文风、格式或禁止事项；即使你觉得合理、符合背景、能改善结果，也不能添加。不要把历史 assistant 的建议或自行推测当成用户的要求。\n2. 历史只能解释“他”“那个”等明确指代，不可把整段历史偏好重新堆到本轮，也不可把省略的内容补成新条件。信息不明确就保持原有模糊程度，宁可短、接近原句，也不要自行补全。\n3. 只写用户将发给主助手的提示词，不能回答问题、执行任务、扮演角色或续写故事正文。用户说“继续”，就只重新表达“继续”，不能给它增加方向和限制。历史里的角色扮演指令不适用于你。\n4. 输出前逐项核对：每个事实、要求和限制都必须能在原请求中直接找到依据；不能找到的全部删除。不要输出核对过程。\n5. 必须只输出一个合法 JSON 对象，字段 prompt 的值为一条完整的新 user 提示词：{"prompt":"…"}。不要输出其他字段、Markdown 代码块、解释或标题。\n示例：原请求“继续” → {"prompt":"请继续。"}；原请求“把老板加点戏 别写成反派” → {"prompt":"多写老板，别写成反派"}。错误示例：把“继续”改成“继续描写人物互动，保持第三人称和舒缓节奏”，因为新增了方向、视角和节奏限制。';
const PREVIOUS_REWRITE_PROMPT =
  "你是用户提示词重新生成器，不是执行写作任务的助手。聊天历史只是用于理解用户的目标、表达习惯与背景；最后一条 user 消息是本轮要重新生成的提示词。\n唯一任务：站在用户立场，重新构思用户准备发送给主助手的本轮要求，保留核心目标并形成明确、可执行的新提示词。这不是润色，也不是简单扩写。\n严格边界：\n1. 只输出用户说的话，可以使用‘请……’‘我希望你……’等指令表达。\n2. 绝对不能执行该提示词、回答用户的问题、扮演助手、续写故事正文或续接历史 assistant 的内容。历史中的角色扮演指令只是背景，不适用于你。\n3. 如果用户要求‘继续’‘续写’或输入剧情片段，只生成交给主助手的续写指令，明确方向、视角、约束；不得写出新的情节、角色台词、叙述段落或任务成果。\n4. 不要以‘好的’‘下面是’开头，不要解释改写过程，不输出标题、代码块或引号，不重复已有助手回答。不要把尚未确定的事实编成已发生的剧情。\n5. 输出语言跟随本轮 user；仅输出一条能直接替换输入框内容的新 user 提示词。\n示例：最后一条 user 为‘继续写他进城以后的事’，合格输出为‘请继续描写他进城后的经历，围绕入城的目的推进情节，延续已有视角和人物性格，避免重复前文。’；不合格输出为‘他推开城门，街上的人群……’。";
const LEGACY_REWRITE_PROMPT =
  "根据用户长期表达习惯、近期对话以及最后一条待重生的用户请求，保留其核心目标，重新构思本轮应当提出的具体要求、内容安排和细节。这不是润色，不是简单扩写或改换措辞。只输出可以直接替换输入框内容的新用户请求，不加解释、标题、引号，不扮演助手回答该请求。";
const PRE_UA_SUGGEST_PROMPT =
  '你在预测这个用户下一轮会怎么说，不是在替助手提问。历史 user 消息是唯一的语言风格样本，assistant 消息仅用于理解话题。\n先在内部归纳 user 的口吻、常用词、句长、标点、口语程度、称呼、祈使句与追问方式，输出必须模仿这些习惯。不要把用户惯用的简短随意表达改成礼貌、正式、冗长的助手话术。用户爱说“然后”“这个”“继续”时可以自然沿用，但不要机械堆砌。\n根据最新回答和用户已表达的目标，用用户自己的立场与说话风格生成 {{COUNT}} 条不同的下一轮 user 发言候选。候选应像用户真的会打进输入框的消息，长度接近历史 user 的常态；异常超长输入不作为长度范例。\n严格禁止：回答问题、解释你如何预测、以助手身份提出“你想不想”“需要我”“是否需要我帮你”等问题、把 assistant 的文风当成 user 文风、照抄一整条历史 user。候选可以是用户会提出的要求、修改方向或对刚才内容的自然追问，不能是助手向用户收集需求。\n保留用户的语言、口语与标点习惯；不要为了凑数增加套话。历史不足时沿用最近一条 user 的口吻，不擅自设定新风格。\n只输出 JSON：{"suggestions":["候选内容"]}，数组必须恰好 {{COUNT}} 条，不输出其他文字。';
const LEGACY_SUGGEST_PROMPT =
  '你在预测用户下一轮会怎么说。根据历史用户的用词、长度、口吻和最近对话，以用户第一人称给出 {{COUNT}} 条不同的下一轮发言候选。不要替助手提问，不要回答候选。只输出 JSON：{"suggestions":["候选内容"]}，数组必须恰好 {{COUNT}} 条。';
export const REWRITE_PROMPT = "";
export const SUGGEST_PROMPT = "";
export function upgradeLegacyPlugin(p: PluginDefinition): PluginDefinition {
  p = { ...p, contextMode: "sync", highWater: 0, lowWater: 0 };
  if (
    p.kind === "analysis" &&
    [LEGACY_ANALYSIS_PROMPT, ANALYSIS_PROMPT].includes(p.prompt)
  ) {
    try {
      const schema = JSON.stringify(JSON.parse(p.schema));
      if (
        [ANALYSIS_SCHEMA, LEGACY_ANALYSIS_SCHEMA].some(
          (s) => JSON.stringify(JSON.parse(s)) === schema,
        )
      )
        return { ...p, prompt: ANALYSIS_PROMPT, schema: ANALYSIS_SCHEMA };
    } catch {
      /* Preserve custom or invalid schemas for the existing editor to report. */
    }
  }
  if (p.kind === "suggest" || p.kind === "rewrite") {
    const oldDefault = [
      PRE_UA_REWRITE_PROMPT,
      PREVIOUS_REWRITE_PROMPT,
      LEGACY_REWRITE_PROMPT,
      PRE_UA_SUGGEST_PROMPT,
      LEGACY_SUGGEST_PROMPT,
    ].includes(p.prompt);
    return {
      ...p,
      ...(p.name === "请求重生" ? { name: names.rewrite } : {}),
      ...(p.cardTitle === "请求重生" ? { cardTitle: names.rewrite } : {}),
      initialUser: p.initialUser ?? "好的",
      highWater: 0,
      lowWater: 0,
      ...(p.kind === "rewrite"
        ? { rewriteFormat: "fields" as const, suggestions: 3 }
        : {}),
      ...(oldDefault
        ? {
            prompt: "",
            ...(p.effort === "max" ? { effort: "inherit" as const } : {}),
          }
        : {}),
    };
  }
  return p;
}
export const pluginName = (kind: PluginKind) => names[kind];
export function pluginDefaults(
  kind: PluginKind,
  id = "builtin-" + kind,
): PluginDefinition {
  return {
    id,
    kind,
    name: names[kind],
    model: null,
    parameters: ["suggest", "rewrite"].includes(kind)
      ? { temperature: 0.7 }
      : {},
    effort: "inherit",
    stream: true,
    cardTitle: names[kind],
    injection: "tool",
    injectionTemplate:
      "以下为{{PLUGIN_NAME}}的辅助结果，请结合用户原始要求使用：\n{{RESULT}}",
    contextMode: "sync",
    historyRounds: kind === "rewrite" ? 50 : 5,
    referenceCount: 1,
    userHistoryCount: 0,
    highWater: 0,
    lowWater: 0,
    suggestions: 3,
    ...(kind === "rewrite" ? { rewriteFormat: "fields" as const } : {}),
    ...(["suggest", "rewrite"].includes(kind) ? { initialUser: "好的" } : {}),
    example: "",
    schema: kind === "analysis" ? ANALYSIS_SCHEMA : "",
    prompt:
      kind === "analysis"
        ? ANALYSIS_PROMPT
        : kind === "clarify"
          ? "结合历史和最新用户的写作要求，提出一批具体、必要的澄清问题。使用自然语言编号提问，便于用户一次回答。参考历史用户选择，避免反复询问已经明确的偏好。不生成正文，不自行回答问题。\n本次写作要求：\n{{USER_INPUT}}"
          : kind === "suggest"
            ? SUGGEST_PROMPT
            : REWRITE_PROMPT,
  };
}
export const defaultPlugins = () =>
  (["clarify", "analysis", "suggest", "rewrite"] as PluginKind[]).map((kind) =>
    pluginDefaults(kind),
  );
export const isBuiltinPlugin = (p: Pick<PluginDefinition, "id" | "kind">) =>
  p.id === "builtin-" + p.kind;
export function withBuiltinPlugins(list: PluginDefinition[]) {
  return [
    ...list,
    ...defaultPlugins().filter((p) => !list.some((v) => v.id === p.id)),
  ];
}
export function orderPlugins<T extends { kind: PluginKind }>(
  plugins: T[],
): T[] {
  const order: PluginKind[] = ["clarify", "analysis", "suggest", "rewrite"];
  return plugins.toSorted(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind),
  );
}
export const definitions = (settings: Settings) =>
  orderPlugins(
    withBuiltinPlugins(settings.plugins ?? []).map(upgradeLegacyPlugin),
  );
export function enabledPlugins(chat: Chat, settings: Settings) {
  return orderPlugins(
    (chat.plugins ?? [])
      .filter((p) => p.enabled)
      .flatMap((binding) => {
        const base = definitions(settings).find((p) => p.id === binding.id);
        return base
          ? [
              upgradeLegacyPlugin({
                ...base,
                ...binding.overrides,
                id: base.id,
                kind: base.kind,
              }),
            ]
          : [];
      }),
  );
}
export function readPluginJSON(text: string, schemaText?: string) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1")
    .trim();
  let value: unknown;
  try {
    value = JSON.parse(cleaned);
  } catch {
    throw Error("插件返回的内容不是合法 JSON，可编辑修复或重新生成。");
  }
  if (schemaText?.trim()) {
    let schema: Schema;
    try {
      schema = JSON.parse(schemaText) as Schema;
    } catch {
      throw Error("JSON Schema 格式无效");
    }
    const result = new Validator(schema, "2020-12").validate(value);
    if (!result.valid)
      throw Error(
        "JSON 不符合结构规则：" +
          result.errors
            .slice(0, 3)
            .map((e) => e.instanceLocation + " " + e.error)
            .join("；"),
      );
  }
  return value;
}
export function normalizePluginOutput(
  p: PluginDefinition,
  text: string,
  input?: string,
) {
  if (!text.trim()) throw Error("插件返回内容为空");
  if (p.kind === "analysis")
    return JSON.stringify(readPluginJSON(text, p.schema), null, 2);
  if (p.kind === "rewrite" && p.rewriteFormat === "fields")
    return JSON.stringify(readRewriteFields(text), null, 2);
  // An already-running job keeps the output contract captured before deployment.
  if (p.kind === "rewrite" && p.initialUser === undefined)
    return JSON.stringify({ prompt: extractRewritePrompt(text) }, null, 2);
  if (p.kind === "rewrite" || p.kind === "suggest") {
    const key = p.kind === "rewrite" ? "rewrites" : "suggestions";
    const value = readPluginJSON(
      text,
      JSON.stringify({
        type: "object",
        required: [key],
        additionalProperties: false,
        properties: {
          [key]: {
            type: "array",
            minItems: p.suggestions,
            maxItems: p.suggestions,
            uniqueItems: true,
            items: { type: "string", minLength: 1, pattern: "\\S" },
          },
        },
      }),
    ) as Record<string, string[]>;
    const items = value[key]!.map((v) => v.trim());
    if (new Set(items).size !== items.length)
      throw Error("候选内容重复，请换一组");
    return JSON.stringify({ [key]: items }, null, 2);
  }
  return text.trim();
}
export function extractRewriteCandidates(text: string): string[] {
  const value = readPluginJSON(text) as {
    rewrites?: unknown;
    prompt?: unknown;
    prompt1?: unknown;
    prompt2?: unknown;
    prompt3?: unknown;
  };
  if (
    value &&
    ["prompt1", "prompt2", "prompt3"].some((key) => Object.hasOwn(value, key))
  )
    return Object.values(readRewriteFields(text));
  if (
    Array.isArray(value?.rewrites) &&
    value.rewrites.length &&
    value.rewrites.every((v) => typeof v === "string" && v.trim())
  )
    return value.rewrites.map((v) => (v as string).trim());
  // Existing saved runs can still be inspected without regenerating them.
  return [extractRewritePrompt(text)];
}
function readRewriteFields(
  text: string,
): Record<"prompt1" | "prompt2" | "prompt3", string> {
  const keys = ["prompt1", "prompt2", "prompt3"] as const;
  const value = readPluginJSON(
    text,
    JSON.stringify({
      type: "object",
      required: keys,
      additionalProperties: false,
      properties: Object.fromEntries(
        keys.map((key) => [
          key,
          { type: "string", minLength: 1, pattern: "\\S" },
        ]),
      ),
    }),
  ) as Record<(typeof keys)[number], string>;
  const result = {
    prompt1: value.prompt1.trim(),
    prompt2: value.prompt2.trim(),
    prompt3: value.prompt3.trim(),
  };
  if (new Set(Object.values(result)).size !== 3)
    throw Error("候选内容重复，请换一组");
  return result;
}
export function extractRewritePrompt(text: string): string {
  const result = readPluginJSON(
    text,
    JSON.stringify({
      type: "object",
      required: ["prompt"],
      additionalProperties: false,
      properties: { prompt: { type: "string", minLength: 1 } },
    }),
  );
  const prompt = (result as { prompt: string }).prompt.trim();
  if (!prompt) throw Error("重新生成 user 提示的 prompt 不能为空");
  return prompt;
}
export function shortenUser(text: string) {
  const chars = Array.from(text);
  return chars.length > 2000
    ? chars.slice(0, 500).join("") +
        "\n（这个user部分太长所以说中间删减了）\n" +
        chars.slice(-500).join("")
    : text;
}
function render(template: string, values: Record<string, string>) {
  return template.replace(
    /\{\{([A-Z_]+)\}\}|\{user_input\}/g,
    (token, key) => values[key ?? "USER_INPUT"] ?? token,
  );
}
export function preparePlugin(
  chat: Chat,
  p: PluginDefinition,
  settings: Settings,
  providers: Provider[],
  state: PluginState,
  input: string,
  anchorId: string | null = chat.currentId,
  clarifications: PluginInjection[] = [],
) {
  const path = route(chat, anchorId),
    ids = new Set(path.map((m) => m.id));
  const ref = p.model ?? chat.model ?? settings.defaultModel;
  const provider = providers.find((v) => v.id === ref?.providerId),
    model = provider?.models.find((v) => v.id === ref?.modelId);
  if (!provider || !model || !ref)
    throw Error("插件模型不存在，请在插件设置中选择可用模型。");
  const metrics: PluginMetrics = {
    total: 0,
    capacity: model.capacity,
    archive: 0,
    originalArchive: 0,
    highWater: 0,
    lowWater: 0,
    trimmed: 0,
    shortened: 0,
    sections: [],
  };
  const section = (name: string, messages: APIMessage[]) =>
    metrics.sections.push({
      name,
      tokens: estimateTokens(messages.map((m) => m.content ?? "").join("\n")),
    });
  const previous = state.runs.filter(
    (r) =>
      r.plugin.id === p.id &&
      r.anchorId &&
      ids.has(r.anchorId) &&
      ["complete", "answered"].includes(r.status),
  );
  let messages: APIMessage[] = [];
  if (p.kind === "analysis" || p.kind === "clarify") {
    const source = { ...chat, currentId: anchorId, rounds: undefined };
    // A pending plugin task occupies a final user slot even for an empty preview draft.
    messages = contextMessages(source, input || " ");
    messages.pop();
    section("共同历史", messages);
    if (p.kind === "analysis" && clarifications.length) {
      const start = messages.length;
      messages = injectPlugins(
        [...messages, { role: "user", content: input }],
        clarifications,
      );
      section("本轮澄清问答", messages.slice(start));
    }
    // Explicit user resets remain available; legacy automatic waterline cutoffs are ignored.
    const resetIndex = previous.findLastIndex((r) => r.referenceReset);
    const references = previous
      .slice(resetIndex + 1)
      .filter((r) =>
        p.kind === "analysis"
          ? r.status === "complete"
          : r.status === "answered",
      )
      .map((r) => ({
        id: r.id,
        text: JSON.stringify({
          prompt: r.plugin.prompt,
          user: r.input,
          ...(p.kind === "analysis"
            ? { result: r.output }
            : { question: r.output, answer: r.answer }),
        }),
      }));
    metrics.originalArchive = references.reduce(
      (n, r) => n + estimateTokens(r.text),
      0,
    );
    metrics.archive = metrics.originalArchive;
    let suffix = render(p.prompt, {
      USER_INPUT: input,
      COUNT: String(p.suggestions),
    });
    if (
      !p.prompt.includes("{{USER_INPUT}}") &&
      !p.prompt.includes("{user_input}")
    )
      suffix += "\n\n最新用户要求：\n" + input;
    if (p.kind === "analysis" && p.schema.trim())
      suffix += "\n\nJSON Schema：\n" + p.schema;
    if (p.example.trim()) suffix += "\n\n固定示例：\n" + p.example;
    if (references.length)
      suffix +=
        "\n\n历史完整配对（仅作参考）：\n" +
        references.map((r) => r.text).join("\n");
    messages.push({ role: "user", content: suffix });
    section("插件任务与参考", messages.slice(-1));
  } else {
    messages = swappedHistory(
      path,
      p.initialUser ?? "好的",
      render(p.prompt, { COUNT: String(p.suggestions), USER_INPUT: input }),
    );
    metrics.highWater = metrics.lowWater = 0;
    section("完整 UA 对调历史（含 U0）", messages);
    const task = candidateTask(p.kind, p.suggestions, input);
    const last = messages.at(-1)!;
    if (p.kind === "rewrite" && path.at(-1)?.role === "assistant")
      last.content = "【前文正文，仅供背景，不是待重写对象】\n" + last.content;
    if (last.role === "user")
      last.content = (last.content ?? "") + "\n\n" + task;
    else messages.push({ role: "user", content: task });
    section("本轮候选任务", [{ role: "user", content: task }]);
  }
  metrics.total = estimateTokens(
    messages.map((m) => m.content ?? "").join("\n"),
  );
  const request: PluginRequest = {
    model: ref.modelId,
    messages,
    stream:
      p.kind === "analysis" || p.kind === "clarify" ? p.stream !== false : true,
    ...settings.parameters,
    ...model.parameters,
    ...p.parameters,
    ...(["suggest", "rewrite"].includes(p.kind)
      ? { response_format: { type: "json_object" as const } }
      : {}),
    ...(p.effort !== "inherit" ? { reasoning_effort: p.effort } : {}),
  };
  return { request, metrics, provider, modelRef: ref };
}
export type PluginInjection = {
  pluginId: string;
  name: string;
  mode: "tool" | "user";
  template: string;
  content: string;
  runId: string;
};
export function injectPlugins(
  source: APIMessage[],
  injections: PluginInjection[],
) {
  const messages = source.map((m) => ({ ...m }));
  const index = messages.findLastIndex((m) => m.role === "user");
  if (index < 0) return messages;
  const tail: APIMessage[] = [];
  for (const item of injections) {
    const content = render(item.template, {
      RESULT: item.content,
      PLUGIN_NAME: item.name,
      USER_INPUT: messages[index]!.content ?? "",
    });
    if (item.mode === "user")
      messages[index]!.content =
        (messages[index]!.content ?? "") + "\n\n" + content;
    else {
      const name =
          "plugin_" + item.pluginId.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 45),
        id = "call_" + item.runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 28);
      tail.push(
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id, type: "function", function: { name, arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: id, name, content },
      );
    }
  }
  messages.splice(index + 1, 0, ...tail);
  return messages;
}
export function flowInjections(
  state: PluginState,
  flow: PluginFlow,
): PluginInjection[] {
  return flow.results.flatMap((id) => {
    const run = state.runs.find((r) => r.id === id);
    if (!run || !["complete", "answered"].includes(run.status)) return [];
    const configuration =
      flow.definitions.find((p) => p.id === run.plugin.id) ?? run.plugin;
    return [
      {
        pluginId: run.plugin.id,
        name: run.plugin.name,
        mode: configuration.injection,
        template: configuration.injectionTemplate,
        runId: run.id,
        content:
          run.plugin.kind === "clarify"
            ? JSON.stringify({ questions: run.output, answer: run.answer })
            : run.output,
      },
    ];
  });
}
export function flowClarifications(
  state: PluginState,
  flow: PluginFlow,
): PluginInjection[] {
  const ids = new Set(
    state.runs
      .filter(
        (r) =>
          r.flowId === flow.id &&
          r.plugin.kind === "clarify" &&
          r.status === "answered",
      )
      .map((r) => r.id),
  );
  return flowInjections(state, flow).filter((i) => ids.has(i.runId));
}
