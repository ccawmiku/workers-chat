import type { APIMessage } from "./plugins";
/** DeepSeek thinking + tool history requires reasoning_content on assistant turns.
 * Synthetic plugin calls have no model reasoning, hence the truthful empty string.
 * https://api-docs.deepseek.com/guides/thinking_mode/
 */
export function compatibleMessages(
  model: string,
  messages: APIMessage[],
): APIMessage[] {
  if (!/(^|\/)deepseek(?:[-/]|$)/i.test(model)) return messages;
  return messages.map((m) =>
    m.role === "assistant"
      ? { ...m, reasoning_content: m.reasoning_content ?? "" }
      : m,
  );
}
