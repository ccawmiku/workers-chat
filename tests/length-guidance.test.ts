import { describe, it, expect } from "vitest";
import {
  lengthInjection,
  withoutLengthTools,
} from "../src/shared/length-guidance";
import { newChat, addMessage, contextMessages } from "../src/shared/chat";
import { injectPlugins } from "../src/shared/plugins";
import { readPluginJSON } from "../src/shared/plugin-json";
import { sectionResult } from "../src/shared/plugin-sections";
import { normalizeSummary } from "../src/shared/summaries";

describe("bounded length guidance and structured output compatibility", () => {
  it("uses exactly the previous branch reply and distinguishes Unicode characters from reported tokens", () => {
    const chat = newChat();
    addMessage(chat, "user", "first");
    const first = addMessage(chat, "assistant", "旧回答");
    first.lengthRequirement = "不得累积";
    addMessage(chat, "user", "second");
    const previous = addMessage(chat, "assistant", "你好🙂");
    previous.lengthRequirement = "3000字左右";
    previous.reasoning = "must not count thinking";
    previous.usage = {
      prompt_tokens: 10,
      completion_tokens: 100,
      completion_tokens_details: { reasoning_tokens: 20 },
    };
    addMessage(chat, "user", "third");
    const item = lengthInjection(chat, "多写点", "current");
    const data = JSON.parse(item.content);
    expect(Object.keys(data)).toHaveLength(3);
    expect(data).toMatchObject({
      上一轮要求: "3000字左右",
      上一轮实际输出: { characters: 3, output_tokens: 80 },
      本轮要求: "多写点",
    });
    expect(item.content).not.toContain("不得累积");
    delete previous.usage;
    expect(
      JSON.parse(lengthInjection(chat, "", "empty").content),
    ).toMatchObject({ 本轮要求: "未提供", 上一轮实际输出: { characters: 3 } });
    expect(lengthInjection(chat, "", "empty").content).not.toContain(
      '"output_tokens"',
    );
    chat.currentId = first.id;
    expect(
      JSON.parse(lengthInjection(chat, "", "branch").content).上一轮要求,
    ).toBe("不得累积");
  });
  it("keeps one current paired tool call, removes historical length tools, and preserves other plugin traces", () => {
    const chat = newChat(),
      u = addMessage(chat, "user", "question");
    const length = lengthInjection(chat, "3000字", "one");
    const other = {
      pluginId: "analysis",
      name: "写前分析",
      template: "{{RESULT}}",
      content: "facts",
      runId: "other",
    };
    const original = injectPlugins(
      [{ role: "user", content: u.content }],
      [other, length],
    );
    const a = addMessage(chat, "assistant", "answer");
    a.toolContext = { parentId: u.id, messages: original.slice(1) };
    const history = contextMessages(chat);
    expect(JSON.stringify(history)).toContain("plugin_analysis");
    expect(JSON.stringify(history)).not.toContain("3000字");
    expect(
      withoutLengthTools(original).filter((m) => m.role === "tool"),
    ).toHaveLength(1);
    expect(original.filter((m) => m.role === "tool")).toHaveLength(2);
  });
  it("accepts one valid fenced JSON with harmless prose for sections and summaries without weakening schemas", () => {
    expect(
      sectionResult(
        '下面是结果：\n```json\n{"type":"动作","content":"放下杯子"}\n```\n已完成。',
      ).content,
    ).toBe("放下杯子");
    expect(
      normalizeSummary('摘要如下\n```json\n{"summary":"有效摘要"}\n```')
        .summary,
    ).toBe("有效摘要");
    expect(() => readPluginJSON("```json\n{}\n```\n```json\n{}\n```")).toThrow(
      "合法 JSON",
    );
    expect(() =>
      sectionResult('```json\n{"type":"x","content":}\n```'),
    ).toThrow("合法 JSON");
    expect(() =>
      normalizeSummary('```json\n{"summary":"", "extra":1}\n```'),
    ).toThrow("结构规则");
  });
});
