import { describe, it, expect } from "vitest";
import {
  newChat,
  addMessage,
  defaultSettings,
  contextMessages,
  forkChat,
  duplicateChat,
  sanitizeUsage,
} from "../src/shared/chat";
import { exportChat } from "../src/shared/exchange";
import { hasReportedUsage } from "../src/shared/completion";
import {
  pluginDefaults,
  preparePlugin,
  injectPlugins,
  emptyPluginState,
  type APIMessage,
  type PluginRun,
} from "../src/shared/plugins";
import {
  prepareSummary,
  defaultSummaryConfig,
  summarySourceKey,
  type SummaryState,
} from "../src/shared/summaries";

const provider = {
  id: "p",
  name: "fixture",
  prefix: "",
  baseUrl: "https://fixture.invalid",
  models: [{ id: "model", capacity: 1048576, enabled: true, parameters: {} }],
};
function fixture() {
  const chat = newChat({ providerId: "p", modelId: "model" });
  const user = addMessage(chat, "user", "我检查钥匙");
  const assistant = addMessage(
    chat,
    "assistant",
    "钥匙仍在柜台，伙计没有见过它的来历。".repeat(100),
  );
  const summaries: SummaryState = {
    runs: [
      {
        id: "sum",
        messageId: assistant.id,
        sourceKey: summarySourceKey(chat, assistant.id),
        status: "complete",
        summary: "钥匙在柜台，伙计不知来历",
        output: "",
        createdAt: 1,
        config: defaultSummaryConfig(),
        inputTokens: 1,
      },
    ],
  };
  return { chat, user, assistant, summaries, settings: defaultSettings() };
}
describe("cache-friendly request histories", () => {
  it("preserves reported cache billing counters without inventing a percentage", () => {
    const usage = {
      prompt_tokens: 13217,
      prompt_cache_hit_tokens: 9344,
      prompt_cache_miss_tokens: 3873,
      cache_read_input_tokens: 9344,
      cache_creation_input_tokens: 100,
      input_tokens_details: { cached_tokens: 9344, cache_write_tokens: 100 },
    };
    expect(sanitizeUsage(usage)).toEqual(usage);
    expect(sanitizeUsage(usage)).not.toHaveProperty("cache_hit_rate");
    expect(hasReportedUsage({ cache_creation_input_tokens: 100 })).toBe(true);
    expect(
      sanitizeUsage({
        cache_read_input_tokens: -1,
        cache_creation_input_tokens: "100",
      }),
    ).toBeUndefined();
  });
  it("keeps fixed front-plugin contracts before independently appendable historical references", () => {
    const { chat, user, summaries, settings } = fixture(),
      state = emptyPluginState();
    for (const kind of ["clarify", "analysis"] as const)
      state.runs.push({
        id: kind,
        plugin: pluginDefaults(kind),
        anchorId: user.id,
        input: "old",
        output: "only-" + kind,
        answer: "answer",
        status: kind === "analysis" ? "complete" : "answered",
        createdAt: 1,
        metrics: {
          total: 0,
          capacity: 1,
          missingSummaries: 0,
          referenceTokens: 0,
          shortened: 0,
          sections: [],
        },
      } satisfies PluginRun);
    const prepare = (kind: "clarify" | "analysis") =>
      preparePlugin(
        chat,
        pluginDefaults(kind),
        settings,
        [provider],
        state,
        "继续",
        chat.currentId,
        [],
        summaries,
      ).request;
    const c = prepare("clarify"),
      a = prepare("analysis");
    expect(c.messages[0]!.content).toContain("【插件固定任务】");
    expect(a.messages[0]!.content).toContain("JSON Schema：");
    expect(c.messages[1]).toEqual(a.messages[1]);
    expect(c.messages[2]!.content).toContain("plugin_history");
    expect(c.messages.at(-2)!.content).toContain("recent_raw_rounds");
    expect(c.response_format).toEqual(a.response_format);
    expect(JSON.stringify(c.messages)).not.toContain(user.id);
    expect(
      preparePlugin(
        chat,
        { ...pluginDefaults("analysis"), schema: '{"type":"array"}' },
        settings,
        [provider],
        state,
        "继续",
      ).request.response_format,
    ).toBeUndefined();
  });
  it("keeps draft variables out of candidate system and restores identical context after forking", () => {
    const { chat, assistant, summaries, settings } = fixture(),
      state = emptyPluginState();
    const plugin = {
      ...pluginDefaults("rewrite"),
      prompt: "只改写 {{USER_INPUT}}；不要新增限制。",
    };
    const prepare = (input: string) =>
      preparePlugin(
        chat,
        plugin,
        settings,
        [provider],
        state,
        input,
        chat.currentId,
        [],
        summaries,
      ).request.messages;
    const first = prepare("短草稿甲"),
      second = prepare("不同的草稿乙");
    expect(first.slice(0, -1)).toEqual(second.slice(0, -1));
    expect(first[0]!.content).not.toContain("短草稿甲");
    expect(first.at(-1)!.content).toContain('"短草稿甲"');
    const copied = forkChat(chat, assistant.id, []);
    const copiedSummary = {
      runs: [
        {
          ...summaries.runs[0]!,
          messageId: copied.currentId!,
          sourceKey: summarySourceKey(copied, copied.currentId!),
        },
      ],
    };
    const original = preparePlugin(
      chat,
      pluginDefaults("analysis"),
      settings,
      [provider],
      state,
      "继续",
      chat.currentId,
      [],
      summaries,
    );
    const fork = preparePlugin(
      copied,
      pluginDefaults("analysis"),
      settings,
      [provider],
      state,
      "继续",
      copied.currentId,
      [],
      copiedSummary,
    );
    expect(fork.request).toEqual(original.request);
  });
  it("preserves historical tool preludes in place, including copies, without exporting them", () => {
    const { chat, user, assistant } = fixture();
    const first = injectPlugins(
      [{ role: "user", content: user.content }],
      [
        {
          pluginId: "analysis",
          name: "写前分析",
          template: "{{RESULT}}",
          content: "PRIVATE_AUXILIARY_RESULT",
          runId: "one",
        },
      ],
    );
    assistant.toolContext = { parentId: user.id, messages: first.slice(1) };
    addMessage(chat, "user", "下一轮");
    const expected = [
      ...first,
      { role: "assistant", content: assistant.content },
      { role: "user", content: "下一轮" },
    ];
    expect(contextMessages(chat)).toEqual(expected);
    expect(contextMessages(duplicateChat(chat, []))).toEqual(expected);
    expect(contextMessages(forkChat(chat, chat.currentId!, []))).toEqual(
      expected,
    );
    expect(JSON.stringify(exportChat(chat))).not.toMatch(
      /PRIVATE_AUXILIARY_RESULT|toolContext/,
    );
    assistant.toolContext.parentId = "removed-parent";
    expect(contextMessages(chat).some((m) => m.role === "tool")).toBe(false);
  });
  it("uses content-stable summary mappings across copied branches and retains full current text", () => {
    const { chat, assistant, summaries, settings } = fixture();
    addMessage(chat, "user", "继续看柜台");
    const latest = addMessage(chat, "assistant", "本轮完整正文".repeat(700));
    const original = prepareSummary(chat, latest.id, summaries, settings, [
      provider,
    ]);
    const copy = duplicateChat(chat, []),
      path = Object.values(copy.messages);
    const copiedSummary = {
      runs: [
        {
          ...summaries.runs[0]!,
          messageId: path[1]!.id,
          sourceKey: summarySourceKey(copy, path[1]!.id),
        },
      ],
    };
    expect(
      prepareSummary(copy, copy.currentId!, copiedSummary, settings, [provider])
        .request,
    ).toEqual(original.request);
    const tail = JSON.parse(original.request.messages.at(-1)!.content!);
    expect(tail.current.assistant).toBe(latest.content);
    expect(tail.previous_example.assistant_excerpt.length).toBeGreaterThan(0);
    expect(JSON.stringify(original.request.messages)).not.toContain(
      assistant.id,
    );
  });
});
