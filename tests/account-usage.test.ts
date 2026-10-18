import { afterEach, describe, expect, it, vi } from "vitest";
import { accountUsage, accountUsageSnapshot, ACCOUNT_USAGE_QUERY } from "../src/server/account-usage";
import { quotaNumber, quotaPercent } from "../src/shared/account-usage";

const now = Date.UTC(2026,9,18,3), token = "synthetic-analytics-token";
const env = { CF_ANALYTICS_TOKEN: token, CF_ANALYTICS_ACCOUNT_ID: "1".repeat(32) };
const raw = () => ({
  workers:[{sum:{requests:900,cpuTimeUs:3000}}],
  doRequests:[{sum:{requests:500}}],
  doUsage:[{sum:{duration:14620.54,rowsRead:300,rowsWritten:400}}],
  d1:[{sum:{rowsRead:12345,rowsWritten:678}}],
  workflows:[{sum:{stepCount:42,cpuTime:12}}], workflowStarts:[{count:13}],
  d1Storage:[{max:{databaseSizeBytes:200}},{max:{databaseSizeBytes:300}}],
  doStorage:[{max:{storedBytes:100}}],
});
function cacheFixture() {
  const responses=new Map<string,Response>();
  return {
    match: vi.fn(async (request:RequestInfo|URL) => responses.get(String(request instanceof Request ? request.url : request))?.clone()),
    put: vi.fn(async (request:RequestInfo|URL, response:Response) => {responses.set(String(request instanceof Request ? request.url : request),response.clone());}),
  };
}
const reply=(data=raw())=>Response.json({data:{viewer:{accounts:[data]}}});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe("account-wide quota statistics",()=>{
  it("uses the entire account and keeps duration units and storage peaks distinct",()=>{
    const snapshot=accountUsageSnapshot(raw(),now),metric=(id:string)=>snapshot.metrics.find(m=>m.id===id)!;
    expect(snapshot).toMatchObject({scope:"account",day:"2026-10-18",resetAt:Date.UTC(2026,9,19)});
    expect(metric("do-duration")).toMatchObject({value:14620.54,limit:13000,unit:"gbs"});
    expect(quotaPercent(metric("do-duration"))).toBeGreaterThan(100);
    expect(metric("workers-cpu").value).toBe(3);
    expect(metric("workflow-cpu").limit).toBeNull();
    expect(metric("d1-storage")).toMatchObject({value:500,period:"storage"});
    expect(metric("workflow-invocations").limit).toBeNull();
    expect(metric("workflow-storage").value).toBeNull();
    expect(ACCOUNT_USAGE_QUERY).not.toMatch(/filter:\s*\{[^}]*\b(scriptName|namespaceId|databaseId|workflowName):/);
    expect(ACCOUNT_USAGE_QUERY).toContain('eventType: "WORKFLOW_START"');
    expect(quotaNumber(14620.54,"gbs")).toBe("14.6k GB·s");
    expect(quotaNumber(null,"bytes")).toBe("暂无数据");
  });
  it("distinguishes missing data, valid zero events, invalid counters and absent storage samples",()=>{
    const snapshot=accountUsageSnapshot({workers:[],d1:[{sum:{rowsRead:-1,rowsWritten:NaN}}],d1Storage:[]},now);
    expect(snapshot.metrics.find(m=>m.id==="workers-requests")?.value).toBe(0);
    for(const id of ["do-duration","d1-read","d1-write","d1-storage"])
      expect(snapshot.metrics.find(m=>m.id===id)?.value).toBeNull();
    expect(accountUsageSnapshot({d1Storage:Array(1000).fill({max:{databaseSizeBytes:1}})},now).metrics.find(m=>m.id==="d1-storage")?.value).toBeNull();
  });
  it("adds no outbound or cache work when not configured",async()=>{
    const cache=cacheFixture(),fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
    expect((await accountUsage({...env,CF_ANALYTICS_TOKEN:""},false,cache)).status).toBe("unconfigured");
    expect(fetcher).not.toHaveBeenCalled();expect(cache.match).not.toHaveBeenCalled();
  });
  it("reuses a five-minute cache and throttles manual refresh for at least one minute",async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);
    const cache=cacheFixture(),fetcher=vi.fn(async()=>reply());vi.stubGlobal("fetch",fetcher);
    await accountUsage(env,false,cache);await accountUsage(env,false,cache);await accountUsage(env,true,cache);
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.setSystemTime(now+61000);await accountUsage(env,true,cache);expect(fetcher).toHaveBeenCalledTimes(2);
    vi.setSystemTime(now+300000);await accountUsage(env,false,cache);expect(fetcher).toHaveBeenCalledTimes(2);
    vi.setSystemTime(now+362000);await accountUsage(env,false,cache);expect(fetcher).toHaveBeenCalledTimes(3);
    const options=fetcher.mock.calls[0] as unknown as [string,RequestInit];
    expect(options[1].redirect).toBe("manual");
    expect(new Headers(options[1].headers).get("Authorization")).toBe("Bearer "+token);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not reuse yesterday's quota after the UTC reset",async()=>{
    vi.useFakeTimers();vi.setSystemTime(Date.UTC(2026,9,18,23,59,59));
    const cache=cacheFixture(),fetcher=vi.fn(async()=>reply());vi.stubGlobal("fetch",fetcher);
    await accountUsage(env,false,cache);vi.setSystemTime(Date.UTC(2026,9,19));
    expect((await accountUsage(env,false,cache)).day).toBe("2026-10-19");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("backs off errors even with no cached good data, and never exposes API errors or credentials",async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);
    const cache=cacheFixture(),fetcher=vi.fn(async()=>new Response(token,{status:403}));vi.stubGlobal("fetch",fetcher);
    const bad=await accountUsage(env,false,cache);
    expect(bad.status).toBe("error");expect(bad.fetchedAt).toBeNull();
    expect(JSON.stringify(bad)).not.toContain(token);
    await accountUsage(env,true,cache);expect(fetcher).toHaveBeenCalledTimes(1);
    vi.setSystemTime(now+61000);await accountUsage(env,true,cache);expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("keeps good values on a temporary failure without refreshing their timestamp",async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);
    const cache=cacheFixture(),fetcher=vi.fn(async()=>reply());vi.stubGlobal("fetch",fetcher);
    const good=await accountUsage(env,false,cache);
    vi.setSystemTime(now+301000);fetcher.mockRejectedValueOnce(Error("network unavailable"));
    const stale=await accountUsage(env,false,cache);
    expect(stale.status).toBe("stale");expect(stale.fetchedAt).toBe(good.fetchedAt);expect(stale.metrics).toEqual(good.metrics);
    await accountUsage(env,true,cache);expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("handles partial GraphQL data independently and ignores raw error details",async()=>{
    const cache=cacheFixture();vi.stubGlobal("fetch",vi.fn(async()=>Response.json({data:{viewer:{accounts:[{...raw(),d1:null}]}},errors:[{message:token}]})));
    const data=await accountUsage(env,false,cache);
    expect(data.status).toBe("partial");expect(data.metrics.find(m=>m.id==="d1-read")?.value).toBeNull();
    expect(data.metrics.find(m=>m.id==="do-duration")?.value).toBe(14620.54);
    expect(JSON.stringify(data)).not.toContain(token);
  });
});
