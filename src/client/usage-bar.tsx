import { useMemo } from "react";
import { formatTokenCount, estimateTokens, type Message } from "../shared/chat";
import { tokenBreakdown, type TokenBreakdown } from "../shared/usage";
import { useCacheReading } from "./cache-usage";
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
  const cache = useCacheReading(usage, cacheId);
  const value = tokenBreakdown(usage) ??
    fallback ?? { input: 0, thinking: 0, output: 0, total: 0 };
  const cached = Math.min(
    value.input,
    cache?.cached ?? (cache ? Math.round(value.input * cache.ratio) : 0),
  );
  const segments = {
    input: value.input - cached,
    cached,
    thinking: value.thinking,
    output: value.output,
  };
  const title =
    `输入 ${formatTokenCount(value.input)} · 思考 ${formatTokenCount(value.thinking)} · 输出 ${formatTokenCount(value.output)} · 合计 ${formatTokenCount(value.total)} Token` +
    (tokenBreakdown(usage) ? "" : "（按文本计算）") +
    (cache ? ` · ${cache.source} ${cache.percent}` : "");
  let offset = 0;
  return (
    <svg
      className={"usage-ring " + (compact ? "compact" : "")}
      viewBox="0 0 36 36"
      role="img"
      aria-label={label + "：" + title}
    >
      <title>{title}</title>
      <circle
        className="ring-track"
        cx="18"
        cy="18"
        r="14"
        fill="none"
        strokeWidth="5"
      />
      {(["input", "cached", "thinking", "output"] as const)
        .filter((key) => segments[key] > 0)
        .map((key) => {
          const amount =
              value.total > 0 ? (segments[key] / value.total) * 100 : 0,
            start = offset;
          offset += amount;
          return (
            <circle
              key={key}
              className={"usage-segment usage-" + key}
              cx="18"
              cy="18"
              r="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="5"
              pathLength="100"
              strokeDasharray={`${amount} ${100 - amount}`}
              strokeDashoffset={-start}
              transform="rotate(-90 18 18)"
              data-kind={key}
              data-tokens={segments[key]}
              aria-hidden="true"
            />
          );
        })}
    </svg>
  );
}
export function ContextRing({
  used,
  capacity,
  label = "上下文占用",
}: {
  used: number;
  capacity: number;
  label?: string;
}) {
  const ratio = Math.max(0, Math.min(1, used / Math.max(1, capacity))),
    percent = ((used / Math.max(1, capacity)) * 100).toFixed(1);
  const title = `${label}：${formatTokenCount(used)} / ${formatTokenCount(capacity)} Token · ${percent}%`;
  return (
    <svg
      className={
        "plugin-context-ring " + (used > capacity ? "over-budget" : "")
      }
      viewBox="0 0 36 36"
      role="img"
      aria-label={title}
      data-used={used}
      data-capacity={capacity}
      data-percent={percent}
    >
      <title>{title}</title>
      <circle
        className="ring-track"
        cx="18"
        cy="18"
        r="14"
        fill="none"
        strokeWidth="5"
      />
      {ratio > 0 && (
        <circle
          cx="18"
          cy="18"
          r="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="5"
          pathLength="100"
          strokeDasharray={`${ratio * 100} ${100 - ratio * 100}`}
          transform="rotate(-90 18 18)"
        />
      )}
    </svg>
  );
}
