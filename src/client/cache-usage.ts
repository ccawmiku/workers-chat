import { useEffect, useState } from "react";
import { cacheHitRate, estimateTokens, type ModelRef } from "../shared/chat";
import type { PluginRequest } from "../shared/plugins";
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const number = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
export type CacheReading = {
  percent: string;
  ratio: number;
  cached?: number;
  source: string;
};
/** Calculate locally from returned counters. An absent counter is unknown, never zero. */
export function cacheReading(value: unknown): CacheReading | undefined {
  const u = object(value),
    details = object(u.prompt_tokens_details ?? u.input_tokens_details);
  const cached = number(
    details.cached_tokens ??
      u.cached_tokens ??
      u.prompt_cache_hit_tokens ??
      u.cache_read_input_tokens,
  );
  const raw = number(u.prompt_tokens ?? u.input_tokens);
  const input =
    raw === undefined
      ? undefined
      : u.prompt_tokens === undefined && u.cache_read_input_tokens !== undefined
        ? raw +
          (number(u.cache_read_input_tokens) ?? 0) +
          (number(u.cache_creation_input_tokens) ?? 0)
        : raw;
  const reported = cacheHitRate(u.cache_hit_rate);
  if (reported)
    return {
      percent: reported,
      ratio: parseFloat(reported) / 100,
      cached:
        cached === undefined || input === undefined
          ? undefined
          : Math.min(cached, input),
      source: "上游返回",
    };
  if (
    cached !== undefined &&
    input !== undefined &&
    input > 0 &&
    cached <= input
  )
    return {
      percent: ((cached / input) * 100).toFixed(1) + "%",
      ratio: cached / input,
      cached,
      source: "按上游用量在本机计算",
    };
}

// Ephemeral and bounded: no prompts in localStorage, server calls, or extra database writes.
const previous = new Map<string, string>();
const estimates = new Map<string, CacheReading | undefined>();
const listeners = new Set<() => void>();
export const hasCacheRequest = (id: string) => estimates.has(id);
export const localCacheEstimate = (id: string) => estimates.get(id);
export function recordCacheRequest(
  id: string,
  model: ModelRef,
  request: Pick<PluginRequest, "messages" | "model"> & Partial<PluginRequest>,
) {
  if (estimates.has(id)) return;
  const key = JSON.stringify([
    model,
    request.response_format,
    request.reasoning_effort,
  ]);
  const text = request.messages.map((m) => JSON.stringify(m)).join("\n");
  const old = previous.get(key);
  let result: CacheReading | undefined;
  if (old) {
    let i = 0;
    while (
      i < old.length &&
      i < text.length &&
      old.charCodeAt(i) === text.charCodeAt(i)
    )
      i++;
    const total = estimateTokens(text),
      common = estimateTokens(text.slice(0, i));
    const ratio = total ? Math.min(common / total, 1) : 0;
    result = {
      percent: (ratio * 100).toFixed(1) + "%",
      ratio,
      source: "本地前缀估算，非真实命中；不含服务商缓存门槛、路由及过期影响",
    };
  }
  estimates.set(id, result);
  previous.set(key, text);
  if (previous.size > 16) previous.delete(previous.keys().next().value!);
  if (estimates.size > 128) estimates.delete(estimates.keys().next().value!);
  listeners.forEach((fn) => fn());
}
export function useCacheReading(
  usage: unknown,
  id?: string,
  preview?: { request: PluginRequest; modelRef: ModelRef },
) {
  const [, update] = useState(0);
  useEffect(() => {
    const change = () => update((n) => n + 1);
    listeners.add(change);
    return () => {
      listeners.delete(change);
    };
  }, []);
  useEffect(() => {
    if (id && preview)
      recordCacheRequest(id, preview.modelRef, preview.request);
  }, [id, preview]);
  return cacheReading(usage) ?? (id ? localCacheEstimate(id) : undefined);
}
