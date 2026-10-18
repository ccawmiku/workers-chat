import { describe, it, expect, vi } from "vitest";
import {
  newChat,
  addMessage,
  duplicateChat,
  forkChat,
  route,
} from "../src/shared/chat";
import { renderTitlePrompt, extractTitle } from "../src/shared/title-template";
import {
  readCompletion,
  type CompletionOutput,
} from "../src/shared/completion";

describe("direct transport and templates", () => {
  it("duplicates every branch independently while Fork copies only ancestors", () => {
    const chat = newChat();
    const user = addMessage(chat, "user", "Q");
    const a = addMessage(chat, "assistant", "A");
    const b = addMessage(chat, "assistant", "B", user.id);
    chat.draft = "not copied";
    chat.groupId = "folder";
    const copy = duplicateChat(chat, []);
    expect(Object.keys(copy.messages)).toHaveLength(3);
    expect(route(copy).map((m) => m.content)).toEqual(["Q", "B"]);
    expect(Object.keys(copy.messages).some((id) => chat.messages[id])).toBe(
      false,
    );
    expect(copy.groupId).toBe("folder");
    expect(copy.draft).toBe("");
    expect(copy.id).not.toBe(chat.id);
    expect(Object.keys(forkChat(chat, a.id, []).messages)).toHaveLength(2);
    copy.messages[copy.currentId!]!.content = "independent";
    expect(b.content).toBe("B");
  });
  it("expands message placeholders at their positions without reasoning while ignoring legacy exclusion switches", () => {
    const chat = newChat();
    const u = addMessage(chat, "user", "old question");
    addMessage(chat, "assistant", "old answer").reasoning = "private";
    addMessage(chat, "user", "new question");
    addMessage(chat, "assistant", "new answer");
    expect(renderTitlePrompt("{{MESSAGES:END:2}}", chat, chat.currentId!)).toBe(
      JSON.stringify([
        { role: "user", content: "new question" },
        { role: "assistant", content: "new answer" },
      ]),
    );
    u.excluded = true;
    const result = renderTitlePrompt(
      "prefix {{MESSAGES:START:1}} suffix {{MESSAGES:END:0}}",
      chat,
      chat.currentId!,
    );
    expect(result).toBe(
      'prefix [{"role":"user","content":"old question"}] suffix []',
    );
    expect(result).not.toContain("private");
    expect(extractTitle('```json\n{"title":"📖 新话题"}\n```')).toBe(
      "📖 新话题",
    );
    expect(() => extractTitle("just plain text")).toThrow();
  });
  it("parses fragmented UTF-8 and CRLF SSE with reasoning and trailing usage", async () => {
    const bytes = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"你好"},"finish_reason":"stop"}]}\r\n\r\ndata: {"choices":[],"usage":{"total_tokens":12,"cached_tokens":8,"cache_hit_rate":"66.7%"}}\r\n\r\ndata: [DONE]\r\n\r\n',
    );
    const output: CompletionOutput = { content: "", reasoning: "" };
    const stream = new ReadableStream({
      start(c) {
        for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
        c.close();
      },
    });
    await readCompletion(
      new Response(stream),
      true,
      new AbortController().signal,
      output,
      () => {},
    );
    expect(output).toEqual({
      content: "你好",
      reasoning: "想",
      usage: { total_tokens: 12, cached_tokens: 8, cache_hit_rate: "66.7%" },
    });
  });
  it("preserves partial output but reports a missing stream terminator", async () => {
    const output: CompletionOutput = { content: "", reasoning: "" };
    await expect(
      readCompletion(
        new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
        true,
        new AbortController().signal,
        output,
        () => {},
      ),
    ).rejects.toThrow("提前结束");
    expect(output.content).toBe("partial");
  });
  it("does not truncate an answer because SSE heartbeat/metadata overhead exceeds 8 MiB", async () => {
    const output: CompletionOutput = { content: "", reasoning: "" };
    const overhead = ": " + "x".repeat(65536) + "\n\n";
    const stream = new ReadableStream({
      start(controller) {
        const encode = new TextEncoder();
        controller.enqueue(
          encode.encode('data: {"choices":[{"delta":{"content":"开头"}}]}\n\n'),
        );
        for (let i = 0; i < 130; i++)
          controller.enqueue(encode.encode(overhead));
        controller.enqueue(
          encode.encode(
            'data: {"choices":[{"delta":{"content":"完整结尾✓"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          ),
        );
        controller.close();
      },
    });
    await readCompletion(
      new Response(stream),
      true,
      new AbortController().signal,
      output,
      () => {},
    );
    expect(output.content).toBe("开头完整结尾✓");
  });
  it("bounds combined UTF-8 answer and reasoning while retaining the received partial", async () => {
    const encoder = new TextEncoder(),
      output: CompletionOutput = {
        content: "continuation seed",
        reasoning: "",
      };
    const content = "文".repeat(100000);
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 30; i++)
          c.enqueue(
            encoder.encode(
              "data: " +
                JSON.stringify({
                  choices: [
                    {
                      delta:
                        i % 2 ? { content } : { reasoning_content: content },
                    },
                  ],
                }) +
                "\n\n",
            ),
          );
        c.close();
      },
    });
    await expect(
      readCompletion(
        new Response(stream),
        true,
        new AbortController().signal,
        output,
        () => {},
      ),
    ).rejects.toThrow("文字超过安全上限");
    const size = encoder.encode(output.content + output.reasoning).byteLength;
    expect(size).toBeGreaterThan(7 * 1024 * 1024);
    expect(size).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
  it("keeps a quiet upstream alive with one outstanding read and cancels its heartbeat", async () => {
    vi.useFakeTimers();
    try {
      const pull = vi.fn(),
        cancel = vi.fn(),
        update = vi.fn(),
        controller = new AbortController();
      const output: CompletionOutput = { content: "", reasoning: "" };
      const pending = readCompletion(
        new Response(new ReadableStream({ pull, cancel })),
        true,
        controller.signal,
        output,
        update,
        20,
      ).catch((error) => error);
      await vi.advanceTimersByTimeAsync(65);
      expect(pull).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledTimes(3);
      controller.abort();
      expect(await pending).toBeInstanceOf(DOMException);
      expect(cancel).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(update).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

it("retains non-streaming cache hit rates", async () => {
  const output: CompletionOutput = { content: "", reasoning: "" };
  await readCompletion(
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "OK" } }],
        usage: {
          input_tokens: 5982,
          cached_tokens: 4908,
          cache_hit_rate: "82.0%",
        },
      }),
    ),
    false,
    new AbortController().signal,
    output,
    () => {},
  );
  expect(output.usage).toEqual({
    input_tokens: 5982,
    cached_tokens: 4908,
    cache_hit_rate: "82.0%",
  });
});
