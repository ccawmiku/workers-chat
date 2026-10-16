import { sanitizeUsage } from "./chat";
export type CompletionOutput = {
  content: string;
  reasoning: string;
  usage?: Record<string, unknown>;
};
export function redactUpstreamError(value: string, key: string) {
  return (key ? value.replaceAll(key, "[已隐藏密钥]") : value)
    .replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]")
    .slice(0, 2000);
}
export async function readResponseText(
  response: Response,
  signal: AbortSignal,
  max = 8 * 1024 * 1024,
) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  let text = "",
    size = 0;
  const decoder = new TextDecoder();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) return text + decoder.decode();
      size += part.value.byteLength;
      if (size > max) throw Error("上游响应超过安全上限");
      text += decoder.decode(part.value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
  }
}
export async function readCompletion(
  response: Response,
  stream: boolean,
  signal: AbortSignal,
  output: CompletionOutput,
  onUpdate: () => void,
) {
  if (!response.ok)
    throw Error(
      `上游 HTTP ${response.status}：${await readResponseText(response, signal, 8192)}`,
    );
  if (!stream) {
    const data = JSON.parse(await readResponseText(response, signal));
    const message = data.choices?.[0]?.message;
    if (!message) throw Error("上游没有返回回答");
    output.content +=
      typeof message.content === "string" ? message.content : "";
    output.reasoning = message.reasoning_content ?? message.reasoning ?? "";
    output.usage = sanitizeUsage(data.usage);
    onUpdate();
    return;
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error("上游没有返回响应流");
  const decoder = new TextDecoder();
  let buffer = "",
    finished = false,
    doneEvent = false,
    size = 0;
  const consume = (block: string) => {
    const text = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!text) return;
    if (text === "[DONE]") {
      finished = doneEvent = true;
      return;
    }
    const event = JSON.parse(text);
    if (event.error) throw Error(event.error.message ?? "上游流式错误");
    const choice = event.choices?.[0],
      delta = choice?.delta;
    if (typeof delta?.content === "string") output.content += delta.content;
    output.reasoning +=
      typeof delta?.reasoning_content === "string"
        ? delta.reasoning_content
        : typeof delta?.reasoning === "string"
          ? delta.reasoning
          : "";
    if (event.usage) output.usage = sanitizeUsage(event.usage);
    if (choice?.finish_reason) finished = true;
    onUpdate();
  };
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!doneEvent) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.value) size += part.value.byteLength;
      if (size > 8 * 1024 * 1024) throw Error("上游响应超过安全上限");
      buffer = (
        buffer + decoder.decode(part.value, { stream: !part.done })
      ).replace(/\r\n|\r(?!$)/g, "\n");
      if (part.done) buffer = buffer.replace(/\r$/, "\n");
      let split: number;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        if (split > 1048576) throw Error("上游 SSE 事件超过安全上限");
        consume(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
        if (doneEvent) break;
      }
      if (buffer.length > 1048576) throw Error("上游 SSE 事件超过安全上限");
      if (part.done) {
        if (buffer.trim()) consume(buffer);
        break;
      }
    }
    if (!finished) throw Error("上游连接提前结束，已保存收到的部分");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
  }
}
