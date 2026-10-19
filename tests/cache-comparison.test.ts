import { describe, it, expect } from "vitest";
import {
  newChat,
  addMessage,
  contextMessages,
  defaultSettings,
} from "../src/shared/chat";
import { comparisonFork, defaultComparison } from "../src/shared/comparison";
import {
  pluginDefaults,
  preparePlugin,
  emptyPluginState,
  injectPlugins,
} from "../src/shared/plugins";
import { lengthInjection } from "../src/shared/length-guidance";
import { prepareSummary, summarySourceKey } from "../src/shared/summaries";
import { titleMessages } from "../src/shared/title-template";
const provider = {
  id: "p",
  name: "p",
  prefix: "",
  baseUrl: "https://fixture.invalid",
  models: [{ id: "m", enabled: true, capacity: 100000, parameters: {} }],
};
function setup() {
  return {
    chat: newChat({ providerId: "p", modelId: "m" }),
    settings: {
      ...defaultSettings(),
      defaultModel: { providerId: "p", modelId: "m" },
    },
  };
}
describe("stable request prefixes and isolated comparison forks", () => {
  it("preserves shared front-plugin history prefixes on the same model and isolates different systems", () => {
    const { chat, settings } = setup();
    const clarify = pluginDefaults("clarify"),
      analysis = pluginDefaults("analysis");
    chat.plugins = [
      { ...clarify, enabled: true },
      { ...analysis, enabled: true },
    ];
    addMessage(chat, "user", "shared history user");
    addMessage(chat, "assistant", "shared history answer");
    const make = (p: typeof clarify) =>
      preparePlugin(chat, p, settings, [provider], emptyPluginState(), "latest")
        .request.messages;
    const c = make(clarify),
      a = make(analysis);
    expect(c[0]).toEqual(a[0]);
    expect(c[0]!.role).toBe("system");
    expect(c[1]!.content).toBe("shared history user");
    expect(
      c.findIndex((m) => m.content?.startsWith("【插件固定任务】")),
    ).toBeGreaterThan(1);
    analysis.system = "independent rules";
    const isolated = make(analysis);
    expect(isolated[0]).toEqual({
      role: "system",
      content: expect.stringContaining("independent rules"),
    });
    expect(isolated[1]!.content).toContain("【插件固定任务】");
  });
  it("keeps fixed prompt/schema/example before changing inputs for both front plugins", () => {
    const { chat, settings } = setup();
    addMessage(chat, "user", "history user");
    addMessage(chat, "assistant", "history answer");
    for (const kind of ["clarify", "analysis"] as const) {
      const p = {
        ...pluginDefaults(kind),
        example: "fixed example",
        rawRounds: 0,
      };
      const make = (input: string) =>
        preparePlugin(chat, p, settings, [provider], emptyPluginState(), input)
          .request.messages;
      const a = make("INPUT_ONE"),
        b = make("INPUT_TWO");
      expect(a.slice(0, -1)).toEqual(b.slice(0, -1));
      expect(a[1]!.content).toContain("fixed example");
      expect(a[0]!.content).not.toContain("INPUT_ONE");
      expect(a.at(-1)!.content).toContain("INPUT_ONE");
    }
  });
  it("keeps scoped length tool identifiers verbatim in the next main request", () => {
    const { chat } = setup();
    const u = addMessage(chat, "user", "first"),
      a = addMessage(chat, "assistant", "answer");
    const tool = lengthInjection(
      { ...chat, currentId: u.id },
      "one hundred characters",
      "fixed-id",
    );
    a.toolContext = {
      parentId: u.id,
      stable: true,
      messages: injectPlugins(
        [{ role: "user", content: u.content }],
        [tool],
      ).slice(1),
    };
    const first = contextMessages(chat);
    addMessage(chat, "user", "second");
    expect(contextMessages(chat).slice(0, -1)).toEqual(first);
    expect(JSON.stringify(first)).toContain("不再约束后续回复");
  });
  it("retains independent summary history records as the timeline grows", () => {
    const { chat, settings } = setup();
    addMessage(chat, "user", "u1");
    const a1 = addMessage(chat, "assistant", "a1");
    const state = {
      runs: [
        {
          id: "s1",
          messageId: a1.id,
          sourceKey: summarySourceKey(chat, a1.id),
          status: "complete" as const,
          summary: "s1",
          output: '{"summary":"s1"}',
          createdAt: 1,
          config: {
            model: null,
            system: "fixed",
            parameters: {},
            effort: "inherit" as const,
            stream: false,
          },
          inputTokens: 1,
        },
      ],
    };
    addMessage(chat, "user", "u2");
    const a2 = addMessage(chat, "assistant", "a2");
    const first = prepareSummary(chat, a2.id, state, settings, [provider])
      .request.messages;
    state.runs.push({
      ...state.runs[0]!,
      id: "s2",
      messageId: a2.id,
      sourceKey: summarySourceKey(chat, a2.id),
      summary: "s2",
    });
    addMessage(chat, "user", "u3");
    const a3 = addMessage(chat, "assistant", "a3");
    const second = prepareSummary(chat, a3.id, state, settings, [provider])
      .request.messages;
    expect(first.slice(0, -1)).toEqual(second.slice(0, first.length - 1));
  });
  it("keeps title instructions stable across different selected chats", () => {
    const { chat } = setup();
    const a = addMessage(chat, "user", "one");
    const first = titleMessages(
      "fixed rules {{MESSAGES:END:2}} final rules",
      chat,
      a.id,
    );
    const b = addMessage(chat, "assistant", "two");
    const second = titleMessages(
      "fixed rules {{MESSAGES:END:2}} final rules",
      chat,
      b.id,
    );
    expect(first[0]).toEqual(second[0]);
    expect(first[1]).not.toEqual(second[1]);
  });
  it("forks only the current main path, strips every tool in plain mode and preserves source data", () => {
    const { chat } = setup();
    chat.system = [{ id: "s", name: "s", content: "main system" }];
    const u = addMessage(chat, "user", "old"),
      a = addMessage(chat, "assistant", "MAIN_A");
    a.toolContext = {
      parentId: u.id,
      stable: true,
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "tool",
              type: "function",
              function: { name: "plugin", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "tool", content: "PRIVATE_TOOL" },
      ],
    };
    const user = addMessage(chat, "user", "new question");
    const before = structuredClone(chat);
    const config = {
      ...defaultComparison(),
      enabled: true,
      mode: "plain" as const,
      parameters: { temperature: 0 },
    };
    const plain = comparisonFork(chat, config, []);
    expect(contextMessages(plain).map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(JSON.stringify(contextMessages(plain))).not.toContain(
      "PRIVATE_TOOL",
    );
    expect(plain.parameters.temperature).toBe(0);
    expect(plain.comparison?.enabled).toBe(false);
    expect(plain.comparisonSource?.userId).toBe(user.id);
    expect(plain.title).toContain("分支01");
    expect(chat).toEqual(before);
    const same = comparisonFork(chat, { ...config, mode: "same" }, [
      plain.title,
    ]);
    expect(contextMessages(same)).toEqual(contextMessages(chat));
    expect(same.title).toContain("分支02");
  });
});
