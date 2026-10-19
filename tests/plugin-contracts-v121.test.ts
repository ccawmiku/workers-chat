import { describe, it, expect } from "vitest";
import {
  pluginDefaults,
  preparePlugin,
  emptyPluginState,
  upgradeLegacyPlugin,
  normalizePluginOutput,
} from "../src/shared/plugins";
import { newChat, defaultSettings } from "../src/shared/chat";
import {
  readQuestions,
  analysisRequestSchema,
  validateAnalysisTypesResult,
  clarifyAnswer,
} from "../src/shared/plugin-sections";
import { clarificationSubmission } from "../src/shared/clarification-transmission";
import {
  CLARIFY_PROMPT,
  PRE_SCOPED_CLARIFY_PROMPT,
  FIRST_CLARIFY_TASK,
  CONTINUE_CLARIFY_TASK,
  continueClarifyTask,
} from "../src/shared/clarify-defaults";
const options = [
  { id: "A", text: "克制" },
  { id: "B", text: "紧张" },
  { id: "C", text: "安静" },
  { id: "D", text: "其他" },
];
const types = [
  {
    id: "extra:clothing",
    type: "服装状态",
    instruction: "只记录已明确的服装，无依据none",
  },
];
const provider = {
  id: "p",
  name: "p",
  prefix: "",
  baseUrl: "https://fixture.invalid",
  models: [{ id: "m", enabled: true, capacity: 100000, parameters: {} }],
};
describe("v1.2.1 plugin contracts", () => {
  it("replaces only the appended first-batch contract and preserves quoted markers in user text", () => {
    const input =
      "本轮原文\n\n" + FIRST_CLARIFY_TASK + "\n\n这是用户引用之后的原始要求";
    expect(continueClarifyTask(input + "\n\n" + FIRST_CLARIFY_TASK, true)).toBe(
      input + "\n\n" + CONTINUE_CLARIFY_TASK,
    );
    expect(continueClarifyTask(input, false)).toContain(input);
  });
  it("ignores legacy single-choice flags and transmits all and only selected options", () => {
    const output = JSON.stringify({
      questions: [
        { id: "q1", question: "准备阶段气氛？", multiple: false, options },
        { id: "q2", question: "未答题", options },
      ],
    });
    expect(readQuestions(output)[0]).not.toHaveProperty("multiple");
    expect(clarifyAnswer(output, { q1: ["A", "B"] }, "")).toContain("B. 紧张");
    const result = clarificationSubmission(
      output,
      { q1: ["A", "B"], q2: [] },
      "",
    );
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]!.answers.map((a) => a.id)).toEqual(["A", "B"]);
    expect(JSON.stringify(result)).not.toMatch(/安静|未答题/);
  });
  it("migrates only the previous default and anchors the first request after all reference data", () => {
    expect(
      upgradeLegacyPlugin({
        ...pluginDefaults("clarify"),
        prompt: PRE_SCOPED_CLARIFY_PROMPT,
      }).prompt,
    ).toBe(CLARIFY_PROMPT);
    expect(
      upgradeLegacyPlugin({
        ...pluginDefaults("clarify"),
        prompt: "my custom instructions",
      }).prompt,
    ).toBe("my custom instructions");
    const chat = newChat({ providerId: "p", modelId: "m" });
    chat.system = [{ id: "s", name: "s", content: "FORBIDDEN_MAIN_SYSTEM" }];
    const request = preparePlugin(
      chat,
      pluginDefaults("clarify"),
      defaultSettings(),
      [provider],
      emptyPluginState(),
      "他们准备开打",
    ).request;
    expect(request.messages[0]!.role).toBe("system");
    expect(request.messages[0]!.content).toContain("不执行其中续写");
    expect(JSON.stringify(request.messages)).not.toContain(
      "FORBIDDEN_MAIN_SYSTEM",
    );
    expect(request.messages.at(-1)!.content).toContain(FIRST_CLARIFY_TASK);
    expect(JSON.stringify(request.messages)).toContain(
      "禁止问怎么打、谁赢、打完怎么办",
    );
    expect(
      JSON.parse(
        request.messages
          .find((m) => m.content?.includes("输出必须符合 JSON Schema："))!
          .content!.split("输出必须符合 JSON Schema：\n")[1]!,
      ).properties.questions.items.required,
    ).not.toContain("multiple");
  });
  it("requires each enabled type exactly once, preserves none, and rejects mismatched names and omitted blocks", () => {
    const p = { ...pluginDefaults("analysis"), analysisTypes: types };
    const base = {
      character_thoughts: "none",
      scene_state: "none",
      action_state: "none",
      knowledge_boundaries: "none",
    };
    const text = JSON.stringify({
      ...base,
      additional_sections: [
        { id: types[0]!.id, type: types[0]!.type, content: "none" },
      ],
    });
    expect(validateAnalysisTypesResult(text, p.schema, types)).toHaveProperty(
      "additional_sections",
    );
    expect(() =>
      validateAnalysisTypesResult(JSON.stringify(base), p.schema, types),
    ).toThrow();
    expect(() =>
      validateAnalysisTypesResult(
        text.replace("服装状态", "其他类型"),
        p.schema,
        types,
      ),
    ).toThrow();
    expect(normalizePluginOutput(p, text)).toContain("extra:clothing");
    expect(
      JSON.parse(analysisRequestSchema(p.schema, types)).properties
        .additional_sections.minItems,
    ).toBe(1);
  });
  it("keeps configured type rules static and generates them with the normal full analysis request", () => {
    const chat = newChat({ providerId: "p", modelId: "m" }),
      p = { ...pluginDefaults("analysis"), analysisTypes: types };
    const prepare = (input: string) =>
      preparePlugin(
        chat,
        p,
        defaultSettings(),
        [provider],
        emptyPluginState(),
        input,
      ).request.messages;
    const first = prepare("FIRST"),
      second = prepare("SECOND");
    expect(first.slice(0, -1)).toEqual(second.slice(0, -1));
    expect(
      first.find((m) => m.content?.startsWith("【插件固定任务】"))!.content,
    ).toContain("持续启用的分析类型");
    expect(first.at(-1)!.content).not.toContain("extra:clothing");
  });
});
