import { useMemo } from "react";
import {
  formatTokenCount,
  estimateTokens,
  type Message,
  type ModelRef,
} from "../shared/chat";
import type { PluginRequest } from "../shared/plugins";
import { tokenBreakdown, type TokenBreakdown } from "../shared/usage";
import { useCacheReading, type CacheReading } from "./cache-usage";

function usageParts(
  usage: unknown,
  fallback: TokenBreakdown | undefined,
  cache: CacheReading | undefined,
) {
  const value = tokenBreakdown(usage) ??
    fallback ?? { input: 0, thinking: 0, output: 0, total: 0 };
  const cached = Math.min(
    value.input,
    cache?.cached ?? (cache ? Math.round(value.input * cache.ratio) : 0),
  );
  return {
    segments: {
      input: value.input - cached,
      cached,
      thinking: value.thinking,
      output: value.output,
    },
    total: value.total,
    title:
      `输入 ${formatTokenCount(value.input)} · 思考 ${formatTokenCount(value.thinking)} · 输出 ${formatTokenCount(value.output)} · 合计 ${formatTokenCount(value.total)} Token` +
      (tokenBreakdown(usage) ? "" : "（按文本计算）") +
      (cache ? ` · ${cache.source} ${cache.percent}` : ""),
  };
}
function UsageArcs({
  parts,
  center = 18,
  radius = 14,
}: {
  parts: ReturnType<typeof usageParts>;
  center?: number;
  radius?: number;
}) {
  let offset = 0;
  return (
    <g className="usage-arcs" aria-hidden="true">
      <circle
        className="ring-track"
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        strokeWidth="5"
      />
      {(["input", "cached", "thinking", "output"] as const)
        .filter((key) => parts.segments[key] > 0)
        .map((key) => {
          const amount =
              parts.total > 0 ? (parts.segments[key] / parts.total) * 100 : 0,
            start = offset;
          offset += amount;
          return (
            <circle
              key={key}
              className={"usage-segment usage-" + key}
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth="5"
              pathLength="100"
              strokeDasharray={`${amount} ${100 - amount}`}
              strokeDashoffset={-start}
              transform={`rotate(-90 ${center} ${center})`}
              data-kind={key}
              data-tokens={parts.segments[key]}
            />
          );
        })}
    </g>
  );
}
export function MessageUsageRing({ message: m }: { message: Message }) {
  const fallback = useMemo(() => {
    const content = estimateTokens(m.content),
      thinking = m.role === "assistant" ? estimateTokens(m.reasoning ?? "") : 0;
    return m.role === "user"
      ? { input: content, thinking: 0, output: 0, total: content }
      : { input: 0, thinking, output: content, total: thinking + content };
  }, [m.content, m.reasoning, m.role]);
  return (
    <UsageRing usage={m.usage} fallback={fallback} cacheId={m.id} compact />
  );
}
export function UsageRing({
  usage,
  fallback,
  compact = false,
  label = "Token 用量组成",
  cacheId,
}: {
  usage?: unknown;
  fallback?: TokenBreakdown;
  compact?: boolean;
  label?: string;
  cacheId?: string;
}) {
  const cache = useCacheReading(usage, cacheId),
    parts = usageParts(usage, fallback, cache);
  return (
    <svg
      className={"usage-ring " + (compact ? "compact" : "")}
      viewBox={compact ? "2.5 2.5 31 31" : "0 0 36 36"}
      role="img"
      aria-label={label + "：" + parts.title}
    >
      <title>{parts.title}</title>
      <UsageArcs parts={parts} />
    </svg>
  );
}
/** One SVG: outer token composition, inner context fill, cache digits in the center. */
export function PluginChipContents({
  name,
  inputLabel,
  used,
  capacity,
  usage,
  cacheId,
  preview,
  fallback,
}: {
  name: string;
  inputLabel: string;
  used: number;
  capacity: number;
  usage?: unknown;
  cacheId?: string;
  preview?: { request: PluginRequest; modelRef: ModelRef };
  fallback?: TokenBreakdown;
}) {
  const cache = useCacheReading(usage, cacheId, preview),
    parts = usageParts(usage, fallback, cache);
  const ratio = Math.max(0, Math.min(1, used / Math.max(1, capacity))),
    percent = ((used / Math.max(1, capacity)) * 100).toFixed(1);
  const contextTitle = `${name}上下文：${formatTokenCount(used)} / ${formatTokenCount(capacity)} Token · ${percent}%`;
  return (
    <>
      <span className="plugin-chip-info">
        <span className="plugin-chip-name">{name}</span>
        <b>{inputLabel}</b>
        <small
          className="plugin-chip-cache"
          title={cache?.source}
          data-cache-source={cache?.source}
        >
          {cache
            ? `${cache.source.startsWith("本地") ? "≈" : ""}${cache.percent}`
            : ""}
        </small>
      </span>
      <svg
        className="plugin-combined-ring"
        viewBox="0 0 64 64"
        role="img"
        aria-label={contextTitle + "；" + parts.title}
      >
        <title>{contextTitle + "；" + parts.title}</title>
        <UsageArcs parts={parts} center={32} radius={28} />
        <g
          className={"context-arcs" + (used > capacity ? " over-budget" : "")}
          data-used={used}
          data-capacity={capacity}
          data-percent={percent}
          aria-hidden="true"
        >
          <circle
            className="ring-track"
            cx="32"
            cy="32"
            r="20"
            fill="none"
            strokeWidth="4"
          />
          {ratio > 0 && (
            <circle
              className="context-fill"
              cx="32"
              cy="32"
              r="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="4"
              pathLength="100"
              strokeDasharray={`${ratio * 100} ${100 - ratio * 100}`}
              transform="rotate(-90 32 32)"
            />
          )}
        </g>
        <text
          className="ring-cache-value"
          x="32"
          y="32"
          dy=".05em"
          textAnchor="middle"
          dominantBaseline="middle"
          aria-hidden="true"
        >
          {cache ? Math.round(cache.ratio * 100) : ""}
        </text>
      </svg>
    </>
  );
}
