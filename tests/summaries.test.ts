import { describe, it, expect } from "vitest";
import {
  newChat,
  addMessage,
  editMessage,
  defaultSettings,
  route,
  type Provider,
} from "../src/shared/chat";
import {
  defaultSummaryConfig,
  prepareSummary,
  normalizeSummary,
  summarySourceKey,
  summarySourceKeys,
  summaryFor,
  excerpt,
  summaryConfig,
  SUMMARY_PROMPT,
  upgradeSummaryConfig,
  type SummaryState,
  type SummaryRun,
} from "../src/shared/summaries";
import {
  pluginDefaults,
  preparePlugin,
  upgradeLegacyPlugin,
  emptyPluginState,
  injectPlugins,
  type PluginRun,
} from "../src/shared/plugins";
const provider: Provider = {
  id: "p",
  name: "Test",
  prefix: "",
  baseUrl: "https://fixture.test/v1",
  models: [
    {
      id: "main",
      enabled: true,
      capacity: 32000,
      parameters: { temperature: 0.8 },
    },
    {
      id: "gemini-3.1-flash-lite",
      enabled: true,
      capacity: 1000000,
      parameters: { temperature: 0.7 },
    },
  ],
};
function fixture() {
  const chat = newChat();
  chat.model = { providerId: "p", modelId: "main" };
  chat.system = [
    { id: "system", name: "secret", content: "MAIN_SYSTEM_FORBIDDEN" },
  ];
  return {
    chat,
    settings: defaultSettings(),
    state: { runs: [] } as SummaryState,
  };
}
function accepted(
  chat: ReturnType<typeof newChat>,
  id: string,
  text = "ACCEPTED_SUMMARY",
): SummaryRun {
  return {
    id: "sum-" + id,
    messageId: id,
    sourceKey: summarySourceKey(chat, id),
    status: "complete",
    summary: text,
    output: JSON.stringify({ summary: text }),
    createdAt: 1,
    config: defaultSummaryConfig(),
    inputTokens: 10,
  };
}
describe("reply summaries", () => {
  it("builds all route fingerprints in one traversal and invalidates only changed prefixes", () => {
    const { chat } = fixture();
    for (let i = 0; i < 1000; i++)
      addMessage(chat, i % 2 ? "assistant" : "user", "message " + i);
    let parentReads = 0;
    const messages = Object.values(chat.messages);
    for (const message of messages) {
      const parentId = message.parentId;
      Object.defineProperty(message, "parentId", {
        get: () => {
          parentReads++;
          return parentId;
        },
      });
    }
    const path = route(chat),
      keys = summarySourceKeys(path);
    expect(keys.size).toBe(1000);
    expect(parentReads).toBe(1000);
    for (const index of [0, 19, 499, 999])
      expect(keys.get(path[index]!.id)).toBe(
        summarySourceKey(chat, path[index]!.id),
      );
    path[500]!.contentVersion = "edited-version";
    const changed = summarySourceKeys(path);
    expect(changed.get(path[499]!.id)).toBe(keys.get(path[499]!.id));
    expect(changed.get(path[500]!.id)).not.toBe(keys.get(path[500]!.id));
    expect(changed.get(path[999]!.id)).not.toBe(keys.get(path[999]!.id));
  });
  it("validates a single nonempty summary, warns rather than truncating length", () => {
    for (const raw of [
      "{}",
      '{"summary":" "}',
      '{"summary":1}',
      '{"summary":"ok","other":1}',
      '["x"]',
      "not JSON",
    ])
      expect(() => normalizeSummary(raw)).toThrow();
    expect(normalizeSummary('{"summary":"已完成。"}')).toMatchObject({
      summary: "已完成。",
      warning: expect.stringContaining("未自动截断"),
    });
    const text = "🙂".repeat(101);
    expect(normalizeSummary(JSON.stringify({ summary: text })).summary).toBe(
      text,
    );
    expect(
      normalizeSummary(JSON.stringify({ summary: "中".repeat(100) })).warning,
    ).toBeUndefined();
  });
  it("cold starts without examples, uses full current UA and an independent system/model/temperature", () => {
    const { chat, settings, state } = fixture();
    addMessage(chat, "system", "HISTORY_SYSTEM_FORBIDDEN");
    const u = addMessage(chat, "user", "U".repeat(4000)),
      a = addMessage(chat, "assistant", "A".repeat(8000));
    const p = prepareSummary(chat, a.id, state, settings, [provider]);
    expect(p.request.model).toBe("main");
    expect(p.request.temperature).toBe(0.3);
    expect(p.request).not.toHaveProperty("reasoning_effort");
    const payload = JSON.parse(p.request.messages.at(-1)!.content!);
    expect(payload).not.toHaveProperty("previous_example");
    expect(payload.current).toMatchObject({
      user: u.content,
      assistant: a.content,
    });
    expect(JSON.stringify(p.request.messages)).not.toMatch(
      /MAIN_SYSTEM_FORBIDDEN|HISTORY_SYSTEM_FORBIDDEN/,
    );
    chat.summaryOverrides = {
      system: "",
      stream: false,
      model: chat.model!,
      parameters: { temperature: 0 },
    };
    const q = prepareSummary(chat, a.id, state, settings, [provider]);
    expect(q.request.messages[0]?.role).toBe("user");
    expect(q.request).toMatchObject({
      model: "main",
      temperature: 0,
      stream: false,
    });
    chat.summaryOverrides = undefined;
    chat.model = { providerId: "p", modelId: "gemini-3.1-flash-lite" };
    expect(
      prepareSummary(chat, a.id, state, settings, [provider]).request.model,
    ).toBe("gemini-3.1-flash-lite");
    settings.replySummary = {
      ...defaultSummaryConfig(),
      model: { providerId: "p", modelId: "main" },
    };
    expect(
      prepareSummary(chat, a.id, state, settings, [provider]).request.model,
    ).toBe("main");
    chat.summaryOverrides = { model: null };
    expect(
      prepareSummary(chat, a.id, state, settings, [provider]).request.model,
    ).toBe("gemini-3.1-flash-lite");
  });
  it("keeps historical U-to-summary mapping, fills missing summaries with bounded A excerpts, and picks the latest valid example", () => {
    const { chat, settings, state } = fixture();
    const u1 = addMessage(
        chat,
        "user",
        "🙂".repeat(251) + "MIDDLE_USER" + "尾".repeat(251),
      ),
      a1 = addMessage(
        chat,
        "assistant",
        "头".repeat(1251) + "MIDDLE_A" + "尾".repeat(1251),
      );
    state.runs.push(accepted(chat, a1.id));
    addMessage(chat, "user", "U2");
    const a2 = addMessage(chat, "assistant", "MISSING_SUMMARY_OLD_A");
    addMessage(chat, "user", "U3");
    const a3 = addMessage(chat, "assistant", "CURRENT_FULL_A");
    const p = prepareSummary(chat, a3.id, state, settings, [provider]),
      history = p.request.messages
        .slice(1, -1)
        .flatMap((m) => JSON.parse(m.content!).history),
      tail = JSON.parse(p.request.messages.at(-1)!.content!);
    expect(history).toHaveLength(2);
    expect(history[1]).toEqual({
      turn: 2,
      user_excerpt: "U2",
      assistant_excerpt: "MISSING_SUMMARY_OLD_A",
    });
    expect(history[0].user_excerpt).toBe(excerpt(u1.content, 500));
    expect(history[0].user_excerpt).not.toContain("MIDDLE_USER");
    expect(tail.previous_example).toMatchObject({
      turn: 1,
      assistant_excerpt: excerpt(a1.content, 2500),
      summary: "ACCEPTED_SUMMARY",
    });
    expect(tail.previous_example.assistant_excerpt).not.toContain("MIDDLE_A");
    expect(JSON.stringify(p.request.messages)).toContain(
      "MISSING_SUMMARY_OLD_A",
    );
    expect(tail.current.assistant).toBe("CURRENT_FULL_A");
  });
  it("invalidates accepted summaries after editing their source or an ancestor and isolates branches", () => {
    const { chat, state } = fixture();
    const u = addMessage(chat, "user", "u"),
      a = addMessage(chat, "assistant", "a");
    state.runs.push(accepted(chat, a.id));
    const key = summarySourceKey(chat, a.id);
    chat.system = [];
    chat.summaryOverrides = { system: "new settings" };
    expect(summarySourceKey(chat, a.id)).toBe(key);
    expect(summaryFor(chat, state, a.id)?.summary).toBe("ACCEPTED_SUMMARY");
    editMessage(chat, a.id, "b");
    expect(summaryFor(chat, state, a.id)).toBeUndefined();
    state.runs.push(accepted(chat, a.id, "new"));
    const sibling = addMessage(chat, "assistant", "sibling", u.id);
    expect(summaryFor(chat, state, sibling.id)).toBeUndefined();
    expect(summaryFor(chat, state, a.id)?.summary).toBe("new");
    chat.messages[u.id]!.contentVersion = "edited-ancestor";
    expect(summaryFor(chat, state, a.id)).toBeUndefined();
    delete chat.messages[a.id];
    expect(summaryFor(chat, state, a.id)).toBeUndefined();
  });
  it("handles Unicode head/tail boundaries and accepts manual partial replies only when text exists", () => {
    expect(excerpt("🙂".repeat(500), 500)).toBe("🙂".repeat(500));
    expect(excerpt("🙂".repeat(501), 500)).toBe(
      "🙂".repeat(250) + "\n[中间已省略]\n" + "🙂".repeat(250),
    );
    const { chat, settings, state } = fixture();
    const a = addMessage(chat, "assistant", "partial");
    a.status = "stopped";
    expect(() =>
      prepareSummary(chat, a.id, state, settings, [provider]),
    ).not.toThrow();
    a.status = "running";
    expect(() =>
      prepareSummary(chat, a.id, state, settings, [provider]),
    ).toThrow();
  });
});
describe("summary fallback across every plugin", () => {
  it.each(["suggest", "rewrite", "clarify", "analysis"] as const)(
    "%s sees valid summaries and the latest unsummarized answer",
    (kind) => {
      const { chat, settings, state } = fixture();
      addMessage(chat, "user", "first user");
      const first = addMessage(
        chat,
        "assistant",
        "FIRST_FULL_BODY_MUST_NOT_LEAK",
      );
      state.runs.push(accepted(chat, first.id));
      addMessage(chat, "user", "latest user");
      const last = addMessage(
        chat,
        "assistant",
        "🙂".repeat(300) + "EXCLUDED_TAIL",
      );
      state.runs.push({
        ...accepted(chat, last.id, "FAILED_SUMMARY"),
        status: "error",
      });
      const p = { ...pluginDefaults(kind), rawRounds: 0 };
      const result = preparePlugin(
        chat,
        p,
        settings,
        [provider],
        emptyPluginState(),
        "draft",
        chat.currentId,
        [],
        state,
      );
      const text = JSON.stringify(result.request.messages);
      expect(text).toContain("ACCEPTED_SUMMARY");
      expect(text).toContain("🙂".repeat(300));
      expect(text).not.toMatch(/FIRST_FULL_BODY|EXCLUDED_TAIL|FAILED_SUMMARY/);
      expect(result.metrics.missingSummaries).toBe(1);
      // An invalidated accepted result must also fall back, never use stale text.
      last.contentVersion = "edited";
      state.runs.push({
        ...accepted(chat, last.id, "STALE"),
        sourceKey: "wrong",
      });
      expect(
        JSON.stringify(
          preparePlugin(
            chat,
            p,
            settings,
            [provider],
            emptyPluginState(),
            "draft",
            chat.currentId,
            [],
            state,
          ).request,
        ),
      ).not.toContain("STALE");
    },
  );
  it("keeps fallback history JSON distinct from real summary examples", () => {
    const { chat, settings, state } = fixture();
    addMessage(chat, "user", "u1");
    addMessage(chat, "assistant", "🙂".repeat(301) + "LEAK");
    addMessage(chat, "user", "u2");
    const a = addMessage(chat, "assistant", "current full answer");
    const messages = prepareSummary(chat, a.id, state, settings, [provider])
      .request.messages;
    expect(JSON.parse(messages[1]!.content!).history[0]).toMatchObject({
      assistant_excerpt: "🙂".repeat(300),
    });
    expect(JSON.parse(messages.at(-1)!.content!)).not.toHaveProperty(
      "previous_example",
    );
    expect(JSON.stringify(messages)).not.toContain("LEAK");
  });
  it("migrates only the exact old built-in summary prompt and keeps custom/blank settings", () => {
    const old = SUMMARY_PROMPT.replaceAll("100–150", "50–100");
    expect(upgradeSummaryConfig({ system: old }).system).toBe(SUMMARY_PROMPT);
    for (const system of ["", "custom 50–100 字"])
      expect(upgradeSummaryConfig({ system }).system).toBe(system);
    const { chat, settings } = fixture();
    settings.replySummary = { ...defaultSummaryConfig(), system: old };
    expect(summaryConfig(chat, settings).system).toBe(SUMMARY_PROMPT);
    chat.summaryOverrides = { system: "" };
    expect(summaryConfig(chat, settings).system).toBe("");
    for (const n of [100, 150])
      expect(
        normalizeSummary(JSON.stringify({ summary: "字".repeat(n) })).warning,
      ).toBeUndefined();
    for (const n of [99, 151])
      expect(
        normalizeSummary(JSON.stringify({ summary: "字".repeat(n) })).warning,
      ).toContain("100–150");
  });
});
describe("front plugin summary context", () => {
  it.each(["clarify", "analysis"] as const)(
    "%s filters all main systems, keeps U + accepted S with 300-character fallback, then appends N raw rounds",
    (kind) => {
      const { chat, settings, state } = fixture();
      addMessage(chat, "system", "HISTORY_SYSTEM_FORBIDDEN");
      addMessage(chat, "user", "USER1");
      const a1 = addMessage(chat, "assistant", "FULL1");
      state.runs.push(accepted(chat, a1.id));
      addMessage(chat, "user", "USER2");
      addMessage(chat, "assistant", "FULL2_MISSING");
      addMessage(chat, "user", "USER3");
      addMessage(chat, "assistant", "FULL3");
      const p = {
        ...pluginDefaults(kind),
        system: "PLUGIN_SYSTEM",
        rawRounds: 1,
        parameters: { temperature: 0 },
      };
      const result = preparePlugin(
        chat,
        p,
        settings,
        [provider],
        emptyPluginState(),
        "next",
        chat.currentId,
        [],
        state,
      );
      expect(result.request.messages[0]).toEqual({
        role: "system",
        content: "PLUGIN_SYSTEM",
      });
      expect(result.request.messages[3]?.content).toContain("ACCEPTED_SUMMARY");
      expect(result.request.messages[5]?.content).toBe("FULL2_MISSING");
      const raw = JSON.parse(
        result.request.messages.at(-2)!.content!,
      ).recent_raw_rounds;
      expect(raw.map((m: { content: string }) => m.content)).toEqual([
        "USER3",
        "FULL3",
      ]);
      expect(JSON.stringify(result.request.messages)).not.toMatch(
        /MAIN_SYSTEM_FORBIDDEN|HISTORY_SYSTEM_FORBIDDEN/,
      );
      expect(result.metrics.missingSummaries).toBe(2);
      expect(result.request.temperature).toBe(0);
      p.rawRounds = 0;
      expect(
        preparePlugin(
          chat,
          p,
          settings,
          [provider],
          emptyPluginState(),
          "next",
          chat.currentId,
          [],
          state,
        ).request.messages.some((m) =>
          m.content?.includes("recent_raw_rounds"),
        ),
      ).toBe(false);
    },
  );
  it("keeps own references after the shared raw prefix, uses stable positions and excludes old prompt/user", () => {
    const { chat, settings, state } = fixture(),
      ps = emptyPluginState();
    const u = addMessage(chat, "user", "USER1"),
      a = addMessage(chat, "assistant", "FULL1");
    state.runs.push(accepted(chat, a.id));
    const p = { ...pluginDefaults("clarify"), prompt: "CURRENT_TASK" };
    const run: PluginRun = {
      id: "r",
      anchorId: u.id,
      plugin: { ...p, prompt: "OLD_PROMPT_FORBIDDEN" },
      input: "OLD_DUP_USER_FORBIDDEN",
      output: "QUESTION",
      answer: "ANSWER",
      status: "answered",
      createdAt: 1,
      metrics: {
        total: 1,
        capacity: 32000,
        referenceTokens: 0,
        missingSummaries: 0,
        shortened: 0,
        sections: [],
      },
    };
    ps.runs.push(
      run,
      { ...run, id: "foreign", anchorId: "other-branch", output: "FOREIGN" },
      {
        ...run,
        id: "otherplugin",
        plugin: { ...p, id: "other" },
        output: "OTHER_PLUGIN",
      },
    );
    const result = preparePlugin(
      chat,
      p,
      settings,
      [provider],
      ps,
      "next",
      chat.currentId,
      [],
      state,
    );
    const ref = JSON.parse(
      result.request.messages.find((m) =>
        m.content?.includes('"plugin_history"'),
      )!.content!,
    ).plugin_history;
    expect(ref).toEqual([
      { message: 1, question: "QUESTION", answer: "ANSWER" },
    ]);
    expect(result.request.messages.at(-2)?.content).toContain(
      "recent_raw_rounds",
    );
    expect(JSON.stringify(result.request.messages)).not.toMatch(
      /OLD_PROMPT_FORBIDDEN|OLD_DUP_USER_FORBIDDEN|FOREIGN|OTHER_PLUGIN/,
    );
    run.referenceReset = true;
    expect(
      preparePlugin(
        chat,
        p,
        settings,
        [provider],
        ps,
        "next",
        chat.currentId,
        [],
        state,
      ).metrics.referenceTokens,
    ).toBe(0);
  });
  it("always injects tool pairs, retaining the editable template and the current clarification pair", () => {
    const source = [{ role: "user" as const, content: "original" }],
      item = {
        pluginId: "p",
        runId: "r",
        name: "Test",
        template: "CUSTOM {{RESULT}}",
        content: "answer",
      };
    const result = injectPlugins(source, [item]);
    expect(result.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(result[2]?.content).toBe("CUSTOM answer");
    expect(result[1]?.tool_calls?.[0]?.id).toBe(result[2]?.tool_call_id);
    expect(source[0]?.content).toBe("original");
    const { chat, settings, state } = fixture(),
      p = pluginDefaults("analysis");
    p.rawRounds = 0;
    const req = preparePlugin(
      chat,
      p,
      settings,
      [provider],
      emptyPluginState(),
      "CURRENT_USER",
      null,
      [item],
      state,
    ).request.messages;
    expect(req.filter((m) => m.role === "tool")).toHaveLength(1);
    expect(
      req.filter(
        (m) => m.role === "user" && m.content?.includes("CURRENT_USER"),
      ),
    ).toHaveLength(2);
  });
  it("migrates obsolete limits and injection mode out, while preserving user templates and effort", () => {
    const old = {
      ...pluginDefaults("analysis"),
      contextMode: "rounds",
      historyRounds: 2,
      userHistoryCount: 5,
      referenceCount: 1,
      highWater: 50,
      lowWater: 20,
      injection: "user",
      injectionTemplate: "CUSTOM",
      effort: "high" as const,
    };
    const result = upgradeLegacyPlugin(old);
    for (const key of [
      "contextMode",
      "historyRounds",
      "referenceCount",
      "userHistoryCount",
      "highWater",
      "lowWater",
      "injection",
    ])
      expect(result).not.toHaveProperty(key);
    expect(result).toMatchObject({
      system: "",
      rawRounds: 3,
      injectionTemplate: "CUSTOM",
      effort: "high",
    });
  });
});
