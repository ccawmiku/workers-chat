import { useState } from "react";
import { Gauge, RefreshCw, ChevronRight } from "lucide-react";
import { Loading } from "./controls";
import { type AccountUsage, type QuotaMetric, quotaPercent, quotaNumber, quotaProducts } from "../shared/account-usage";

function ProductPeak({ metrics }: { metrics: QuotaMetric[] }) {
  const peak = metrics.filter(m => m.period === "day")
    .map(quotaPercent).filter((p): p is number => p !== null)
    .reduce<number | null>((value, p) => value === null ? p : Math.max(value, p), null);
  return <><b>{peak === null ? "—" : peak.toFixed(1) + "%"}</b>
    <progress className={"du-progress quota-progress " + (peak !== null && peak >= 90 ? "quota-high" : "")}
      value={peak === null ? 0 : Math.min(100, peak)} max={100} aria-label={peak === null ? "暂无额度数据" : "最高日用量 " + peak.toFixed(1) + "%"} /></>;
}
export function AccountUsageSidebar({ usage, open }: { usage: AccountUsage | null; open: () => void }) {
  return <button className="du-btn du-btn-ghost account-quota-sidebar" onClick={open} aria-label="查看账号额度">
    <span className="quota-sidebar-title"><Gauge size={14}/><span>账号额度</span><small>全账号</small><ChevronRight size={13}/></span>
    {usage && !["unconfigured", "error"].includes(usage.status) ? <span className="quota-sidebar-grid">
      {quotaProducts.map((product, i) => <span className={"quota-mini quota-product-"+i} key={product} title={product + "：最高日用量比例；点击查看各项额度"}>
        <span>{["Workers", "DO", "D1", "Workflows"][i]}</span>
        <ProductPeak metrics={usage.metrics.filter(m=>m.product===product)}/>
      </span>)}
    </span> : <small className="muted">{usage?.status === "unconfigured" ? "查看免费额度与统计配置" : usage?.status === "error" ? "统计暂不可用" : "正在读取统计"}</small>}
    {usage?.status === "stale" && <small className="quota-stale">显示上次数据</small>}
  </button>;
}
function Metric({ metric: m }: {metric: QuotaMetric}) {
  const percent=quotaPercent(m);
  return <div className="quota-metric" title={m.note}>
    <div className="quota-metric-title"><span>{m.name}</span>{percent !== null && <b className={percent>=90?"quota-high-text":""}>{percent.toFixed(1)}%</b>}</div>
    <div className="quota-amount"><strong>{quotaNumber(m.value,m.unit)}</strong>{m.limit !== null && <span> / {quotaNumber(m.limit,m.unit)}{m.period==="day"?" / 天":""}</span>}</div>
    {percent !== null && <progress className={"du-progress quota-progress "+(percent>=90?"quota-high":"")} value={Math.min(100,percent)} max={100} aria-label={m.name+"用量"}/>}
    {m.note && <small className="muted">{m.note}</small>}
  </div>;
}
export function AccountUsageSettings({usage, refresh}: {usage: AccountUsage|null; refresh:()=>Promise<void>}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  return <section className="account-quota-settings">
    <header><div><h2>账号额度</h2><p className="muted">整个 Cloudflare 账号 · 免费套餐参考额度</p></div>
      <button className="du-btn du-btn-sm" disabled={busy} onClick={()=>{
        setBusy(true);setError("");void refresh().catch(()=>setError("暂时无法刷新统计，请稍后重试。")).finally(()=>setBusy(false));
      }}>{busy?<Loading small/>:<RefreshCw size={15}/>}刷新额度</button>
    </header>
    <p className="muted quota-update">{usage?.day ? "UTC 今日："+usage.day+" · " : ""}
      {usage?.fetchedAt ? "获取于 "+new Date(usage.fetchedAt).toLocaleTimeString("zh-CN") : "尚无成功统计"}
      <br/>每日额度在 UTC 00:00（北京时间 08:00）重置；存储容量不随日重置。统计可能延迟，自动查询缓存 5 分钟，手动刷新最快每分钟一次。</p>
    {(usage?.message||error) && <p className="du-alert du-alert-warning" role="status">{error||usage?.message}</p>}
    {!usage ? <Loading/> : <div className="quota-products">
      {quotaProducts.map((product,i)=><section className={"du-card quota-product quota-product-"+i} key={product}>
        <h3>{product}</h3>{usage.metrics.filter(m=>m.product===product).map(m=><Metric key={m.id} metric={m}/>)}
      </section>)}
    </div>}
    <p className="muted quota-source">来源：Cloudflare 官方 Analytics。用量不按本站筛选；没有返回的数据保持“暂无数据”。各项参考额度见
      {quotaProducts.map((p,i)=><span key={p}>{i>0?"、":" "}<a target="_blank" rel="noreferrer" href={[
        "https://developers.cloudflare.com/workers/platform/pricing/",
        "https://developers.cloudflare.com/durable-objects/platform/pricing/",
        "https://developers.cloudflare.com/d1/platform/pricing/",
        "https://developers.cloudflare.com/workflows/reference/pricing/",
      ][i]}>{p}</a></span>)}。</p>
  </section>;
}
