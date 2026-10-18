export type QuotaProduct = "Workers" | "Durable Objects" | "D1" | "Workflows";
export type QuotaMetric = {
  id: string;
  product: QuotaProduct;
  name: string;
  value: number | null;
  limit: number | null;
  unit: "count" | "bytes" | "gbs" | "ms";
  period: "day" | "storage";
  note?: string;
};
export type AccountUsage = {
  status: "ok" | "partial" | "stale" | "error" | "unconfigured";
  scope: "account";
  day: string;
  fetchedAt: number | null;
  nextRefreshAt: number;
  resetAt: number;
  metrics: QuotaMetric[];
  message?: string;
};
export const quotaProducts: QuotaProduct[] = ["Workers", "Durable Objects", "D1", "Workflows"];
export function quotaPercent(metric: QuotaMetric): number | null {
  return metric.value !== null && metric.limit !== null && metric.limit > 0
    ? metric.value / metric.limit * 100 : null;
}
export function quotaNumber(n: number | null, unit: QuotaMetric["unit"]): string {
  if (n === null) return "暂无数据";
  if (unit === "bytes") {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + " kB";
    return Math.round(n) + " B";
  }
  const text = n >= 1e6 ? (n / 1e6).toFixed(1) + "m"
    : n >= 1000 ? (n / 1000).toFixed(1) + "k"
      : Number.isInteger(n) ? String(n) : n.toFixed(1);
  return text + (unit === "gbs" ? " GB·s" : unit === "ms" ? " ms" : "");
}
