import { describe, it, expect } from "vitest";
import {
  clarificationSubmission,
  legacyClarificationSubmission,
  cleanLegacyClarificationTools,
} from "../src/shared/clarification-transmission";
import { clarifyAnswer } from "../src/shared/plugin-sections";
import {
  flowInjections,
  pluginDefaults,
  type APIMessage,
  type PluginState,
} from "../src/shared/plugins";
import { upgradeLegacyPlugin } from "../src/shared/plugin-migrations";
import {
  ANALYSIS_PROMPT,
  PRE_PRESENT_ANALYSIS_PROMPT,
} from "../src/shared/analysis-defaults";

const questions = JSON.stringify({
  questions: [
    {
      id: "q1",
      question: "选哪种风格？",
      multiple: false,
      options: [
        { id: "A", text: "轻松" },
        { id: "B", text: "严肃" },
        { id: "C", text: "中性" },
      ],
    },
    {
      id: "q2",
      question: "走哪条路线？",
      multiple: true,
      options: [
        { id: "A", text: "公路" },
        { id: "B", text: "水路" },
        { id: "C", text: "铁路" },
      ],
    },
    {
      id: "q3",
      question: "未回答的秘密问题？",
      multiple: false,
      options: [
        { id: "A", text: "秘密选项" },
        { id: "B", text: "秘密二" },
        { id: "C", text: "秘密三" },
      ],
    },
  ],
});
describe("supplementary answers transmitted to the main model", () => {
  it("includes only selected answers, omits skipped questions and preserves free text", () => {
    const s = clarificationSubmission(
      questions,
      { q1: ["A"], q2: [], q3: [] },
      "照原来的语气",
    );
    expect(s).toEqual({
      questions: [
        {
          id: "q1",
          question: "选哪种风格？",
          answers: [{ id: "A", text: "轻松" }],
        },
      ],
      free_text: "照原来的语气",
    });
    expect(JSON.stringify(s)).not.toMatch(/严肃|路线|秘密|options/);
    expect(clarificationSubmission(questions, {}, "")).toEqual({
      questions: [],
    });
    expect(
      clarificationSubmission(questions, {}, "1A 2AB").questions.map(
        (q) => q.answers.length,
      ),
    ).toEqual([1, 2]);
    expect(clarificationSubmission(questions, {}, "自由说明")).toEqual({
      questions: [],
      free_text: "自由说明",
    });
  });
  it("migrates old deterministic transcripts without changing their displayed history", () => {
    const answer = clarifyAnswer(
      questions,
      { q1: ["B"], q2: ["A", "B"] },
      "补充要求",
    );
    const s = legacyClarificationSubmission(questions, answer);
    expect(s.questions.map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(s.questions[0]!.answers).toEqual([{ id: "B", text: "严肃" }]);
    expect(s.free_text).toBe("补充要求");
    expect(answer).toContain("未回答的秘密问题");
    expect(JSON.stringify(s)).not.toContain("秘密");
    expect(
      legacyClarificationSubmission(questions, "修改后的自由回答"),
    ).toEqual({ questions: [], free_text: "修改后的自由回答" });
  });
  it("keeps full question batches private to the questioner and drops empty tool submissions", () => {
    const plugin = pluginDefaults("clarify");
    const run = {
      id: "r1",
      plugin,
      status: "answered",
      output: questions,
      answer: clarifyAnswer(questions, { q1: ["A"] }, ""),
    };
    const flow = { id: "f1", results: ["r1"], definitions: [plugin] };
    const state = { runs: [run], flows: [flow] } as unknown as PluginState;
    expect(flowInjections(state, state.flows[0]!)[0]!.content).not.toMatch(
      /秘密|严肃|options/,
    );
    expect(flowInjections(state, state.flows[0]!, true)[0]!.content).toContain(
      "秘密选项",
    );
    state.runs[0]!.answer = clarifyAnswer(questions, {}, "");
    expect(flowInjections(state, state.flows[0]!)).toEqual([]);
  });
  it("cleans legacy main tool snapshots and removes matching empty tool calls while preserving other tools", () => {
    const call = (id: string) => ({
      id,
      type: "function" as const,
      function: { name: "fixture", arguments: "{}" },
    });
    const messages: APIMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [call("selected"), call("empty"), call("analysis")],
      },
      {
        role: "tool",
        tool_call_id: "selected",
        content:
          "模板前缀 {其他内容} 结果：" +
          JSON.stringify({
            questions,
            answer: clarifyAnswer(questions, { q1: ["A"] }, ""),
          }),
      },
      {
        role: "tool",
        tool_call_id: "empty",
        content: JSON.stringify({
          questions,
          answer: clarifyAnswer(questions, {}, ""),
        }),
      },
      {
        role: "tool",
        tool_call_id: "analysis",
        content: '{"scene_state":"旧状态"}',
      },
    ];
    const clean = cleanLegacyClarificationTools(messages);
    expect(clean[0]!.tool_calls?.map((c) => c.id)).toEqual([
      "selected",
      "analysis",
    ]);
    expect(clean.filter((m) => m.role === "tool")).toHaveLength(2);
    expect(JSON.stringify(clean)).not.toMatch(/秘密|严肃|options/);
    expect(messages).toHaveLength(4);
    expect(cleanLegacyClarificationTools(clean)).toEqual(clean);
  });
  it("upgrades built-in names and exact previous analysis defaults but preserves custom settings", () => {
    const p = pluginDefaults("clarify");
    expect(
      upgradeLegacyPlugin({ ...p, name: "提问澄清", cardTitle: "提问澄清" }),
    ).toMatchObject({ name: "补充提问", cardTitle: "补充提问" });
    expect(upgradeLegacyPlugin({ ...p, name: "我的提问" }).name).toBe(
      "我的提问",
    );
    const a = pluginDefaults("analysis");
    expect(
      upgradeLegacyPlugin({ ...a, prompt: PRE_PRESENT_ANALYSIS_PROMPT }).prompt,
    ).toBe(ANALYSIS_PROMPT);
    expect(ANALYSIS_PROMPT).toContain("不在场");
    expect(upgradeLegacyPlugin({ ...a, prompt: "用户自定义" }).prompt).toBe(
      "用户自定义",
    );
  });
});
