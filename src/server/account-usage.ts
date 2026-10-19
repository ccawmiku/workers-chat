import type { AccountUsage, QuotaMetric } from "../shared/account-usage";
import { generationDeadline } from "./deadline";
import { limitedText } from "./generation";

// No script, namespace, database or workflow filters: every metric is account-wide.
export const ACCOUNT_USAGE_QUERY = `query AccountUsage($account: string!, $start: Time!, $end: Time!, $storageStart: Time!) {
  viewer { accounts(filter: {accountTag: $account}) {
    workers: workersInvocationsAdaptive(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { requests cpuTimeUs } }
    doRequests: durableObjectsInvocationsAdaptiveGroups(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { requests } }
    doUsage: durableObjectsPeriodicGroups(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { duration rowsRead rowsWritten cpuTime } }
    d1: d1AnalyticsAdaptiveGroups(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { rowsRead rowsWritten } }
    workflows: workflowsAdaptiveGroups(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { stepCount cpuTime } }
    workflowStarts: workflowsAdaptiveGroups(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end, eventType: "WORKFLOW_START"}) { count }
    d1Storage: d1StorageAdaptiveGroups(limit: 1000, filter: {datetime_geq: $storageStart, datetime_lt: $end}) { dimensions { databaseId } max { databaseSizeBytes } }
    doStorage: durableObjectsSqlStorageGroups(limit: 1000, filter: {datetime_geq: $storageStart, datetime_lt: $end}) { dimensions { namespaceId } max { storedBytes } }
  }}
}`;
const TTL = 300000, RETRY = 60000;
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
function total(account: Record<string, unknown>, node: string, field: string, container = "sum") {
  const rows = account[node];
  if (!Array.isArray(rows)) return null;
  let sum = 0;
  for (const row of rows) {
    const value = number(container ? object(object(row)[container])[field] : object(row)[field]);
    if (value === null) return null;
    sum += value;
  }
  return sum;
}
function storage(account: Record<string, unknown>, node: string, field: string) {
  const rows = account[node];
  // Storage emits periodic samples; an empty response does not prove zero storage.
  return !Array.isArray(rows) || !rows.length || rows.length >= 1000 ? null : total(account, node, field, "max");
}
export function accountUsageSnapshot(account: Record<string, unknown>, now: number, status: AccountUsage["status"] = "ok"): AccountUsage {
  const start = new Date(now); start.setUTCHours(0, 0, 0, 0);
  const metrics: QuotaMetric[] = [];
  const add = (id: string, product: QuotaMetric["product"], name: string, value: number | null, limit: number | null, unit: QuotaMetric["unit"] = "count", period: QuotaMetric["period"] = "day", note?: string) =>
    metrics.push({id, product, name, value, limit, unit, period, ...(note ? { note } : {})});
  add("workers-requests", "Workers", "请求统计", total(account, "workers", "requests"), 100000, "count", "day", "整个账号的 Worker 请求统计；Workflows 调用共享这份日额度，不另分配 100k。Analytics 不是实时账单。");
  const cpu = total(account, "workers", "cpuTimeUs");
  add("workers-cpu", "Workers", "CPU 累计", cpu === null ? null : cpu / 1000, null, "ms", "day", "免费套餐 CPU 限制为每次调用 10 ms，不是每日累计额度。");
  add("do-requests", "Durable Objects", "请求统计", total(account, "doRequests", "requests"), 100000, "count", "day", "含 RPC、HTTP、Alarm 等；入站 WebSocket 在 Analytics 按原始条数统计，计费有 20:1 折算。");
  add("do-duration", "Durable Objects", "内存驻留时长", total(account, "doUsage", "duration"), 13000, "gbs");
  add("do-read", "Durable Objects", "SQLite 读取行数", total(account, "doUsage", "rowsRead"), 5000000);
  add("do-write", "Durable Objects", "SQLite 写入行数", total(account, "doUsage", "rowsWritten"), 100000);
  add("do-storage", "Durable Objects", "SQLite 存储峰值", storage(account, "doStorage", "storedBytes"), 5e9, "bytes", "storage", "近 24 小时各命名空间峰值之和，可能高于当前存储；容量不在每日重置。");
  add("d1-read", "D1", "读取行数", total(account, "d1", "rowsRead"), 5000000);
  add("d1-write", "D1", "写入行数", total(account, "d1", "rowsWritten"), 100000);
  add("d1-storage", "D1", "存储峰值", storage(account, "d1Storage", "databaseSizeBytes"), 5e9, "bytes", "storage", "近 24 小时各数据库峰值之和，可能高于当前存储；容量不在每日重置。");
  add("workflow-invocations", "Workflows", "启动次数", total(account, "workflowStarts", "count", ""), null, "count", "day", "调用与 Workers 共享 100k/天，不与另一套请求统计重复相加。");
  add("workflow-steps", "Workflows", "步骤（step.do）", total(account, "workflows", "stepCount"), 3000);
  add("workflow-cpu", "Workflows", "CPU 累计", total(account, "workflows", "cpuTime"), null, "ms", "day", "CPU 限制按每次调用计算，不把今日累计值与单次 10 ms 相比。");
  add("workflow-storage", "Workflows", "状态存储", null, 1e9, "bytes", "storage", "免费参考额度 1 GB-month；此 Analytics 数据集没有可核对的账号存储总量，不用 storageRate 代替。");
  return { status, scope: "account", day: start.toISOString().slice(0,10), fetchedAt: now, nextRefreshAt: now + RETRY, resetAt: start.getTime() + 86400000, metrics };
}
type UsageEnv = Pick<Env, "CF_ANALYTICS_TOKEN" | "CF_ANALYTICS_ACCOUNT_ID">;
type UsageCache = Pick<Cache, "match" | "put">;
export async function accountUsage(env: UsageEnv, force = false, cache?: UsageCache): Promise<AccountUsage> {
  const now = Date.now(), empty = accountUsageSnapshot({}, now, "unconfigured");
  if (!env.CF_ANALYTICS_TOKEN || !/^[a-f\d]{32}$/i.test(env.CF_ANALYTICS_ACCOUNT_ID ?? ""))
    return { ...empty, fetchedAt: null, message: "账号统计未配置服务端 Analytics 凭证。" };
  let usageCache = cache;
  try {
    if (typeof caches !== "undefined") {
      usageCache ??= await caches.open("account-usage");
    }
  } catch { /* Cache availability must not prevent login or chat navigation. */ }
  const key = new Request(`https://account-usage.internal/v1/${env.CF_ANALYTICS_ACCOUNT_ID}/${empty.day}`);
  let previous: AccountUsage | undefined;
  try {
    const cached = await usageCache?.match(key);
    if (cached) previous = await cached.json<AccountUsage>();
  } catch { /* A cache miss or eviction must not break the chat. */ }
  if (previous && previous.day === empty.day &&
    (now < previous.nextRefreshAt || (!force && previous.fetchedAt !== null && now - previous.fetchedAt < TTL))) return previous;
  const controller = new AbortController(), dispose = generationDeadline(controller, 8000);
  let snapshot: AccountUsage;
  try {
    const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST", redirect: "manual", signal: controller.signal,
      headers: { "Authorization": "Bearer " + env.CF_ANALYTICS_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({query: ACCOUNT_USAGE_QUERY, variables: {
        account: env.CF_ANALYTICS_ACCOUNT_ID,
        start: empty.day + "T00:00:00Z", end: new Date(now).toISOString(),
        storageStart: new Date(now - 86400000).toISOString(),
      }}),
    });
    if (!response.ok) { await response.body?.cancel(); throw Error("analytics unavailable"); }
    const parsed = object(JSON.parse(await limitedText(response, 1048576, controller.signal)));
    const accounts = object(object(parsed.data).viewer).accounts;
    if (!Array.isArray(accounts) || !accounts[0]) throw Error("analytics unavailable");
    const partial = Array.isArray(parsed.errors) && parsed.errors.length > 0;
    snapshot = accountUsageSnapshot(object(accounts[0]), now, partial ? "partial" : "ok");
    if (partial) snapshot.message = "部分统计暂时不可用，未返回的用量不会显示为零。";
  } catch {
    snapshot = previous && previous.fetchedAt !== null
      ? { ...previous, status: "stale", nextRefreshAt: now + RETRY, message: "统计暂时不可用，显示上次数据。" }
      : { ...empty, status: "error", fetchedAt: null, nextRefreshAt: now + RETRY, message: "暂时无法读取账号统计，请稍后刷新。" };
  } finally { dispose(); }
  try { await usageCache?.put(key, Response.json(snapshot, {headers:{"Cache-Control":"public, max-age=86400"}})); }
  catch { /* Statistics remain usable when the edge cache cannot store them. */ }
  return snapshot;
}
