import { useMemo } from "react";
import { formatTokenCount, estimateTokens, type Message } from "../shared/chat";
import { tokenBreakdown, type TokenBreakdown } from "../shared/usage";
import { useCacheReading } from "./cache-usage";
export function MessageTokenBar({ message: m }: { message: Message }) {
  const fallback = useMemo(() => {
    const content = estimateTokens(m.content),
      thinking = m.role === "assistant" ? estimateTokens(m.reasoning ?? "") : 0;
    return m.role === "user"
      ? { input: content, thinking: 0, output: 0, total: content }
      : { input: 0, thinking, output: content, total: thinking + content };
  }, [m.content, m.reasoning, m.role]);
  return (
    <UsageBar usage={m.usage} fallback={fallback} cacheId={m.id} compact />
  );
}
export function UsageBar({
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
  const value = tokenBreakdown(usage) ?? fallback;
  if (!value || value.total <= 0)
    return (
      <span
        className={"usage-stack empty " + (compact ? "compact" : "")}
        aria-label={label + "：暂无用量"}
      />
    );
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
  return (
    <span
      className={"usage-stack " + (compact ? "compact" : "")}
      role="img"
      aria-label={label + "：" + title}
      title={title}
    >
      {(["input", "cached", "thinking", "output"] as const)
        .filter((key) => segments[key] > 0)
        .map((key) => (
          <progress
            key={key}
            className={
              "du-progress usage-segment usage-" +
              key +
              (key === "input"
                ? " du-progress-info"
                : key === "thinking"
                  ? " du-progress-warning"
                  : " du-progress-primary")
            }
            value={1}
            max={1}
            style={{ width: `${(segments[key] / value.total) * 100}%` }}
            data-kind={key}
            data-tokens={segments[key]}
            aria-hidden="true"
          />
        ))}
    </span>
  );
}
