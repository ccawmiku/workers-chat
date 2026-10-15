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
  reasoning?: string;
  createdAt: number;
  excluded?: boolean;
  status?: "complete" | "running" | "stopped" | "error";
  model?: ModelRef;
  usage?: Record<string, unknown>;
  elapsedMs?: number;
  error?: string;
  raw?: Record<string, unknown>;
};
export type Chat = {
  id: string;
  title: string;
  titleManual: boolean;
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
  titleScope: "branch" | "first";
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
  titlePrompt: "为以下对话生成一个简短中文标题，只返回标题。",
  titleModel: null,
});
export const uuid = () => crypto.randomUUID();
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
    effort: "max",
    parameters: {},
    stream: true,
    system: [],
    includeStopped: true,
    templateMode: "replace",
    titleScope: "branch",
  };
}
export function route(chat: Chat, currentId = chat.currentId): Message[] {
  const result: Message[] = [],
    seen = new Set<string>();
  while (currentId) {
    if (seen.has(currentId)) throw new Error("消息树包含循环");
    seen.add(currentId);
    const msg: Message | undefined = chat.messages[currentId];
    if (!msg) throw new Error("消息树引用不存在的父节点");
    result.push(msg);
    currentId = msg.parentId;
  }
  return result.reverse();
}
export function children(chat: Chat, parentId: string | null) {
  return Object.values(chat.messages)
    .filter((m) => m.parentId === parentId)
    .sort((a, b) => a.createdAt - b.createdAt);
}
export function selectBranch(chat: Chat, id: string) {
  if (!chat.messages[id]) throw new Error("消息不存在");
  const seen = new Set<string>();
  while (!seen.has(id)) {
    seen.add(id);
    const next = children(chat, id).at(-1);
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
  if (parentId && !chat.messages[parentId]) throw new Error("父消息不存在");
  const msg: Message = {
    id: uuid(),
    role,
    content,
    parentId,
    createdAt: Date.now(),
    status: "complete",
  };
  chat.messages[msg.id] = msg;
  chat.currentId = msg.id;
  chat.updatedAt = Date.now();
  return msg;
}
export function editMessage(chat: Chat, id: string, content: string): Message {
  const msg = chat.messages[id];
  if (!msg) throw new Error("消息不存在");
  if (msg.role === "assistant") {
    msg.content = content;
    return msg;
  }
  return addMessage(chat, msg.role, content, msg.parentId);
}
export function descendants(chat: Chat, id: string): string[] {
  if (!chat.messages[id]) throw new Error("消息不存在");
  const byParent = new Map<string, string[]>();
  for (const msg of Object.values(chat.messages))
    if (msg.parentId)
      byParent.set(msg.parentId, [
        ...(byParent.get(msg.parentId) ?? []),
        msg.id,
      ]);
  const ids: string[] = [],
    pending = [id],
    seen = new Set<string>();
  while (pending.length) {
    const next = pending.pop()!;
    if (seen.has(next)) throw new Error("消息树包含循环");
    seen.add(next);
    ids.push(next);
    pending.push(...(byParent.get(next) ?? []));
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
export function forkChat(chat: Chat, id: string, titles: string[]): Chat {
  const copy = structuredClone(chat),
    base = chat.title.replace(/ · 分支[A-Z]+$/u, "");
  let n = 0,
    title: string;
  do {
    let x = ++n,
      suffix = "";
    while (x) {
      x--;
      suffix = String.fromCharCode(65 + (x % 26)) + suffix;
      x = Math.floor(x / 26);
    }
    title = `${base} · 分支${suffix}`;
  } while (titles.includes(title));
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
export function contextMessages(chat: Chat, draft?: string) {
  let path = route(chat).filter(
    (m) => !m.excluded && (chat.includeStopped || m.status !== "stopped"),
  );
  if (chat.rounds && chat.rounds > 0) {
    let rounds = 0,
      index = path.length;
    while (index > 0) {
      index--;
      if (path[index]!.role === "user" && ++rounds === chat.rounds) break;
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
