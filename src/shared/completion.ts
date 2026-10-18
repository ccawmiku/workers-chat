import { mergeUsage } from "./chat";
export function responseUsage(
  headers: Headers,
  body?: unknown,
  previous?: unknown,
) {
  let usage = mergeUsage(previous, undefined);
  for (const name of [
    "x-cache-hit-rate",
    "cache-hit-rate",
    "x-cache-hit-ratio",
  ]) {
    const value = headers.get(name);
    if (value !== null && usage?.cache_hit_rate === undefined) {
      const next = mergeUsage(usage, { cache_hit_rate: value });
      if (next?.cache_hit_rate !== undefined) {
        usage = next;
        break;
      }
    }
  }
  const data =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  usage = mergeUsage(usage, data);
  usage = mergeUsage(usage, data.usage);
  return usage;
}
/** Most SSE frames contain only text: avoid sanitizing and copying stats for each token. */
export function hasReportedUsage(value: unknown) {
  if (!value || typeof value !== "object") return false;
  return [
    "usage",
    "cache_hit_rate",
    "cacheHitRate",
    "cache_hit_ratio",
    "prompt_tokens",
    "input_tokens",
    "completion_tokens",
    "output_tokens",
    "total_tokens",
    "cached_tokens",
    "reasoning_tokens",
    "thinking_tokens",
  ].some((key) => key in value);
}
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
  heartbeatMs?: number,
) {
  if (!response.ok)
    throw Error(
      `上游 HTTP ${response.status}：${await readResponseText(response, signal, 8192)}`,
    );
  output.usage = responseUsage(response.headers, undefined, output.usage);
  if (!stream) {
    const data = JSON.parse(await readResponseText(response, signal));
    const message = data.choices?.[0]?.message;
    if (!message) throw Error("上游没有返回回答");
    output.content +=
      typeof message.content === "string" ? message.content : "";
    output.reasoning = message.reasoning_content ?? message.reasoning ?? "";
    output.usage = responseUsage(response.headers, data, output.usage);
    onUpdate();
    return;
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error("上游没有返回响应流");
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "",
    finished = false,
    doneEvent = false,
    size = encoder.encode(output.content + output.reasoning).byteLength;
  const append = (kind: "content" | "reasoning", text: unknown) => {
    if (typeof text !== "string") return;
    size += encoder.encode(text).byteLength;
    if (size > 8 * 1024 * 1024) throw Error("上游回答文字超过安全上限");
    output[kind] += text;
  };
  let lastUpdate = Date.now();
  const notify = () => {
    if (heartbeatMs !== undefined) lastUpdate = Date.now();
    onUpdate();
  };
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
    append("content", delta?.content);
    append(
      "reasoning",
      typeof delta?.reasoning_content === "string"
        ? delta.reasoning_content
        : delta?.reasoning,
    );
    if (hasReportedUsage(event))
      output.usage = responseUsage(response.headers, event, output.usage);
    if (choice?.finish_reason) finished = true;
    notify();
  };
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    let pending = reader.read();
    while (!doneEvent) {
      signal.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let part: ReadableStreamReadResult<Uint8Array> | null;
      try {
        part =
          heartbeatMs === undefined
            ? await pending
            : await Promise.race([
                pending,
                new Promise<null>((resolve) => {
                  timer = setTimeout(() => resolve(null), heartbeatMs);
                }),
              ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      signal.throwIfAborted();
      if (!part) {
        // Reuse the outstanding read: a quiet upstream must not accumulate
        // readers or make a live generation look interrupted to observers.
        notify();
        continue;
      }
      // Bound the assembled answer and each event, not SSE framing/heartbeats.
      // Long streams may carry much more protocol metadata than actual text.
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
      if (heartbeatMs !== undefined && Date.now() - lastUpdate >= heartbeatMs)
        notify();
      if (part.done) {
        if (buffer.trim()) consume(buffer);
        break;
      }
      if (!doneEvent) pending = reader.read();
    }
    if (!finished) throw Error("上游连接提前结束，已保存收到的部分");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
  }
}
