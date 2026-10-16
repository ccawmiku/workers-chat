import { type Chat, contextTurns } from "./chat";

export function renderTitlePrompt(
  template: string,
  chat: Chat,
  selection: string,
) {
  const copy = { ...chat, currentId: selection };
  const messages = contextTurns(copy)
    .filter((turn) => !turn.some((m) => m.excluded))
    .flat()
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
    .map((m) => ({ role: m.role, content: m.content }));
  return template.replace(
    /\{\{MESSAGES:(START|END):(\d+)\}\}/g,
    (_match, side: string, value: string) => {
      const count = Math.min(Number(value), messages.length);
      return JSON.stringify(
        side === "END"
          ? messages.slice(messages.length - count)
          : messages.slice(0, count),
      );
    },
  );
}

export function extractTitle(value: string) {
  const text = value
    .trim()
    .replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{"),
      end = text.lastIndexOf("}");
    if (start >= 0 && end > start)
      parsed = JSON.parse(text.slice(start, end + 1));
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { title?: unknown }).title !== "string"
  )
    throw new Error("标题模型需返回包含 title 字符串的 JSON");
  const title = (parsed as { title: string }).title.trim();
  if (!title || title.length > 500)
    throw new Error("标题为空或超过 500 个字符");
  return title;
}
