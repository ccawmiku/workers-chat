import { useState } from "react";
import { ArrowUp, ArrowDown, Save, Eye, Palette } from "lucide-react";
import { defaultBodyStyles, STYLE_NAMES, styleCSS, type BodyStyles, type StyleRule } from "../shared/body-styles";
export function BodyStyleSettings({value,save,disabled}:{value?:BodyStyles;save:(v:BodyStyles)=>Promise<void>;disabled:boolean}) {
  const [draft,setDraft]=useState(()=>structuredClone(value??defaultBodyStyles()));
  const [pending,setPending]=useState(false),[error,setError]=useState(""),[saved,setSaved]=useState(false);
  const update=(id:string,patch:Partial<StyleRule>)=>{setSaved(false);setDraft(old=>({...old,rules:old.rules.map(r=>r.id===id?{...r,...patch}:r)}));};
  const move=(index:number,step:number)=>{setSaved(false);setDraft(old=>{const rules=[...old.rules];[rules[index],rules[index+step]]=[rules[index+step]!,rules[index]!];return {...old,rules};});};
  return <details className="body-style-settings">
    <summary><Palette size={15}/>正文样式 <small>{value?.enabled?"已开启":"已关闭"}</small></summary>
    <div className="style-settings-scroll">
      <label className="toggle">仅在此聊天启用<input aria-label="启用正文样式" type="checkbox" className="du-toggle du-toggle-primary du-toggle-sm" checked={draft.enabled} disabled={disabled||pending} onChange={e=>{setSaved(false);setDraft({...draft,enabled:e.target.checked});}}/></label>
      <small>从上到下优先。仅启用并填写用途的规则会发送给主模型；预览不保存。</small>
      {draft.rules.map((r,index)=><section className="style-rule" key={r.id} aria-label={STYLE_NAMES[r.id]}>
        <header><input type="checkbox" className="du-checkbox du-checkbox-primary du-checkbox-xs" aria-label={`使用${STYLE_NAMES[r.id]}`} checked={r.enabled} disabled={disabled||pending} onChange={e=>update(r.id,{enabled:e.target.checked})}/><strong>{STYLE_NAMES[r.id]}</strong><span className="style-example" style={styleCSS(r)}>示例</span><code>{r.id==="b"?"**…**":r.id==="i"?"*…*":`{${r.id}}…{/${r.id}}`}</code>
          <button type="button" aria-label={`上移${STYLE_NAMES[r.id]}`} disabled={!index||disabled||pending} onClick={()=>move(index,-1)}><ArrowUp size={13}/></button><button type="button" aria-label={`下移${STYLE_NAMES[r.id]}`} disabled={index===9||disabled||pending} onClick={()=>move(index,1)}><ArrowDown size={13}/></button></header>
        <textarea className="du-textarea du-textarea-sm" aria-label={`${STYLE_NAMES[r.id]}用途`} rows={2} maxLength={2000} placeholder="例如：主角说出口的话，不包含旁白；留空不发送" value={r.instruction} disabled={disabled||pending} onChange={e=>update(r.id,{instruction:e.target.value})}/>
        {!["b","i"].includes(r.id)&&<details><summary><Eye size={13}/>调整样式</summary><div className="style-rule-controls">
          {(["color","background"] as const).map(key=><label key={key}><input type="checkbox" checked={!!r[key]} disabled={disabled||pending} onChange={e=>update(r.id,{[key]:e.target.checked?(key==="color"?"#528ad1":"#e8bd44"):""})}/>{key==="color"?"文字颜色":"浅色背景"}<input type="color" aria-label={`${STYLE_NAMES[r.id]}${key==="color"?"文字颜色":"背景颜色"}`} value={r[key]||"#888888"} disabled={!r[key]||disabled||pending} onChange={e=>update(r.id,{[key]:e.target.value})}/></label>)}
          <label>字号比例<input className="du-input du-input-xs" aria-label={`${STYLE_NAMES[r.id]}字号比例`} type="number" min={75} max={200} step={5} value={Math.round(r.scale*100)} disabled={disabled||pending} onChange={e=>update(r.id,{scale:Math.max(.75,Math.min(2,Number(e.target.value)/100))})}/>%</label>
          <label><input type="checkbox" checked={r.bold} disabled={disabled||pending} onChange={e=>update(r.id,{bold:e.target.checked})}/>加粗</label><label><input type="checkbox" checked={r.italic} disabled={disabled||pending} onChange={e=>update(r.id,{italic:e.target.checked})}/>斜体</label>
        </div></details>}
      </section>)}
    </div>
    <footer className="style-settings-save"><small role="status">{error|| (saved?"已保存到此聊天":"关闭后，旧回复保留样式，新回复不用短标记")}</small><button className="du-btn du-btn-primary du-btn-sm" disabled={disabled||pending} onClick={async()=>{setPending(true);setError("");try{await save(draft);setSaved(true);}catch(e){setError((e as Error).message);}finally{setPending(false);}}}><Save size={14}/>{pending?"保存中…":"保存"}</button></footer>
  </details>;
}
