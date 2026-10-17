import { describe, it, expect } from "vitest";
import {
  candidateReplyExcerpt,
  candidateTask,
  swappedHistory,
} from "../src/shared/candidate-requests";
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
  upgradeLegacyPlugin,
  REWRITE_PROMPT,
  SUGGEST_PROMPT,
  extractRewritePrompt,
  extractRewriteCandidates,
  definitions,
  enabledPlugins,
  flowClarifications,
  type PluginRun,
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
  it("gives analysis only this flow's answered clarification pairs with switchable tool/user injection", () => {
    const { chat, settings, state } = fixture();
    addMessage(chat, "user", "过去");
    addMessage(chat, "assistant", "已有事实");
    const anchor = chat.currentId,
      question = run(
        "current",
        "clarify",
        "q",
        "当前要求",
        "问题：是什么颜色？",
        "蓝色",
      );
    question.flowId = "flow";
    const other = {
      ...question,
      id: "other",
      flowId: "other-flow",
      answer: "别的分支",
    };
    state.runs.push(question, other);
    const flow = {
      id: "flow",
      userId: "current",
      definitions: [],
      index: 1,
      results: ["q", "other"],
      debug: false,
      status: "running" as const,
    };
    for (const mode of ["tool", "user"] as const) {
      question.plugin.injection = mode;
      const injections = flowClarifications(state, flow);
      expect(injections).toHaveLength(1);
      const prepared = preparePlugin(
        chat,
        pluginDefaults("analysis"),
        settings,
        [provider],
        state,
        "当前要求",
        anchor,
        injections,
      );
      expect(prepared.request.messages.slice(0, 3)).toEqual(
        contextMessages(chat),
      );
      expect(JSON.stringify(prepared.request.messages)).toContain("蓝色");
      expect(JSON.stringify(prepared.request.messages)).not.toContain(
        "别的分支",
      );
      expect(prepared.request.messages.at(-1)?.content).toContain(
        "HARD INTERRUPT",
      );
      expect(prepared.request.messages.some((m) => m.role === "tool")).toBe(
        mode === "tool",
      );
      expect(
        prepared.metrics.sections.find((s) => s.name === "本轮澄清问答")
          ?.tokens,
      ).toBeGreaterThan(0);
    }
    expect(Object.values(chat.messages)).toHaveLength(2);
  });
  it("matches three named rewrite fields and preserves saved and in-flight legacy outputs", () => {
    const p = pluginDefaults("rewrite"),
      value = {
        prompt1: "请继续。",
        prompt2: "接着写下去。",
        prompt3: "继续后面的内容。",
      };
    expect(
      JSON.parse(normalizePluginOutput(p, JSON.stringify(value), "继续")),
    ).toEqual(value);
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

  it("defaults all efforts to inherit and migrates candidate labels and disabled waterlines", () => {
    for (const kind of ["analysis", "clarify", "suggest", "rewrite"] as const)
      expect(pluginDefaults(kind)).toMatchObject({
        effort: "inherit",
        highWater: 0,
        lowWater: 0,
      });
    for (const kind of ["analysis", "clarify"] as const)
      expect(
        upgradeLegacyPlugin({
          ...pluginDefaults(kind),
          contextMode: "rounds",
          highWater: 500000,
          lowWater: 200000,
        }),
      ).toMatchObject({ contextMode: "sync", highWater: 0, lowWater: 0 });
    expect(newChat().effort).toBe("inherit");
    const old = {
      ...pluginDefaults("rewrite"),
      initialUser: undefined,
      name: "请求重生",
      highWater: 30000,
      lowWater: 10000,
      prompt: "custom",
      effort: "high" as const,
    };
    expect(upgradeLegacyPlugin(old)).toMatchObject({
      name: "重新生成 user 提示",
      initialUser: "好的",
      highWater: 0,
      lowWater: 0,
      prompt: "custom",
      effort: "high",
    });
    expect(pluginDefaults("suggest")).toMatchObject({
      prompt: SUGGEST_PROMPT,
      highWater: 0,
      lowWater: 0,
      initialUser: "好的",
    });
    expect(pluginDefaults("rewrite").prompt).toBe(REWRITE_PROMPT);
  });

  it("keeps the historical reply in analysis previews and merges adjacent mapped roles without losing text", () => {
    const { chat, settings, state } = fixture();
    addMessage(chat, "user", "U1");
    addMessage(chat, "assistant", "A1");
    const preview = preparePlugin(
      chat,
      pluginDefaults("analysis"),
      settings,
      [provider],
      state,
      "",
    );
    expect(preview.request.messages.slice(0, -1)).toEqual(
      contextMessages(chat),
    );
    addMessage(chat, "user", "U2");
    addMessage(chat, "user", "U3");
    const result = preparePlugin(
      chat,
      pluginDefaults("rewrite"),
      settings,
      [provider],
      state,
      "草稿",
    ).request.messages;
    expect(result.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(result[3]?.content).toBe("U2\n\nU3");
    expect(result.at(-1)?.content).toContain("草稿");
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
    expect(actual.request).not.toHaveProperty("reasoning_effort");
  });
  it("ignores old round and reference limits, preserving full history and paired prompts", () => {
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
    chat.rounds = 1;
    p.referenceCount = 1;
    p.example = '{"v":"example"}';
    const result = preparePlugin(chat, p, settings, [provider], state, "next")
      .request.messages;
    expect(result.slice(0, -1).map((m) => m.content)).toEqual([
      "Stable system",
      "U0",
      "A0",
      "U1",
      "A1",
      "U2",
      "A2",
      "U3",
      "A3",
    ]);
    const suffix = result.at(-1)?.content;
    const reference = JSON.parse(
      suffix!.split("历史完整配对（仅作参考）：\n")[1]!.split("\n")[3]!,
    );
    expect(reference.prompt).toBe(state.runs[3]!.plugin.prompt);
    expect(suffix).toContain("example");
    expect(
      suffix!
        .split("历史完整配对（仅作参考）：\n")[1]!
        .split("\n")
        .map((line) => JSON.parse(JSON.parse(line).result).v),
    ).toEqual([0, 1, 2, 3]);
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
  it("preserves all question-answer groups despite legacy watermarks and cutoffs, without branch leakage", () => {
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
    state.runs[7]!.metrics.cutoff = "r5";
    chat.rounds = 1;
    const p = pluginDefaults("clarify");
    p.contextMode = "rounds";
    p.historyRounds = 1;
    p.highWater = 1000;
    p.lowWater = 500;
    const result = preparePlugin(chat, p, settings, [provider], state, "next");
    expect(result.metrics.trimmed).toBe(0);
    expect(result.metrics.highWater).toBe(0);
    expect(result.metrics.archive).toBe(result.metrics.originalArchive);
    expect(result.request.messages[1]?.content).toBe("U0");
    const suffix = result.request.messages.at(-1)?.content ?? "";
    expect(suffix).not.toContain("PRIVATE");
    expect(suffix).toContain("ANSWER7");
    expect(suffix).toContain("ANSWER0");
  });
  it("honors an explicit reference reset without cutting the chat history", () => {
    const { chat, settings, state } = fixture();
    const u = addMessage(chat, "user", "U0");
    addMessage(chat, "assistant", "A0");
    const old = run(u.id, "clarify", "r0", "U0", "old question", "old answer");
    old.referenceReset = true;
    state.runs.push(old);
    const result = preparePlugin(
      chat,
      pluginDefaults("clarify"),
      settings,
      [provider],
      state,
      "next",
    );
    expect(result.request.messages.map((m) => m.content)).toContain("U0");
    expect(result.request.messages.map((m) => m.content)).toContain("A0");
    expect(result.request.messages.at(-1)?.content).not.toContain(
      "old question",
    );
    expect(result.metrics.archive).toBe(0);
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
        lowWater: 0,
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
        trimmed: 0,
        shortened: 0,
        highWater: 0,
        lowWater: 0,
      });
      expect(result.metrics.total).toBeGreaterThan(result.metrics.capacity / 4);
    }
  });

  it("temporarily excerpts each original assistant reply before merging, preserving user instructions and source history", () => {
    const { chat, settings, state } = fixture();
    const user = "令".repeat(2000),
      reply = "🙂".repeat(201) + "END_REPLY";
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
      expect(tail).toContain("🙂".repeat(200) + "\n\n" + "文".repeat(200));
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

  it("caps replies at 200 Unicode code points without cutting surrogate pairs or limiting the task, system or U0", () => {
    expect(candidateReplyExcerpt("中".repeat(200))).toBe("中".repeat(200));
    expect(candidateReplyExcerpt("中".repeat(201))).toBe("中".repeat(200));
    expect(candidateReplyExcerpt("A".repeat(199) + "🙂B")).toBe(
      "A".repeat(199) + "🙂",
    );
    const { chat } = fixture();
    addMessage(chat, "assistant", "🙂".repeat(201));
    const system = "S".repeat(300),
      u0 = "U".repeat(300);
    expect(swappedHistory(Object.values(chat.messages), u0, system)).toEqual([
      { role: "system", content: system },
      { role: "user", content: u0 + "\n\n" + "🙂".repeat(200) },
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
    expect(result.metrics.trimmed).toBe(0);
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
