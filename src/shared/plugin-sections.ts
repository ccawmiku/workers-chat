import { readPluginJSON } from "./plugin-json";

export type AnalysisSection = {
  id: string;
  type: string;
  content: string;
  character?: string;
  instruction?: string;
};
export type AnalysisType = {
  id: string;
  type: string;
  instruction: string;
  scope?: "chat" | "global";
};
export type ClarifyQuestion = {
  id: string;
  question: string;
  multiple: boolean;
  options: { id: string; text: string }[];
};
export const QUESTION_SCHEMA = JSON.stringify({
  type: "object",
  required: ["questions"],
  additionalProperties: false,
  properties: {
    questions: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        required: ["id", "question", "multiple", "options"],
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: 128 },
          question: { type: "string", minLength: 1 },
          multiple: { type: "boolean" },
          options: {
            type: "array",
            minItems: 3,
            maxItems: 20,
            items: {
              type: "object",
              required: ["id", "text"],
              additionalProperties: false,
              properties: {
                id: { type: "string", minLength: 1, maxLength: 32 },
                text: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    },
  },
});
export function readQuestions(text: string): ClarifyQuestion[] {
  const result = readPluginJSON(text, QUESTION_SCHEMA) as {
    questions: ClarifyQuestion[];
  };
  if (
    new Set(result.questions.map((q) => q.id)).size !== result.questions.length
  )
    throw Error("问题 ID 重复");
  for (const q of result.questions)
    if (new Set(q.options.map((o) => o.id)).size !== q.options.length)
      throw Error("选项 ID 重复");
  return result.questions;
}
export function questionView(text: string): ClarifyQuestion[] | null {
  try {
    return readQuestions(text);
  } catch {
    return null;
  }
}
const labels: Record<string, string> = {
  scene_state: "场景记录",
  action_state: "动作记录",
  knowledge_boundaries: "认知边界",
  character_thoughts: "角色内心",
};
export function analysisSections(text: string): AnalysisSection[] {
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) return [];
    const sections = Object.entries(data).flatMap(
      ([key, value]): AnalysisSection[] => {
        if (
          key === "additional_sections" &&
          Array.isArray(value) &&
          value.every(
            (v) =>
              v &&
              typeof v === "object" &&
              typeof v.id === "string" &&
              typeof v.type === "string" &&
              typeof v.content === "string",
          )
        )
          return value.map((v) => ({ ...v }));
        if (
          key === "character_thoughts" &&
          Array.isArray(value) &&
          value.every(
            (v) =>
              v &&
              typeof v === "object" &&
              typeof v.character === "string" &&
              typeof v.thought === "string",
          )
        )
          return value.map((v, i) => ({
            id: "thought:" + i,
            type: "角色内心",
            character: v.character,
            content: v.thought,
          }));
        return [
          {
            id: key,
            type: Object.hasOwn(labels, key) ? labels[key]! : key,
            content:
              typeof value === "string"
                ? value
                : JSON.stringify(value, null, 2),
          },
        ];
      },
    );
    return new Set(sections.map((s) => s.id)).size === sections.length
      ? sections
      : [];
  } catch {
    return [];
  }
}
export function sectionResult(text: string): AnalysisSection {
  const data = readPluginJSON(
    text,
    JSON.stringify({
      type: "object",
      required: ["type", "content"],
      additionalProperties: false,
      properties: {
        type: { type: "string", minLength: 1, maxLength: 100 },
        content: { type: "string", minLength: 1 },
        instruction: { type: "string", maxLength: 10000 },
      },
    }),
  ) as Omit<AnalysisSection, "id">;
  if (!data.type.trim() || !data.content.trim())
    throw Error("类型和内容不能为空");
  return { ...data, id: "" };
}
export function mergeSection(
  text: string,
  targetId: string | null,
  section: AnalysisSection,
  remove = false,
): string {
  const data = JSON.parse(text),
    current = analysisSections(text).find((s) => s.id === targetId);
  if (targetId && !current) throw Error("原分块不存在");
  if (!targetId) {
    const extra = (data.additional_sections ??= []);
    if (extra.length >= 64) throw Error("本轮新增类型最多 64 个");
    if (analysisSections(text).some((s) => s.id === section.id))
      throw Error("分块 ID 重复");
    extra.push(section);
  } else if (
    targetId.startsWith("thought:") &&
    current?.character !== undefined
  ) {
    data.character_thoughts[Number(targetId.slice(8))].thought = remove
      ? "none"
      : section.content;
  } else if (Object.hasOwn(data, targetId)) {
    const old = data[targetId];
    data[targetId] = remove
      ? "none"
      : typeof old === "string"
        ? section.content
        : JSON.parse(section.content);
  } else {
    const index =
      data.additional_sections?.findIndex(
        (s: AnalysisSection) => s.id === targetId,
      ) ?? -1;
    if (index < 0) throw Error("原分块不存在");
    if (remove) data.additional_sections.splice(index, 1);
    else
      data.additional_sections[index] = {
        ...data.additional_sections[index],
        content: section.content,
      };
  }
  return JSON.stringify(data, null, 2);
}
export function clarifyAnswer(
  output: string,
  selections: unknown,
  freeText: string,
): string {
  const questions = readQuestions(output),
    selected = (
      selections && typeof selections === "object" && !Array.isArray(selections)
        ? selections
        : {}
    ) as Record<string, unknown>;
  const lines = questions.map((q, index) => {
    const values = Object.hasOwn(selected, q.id) ? (selected[q.id] ?? []) : [];
    if (
      !Array.isArray(values) ||
      values.some(
        (v) => typeof v !== "string" || !q.options.some((o) => o.id === v),
      ) ||
      new Set(values).size !== values.length ||
      (!q.multiple && values.length > 1)
    )
      throw Error("问题选择无效");
    return `${index + 1}. ${q.question}\n${
      values.length
        ? q.options
            .filter((o) => values.includes(o.id))
            .map((o) => o.id + ". " + o.text)
            .join("\n")
        : "本题跳过，不再追问"
    }`;
  });
  if (freeText.trim()) lines.push("用户自由回答（原文）：\n" + freeText);
  return lines.join("\n\n");
}
