import { describe, it, expect } from "vitest";
import {
  analysisSections,
  mergeSection,
  readQuestions,
  clarifyAnswer,
  sectionResult,
  questionView,
} from "../src/shared/plugin-sections";
import { pluginDefaults, upgradeLegacyPlugin } from "../src/shared/plugins";
import {
  PRE_BLOCK_ANALYSIS_PROMPT,
  PRE_BLOCK_ANALYSIS_SCHEMA,
  ANALYSIS_PROMPT,
} from "../src/shared/analysis-defaults";
const original = {
  character_thoughts: [
    { character: "甲", thought: "我没有看见来人。" },
    { character: "乙", thought: "none" },
  ],
  scene_state: "茶室",
  action_state: "放下茶杯",
  knowledge_boundaries: "甲不知道来人是谁",
};
const question = {
  id: "q1",
  question: "选择行动",
  multiple: false,
  options: [
    { id: "A", text: "留在茶室" },
    { id: "B", text: "走到门边" },
    { id: "C", text: "先等一下" },
  ],
};
describe("structured plugin blocks", () => {
  it("retains custom JSON fields safely when they resemble built-in arrays or prototype keys", () => {
    const text =
      '{"character_thoughts":[null],"additional_sections":[{"type":{}}],"constructor":"custom","thought:custom":"value"}';
    const sections = analysisSections(text);
    expect(sections).toHaveLength(4);
    expect(
      sections.every(
        (s) => typeof s.type === "string" && typeof s.content === "string",
      ),
    ).toBe(true);
    expect(
      JSON.parse(
        mergeSection(text, "thought:custom", {
          id: "thought:custom",
          type: "custom",
          content: "changed",
        }),
      )["thought:custom"],
    ).toBe("changed");
    expect(
      JSON.parse(
        mergeSection(text, "additional_sections", {
          id: "additional_sections",
          type: "custom",
          content: "[]",
        }),
      ).additional_sections,
    ).toEqual([]);
    expect(
      clarifyAnswer(
        JSON.stringify({ questions: [{ ...question, id: "constructor" }] }),
        {},
        "",
      ),
    ).toContain("本题跳过");
    expect(
      analysisSections(
        '{"scene_state":"room","additional_sections":[{"id":"scene_state","type":"x","content":"x"}]}',
      ),
    ).toEqual([]);
  });
  it("maps individual characters and fields while retaining all other values on a local edit", () => {
    const text = JSON.stringify(original),
      sections = analysisSections(text);
    expect(sections.map((s) => s.id)).toEqual([
      "thought:0",
      "thought:1",
      "scene_state",
      "action_state",
      "knowledge_boundaries",
    ]);
    const next = JSON.parse(
      mergeSection(text, "thought:1", {
        id: "thought:1",
        type: "角色内心",
        content: "我听到有人敲门。",
      }),
    );
    expect(next).toEqual({
      ...original,
      character_thoughts: [
        original.character_thoughts[0],
        { character: "乙", thought: "我听到有人敲门。" },
      ],
    });
    expect(original.character_thoughts[1]!.thought).toBe("none");
  });
  it("adds and removes custom blocks without changing default sections", () => {
    const section = { id: "extra:one", type: "服装", content: "灰色外套" },
      text = mergeSection(JSON.stringify(original), null, section);
    expect(JSON.parse(text)).toEqual({
      ...original,
      additional_sections: [section],
    });
    expect(JSON.parse(mergeSection(text, section.id, section, true))).toEqual({
      ...original,
      additional_sections: [],
    });
    expect(
      JSON.parse(
        mergeSection(text, "scene_state", { ...section, content: "" }, true),
      ).scene_state,
    ).toBe("none");
    expect(() => mergeSection(text, "missing", section)).toThrow("不存在");
    expect(() => mergeSection(text, null, section)).toThrow("重复");
  });
  it("validates independent question/option fields and unique stable identities", () => {
    const text = JSON.stringify({ questions: [question] });
    expect(readQuestions(text)).toEqual([question]);
    expect(() =>
      readQuestions(JSON.stringify({ questions: [question, question] })),
    ).toThrow("重复");
    expect(() =>
      readQuestions(
        JSON.stringify({
          questions: [
            {
              ...question,
              options: [
                question.options[0],
                question.options[0],
                question.options[1],
              ],
            },
          ],
        }),
      ),
    ).toThrow("重复");
    expect(questionView("旧版自然语言问题")).toBeNull();
    expect(readQuestions('{"questions":[]}')).toEqual([]);
  });
  it("sends full selected option text, preserves free text and explicitly skips unselected questions", () => {
    const text = JSON.stringify({
        questions: [question, { ...question, id: "q2", question: "选择地点" }],
      }),
      answer = clarifyAnswer(text, { q1: ["B"] }, "  自由回答原文\n保留空格  ");
    expect(answer).toContain("1. 选择行动\nB. 走到门边");
    expect(answer).toContain("2. 选择地点\n本题跳过，不再追问");
    expect(answer).toContain("  自由回答原文\n保留空格  ");
    for (const selections of [
      { q1: ["A", "B"] },
      { q1: ["Z"] },
      { q1: ["A", "A"] },
      { q1: "A" },
    ])
      expect(() => clarifyAnswer(text, selections, "")).toThrow("选择无效");
    expect(
      clarifyAnswer(
        JSON.stringify({ questions: [{ ...question, multiple: true }] }),
        { q1: ["A", "C"] },
        "",
      ),
    ).toContain("C. 先等一下");
  });
  it("accepts only one block from a partial request, never a full replacement", () => {
    expect(
      sectionResult(
        '{"type":"服装","content":"灰色外套","instruction":"记录既有服装"}',
      ).content,
    ).toBe("灰色外套");
    for (const text of [
      '{"type":"服装","content":" "}',
      '{"scene_state":"场景"}',
      '{"type":"服装","content":"内容","scene_state":"偷改其他块"}',
    ])
      expect(() => sectionResult(text)).toThrow();
  });
  it("upgrades built-in names/prompts, excludes protagonist thoughts and preserves custom text", () => {
    const p = pluginDefaults("analysis");
    expect(p.name).toBe("写前分析");
    expect(ANALYSIS_PROMPT).toContain("不要生成主角或‘你’的第一人称想法");
    expect(
      upgradeLegacyPlugin({
        ...p,
        name: "JSON 分析",
        cardTitle: "JSON 分析",
        prompt: PRE_BLOCK_ANALYSIS_PROMPT,
        schema: PRE_BLOCK_ANALYSIS_SCHEMA,
      }),
    ).toMatchObject({ name: "写前分析", prompt: ANALYSIS_PROMPT });
    expect(
      upgradeLegacyPlugin({ ...p, name: "自己的名称", prompt: "自己的规则" }),
    ).toMatchObject({ name: "自己的名称", prompt: "自己的规则" });
  });
});
