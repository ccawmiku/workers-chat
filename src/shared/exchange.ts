import { type Chat, type Message, newChat, route } from "./chat";
type Obj = Record<string, unknown>;
const object = (value: unknown): Obj =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Obj)
    : {};
const string = (value: unknown, fallback = "") =>
  typeof value === "string" ? value : fallback;
function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .filter((v) => object(v).type === "text")
      .map((v) => string(object(v).text))
      .join("\n");
  return "";
}
function stripAttachments(input: unknown, counter: { n: number }): unknown {
  if (Array.isArray(input))
    return input.map((v) => stripAttachments(v, counter));
  if (!input || typeof input !== "object") return input;
  const clean: Obj = Object.create(null);
  for (const [key, value] of Object.entries(input)) {
    if (["files", "attachments", "images"].includes(key)) {
      if (Array.isArray(value)) counter.n += value.length;
      continue;
    }
    if (["image_url", "file_url", "file_id"].includes(key)) {
      counter.n++;
      continue;
    }
    clean[key] = stripAttachments(value, counter);
  }
  return clean;
}
export function importChats(input: unknown): {
  chats: Chat[];
  failures: { index: number; reason: string }[];
  attachments: number;
  branches: number;
} {
  const rows = Array.isArray(input) ? input : [input],
    chats: Chat[] = [],
    failures: { index: number; reason: string }[] = [];
  let attachments = 0,
    branches = 0;
  rows.forEach((original, index) => {
    try {
      const rawRoot = object(original),
        rawChat = object(rawRoot.chat ?? original);
      if (!Object.keys(rawChat).length)
        throw new Error("不是 OpenWebUI 聊天对象");
      const counter = { n: 0 };
      const root = object(stripAttachments(original, counter)),
        source = object(root.chat ?? root);
      const history = object(source.history),
        stored = object(history.messages);
      const list = Object.keys(stored).length
        ? Object.values(stored)
        : source.messages;
      if (!Array.isArray(list))
        throw new Error("缺少 history.messages 或 messages");
      const chat = newChat();
      chat.raw = root;
      chat.title = string(source.title, "导入的聊天");
      chat.titleManual = true;
      const at = Number(source.timestamp ?? rawRoot.created_at);
      if (Number.isFinite(at) && at > 0)
        chat.createdAt = at < 1e12 ? at * 1000 : at;
      let previous: string | null = null;
      for (const item of list) {
        const m = object(item),
          id = string(m.id);
        if (
          !id ||
          id.length > 500 ||
          ["__proto__", "constructor", "prototype"].includes(id) ||
          Object.hasOwn(chat.messages, id)
        )
          throw new Error("消息 ID 缺失或重复");
        const role = string(m.role);
        if (!["user", "assistant", "system"].includes(role))
          throw new Error("消息角色无效");
        const stamp = Number(m.timestamp);
        const parent = Object.hasOwn(m, "parentId") ? m.parentId : previous;
        if (parent !== null && typeof parent !== "string")
          throw new Error("父节点 ID 无效");
        const msg: Message = {
          id,
          parentId: parent,
          role: role as Message["role"],
          content: textContent(m.content),
          createdAt:
            Number.isFinite(stamp) && stamp > 0
              ? stamp < 1e12
                ? stamp * 1000
                : stamp
              : chat.createdAt,
          raw: m,
          reasoning: string(m.reasoning_content ?? m.reasoning),
          status: m.done === false ? "error" : "complete",
        };
        // Keep original model metadata in raw without guessing a provider identity.
        if (m.usage && typeof m.usage === "object") msg.usage = object(m.usage);
        chat.messages[id] = msg;
        previous = id;
      }
      for (const msg of Object.values(chat.messages)) route(chat, msg.id);
      chat.currentId =
        typeof history.currentId === "string" ? history.currentId : previous;
      route(chat);
      for (const msg of Object.values(chat.messages))
        if (msg.parentId) {
          const declared = object(stored[msg.parentId]).childrenIds;
          if (Array.isArray(declared) && !declared.includes(msg.id))
            throw new Error("父子关系不一致");
        }
      branches += Object.values(chat.messages).reduce(
        (n, m) =>
          n +
          (Object.values(chat.messages).filter((c) => c.parentId === m.id)
            .length > 1
            ? 1
            : 0),
        0,
      );
      attachments += counter.n;
      chats.push(chat);
    } catch (e) {
      failures.push({
        index: index + 1,
        reason: e instanceof Error ? e.message : "格式无效",
      });
    }
  });
  return { chats, failures, attachments, branches };
}
export function exportChat(chat: Chat): Obj {
  const root = structuredClone(chat.raw ?? {}),
    original = object(root.chat ?? root);
  const messages: Obj = {};
  const children = new Map<string, string[]>();
  for (const m of Object.values(chat.messages))
    if (m.parentId)
      children.set(m.parentId, [...(children.get(m.parentId) ?? []), m.id]);
  for (const m of Object.values(chat.messages))
    messages[m.id] = {
      ...m.raw,
      id: m.id,
      parentId: m.parentId,
      childrenIds: children.get(m.id) ?? [],
      role: m.role,
      content: m.content,
      timestamp: m.createdAt / 1000,
      done: m.status !== "running",
      ...(m.reasoning ? { reasoning_content: m.reasoning } : {}),
      ...(m.model ? { model: m.model.modelId } : {}),
      ...(m.usage ? { usage: m.usage } : {}),
    };
  const output = {
    ...original,
    title: chat.title,
    timestamp: chat.createdAt / 1000,
    history: {
      ...object(original.history),
      messages,
      currentId: chat.currentId,
    },
    messages: route(chat).map((m) => messages[m.id]),
    models: chat.model ? [chat.model.modelId] : (original.models ?? []),
  };
  return Object.hasOwn(root, "chat")
    ? { ...root, id: chat.id, chat: output }
    : { id: chat.id, ...output };
}
