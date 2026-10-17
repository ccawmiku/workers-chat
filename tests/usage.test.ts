import { describe, it, expect } from "vitest";
import { mergeUsage } from "../src/shared/chat";
import {
  responseUsage,
  readCompletion,
  type CompletionOutput,
} from "../src/shared/completion";
import { tokenBreakdown } from "../src/shared/usage";
import { pluginDefaults, upgradeLegacyPlugin } from "../src/shared/plugins";
import { LEGACY_CLARIFY_PROMPT } from "../src/shared/clarify-defaults";
describe("reported usage across partial responses", () => {
  it("retains cache and nested reasoning when later frames are partial", () => {
    const first = {
      input_tokens: 18929,
      output_tokens: 500,
      cache_hit_rate: "85.8%",
      completion_tokens_details: { reasoning_tokens: 100 },
    };
    const merged = mergeUsage(first, {
      total_tokens: 19429,
      completion_tokens_details: { audio_tokens: 0 },
    });
    expect(merged).toMatchObject({
      ...first,
      total_tokens: 19429,
      completion_tokens_details: { reasoning_tokens: 100, audio_tokens: 0 },
    });
    expect(mergeUsage(merged, { cache_hit_rate: "unknown" })).toEqual(merged);
    expect(mergeUsage(merged, { cache_hit_rate: 0 })?.cache_hit_rate).toBe(
      "0%",
    );
  });
  it("reads explicit headers and body rates, never timing, accounts, or count ratios", () => {
    const headers = new Headers({
      "x-cache-hit-rate": "22%",
      "x-timing-total-ms": "2873.305",
      "x-account-email": "fixture@example.invalid",
    });
    expect(
      responseUsage(headers, {
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
    ).toEqual({ input_tokens: 100, output_tokens: 20, cache_hit_rate: "22%" });
    expect(
      responseUsage(headers, { usage: { cache_hit_rate: "85.8%" } })
        ?.cache_hit_rate,
    ).toBe("85.8%");
    expect(
      responseUsage(new Headers(), {
        usage: { cached_tokens: 22, input_tokens: 100 },
      })?.cache_hit_rate,
    ).toBeUndefined();
    expect(
      responseUsage(new Headers({ "x-timing-total-ms": "22" })),
    ).toBeUndefined();
  });
  it("preserves cache-only SSE frames through later total-only frames", async () => {
    const output: CompletionOutput = { content: "", reasoning: "" };
    await readCompletion(
      new Response(
        'data: {"choices":[{"delta":{"content":"complete"}}],"usage":{"input_tokens":100,"cache_hit_rate":"82.0%"}}\n\ndata: {"usage":{"output_tokens":50,"completion_tokens_details":{"reasoning_tokens":20}}}\n\ndata: {"usage":{"total_tokens":150}}\n\ndata: [DONE]\n\n',
      ),
      true,
      new AbortController().signal,
      output,
      () => {},
    );
    expect(output.content).toBe("complete");
    expect(output.usage).toMatchObject({
      cache_hit_rate: "82.0%",
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    });
    expect(tokenBreakdown(output.usage)).toEqual({
      input: 100,
      thinking: 20,
      output: 30,
      total: 150,
    });
  });
  it("does not overwrite a body rate with a header in later SSE frames", async () => {
    const output: CompletionOutput = { content: "", reasoning: "" };
    const response = new Response(
      'data: {"choices":[{"delta":{"content":"done"}}],"usage":{"input_tokens":100,"cache_hit_rate":"85.8%"}}\n\ndata: {"usage":{"total_tokens":150}}\n\ndata: [DONE]\n\n',
      { headers: { "x-cache-hit-rate": "22%" } },
    );
    await readCompletion(
      response,
      true,
      new AbortController().signal,
      output,
      () => {},
    );
    expect(output.usage?.cache_hit_rate).toBe("85.8%");
    expect(
      responseUsage(
        new Headers({ "x-cache-hit-rate": "invalid", "cache-hit-rate": "0%" }),
      )?.cache_hit_rate,
    ).toBe("0%");
  });
  it("splits included reasoning and supports explicitly separate counters", () => {
    expect(
      tokenBreakdown({
        prompt_tokens: 100,
        completion_tokens: 50,
        completion_tokens_details: { reasoning_tokens: 20 },
        total_tokens: 150,
      }),
    ).toEqual({ input: 100, thinking: 20, output: 30, total: 150 });
    expect(
      tokenBreakdown({
        input_tokens: 100,
        output_tokens: 50,
        thinking_tokens: 20,
        total_tokens: 170,
      }),
    ).toEqual({ input: 100, thinking: 20, output: 50, total: 170 });
    expect(tokenBreakdown({ output_tokens: 5, reasoning_tokens: 99 })).toEqual({
      input: 0,
      thinking: 5,
      output: 0,
      total: 5,
    });
    expect(
      tokenBreakdown({ input_tokens: -1, output_tokens: NaN }),
    ).toBeUndefined();
    expect(
      tokenBreakdown({ cached_tokens: 42, cache_hit_rate: "22%" }),
    ).toBeUndefined();
  });
});
describe("default prompt migration", () => {
  it("upgrades only the old clarification default and rewrite display names", () => {
    const p = pluginDefaults("clarify");
    expect(p.prompt).toContain("A、B、C");
    expect(
      upgradeLegacyPlugin({ ...p, prompt: LEGACY_CLARIFY_PROMPT }).prompt,
    ).toBe(p.prompt);
    expect(
      upgradeLegacyPlugin({ ...p, prompt: "my custom prompt" }).prompt,
    ).toBe("my custom prompt");
    for (const name of ["请求重生", "重新生成 user 提示"]) {
      const rewritten = upgradeLegacyPlugin({
        ...pluginDefaults("rewrite"),
        name,
        cardTitle: name,
      });
      expect(rewritten.name).toBe("重写提示");
      expect(rewritten.cardTitle).toBe("重写提示");
    }
    expect(
      upgradeLegacyPlugin({ ...pluginDefaults("rewrite"), name: "custom" })
        .name,
    ).toBe("custom");
  });
});
