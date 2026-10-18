import type { SummaryConfig } from "./summaries";
export const MODEL_ID_MAX_LENGTH = 1000;
import { DEFAULT_TITLE_PROMPT } from "./default-title-prompt";
import type { PluginBinding, PluginDefinition } from "./plugins";
export type Role = "user" | "assistant" | "system";
export type Effort = "inherit" | "none" | "low" | "medium" | "high" | "max";
export type Parameters = {
  temperature?: number;
  top_p?: number;
  top_k?: number;
};
export type ModelRef = { providerId: string; modelId: string };
export type Message = {
  id: string;
  parentId: string | null;
  role: Role;
  content: string;
  contentVersion?: string;
  reasoning?: string;
  createdAt: number;
  excluded?: boolean;
  status?: "complete" | "running" | "stopped" | "error";
  model?: ModelRef;
  usage?: Record<string, unknown>;
  request?: {
    parameters: Parameters;
    effort: Effort;
    stream: boolean;
    transport?: "device";
  };
  elapsedMs?: number;
  error?: string;
  raw?: Record<string, unknown>;
};
export type Chat = {
  summaryOverrides?: Partial<SummaryConfig>;
  plugins?: PluginBinding[];
  pluginPending?: "running" | "waiting" | "error" | "debug";
  id: string;
  title: string;
  titleManual: boolean;
  titleRevision?: string;
  createdAt: number;
  updatedAt: number;
  groupId: string | null;
  pinned: boolean;
  archived: boolean;
  deleted: boolean;
  unread: boolean;
  draft: string;
  currentId: string | null;
  messages: Record<string, Message>;
  model: ModelRef | null;
  effort: Effort;
  parameters: Parameters;
  stream: boolean;
  system: { id: string; name: string; content: string }[];
  includeStopped: boolean;
  rounds?: number;
  templateMode: "replace" | "append";
  /** Legacy imported field, no longer controls title requests. */
  titleScope?: "branch" | "first";
  raw?: Record<string, unknown>;
};
export type Provider = {
  id: string;
  name: string;
  baseUrl: string;
  prefix: string;
  encryptedKey?: string;
  models: {
    id: string;
    enabled: boolean;
    capacity: number;
    parameters: Parameters;
  }[];
};
export type Settings = {
  replySummary?: SummaryConfig;
  plugins?: PluginDefinition[];
  defaultModel: ModelRef | null;
  parameters: Parameters;
  templates: Chat["system"];
  titlePrompt: string;
  titleModel: ModelRef | null;
};
export const defaultSettings = (): Settings => ({
  defaultModel: null,
  parameters: {},
  templates: [],
  titlePrompt: DEFAULT_TITLE_PROMPT,
  titleModel: null,
});
export const uuid = () => crypto.randomUUID();
export function findMessage(
  chat: Chat,
  id: string | null | undefined,
): Message | undefined {
  return typeof id === "string" && Object.hasOwn(chat.messages, id)
    ? chat.messages[id]
    : undefined;
}
export function newChat(
  model: ModelRef | null = null,
  groupId: string | null = null,
): Chat {
  return {
    id: uuid(),
    title: "新聊天",
    titleManual: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    groupId,
    pinned: false,
    archived: false,
    deleted: false,
    unread: false,
    draft: "",
    currentId: null,
    messages: {},
    model,
    effort: "inherit",
    parameters: {},
    stream: true,
    system: [],
    includeStopped: true,
    templateMode: "replace",
  };
}
export function route(chat: Chat, currentId = chat.currentId): Message[] {
  const result: Message[] = [],
    seen = new Set<string>();
  while (currentId !== null) {
    if (seen.has(currentId)) throw new Error("消息树包含循环");
    seen.add(currentId);
    const msg = findMessage(chat, currentId);
    if (!msg) throw new Error("消息树引用不存在的父节点");
    result.push(msg);
    currentId = msg.parentId;
  }
  return result.reverse();
}
export function indexChildren(chat: Chat) {
  const result = new Map<string | null, Message[]>();
  for (const message of Object.values(chat.messages)) {
    let list = result.get(message.parentId);
    if (!list) {
      list = [];
      result.set(message.parentId, list);
    }
    list.push(message);
  }
  for (const list of result.values())
    list.sort((a, b) => a.createdAt - b.createdAt);
  return result;
}
export function validateMessageTree(chat: Chat) {
  const complete = new Set<string>();
  for (const start of Object.keys(chat.messages)) {
    const pending: string[] = [],
      visiting = new Set<string>();
    let id: string | null = start;
    while (id !== null && !complete.has(id)) {
      if (visiting.has(id)) throw new Error("消息树包含循环");
      const message = findMessage(chat, id);
      if (!message) throw new Error("消息树引用不存在的父节点");
      visiting.add(id);
      pending.push(id);
      id = message.parentId;
    }
    for (const id of pending) complete.add(id);
  }
  if (chat.currentId !== null && !findMessage(chat, chat.currentId))
    throw new Error("当前消息不存在");
}
export function children(chat: Chat, parentId: string | null) {
  return Object.values(chat.messages)
    .filter((m) => m.parentId === parentId)
    .sort((a, b) => a.createdAt - b.createdAt);
}
export function selectBranch(chat: Chat, id: string) {
  if (!findMessage(chat, id)) throw new Error("消息不存在");
  const seen = new Set<string>(),
    index = indexChildren(chat);
  while (!seen.has(id)) {
    seen.add(id);
    const next = index.get(id)?.at(-1);
    if (!next) break;
    id = next.id;
  }
  chat.currentId = id;
  route(chat);
}
export function addMessage(
  chat: Chat,
  role: Role,
  content: string,
  parentId = chat.currentId,
): Message {
  if (parentId !== null && !findMessage(chat, parentId))
    throw new Error("父消息不存在");
  const msg: Message = {
    id: uuid(),
    role,
    content,
    parentId,
    createdAt: Date.now(),
    contentVersion: uuid(),
    status: "complete",
  };
  chat.messages[msg.id] = msg;
  chat.currentId = msg.id;
  chat.updatedAt = Date.now();
  return msg;
}
export function editMessage(chat: Chat, id: string, content: string): Message {
  const msg = findMessage(chat, id);
  if (!msg) throw new Error("消息不存在");
  if (msg.role === "assistant") {
    msg.content = content;
    msg.contentVersion = uuid();
    return msg;
  }
  return addMessage(chat, msg.role, content, msg.parentId);
}
export function descendants(chat: Chat, id: string): string[] {
  if (!findMessage(chat, id)) throw new Error("消息不存在");
  const byParent = indexChildren(chat);
  const ids: string[] = [],
    pending = [id],
    seen = new Set<string>();
  while (pending.length) {
    const next = pending.pop()!;
    if (seen.has(next)) throw new Error("消息树包含循环");
    seen.add(next);
    ids.push(next);
    for (const child of byParent.get(next) ?? []) pending.push(child.id);
  }
  return ids;
}
export function deleteSubtree(chat: Chat, id: string) {
  const ids = descendants(chat, id),
    parent = chat.messages[id]!.parentId;
  if (chat.currentId && ids.includes(chat.currentId)) chat.currentId = parent;
  ids.forEach((key) => delete chat.messages[key]);
  return ids.length;
}
/** OpenWebUI-style removal: splice out the selected message and direct children. */
export function deleteMessage(chat: Chat, id: string): string[] {
  const message = findMessage(chat, id);
  if (!message) throw new Error("消息不存在");
  const byParent = indexChildren(chat),
    removed = [id, ...(byParent.get(id) ?? []).map((m) => m.id)],
    deleted = new Set(removed);
  for (const child of byParent.get(id) ?? [])
    for (const grandchild of byParent.get(child.id) ?? [])
      grandchild.parentId = message.parentId;
  for (const key of deleted) delete chat.messages[key];
  const next = indexChildren(chat).get(message.parentId)?.at(-1);
  if (next) selectBranch(chat, next.id);
  else chat.currentId = message.parentId;
  chat.updatedAt = Date.now();
  return removed;
}
export function forkChat(chat: Chat, id: string, titles: string[]): Chat {
  const copy = structuredClone({ ...chat, messages: {} }),
    base = chat.title.replace(/ · 分支(?:[A-Z]+|\d+)$/u, "");
  const taken = new Set(titles);
  let n = 0, title: string;
  do {
    title = `${base} · 分支${String(++n).padStart(2, "0")}`;
  } while (taken.has(title));
  const path = route(chat, id),
    remap = new Map(path.map((m) => [m.id, uuid()]));
  copy.messages = Object.fromEntries(
    path.map((m) => {
      const v = structuredClone(m);
      v.id = remap.get(m.id)!;
      v.parentId = m.parentId ? remap.get(m.parentId)! : null;
      return [v.id, v];
    }),
  );
  copy.id = uuid();
  copy.currentId = remap.get(id)!;
  copy.title = title;
  copy.titleManual = true;
  copy.draft = "";
  copy.createdAt = copy.updatedAt = Date.now();
  copy.deleted = copy.archived = copy.unread = false;
  return copy;
}
export function duplicateChat(chat: Chat, titles: string[]): Chat {
  const copy = structuredClone(chat);
  const ids = new Map(Object.keys(chat.messages).map((id) => [id, uuid()]));
  copy.messages = Object.fromEntries(
    Object.values(chat.messages).map((message) => {
      const cloned = structuredClone(message);
      cloned.id = ids.get(message.id)!;
      cloned.parentId = message.parentId ? ids.get(message.parentId)! : null;
      return [cloned.id, cloned];
    }),
  );
  copy.id = uuid();
  copy.currentId = chat.currentId ? ids.get(chat.currentId)! : null;
  const base = chat.title.replace(/ · 副本(?:\d+)?$/, "");
  let index = 1;
  do {
    copy.title = base + " · 副本" + (index === 1 ? "" : index);
    index++;
  } while (titles.includes(copy.title));
  copy.titleManual = true;
  copy.titleRevision = uuid();
  copy.createdAt = copy.updatedAt = Date.now();
  copy.pinned = copy.archived = copy.deleted = copy.unread = false;
  copy.draft = "";
  return copy;
}
export function resolveModel(
  ref: ModelRef | null,
  settings: Settings,
  providers: Provider[],
): ModelRef {
  const exists = (r: ModelRef | null): r is ModelRef =>
    !!r &&
    providers.some(
      (p) => p.id === r.providerId && p.models.some((m) => m.id === r.modelId),
    );
  if (exists(ref)) return ref;
  if (exists(settings.defaultModel)) return settings.defaultModel;
  throw new Error("当前模型不存在，且没有可用默认模型；请在设置中选择默认模型");
}
export function contextTurns(chat: Chat) {
  const turns: Message[][] = [];
  for (const message of route(chat)) {
    if (message.role === "user" || !turns.length) turns.push([]);
    turns.at(-1)!.push(message);
  }
  return turns;
}

export function contextMessages(chat: Chat, draft?: string) {
  // Legacy exclusion flags are retained for JSON exchange, but no longer affect requests.
  let path = contextTurns(chat).flat();
  if (chat.rounds && chat.rounds > 0) {
    const historyRounds = chat.rounds - (draft ? 1 : 0);
    let rounds = 0,
      index = path.length;
    while (historyRounds > 0 && index > 0) {
      index--;
      if (path[index]!.role === "user" && ++rounds === historyRounds) break;
    }
    path = path.slice(index);
  }
  const messages: { role: Role; content: string }[] = [];
  const system = chat.system
    .map((t) => t.content)
    .filter(Boolean)
    .join("\n\n");
  if (system) messages.push({ role: "system", content: system });
  messages.push(...path.map((m) => ({ role: m.role, content: m.content })));
  if (draft) messages.push({ role: "user", content: draft });
  return messages;
}
export function requestPreview(
  chat: Chat,
  settings: Settings,
  providers: Provider[],
  draft?: string,
) {
  const model = resolveModel(chat.model, settings, providers),
    provider = providers.find((p) => p.id === model.providerId)!;
  const modelSettings = provider.models.find((m) => m.id === model.modelId)!;
  const messages = contextMessages(chat, draft);
  const request = {
    model: model.modelId,
    messages,
    stream: chat.stream,
    ...(chat.stream
      ? { stream_options: { include_usage: true as const } }
      : {}),
    ...settings.parameters,
    ...modelSettings.parameters,
    ...chat.parameters,
    ...(chat.effort !== "inherit" ? { reasoning_effort: chat.effort } : {}),
  };
  return {
    model,
    provider,
    request,
    capacity: modelSettings.capacity,
    estimatedTokens: estimateTokens(messages.map((m) => m.content).join("\n")),
  };
}
export function estimateTokens(text: string) {
  // Deliberately labelled an estimate: CJK and emoji are costlier than Latin words.
  let units = 0;
  for (const char of text) units += /[\u0000-\u007f]/u.test(char) ? 0.28 : 1.5;
  return Math.ceil(units);
}
export function markdownExport(chat: Chat) {
  return (
    `# ${chat.title}\n\n` +
    route(chat)
      .map(
        (m) =>
          `## ${m.role === "user" ? "用户" : m.role === "assistant" ? "AI" : "系统"}\n\n${m.content}`,
      )
      .join("\n\n")
  );
}

export function formatTokenCount(value: number): string {
  return value < 1000
    ? String(Math.round(value))
    : (value / 1000).toFixed(1) + "k";
}

// Preserve explicit upstream percentages; never invent a rate from token counts.
export function cacheHitRate(value: unknown): string | undefined {
  if (typeof value === "string") {
    const rate = value.trim();
    if (/^\d+(?:\.\d+)?%$/.test(rate) && Number(rate.slice(0, -1)) <= 100)
      return rate;
    if (!/^\d+(?:\.\d+)?$/.test(rate)) return undefined;
    value = Number(rate);
  }
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  )
    return `${Number((value <= 1 ? value * 100 : value).toFixed(2))}%`;
  return undefined;
}
export function sanitizeUsage(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>,
    out: Record<string, unknown> = {};
  for (const key of [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "input_tokens",
    "output_tokens",
    "cached_tokens",
    "reasoning_tokens",
    "thinking_tokens",
  ]) {
    const n = source[key];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[key] = n;
  }
  const rate = cacheHitRate(
    source.cache_hit_rate ?? source.cacheHitRate ?? source.cache_hit_ratio,
  );
  if (rate !== undefined) out.cache_hit_rate = rate;
  if (typeof source.output_tokens_includes_reasoning === "boolean")
    out.output_tokens_includes_reasoning =
      source.output_tokens_includes_reasoning;
  for (const key of [
    "prompt_tokens_details",
    "completion_tokens_details",
    "input_tokens_details",
    "output_tokens_details",
  ]) {
    const details = source[key];
    if (details && typeof details === "object") {
      const clean: Record<string, number> = {};
      for (const [name, n] of Object.entries(details))
        if (
          [
            "cached_tokens",
            "reasoning_tokens",
            "audio_tokens",
            "accepted_prediction_tokens",
            "rejected_prediction_tokens",
          ].includes(name) &&
          typeof n === "number" &&
          Number.isFinite(n) &&
          n >= 0
        )
          clean[name] = n;
      if (Object.keys(clean).length) out[key] = clean;
    }
  }
  return Object.keys(out).length ? out : undefined;
}
/** Usage often arrives in multiple SSE frames; later partial frames must not erase earlier cache data. */
export function mergeUsage(previous: unknown, next: unknown) {
  const a = sanitizeUsage(previous),
    b = sanitizeUsage(next);
  if (!a) return b;
  if (!b) return a;
  const merged = { ...a, ...b };
  for (const key of [
    "prompt_tokens_details",
    "completion_tokens_details",
    "input_tokens_details",
    "output_tokens_details",
  ])
    if (a[key] || b[key])
      merged[key] = {
        ...((a[key] as object) ?? {}),
        ...((b[key] as object) ?? {}),
      };
  return merged;
}
