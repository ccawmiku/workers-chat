import { describe, it, expect } from "vitest";
import {
  newChat,
  addMessage,
  defaultSettings,
  contextMessages,
  type Provider,
} from "../src/shared/chat";
import {
  pluginDefaults,
  preparePlugin,
  emptyPluginState,
  injectPlugins,
  normalizePluginOutput,
  shortenUser,
  type PluginRun,
} from "../src/shared/plugins";
const provider: Provider = {
  id: "p",
  name: "Test",
  prefix: "T/",
  baseUrl: "https://fixture.test/v1",
  models: [
    {
      id: "model",
      enabled: true,
      capacity: 32000,
      parameters: { temperature: 0.4 },
    },
  ],
};
const fixture = () => {
  const chat = newChat();
  chat.model = { providerId: "p", modelId: "model" };
  chat.system = [{ id: "sys", name: "test", content: "Stable system" }];
  return { chat, settings: defaultSettings(), state: emptyPluginState() };
};
const run = (
  anchorId: string,
  kind: "analysis" | "clarify",
  id: string,
  input: string,
  output: string,
  answer?: string,
): PluginRun => ({
  id,
  anchorId,
  plugin: pluginDefaults(kind),
  input,
  output,
  answer,
  status: answer === undefined ? "complete" : "answered",
  createdAt: 1,
  metrics: {
    total: 1,
    capacity: 32000,
    archive: 0,
    originalArchive: 0,
    highWater: 0,
    lowWater: 0,
    trimmed: 0,
    shortened: 0,
    sections: [],
  },
});
describe("plugin context assembly", () => {
  it("keeps the final historical reply for an empty preview and counts only complete recent pairs", () => {
    const { chat, settings, state } = fixture();
    for (let i = 0; i < 2; i++) {
      addMessage(chat, "user", "U" + i);
      addMessage(chat, "assistant", "A" + i);
    }
    const expected = contextMessages(chat, " ").slice(0, -1);
    const preview = preparePlugin(
      chat,
      pluginDefaults("analysis"),
      settings,
      [provider],
      state,
      "",
    );
    expect(preview.request.messages.slice(0, -1)).toEqual(expected);
    addMessage(chat, "user", "未完成的历史问题");
    const p = pluginDefaults("rewrite");
    p.historyRounds = 2;
    const actual = preparePlugin(
      chat,
      p,
      settings,
      [provider],
      state,
      "新草稿",
    );
    expect(
      actual.request.messages.filter((m) => m.role === "assistant"),
    ).toHaveLength(2);
    expect(
      actual.request.messages.filter((m) => m.content === "未完成的历史问题"),
    ).toHaveLength(1);
    expect(actual.request.messages.at(-1)?.content).toBe("新草稿");
  });
  it("keeps the main prefix byte-for-byte and changes only the final user", () => {
    const { chat, settings, state } = fixture();
    addMessage(chat, "user", "old");
    addMessage(chat, "assistant", "reply");
    const anchor = chat.currentId,
      p = pluginDefaults("analysis");
    const actual = preparePlugin(
      chat,
      p,
      settings,
      [provider],
      state,
      "new",
      anchor,
    );
    expect(actual.request.messages.slice(0, -1)).toEqual(contextMessages(chat));
    expect(actual.request.messages.at(-1)?.content).toContain("new");
    expect(chat.messages[anchor!]?.content).toBe("reply");
    expect(actual.request.temperature).toBe(0.4);
    expect(actual.request.reasoning_effort).toBe("max");
  });
  it("selects complete recent rounds and keeps the paired old prompt after config edits", () => {
    const { chat, settings, state } = fixture();
    for (let i = 0; i < 4; i++) {
      const u = addMessage(chat, "user", "U" + i);
      addMessage(chat, "assistant", "A" + i);
      state.runs.push(
        run(u.id, "analysis", "r" + i, "U" + i, JSON.stringify({ v: i })),
      );
    }
    const p = pluginDefaults("analysis");
    p.prompt = "NEW {{USER_INPUT}}";
    p.contextMode = "rounds";
    p.historyRounds = 2;
    p.example = '{"v":"example"}';
    const result = preparePlugin(chat, p, settings, [provider], state, "next")
      .request.messages;
    expect(result.slice(0, -1).map((m) => m.content)).toEqual([
      "Stable system",
      "U2",
      "A2",
      "U3",
      "A3",
    ]);
    const suffix = result.at(-1)?.content;
    expect(suffix).toContain(
      state.runs[3]!.plugin.prompt.replaceAll("\n", "\\n"),
    );
    expect(suffix).toContain("example");
    expect(suffix).not.toContain('"v":2');
  });
  it("uses no first-turn reference when no example is supplied", () => {
    const { chat, settings, state } = fixture();
    const result = preparePlugin(
      chat,
      pluginDefaults("analysis"),
      settings,
      [provider],
      state,
      "new",
    );
    expect(result.metrics.archive).toBe(0);
    expect(result.request.messages.at(-1)?.content).not.toContain(
      "历史完整参考",
    );
  });
  it("trims complete question-answer groups and never leaks another branch or plugin", () => {
    const { chat, settings, state } = fixture();
    for (let i = 0; i < 8; i++) {
      const u = addMessage(chat, "user", "U" + i);
      addMessage(chat, "assistant", "A" + i);
      state.runs.push(
        run(
          u.id,
          "clarify",
          "r" + i,
          "U" + i,
          "question" + i,
          "ANSWER" + i + "中".repeat(60),
        ),
      );
    }
    state.runs.push(
      run(
        "other-branch",
        "clarify",
        "foreign",
        "PRIVATE",
        "PRIVATE",
        "PRIVATE",
      ),
    );
    const p = pluginDefaults("clarify");
    p.highWater = 1000;
    p.lowWater = 500;
    const result = preparePlugin(chat, p, settings, [provider], state, "next");
    expect(result.metrics.trimmed).toBeGreaterThan(0);
    expect(result.metrics.archive).toBeLessThanOrEqual(500);
    const suffix = result.request.messages.at(-1)?.content ?? "";
    expect(suffix).not.toContain("PRIVATE");
    expect(suffix).toContain("ANSWER7");
    expect(suffix).not.toContain("ANSWER0");
  });
  it("separates the user archive, complete recent pairs, and the full rewrite draft", () => {
    const { chat, settings, state } = fixture();
    for (let i = 0; i < 9; i++) {
      addMessage(
        chat,
        "user",
        i === 8
          ? "首".repeat(600) + "中".repeat(8000) + "尾".repeat(600)
          : "U" + i,
      );
      addMessage(chat, "assistant", "A" + i);
    }
    const p = pluginDefaults("rewrite");
    p.historyRounds = 5;
    const draft = "原".repeat(10000),
      result = preparePlugin(chat, p, settings, [provider], state, draft);
    expect(result.request.messages.at(-1)).toEqual({
      role: "user",
      content: draft,
    });
    expect(result.metrics.shortened).toBe(1);
    for (let i = 0; i < 8; i++)
      expect(
        result.request.messages.filter((m) => m.content === "U" + i),
      ).toHaveLength(1);
    expect(
      result.request.messages.filter((m) => m.role === "assistant"),
    ).toHaveLength(5);
    expect(
      result.request.messages.find((m) => m.content?.includes("中间删减了"))
        ?.content?.length,
    ).toBeLessThan(1100);
  });
  it("trims only the old user archive to the low watermark", () => {
    const { chat, settings, state } = fixture();
    for (let i = 0; i < 20; i++) {
      addMessage(chat, "user", "user" + i + "中".repeat(300));
      addMessage(chat, "assistant", "assistant" + i);
    }
    const p = pluginDefaults("suggest");
    p.highWater = 2000;
    p.lowWater = 700;
    const result = preparePlugin(chat, p, settings, [provider], state, "");
    expect(result.metrics.archive).toBeLessThanOrEqual(700);
    expect(result.metrics.trimmed).toBeGreaterThan(0);
    expect(
      result.request.messages.filter((m) => m.role === "assistant"),
    ).toHaveLength(5);
    expect(result.request.messages.at(-1)?.content).toBe("assistant19");
  });
  it("shortens Unicode characters without breaking surrogate pairs", () => {
    const text = "🙂".repeat(2001),
      short = shortenUser(text);
    expect(Array.from(short.split("\n")[0]!)).toHaveLength(500);
    expect(Array.from(short.split("\n").at(-1)!)).toHaveLength(500);
    expect(shortenUser("x".repeat(2000))).toHaveLength(2000);
  });
  it("injects native tool pairs or user suffix without mutating stored messages", () => {
    const source = [{ role: "user" as const, content: "original" }],
      item = {
        pluginId: "builtin-analysis",
        runId: "run",
        name: "Analysis",
        mode: "tool" as const,
        template: "{{RESULT}}",
        content: '{"goals":[]}',
      };
    const result = injectPlugins(source, [item]);
    expect(result.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(result[1]?.tool_calls?.[0]?.id).toBe(result[2]?.tool_call_id);
    expect(source).toEqual([{ role: "user", content: "original" }]);
    expect(injectPlugins(source, [{ ...item, mode: "user" }])).toEqual([
      { role: "user", content: 'original\n\n{"goals":[]}' },
    ]);
  });
  it("validates custom JSON Schema and exact distinct candidate counts", () => {
    const p = pluginDefaults("analysis");
    p.schema =
      '{"type":"object","properties":{"ABC":{"type":"integer"}},"required":["ABC"],"additionalProperties":false}';
    expect(
      JSON.parse(normalizePluginOutput(p, '```json\n{"ABC":3}\n```')),
    ).toEqual({ ABC: 3 });
    expect(() => normalizePluginOutput(p, '{"ABC":"bad"}')).toThrow("结构");
    expect(() =>
      normalizePluginOutput(
        pluginDefaults("suggest"),
        '{"suggestions":["A","A","B"]}',
      ),
    ).toThrow();
  });
  it("does not silently use another provider with a same-name model", () => {
    const { chat, settings, state } = fixture();
    const p = pluginDefaults("analysis");
    p.model = { providerId: "missing", modelId: "model" };
    expect(() =>
      preparePlugin(chat, p, settings, [provider], state, "new"),
    ).toThrow("模型不存在");
  });
});
