import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PluginChipContents } from "../src/client/usage-bar";
import { describe, it, expect } from "vitest";
import {
  cacheReading,
  historicalCacheReading,
  recordCacheRequest,
  localCacheEstimate,
} from "../src/client/cache-usage";
import { tokenBreakdown } from "../src/shared/usage";
import { fallbackRequest } from "../src/server/fallback-model";
import {
  defaultSettings,
  newChat,
  addMessage,
  contextMessages,
  type Provider,
} from "../src/shared/chat";
import { compatibleMessages } from "../src/shared/upstream-compat";
describe("local cache counters and single-attempt model overrides", () => {
  it("uses reported percentages first, computes known counters locally, and never invents missing data", () => {
    expect(
      cacheReading({ input_tokens: 18929, cached_tokens: 16247 })?.percent,
    ).toBe("85.8%");
    expect(
      cacheReading({
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 25 },
        cache_hit_rate: "80%",
      }),
    ).toMatchObject({ percent: "80%", source: "上游返回", cached: 25 });
    expect(
      cacheReading({ prompt_tokens: 100, prompt_cache_hit_tokens: 0 })?.percent,
    ).toBe("0.0%");
    expect(
      cacheReading({ prompt_tokens: 100, prompt_cache_hit_tokens: 101 }),
    ).toBeUndefined();
    expect(cacheReading({ prompt_tokens: 100 })).toBeUndefined();
    expect(
      cacheReading({
        input_tokens: 20,
        cache_read_input_tokens: 60,
        cache_creation_input_tokens: 20,
      })?.percent,
    ).toBe("60.0%");
    expect(
      tokenBreakdown({
        input_tokens: 20,
        cache_read_input_tokens: 60,
        cache_creation_input_tokens: 20,
        output_tokens: 10,
      }),
    ).toEqual({ input: 100, output: 10, thinking: 0, total: 110 });
  });
  it("retains historical zero and nonzero readings only for the exact model, never substitutes unknown data", () => {
    const model = { providerId: "p", modelId: "m" };
    const runs = [
      {
        id: "other",
        model: { providerId: "another", modelId: "m" },
        usage: { cache_hit_rate: "95%" },
      },
      { id: "old", model, usage: { cache_hit_rate: "0%" } },
      { id: "new", model },
    ];
    expect(historicalCacheReading(runs, "new", model)).toMatchObject({
      percent: "0%",
      historical: true,
    });
    expect(historicalCacheReading(runs, "old", model)).toBeUndefined();
    expect(
      historicalCacheReading(runs, "new", {
        providerId: "p",
        modelId: "different",
      }),
    ).toBeUndefined();
    expect(historicalCacheReading([], undefined, model)).toBeUndefined();
  });
  it("dims historical digits without applying their cached tokens to a new request's composition, and prefers a current zero", () => {
    const historical = {
      ratio: 0.8,
      percent: "80%",
      historical: true,
      source: "上游返回 · 历史缓存率",
    };
    const props = {
      name: "ABCD",
      inputLabel: "100",
      used: 100,
      capacity: 1000,
      historicalCache: historical,
    };
    const old = renderToStaticMarkup(
      createElement(PluginChipContents, {
        ...props,
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }),
    );
    expect(old).toContain("ring-cache-value historical");
    expect(old).toContain('data-cache-age="historical"');
    expect(old).toMatch(/>80<\/text>/);
    expect(old).not.toContain("usage-segment usage-cached");
    expect(old).toContain("<span>AB</span><span>CD</span>");
    const current = renderToStaticMarkup(
      createElement(PluginChipContents, {
        ...props,
        usage: { prompt_tokens: 100, cached_tokens: 0 },
      }),
    );
    expect(current).toContain('data-cache-age="current"');
    expect(current).not.toContain("ring-cache-value historical");
    expect(current).toMatch(/>0<\/text>/);
  });
  it("does not let a local estimate overwrite real returned usage", () => {
    recordCacheRequest(
      "fixture-cache-a",
      { providerId: "p", modelId: "m" },
      { model: "m", messages: [{ role: "user", content: "same" }] },
    );
    recordCacheRequest(
      "fixture-cache-b",
      { providerId: "p", modelId: "m" },
      { model: "m", messages: [{ role: "user", content: "same" }] },
    );
    expect(localCacheEstimate("fixture-cache-a")).toBeUndefined();
    expect(localCacheEstimate("fixture-cache-b")).toMatchObject({
      percent: "100.0%",
      source: expect.stringContaining("非真实命中"),
    });
    recordCacheRequest(
      "fixture-cache-c",
      { providerId: "p", modelId: "another" },
      { model: "another", messages: [{ role: "user", content: "same" }] },
    );
    expect(localCacheEstimate("fixture-cache-c")).toBeUndefined();
    expect(
      cacheReading({ prompt_tokens: 100, cached_tokens: 20 })?.percent,
    ).toBe("20.0%");
  });
  it("requires a listed, enabled fallback and preserves the task and explicit plugin parameters", () => {
    const settings = {
      ...defaultSettings(),
      parameters: { temperature: 0.8 },
      pluginFallbackModels: [{ providerId: "p", modelId: "spare" }],
    };
    const providers: Provider[] = [
      {
        id: "p",
        name: "fixture",
        prefix: "",
        baseUrl: "https://example.invalid/v1",
        models: [
          {
            id: "spare",
            enabled: true,
            capacity: 10000,
            parameters: { temperature: 0.6, top_p: 0.7 },
          },
        ],
      },
    ];
    const original = {
      model: "primary",
      messages: [{ role: "user" as const, content: "same task" }],
      temperature: 1,
      stream: false,
    };
    const selected = fallbackRequest(
      settings,
      providers,
      { providerId: "p", modelId: "spare" },
      original,
      { temperature: 0.2 },
    );
    expect(selected.request).toMatchObject({
      model: "spare",
      temperature: 0.2,
      top_p: 0.7,
      messages: original.messages,
    });
    expect(original.model).toBe("primary");
    expect(() =>
      fallbackRequest(
        settings,
        providers,
        { providerId: "p", modelId: "unlisted" },
        original,
        {},
      ),
    ).toThrow("备用列表");
    providers[0]!.models[0]!.enabled = false;
    expect(() =>
      fallbackRequest(
        settings,
        providers,
        { providerId: "p", modelId: "spare" },
        original,
        {},
      ),
    ).toThrow("关闭或移除");
  });
  it("supplies DeepSeek tool reasoning fields without inventing thoughts, and retains real stored reasoning", () => {
    const chat = newChat();
    addMessage(chat, "user", "hello");
    const a = addMessage(chat, "assistant", "answer");
    a.reasoning = "real returned reasoning";
    const raw = contextMessages(chat, undefined, true);
    const messages = compatibleMessages("deepseek-flash", [
      ...raw,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call",
            type: "function",
            function: { name: "analysis", arguments: "{}" },
          },
        ],
      },
      { role: "tool", content: "known facts", tool_call_id: "call" },
    ]);
    expect(messages[1]?.reasoning_content).toBe(a.reasoning);
    expect(messages[2]?.reasoning_content).toBe("");
    expect(compatibleMessages("another-model", raw)).toBe(raw);
    expect(raw).not.toHaveLength(messages.length);
  });
});
