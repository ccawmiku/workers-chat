import { describe, it, expect } from "vitest";
import {
  newChat,
  sanitizeUsage,
  addMessage,
  editMessage,
  route,
  selectBranch,
  forkChat,
  deleteSubtree,
  deleteMessage,
  validateMessageTree,
  requestPreview,
  defaultSettings,
  contextMessages,
  type Provider,
} from "../src/shared/chat";
import { importChats, exportChat } from "../src/shared/exchange";
import { chunks } from "../src/server/store";
const provider = (id: string): Provider => ({
  id,
  name: id,
  baseUrl: "https://api.example.com/v1",
  prefix: id + "/",
  models: [
    {
      id: "same-model",
      enabled: false,
      capacity: 1048576,
      parameters: { temperature: 0.7 },
    },
  ],
});
describe("message tree", () => {
  it("splices a message and all direct children while preserving grandchildren and sibling branches", () => {
    const chat = newChat(),
      u1 = addMessage(chat, "user", "u1"),
      a1 = addMessage(chat, "assistant", "a1"),
      u2 = addMessage(chat, "user", "u2"),
      a2 = addMessage(chat, "assistant", "a2"),
      alternate = addMessage(chat, "assistant", "alternate", u1.id),
      u3 = addMessage(chat, "user", "u3"),
      a3 = addMessage(chat, "assistant", "a3");
    expect(new Set(deleteMessage(chat, u1.id))).toEqual(
      new Set([u1.id, a1.id, alternate.id]),
    );
    expect(chat.messages[u2.id]!.parentId).toBeNull();
    expect(chat.messages[u3.id]!.parentId).toBeNull();
    expect(chat.messages[a2.id]!.parentId).toBe(u2.id);
    expect(chat.currentId).toBe(a3.id);
    validateMessageTree(chat);
    expect(deleteMessage(chat, a3.id)).toEqual([a3.id]);
    expect(chat.currentId).toBe(u3.id);
    expect(deleteMessage(chat, u3.id)).toEqual([u3.id]);
    expect(chat.currentId).toBe(a2.id);
    expect(deleteMessage(chat, u2.id)).toEqual([u2.id, a2.id]);
    expect(chat.currentId).toBeNull();
    expect(chat.messages).toEqual({});
    expect(() => deleteMessage(chat, "constructor")).toThrow("消息不存在");
  });
  it("removes an assistant and the next user, then reconnects the later reply", () => {
    const chat = newChat(),
      u = addMessage(chat, "user", "first"),
      a = addMessage(chat, "assistant", "answer"),
      next = addMessage(chat, "user", "next"),
      reply = addMessage(chat, "assistant", "later"),
      tail = addMessage(chat, "user", "tail");
    expect(deleteMessage(chat, a.id)).toEqual([a.id, next.id]);
    expect(chat.messages[reply.id]!.parentId).toBe(u.id);
    expect(chat.currentId).toBe(tail.id);
    validateMessageTree(chat);
    expect(route(chat).map((m) => m.content)).toEqual([
      "first",
      "later",
      "tail",
    ]);
  });
  it("includes selected history and stopped partial replies despite legacy exclusion options", () => {
    const chat = newChat();
    addMessage(chat, "user", "question").excluded = true;
    const answer = addMessage(chat, "assistant", "partial");
    answer.status = "stopped";
    answer.excluded = true;
    answer.reasoning = "private";
    chat.includeStopped = false;
    addMessage(chat, "user", "next");
    expect(contextMessages(chat)).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "partial" },
      { role: "user", content: "next" },
    ]);
    chat.rounds = 1;
    expect(contextMessages(chat)).toEqual([{ role: "user", content: "next" }]);
  });
  it("rejects inherited properties and empty parent references as message IDs", () => {
    for (const id of ["__proto__", "constructor", "toString", ""]) {
      const chat = newChat();
      expect(() => addMessage(chat, "user", "invalid", id)).toThrow(
        "父消息不存在",
      );
      expect(() => selectBranch(chat, id)).toThrow("消息不存在");
      expect(() => editMessage(chat, id, "invalid")).toThrow("消息不存在");
      expect(() => route(chat, id)).toThrow("消息树引用不存在的父节点");
      const imported = importChats({
        history: {
          messages: {
            u: { id: "u", role: "user", parentId: id, content: "invalid" },
          },
        },
      });
      expect(imported.chats).toHaveLength(0);
      expect(imported.failures[0]?.reason).toBe("消息树引用不存在的父节点");
    }
  });
  it("keeps user edits as sibling routes and overwrites assistant edits without losing descendants", () => {
    const chat = newChat(),
      user = addMessage(chat, "user", "original"),
      ai = addMessage(chat, "assistant", "answer"),
      followup = addMessage(chat, "user", "followup");
    const edit = editMessage(chat, user.id, "edited");
    expect(edit.id).not.toBe(user.id);
    expect(route(chat).map((m) => m.content)).toEqual(["edited"]);
    editMessage(chat, ai.id, "corrected");
    selectBranch(chat, user.id);
    expect(route(chat).map((m) => m.id)).toEqual([user.id, ai.id, followup.id]);
    expect(chat.messages[ai.id]?.content).toBe("corrected");
  });
  it("forks only ancestors, with independent IDs, no draft and stable fork suffixes", () => {
    const chat = newChat();
    chat.title = "原聊天";
    chat.draft = "private draft";
    chat.groupId = "group";
    const u = addMessage(chat, "user", "问题"),
      a = addMessage(chat, "assistant", "回答");
    addMessage(chat, "user", "more");
    const fork = forkChat(chat, a.id, []);
    expect(fork.title).toBe("原聊天 · 分支01");
    expect(route(fork).map((m) => m.content)).toEqual(["问题", "回答"]);
    expect(fork.draft).toBe("");
    expect(fork.groupId).toBe("group");
    expect(fork.messages[u.id]).toBeUndefined();
    const fork2 = forkChat(fork, fork.currentId!, [fork.title]);
    expect(fork2.title).toBe("原聊天 · 分支02");
    const titles = Array.from({ length: 99 }, (_, i) => `原聊天 · 分支${String(i + 1).padStart(2, "0")}`);
    expect(forkChat(fork2, fork2.currentId!, titles).title).toBe("原聊天 · 分支100");
    chat.title = "原聊天 · 分支A";
    expect(forkChat(chat, a.id, []).title).toBe("原聊天 · 分支01");
    expect(deleteSubtree(chat, a.id)).toBe(2);
    expect(route(chat).map((m) => m.id)).toEqual([u.id]);
    expect(Object.keys(fork.messages)).toHaveLength(2);
  });
  it("keeps same model IDs distinct across providers and sends raw IDs even when disabled", () => {
    const chat = newChat({ providerId: "two", modelId: "same-model" });
    addMessage(chat, "user", "hi");
    const a = addMessage(chat, "assistant", "body");
    a.reasoning = "do not resend";
    a.excluded = true;
    const settings = defaultSettings();
    settings.parameters = { top_p: 0.9 };
    chat.parameters = { temperature: 1 };
    const result = requestPreview(chat, settings, [
      provider("one"),
      provider("two"),
    ]);
    expect(result.provider.id).toBe("two");
    expect(result.request.model).toBe("same-model");
    expect(result.request).not.toHaveProperty("reasoning_effort");
    expect(result.request).toMatchObject({ temperature: 1, top_p: 0.9 });
    expect(result.request.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "body" },
    ]);
    chat.effort = "inherit";
    expect(
      requestPreview(chat, settings, [provider("two")]).request,
    ).not.toHaveProperty("reasoning_effort");
    chat.effort = "none";
    expect(
      requestPreview(chat, settings, [provider("two")]).request
        .reasoning_effort,
    ).toBe("none");
    chat.model = { providerId: "missing", modelId: "same-model" };
    expect(() => requestPreview(chat, settings, [provider("two")])).toThrow(
      "默认模型",
    );
  });
  it("retains a million emoji across chunk boundaries without splitting UTF-16 surrogate pairs", () => {
    const text = "a" + "🙂中文".repeat(350000),
      parts = chunks(text);
    expect(parts.join("")).toBe(text);
    expect(parts.every((p) => !/[\ud800-\udbff]$/.test(p))).toBe(true);
    expect(
      parts.every((p) => new TextEncoder().encode(p).length < 2000000),
    ).toBe(true);
  });
  it("counts the pending user message in the same round budget as the actual send", () => {
    for (const rounds of [1, 2]) {
      const chat = newChat({ providerId: "one", modelId: "same-model" });
      addMessage(chat, "user", "first");
      addMessage(chat, "assistant", "first answer");
      addMessage(chat, "user", "second");
      addMessage(chat, "assistant", "second answer");
      chat.rounds = rounds;
      const preview = requestPreview(
        chat,
        defaultSettings(),
        [provider("one")],
        "next question",
      ).request.messages;
      addMessage(chat, "user", "next question");
      const actual = requestPreview(chat, defaultSettings(), [provider("one")])
        .request.messages;
      expect(preview).toEqual(actual);
      expect(preview.filter((m) => m.role === "user")).toHaveLength(rounds);
    }
  });
});
describe("OpenWebUI v0.12.2 exchange", () => {
  const fixture = {
    id: "source",
    chat: {
      title: "多分支",
      models: ["same-model"],
      timestamp: 1760000000,
      history: {
        currentId: "b",
        messages: {
          u: {
            id: "u",
            role: "user",
            parentId: null,
            childrenIds: ["a", "b"],
            content: [
              { type: "text", text: "文字保留" },
              {
                type: "image_url",
                image_url: { url: "https://image.example/x" },
              },
            ],
            timestamp: 1760000001,
            files: [{ id: "attachment" }],
          },
          a: {
            id: "a",
            role: "assistant",
            parentId: "u",
            childrenIds: [],
            content: "旧回答",
            reasoning_content: "思考",
            model: "same-model",
            timestamp: 1760000002,
            custom: { retain: true },
          },
          b: {
            id: "b",
            role: "assistant",
            parentId: "u",
            childrenIds: [],
            content: "新回答",
            timestamp: 1760000003,
            usage: { total_tokens: 10 },
          },
        },
      },
      params: { temperature: 0.4 },
    },
  };
  it("round-trips the complete tree, selected route, timestamps and unknown text metadata", () => {
    const first = importChats([fixture]);
    expect(first.failures).toEqual([]);
    expect(first.branches).toBe(1);
    expect(first.attachments).toBe(2);
    const chat = first.chats[0]!;
    expect(route(chat).map((m) => m.content)).toEqual(["文字保留", "新回答"]);
    expect(chat.messages.a?.reasoning).toBe("思考");
    expect(chat.messages.a?.createdAt).toBe(1760000002000);
    editMessage(chat, "b", "修改后");
    const exported = exportChat(chat);
    expect(JSON.stringify(exported)).not.toMatch(
      /attachment|image_url|https:\/\/image/,
    );
    const second = importChats(exported).chats[0]!;
    expect(Object.keys(second.messages)).toEqual(["u", "a", "b"]);
    expect(second.currentId).toBe("b");
    expect(second.messages.b?.content).toBe("修改后");
    expect(second.messages.a?.raw?.custom).toEqual({ retain: true });
    expect(second.messages.b?.usage).toEqual({ total_tokens: 10 });
  });
  it("creates independent chat IDs on repeated import and isolates invalid entries", () => {
    const result = importChats([
      fixture,
      {
        chat: {
          history: {
            messages: {
              bad: {
                id: "bad",
                role: "user",
                parentId: "missing",
                content: "bad",
              },
            },
          },
        },
      },
      fixture,
    ]);
    expect(result.chats).toHaveLength(2);
    expect(result.chats[0]!.id).not.toBe(result.chats[1]!.id);
    expect(result.failures).toEqual([
      { index: 2, reason: "消息树引用不存在的父节点" },
    ]);
  });
  it("rejects cycles without hanging", () => {
    const x = structuredClone(fixture);
    x.chat.history.messages.u.parentId = "b" as never;
    expect(importChats(x).failures[0]?.reason).toBe("消息树包含循环");
  });
  it("counts repeated attachment references once and stores a single copy of imported messages", () => {
    const data = structuredClone(fixture) as typeof fixture & {
      chat: { messages?: unknown[] };
    };
    data.chat.messages = Object.values(data.chat.history.messages);
    const result = importChats(data),
      chat = result.chats[0]!;
    expect(result.attachments).toBe(2);
    expect(JSON.stringify(chat.raw)).not.toContain("旧回答");
    expect(chat.messages.a!.raw).not.toHaveProperty("content");
    expect(importChats(exportChat(chat)).chats[0]!.messages.a!.content).toBe(
      "旧回答",
    );
  });
  it("validates, switches, forks and exports a deep tree without recursive traversal", () => {
    const messages = Object.fromEntries(
      Array.from({ length: 10000 }, (_, i) => [
        String(i),
        {
          id: String(i),
          role: i % 2 ? "assistant" : "user",
          parentId: i ? String(i - 1) : null,
          content: "节点" + i,
          timestamp: 1760000000 + i,
        },
      ]),
    );
    const result = importChats({ history: { messages, currentId: "9999" } });
    expect(result.failures).toEqual([]);
    const chat = result.chats[0]!;
    selectBranch(chat, "0");
    expect(route(chat)).toHaveLength(10000);
    const fork = forkChat(chat, "2", []);
    expect(Object.values(fork.messages).map((m) => m.content)).toEqual([
      "节点0",
      "节点1",
      "节点2",
    ]);
    const exported = exportChat(chat);
    expect(importChats(exported).chats[0]!.messages["9999"]!.parentId).toBe(
      "9998",
    );
    expect(deleteSubtree(chat, "1")).toBe(9999);
  });
});

it("keeps explicit cache hit rates and top-level cache counts without inventing rates", () => {
  expect(
    sanitizeUsage({
      input_tokens: 5982,
      cached_tokens: 4908,
      cache_hit_rate: "82.0%",
      _session_thinking_id: "private",
    }),
  ).toEqual({
    input_tokens: 5982,
    cached_tokens: 4908,
    cache_hit_rate: "82.0%",
  });
  expect(sanitizeUsage({ cache_hit_rate: "0%" })).toEqual({
    cache_hit_rate: "0%",
  });
  expect(sanitizeUsage({ cache_hit_rate: 0.82 })).toEqual({
    cache_hit_rate: "82%",
  });
  for (const rate of [22, "22", "22%", 0.22, "0.22"])
    expect(sanitizeUsage({ cache_hit_rate: rate })).toEqual({
      cache_hit_rate: "22%",
    });
  for (const rate of [null, "", "unknown", "101%", "-1%", {}, Infinity])
    expect(sanitizeUsage({ cache_hit_rate: rate })).toBeUndefined();
  expect(sanitizeUsage({ input_tokens: 10, cached_tokens: 8 })).toEqual({
    input_tokens: 10,
    cached_tokens: 8,
  });
});

describe("compact token counts", () => {
  it("shows integers below 1k and one decimal k from 1k", async () => {
    const { formatTokenCount } = await import("../src/shared/chat");
    expect([0, 424, 999, 1000, 18929, 34700].map(formatTokenCount)).toEqual([
      "0",
      "424",
      "999",
      "1.0k",
      "18.9k",
      "34.7k",
    ]);
  });
});
