import { describe, it, expect } from "vitest";
import {
  newChat,
  addMessage,
  editMessage,
  route,
  selectBranch,
  forkChat,
  deleteSubtree,
  requestPreview,
  defaultSettings,
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
    expect(fork.title).toBe("原聊天 · 分支A");
    expect(route(fork).map((m) => m.content)).toEqual(["问题", "回答"]);
    expect(fork.draft).toBe("");
    expect(fork.groupId).toBe("group");
    expect(fork.messages[u.id]).toBeUndefined();
    const fork2 = forkChat(fork, fork.currentId!, [fork.title]);
    expect(fork2.title).toBe("原聊天 · 分支B");
    expect(deleteSubtree(chat, a.id)).toBe(2);
    expect(route(chat).map((m) => m.id)).toEqual([u.id]);
    expect(Object.keys(fork.messages)).toHaveLength(2);
  });
  it("keeps same model IDs distinct across providers and sends raw IDs even when disabled", () => {
    const chat = newChat({ providerId: "two", modelId: "same-model" });
    const u = addMessage(chat, "user", "hi"),
      a = addMessage(chat, "assistant", "body");
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
    expect(result.request.reasoning_effort).toBe("max");
    expect(result.request).toMatchObject({ temperature: 1, top_p: 0.9 });
    expect(result.request.messages).toEqual([
      { role: "user", content: u.content },
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
});
