import { route, type Chat } from "./chat";
import type { APIMessage, PluginInjection } from "./plugins";
import { tokenBreakdown } from "./usage";

export const LENGTH_PLUGIN_ID = "reply-length";
const functionName = "plugin_reply_length";
export type LengthGuidance = { enabled: boolean; requirement: string };

/** Exactly one previous reply on this branch, never cumulative requirements. */
export function lengthInjection(
  chat: Chat,
  requirement: string,
  id: string,
): PluginInjection {
  const previous = route(chat).findLast((m) => m.role === "assistant");
  let characters = 0;
  if (previous) for (const _ of previous.content) characters++;
  const usage = previous ? tokenBreakdown(previous.usage) : null;
  const actual = previous
    ? {
        characters,
        ...(usage &&
        (typeof previous?.usage?.completion_tokens === "number" ||
          typeof previous?.usage?.output_tokens === "number")
          ? { output_tokens: usage.output }
          : {}),
        units:
          "characters为当前正文Unicode字符数（含标点空白）；output_tokens仅在上游提供原始生成用量时填写，不含思考，手工编辑后不重算此Token量；字符与Token不是同一单位",
      }
    : "未提供（无上一轮回复）";
  return {
    pluginId: LENGTH_PLUGIN_ID,
    name: "字数要求",
    runId: id,
    template:
      "以下仅为紧邻用户消息这一轮的写作长度参考，按用户自然语言要求尽量调整，不把它当作正文，也不声称能精确满足Token数。此工具结果作为历史记录保留时不再约束后续回复；后续轮次只使用其自己的最新要求，没有新要求时不得沿用旧轮次的字数限制。\n{{RESULT}}",
    content: JSON.stringify({
      上一轮要求: previous?.lengthRequirement?.trim() || "未提供",
      上一轮实际输出: actual,
      本轮要求: requirement.trim() || "未提供",
    }),
  };
}

/** Remove legacy, unscoped length results; new scoped preludes replay unchanged. */
export function withoutLengthTools(messages: APIMessage[]): APIMessage[] {
  const ids = new Set(
    messages.flatMap(
      (m) =>
        m.tool_calls
          ?.filter((c) => c.function.name === functionName)
          .map((c) => c.id) ?? [],
    ),
  );
  return messages.flatMap((m) => {
    if (
      m.role === "tool" &&
      (m.name === functionName || ids.has(m.tool_call_id ?? ""))
    )
      return [];
    if (!m.tool_calls?.some((c) => ids.has(c.id))) return [m];
    const calls = m.tool_calls.filter((c) => !ids.has(c.id));
    return calls.length
      ? [{ ...m, tool_calls: calls }]
      : m.content
        ? [{ ...m, tool_calls: undefined }]
        : [];
  });
}
