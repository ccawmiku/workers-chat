import { replyFallback as candidateReplyExcerpt } from "../src/shared/reply-context";
import { describe, it, expect } from "vitest";
import {
  candidateTask,
  swappedHistory,
} from "../src/shared/candidate-requests";
import {
  newChat,
  addMessage,
  defaultSettings,
  type Provider,
} from "../src/shared/chat";
import {
  pluginDefaults,
  preparePlugin,
  emptyPluginState,
  normalizePluginOutput,
  upgradeLegacyPlugin,
  extractRewritePrompt,
  extractRewriteCandidates,
  definitions,
  enabledPlugins,
} from "../src/shared/plugins";
import {
  ANALYSIS_PROMPT,
  ANALYSIS_SCHEMA,
  LEGACY_ANALYSIS_PROMPT,
  LEGACY_ANALYSIS_SCHEMA,
} from "../src/shared/analysis-defaults";
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

describe("plugin context assembly", () => {
  it("retains all built-ins while custom instances remain removable", () => {
    const s = defaultSettings();
    s.plugins = [];
    expect(definitions(s).map((p) => p.id)).toEqual([
      "builtin-clarify",
      "builtin-analysis",
      "builtin-suggest",
      "builtin-rewrite",
    ]);
  });
  it("uses fixed clarification-before-analysis order even for previously reordered bindings", () => {
    const { chat, settings } = fixture();
    chat.plugins = ["rewrite", "analysis", "suggest", "clarify"].map(
      (kind) => ({ id: "builtin-" + kind, enabled: true }),
    );
    expect(enabledPlugins(chat, settings).map((p) => p.kind)).toEqual([
      "clarify",
      "analysis",
      "suggest",
      "rewrite",
    ]);
  });
  it("upgrades the old default analysis pair while preserving customized prompts and schemas", () => {
    const old = {
      ...pluginDefaults("analysis"),
      prompt: LEGACY_ANALYSIS_PROMPT,
      schema: LEGACY_ANALYSIS_SCHEMA,
    };
    expect(upgradeLegacyPlugin(old)).toMatchObject({
      prompt: ANALYSIS_PROMPT,
      schema: ANALYSIS_SCHEMA,
    });
    expect(upgradeLegacyPlugin({ ...old, prompt: "custom" })).toMatchObject({
      prompt: "custom",
      schema: LEGACY_ANALYSIS_SCHEMA,
    });
    expect(
      upgradeLegacyPlugin({
        ...old,
        schema: '{"type":"object","required":["ABC"]}',
      }).schema,
    ).toContain("ABC");
  });
  it("validates narrative fields and none without discarding factual records for approximate model word counts", () => {
    const p = pluginDefaults("analysis"),
      none = {
        character_thoughts: "none",
        scene_state: "none",
        action_state: "none",
        knowledge_boundaries: "none",
      };
    expect(JSON.parse(normalizePluginOutput(p, JSON.stringify(none)))).toEqual(
      none,
    );
    const full = {
      character_thoughts: [
        { character: "甲", thought: "我".repeat(150) },
        { character: "乙", thought: "none" },
      ],
      scene_state: "景".repeat(200),
      action_state: "动".repeat(150),
      knowledge_boundaries: "知".repeat(50),
    };
    expect(JSON.parse(normalizePluginOutput(p, JSON.stringify(full)))).toEqual(
      full,
    );
    for (const bad of [
      { ...none, scene_state: "" },
      { ...none, action_state: " " },
      { ...none, character_thoughts: [] },
      { ...none, knowledge_boundaries: null },
    ])
      expect(() => normalizePluginOutput(p, JSON.stringify(bad))).toThrow(
        "结构",
      );
    expect(
      JSON.parse(
        normalizePluginOutput(
          p,
          JSON.stringify({ ...none, scene_state: "有依据的短记录" }),
        ),
      ),
    ).toMatchObject({ scene_state: "有依据的短记录" });
  });
  it("matches three named rewrite fields and preserves saved and in-flight legacy outputs", () => {
    const p = pluginDefaults("rewrite"),
      value = {
        prompt1: "请继续。",
        prompt2: "接着写下去。",
        prompt3: "继续后面的内容。",
      };
    expect(JSON.parse(normalizePluginOutput(p, JSON.stringify(value)))).toEqual(
      value,
    );
    expect(
      extractRewriteCandidates(
        JSON.stringify({
          prompt3: value.prompt3,
          prompt1: value.prompt1,
          prompt2: value.prompt2,
        }),
      ),
    ).toEqual(Object.values(value));
    const array = { rewrites: Object.values(value) };
    expect(extractRewriteCandidates(JSON.stringify(array))).toEqual(
      Object.values(value),
    );
    expect(
      JSON.parse(
        normalizePluginOutput(
          { ...p, rewriteFormat: undefined },
          JSON.stringify(array),
        ),
      ),
    ).toEqual(array);
    expect(extractRewriteCandidates('{"prompt":"旧结果"}')).toEqual(["旧结果"]);
    expect(extractRewritePrompt('{"prompt":"旧结果"}')).toBe("旧结果");
    expect(
      JSON.parse(
        normalizePluginOutput(
          { ...p, rewriteFormat: undefined, initialUser: undefined },
          '{"prompt":"旧结果"}',
        ),
      ),
    ).toEqual({ prompt: "旧结果" });
    for (const bad of [
      array,
      { prompt1: "A", prompt2: "B" },
      { ...value, prompt3: " " },
      { ...value, prompt2: value.prompt1 },
      { ...value, prompt2: ["B"] },
      { ...value, extra: true },
    ])
      expect(() => normalizePluginOutput(p, JSON.stringify(bad))).toThrow();
  });

  it("sets streaming independently for analysis and clarification, defaulting legacy definitions to on", () => {
    const { chat, settings, state } = fixture();
    for (const kind of ["analysis", "clarify"] as const) {
      for (const stream of [true, false, undefined]) {
        const p = { ...pluginDefaults(kind), stream };
        expect(
          preparePlugin(chat, p, settings, [provider], state, "next").request
            .stream,
        ).toBe(stream !== false);
      }
    }
  });
  it("swaps full UA history for both candidates, leaves main system out, and appends the task to the latest mapped user", () => {
    const { chat, settings, state } = fixture();
    const long = "🙂".repeat(10000);
    addMessage(chat, "user", long);
    addMessage(chat, "assistant", "A1");
    const anchor = chat.currentId;
    addMessage(chat, "user", "later branch content");
    addMessage(chat, "assistant", "later answer");
    chat.rounds = 1;
    for (const kind of ["suggest", "rewrite"] as const) {
      const p = {
        ...pluginDefaults(kind),
        historyRounds: 1,
        highWater: 1,
        userHistoryCount: 1,
      };
      const result = preparePlugin(
        chat,
        p,
        settings,
        [provider],
        state,
        "草稿",
        anchor,
      );
      expect(result.request.messages.map((m) => m.role)).toEqual([
        "user",
        "assistant",
        "user",
      ]);
      expect(result.request.messages[0]?.content).toBe("好的");
      expect(result.request.messages[1]?.content).toBe(long);
      expect(result.request.messages[2]?.content).toContain("A1\n\n");
      expect(JSON.stringify(result.request.messages)).not.toMatch(
        /Stable system|later branch content|中间删减/,
      );
      expect(result.request.response_format).toEqual({ type: "json_object" });
      expect(result.request).not.toHaveProperty("reasoning_effort");
      expect(result.metrics).toMatchObject({
        shortened: 0,
      });
      expect(result.metrics.total).toBeGreaterThan(result.metrics.capacity / 4);
    }
  });

  it("temporarily excerpts each original assistant reply before merging, preserving user instructions and source history", () => {
    const { chat, settings, state } = fixture();
    const user = "令".repeat(2000),
      reply = "🙂".repeat(301) + "END_REPLY";
    addMessage(chat, "user", user);
    addMessage(chat, "assistant", reply);
    addMessage(chat, "assistant", "文".repeat(300) + "SECOND_END");
    const original = structuredClone(chat.messages);
    for (const kind of ["suggest", "rewrite"] as const) {
      const request = preparePlugin(
        chat,
        pluginDefaults(kind),
        settings,
        [provider],
        state,
        "DRAFT".repeat(100),
      );
      expect(request.request.messages[1]?.content).toBe(user);
      const tail = request.request.messages.at(-1)?.content ?? "";
      expect(tail).toContain("🙂".repeat(300) + "\n\n" + "文".repeat(300));
      expect(tail).not.toMatch(/END_REPLY|SECOND_END/);
      expect(request.metrics.shortened).toBe(2);
      if (kind === "rewrite") expect(tail).toContain("DRAFT".repeat(100));
    }
    expect(chat.messages).toEqual(original);
    const task = candidateTask("suggest", 5, "");
    expect(task).toContain("5 条不同走向的下一步具体行动指令");
    expect(task).toContain("数组必须恰好 5 条");
    expect(task).toContain("每条都用“我……”第一人称发令");
    expect(task).not.toMatch(/写作助手|模仿历史|assistant/);
  });

  it("caps missing-summary replies at 300 Unicode characters without limiting U0, system or user instructions", () => {
    expect(candidateReplyExcerpt("中".repeat(300))).toBe("中".repeat(300));
    expect(candidateReplyExcerpt("中".repeat(301))).toBe("中".repeat(300));
    expect(candidateReplyExcerpt("A".repeat(299) + "🙂B")).toBe("A".repeat(299) + "🙂");
    const { chat } = fixture();
    addMessage(chat, "assistant", "🙂".repeat(301));
    const system = "S".repeat(500), u0 = "U".repeat(500);
    expect(swappedHistory(Object.values(chat.messages), u0, system)).toEqual([
      { role: "system", content: system },
      { role: "user", content: u0 + "\n\n" + "🙂".repeat(300) },
    ]);
  });

  it("uses independent editable U0 and optional system with no context ceiling", () => {
    const { chat, settings, state } = fixture();
    for (let i = 0; i < 20; i++) {
      addMessage(chat, "user", "U" + i);
      addMessage(chat, "assistant", "A" + i);
    }
    const p = {
      ...pluginDefaults("suggest"),
      initialUser: "开始",
      prompt: "custom system",
      historyRounds: 1,
      highWater: 1,
      lowWater: 0,
    };
    const result = preparePlugin(chat, p, settings, [provider], state, "");
    expect(result.request.messages[0]).toEqual({
      role: "system",
      content: "custom system",
    });
    expect(result.request.messages[1]).toEqual({
      role: "user",
      content: "开始",
    });
    expect(
      result.request.messages.filter((m) => m.role === "assistant"),
    ).toHaveLength(20);
    expect(result.request.messages.at(-1)?.content).toContain("A19");
    expect(result.metrics.shortened).toBe(0);
  });

  it("supports first-message rewrite as a single final user with required U0 and the unmodified draft", () => {
    const { chat, settings, state } = fixture();
    const draft = "原".repeat(10000);
    const result = preparePlugin(
      chat,
      pluginDefaults("rewrite"),
      settings,
      [provider],
      state,
      draft,
    );
    expect(result.request.messages).toHaveLength(1);
    expect(result.request.messages[0]?.content).toContain(draft);
    expect(result.request.messages[0]?.content).toMatch(/^好的\n\n/);
    expect(result.request.messages[0]?.content).toContain('"prompt1"');
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
