import { CLARIFY_PROMPT } from "./clarify-defaults";
import {
  candidateTask,
  swappedHistory,
  candidateReplyExcerpt,
  CANDIDATE_REPLY_CHAR_LIMIT,
} from "./candidate-requests";
import { readPluginJSON } from "./plugin-json";
import { upgradeLegacyPlugin } from "./plugin-migrations";
export { upgradeLegacyPlugin } from "./plugin-migrations";
import { summaryIndex, type SummaryState } from "./summaries";
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
  injectionTemplate: string;
  system: string;
  rawRounds: number;
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
  referenceTokens: number;
  missingSummaries: number;
  shortened: number;
  sections: { name: string; tokens: number }[];
};
export type PluginRequest = {
  model: string;
  messages: APIMessage[];
  stream: boolean;
  stream_options?: { include_usage: true };
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
  rewrite: "重写提示",
};
export const REWRITE_PROMPT = "";
export const SUGGEST_PROMPT = "";
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
    injectionTemplate:
      "以下为{{PLUGIN_NAME}}的辅助结果，请结合用户原始要求使用：\n{{RESULT}}",
    system: "",
    rawRounds: 3,
    suggestions: 3,
    ...(kind === "rewrite" ? { rewriteFormat: "fields" as const } : {}),
    ...(["suggest", "rewrite"].includes(kind) ? { initialUser: "好的" } : {}),
    example: "",
    schema: kind === "analysis" ? ANALYSIS_SCHEMA : "",
    prompt:
      kind === "analysis"
        ? ANALYSIS_PROMPT
        : kind === "clarify"
          ? CLARIFY_PROMPT
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
export { readPluginJSON } from "./plugin-json";
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
  if (!prompt) throw Error("重写提示的 prompt 不能为空");
  return prompt;
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
  summaries: SummaryState = { runs: [] },
) {
  p = upgradeLegacyPlugin(p);
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
    referenceTokens: 0,
    missingSummaries: 0,
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
    let rawSupplement: APIMessage | undefined;
    if (p.system.trim()) messages.push({ role: "system", content: p.system });
    const cleanPath = path.filter(
      (m) => m.role === "user" || m.role === "assistant",
    );
    const savedSummaries = summaryIndex(chat, summaries, cleanPath);
    const history: APIMessage[] = cleanPath.map((m) => {
      if (m.role === "user") return { role: "user", content: m.content };
      const saved = savedSummaries.get(m.id);
      if (!saved) metrics.missingSummaries++;
      return {
        role: "assistant",
        content: saved
          ? JSON.stringify({ message_id: m.id, summary: saved.summary })
          : m.content,
      };
    });
    messages.push(...history);
    section("历史 U 与 A 摘要（缺失回退原文）", history);
    if (p.rawRounds > 0) {
      const rounds: (typeof cleanPath)[] = [];
      for (const m of cleanPath) {
        if (m.role === "user" || !rounds.length) rounds.push([]);
        rounds.at(-1)!.push(m);
      }
      const recent = rounds.slice(-p.rawRounds).flat();
      if (recent.length) {
        const raw: APIMessage = {
          role: "user",
          content: JSON.stringify({
            recent_raw_rounds: recent.map((m) => ({
              message_id: m.id,
              role: m.role,
              content: m.content,
            })),
          }),
        };
        rawSupplement = raw;
      }
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
          message_id: r.anchorId,
          ...(p.kind === "analysis"
            ? { result: r.output }
            : { question: r.output, answer: r.answer }),
        }),
      }));
    metrics.referenceTokens = references.reduce(
      (n, r) => n + estimateTokens(r.text),
      0,
    );
    if (references.length) {
      const reference: APIMessage = {
        role: "user",
        content: JSON.stringify({
          plugin_history: references.map((r) => JSON.parse(r.text)),
        }),
      };
      messages.push(reference);
      section("插件历史结果", [reference]);
    }
    if (rawSupplement) {
      messages.push(rawSupplement);
      section("最近原始 UA 补充", [rawSupplement]);
    }
    if (p.kind === "analysis" && clarifications.length) {
      const start = messages.length;
      messages = injectPlugins(
        [...messages, { role: "user", content: input }],
        clarifications,
      );
      section("本轮澄清问答", messages.slice(start));
    }
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
    messages.push({ role: "user", content: suffix });
    section("插件任务与参考", messages.slice(-1));
  } else {
    metrics.shortened = path.filter(
      (m) =>
        m.role === "assistant" &&
        candidateReplyExcerpt(m.content) !== m.content,
    ).length;
    messages = swappedHistory(
      path,
      p.initialUser ?? "好的",
      render(p.prompt, { COUNT: String(p.suggestions), USER_INPUT: input }),
    );
    section(
      `UA 对调历史（回复前 ${CANDIDATE_REPLY_CHAR_LIMIT} 字符，含 U0）`,
      messages,
    );
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
  if (request.stream) request.stream_options = { include_usage: true };
  return { request, metrics, provider, modelRef: ref };
}
export type PluginInjection = {
  pluginId: string;
  name: string;
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
    {
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
