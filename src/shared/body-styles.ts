import type { APIMessage } from "./plugins";
export const STYLE_IDS = ["b", "i", "lg", "sm", "rt", "bt", "yb", "bb", "rb", "gb"] as const;
export type StyleId = (typeof STYLE_IDS)[number];
export type StyleRule = {
  id: StyleId; enabled: boolean; instruction: string;
  color: string; background: string; scale: number; bold: boolean; italic: boolean;
};
export type BodyStyles = { enabled: boolean; rules: StyleRule[] };
export const STYLE_NAMES: Record<StyleId, string> = {
  b: "加粗", i: "斜体", lg: "稍大字号", sm: "稍小字号", rt: "红色文字", bt: "蓝色文字",
  yb: "浅黄背景", bb: "浅蓝背景", rb: "浅红背景", gb: "浅绿背景",
};
export const SHORT_STYLE = /\{(\/?)(lg|sm|rt|bt|yb|bb|rb|gb)(\/?)\}/g;
export function defaultBodyStyles(): BodyStyles {
  return { enabled: false, rules: STYLE_IDS.map(id => ({
    id, enabled: true, instruction: "", color: id === "rt" ? "#d65656" : id === "bt" ? "#528ad1" : "",
    background: ({yb:"#e8bd44",bb:"#66a8e0",rb:"#e88888",gb:"#6ebd98"} as Record<string,string>)[id] ?? "",
    scale: id === "lg" ? 1.15 : id === "sm" ? .9 : 1, bold: id === "b", italic: id === "i",
  })) };
}
export function parseBodyStyles(value: unknown): BodyStyles {
  if (!value || typeof value !== "object") throw Error("正文样式配置无效");
  const v = value as BodyStyles;
  if (typeof v.enabled !== "boolean" || !Array.isArray(v.rules) || v.rules.length !== 10 ||
      new Set(v.rules.map(r => r?.id)).size !== 10) throw Error("必须保留十种不同的内置样式");
  return {enabled: v.enabled, rules: v.rules.map(r => {
    if (!STYLE_IDS.includes(r.id) || typeof r.enabled !== "boolean" || typeof r.instruction !== "string" || r.instruction.length > 2000 ||
        ![r.color,r.background].every(c => typeof c === "string" && /^(?:|#[0-9a-fA-F]{6})$/.test(c)) ||
        !Number.isFinite(r.scale) || r.scale < .75 || r.scale > 2 || typeof r.bold !== "boolean" || typeof r.italic !== "boolean")
      throw Error("样式参数无效：颜色需为六位色值，字号为75%–200%");
    const native = r.id === "b" || r.id === "i";
    return {id:r.id,enabled:r.enabled,instruction:r.instruction,
      color:native?"":r.color,background:native?"":r.background,scale:native?1:r.scale,
      bold:native?r.id==="b":r.bold,italic:native?r.id==="i":r.italic};
  })};
}
/** Preserve fenced and inline code verbatim, including an unfinished streaming fence. */
export function outsideCode(text: string, transform: (text: string) => string): string {
  const protectedCode = /(^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\2[~`]*[^\n]*(?:\n|$)|(?![\s\S])))|(`+)([^`]|(?!\3)`)*?\3/gm;
  let start=0, result="";
  for (const m of text.matchAll(protectedCode)) {
    result += transform(text.slice(start,m.index)) + m[0]; start = m.index! + m[0].length;
  }
  return result + transform(text.slice(start));
}
export function stripStyleMarkers(text: string): string {
  return outsideCode(text, s => s.replace(SHORT_STYLE,""));
}
export function styleCSS(rule: StyleRule): Record<string,string|number> {
  return {
    ...(rule.color ? {color:`color-mix(in srgb, ${rule.color} 75%, var(--text, #222))`} : {}),
    ...(rule.background ? {backgroundColor:`color-mix(in srgb, ${rule.background} 18%, transparent)`,borderRadius:".2em",padding:".03em .13em",boxDecorationBreak:"clone"} : {}),
    ...(rule.scale !== 1 ? {fontSize:`${rule.scale}em`} : {}),
    ...(rule.bold ? {fontWeight:700} : {}), ...(rule.italic ? {fontStyle:"italic"} : {}),
  };
}
const escapeAttr = (s:string) => s.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;");
export function styledMarkdown(text:string, config?:BodyStyles, tagged=false):string {
  if (!tagged || !config) return stripStyleMarkers(text);
  let open = "";
  const output = outsideCode(text,s => s.replace(SHORT_STYLE,(_all,pre:string,id:string,post:string) => {
    if (pre || post) {if(open===id){open="";return "</span>";}return "";}
    const r=config.rules.find(r=>r.id===id); if(!r)return "";
    const prior = open ? "</span>" : ""; open=id;
    // Portable HTML uses literal colors; website rendering adapts the palette to its theme.
    const css = [r.color&&`color:${r.color}`,r.background&&`background-color:${r.background}2e`,r.scale!==1&&`font-size:${r.scale}em`,r.bold&&"font-weight:700",r.italic&&"font-style:italic"].filter(Boolean).join(";");
    return `${prior}<span style="${escapeAttr(css)}">`;
  }));
  return output + (open ? "</span>" : "");
}
/** One stable, request-only tool pair; never accumulated into stored history. */
export function bodyStyleMessages(messages:APIMessage[],config?:BodyStyles,pure=false):APIMessage[] {
  if(pure) return messages.map(m=>({...m,content:m.role==="assistant"&&m.content?stripStyleMarkers(m.content):m.content}));
  if(!config)return messages;
  const rules=config.rules.filter(r=>r.enabled&&r.instruction.trim());
  const content = config.enabled
    ? "正文样式仅作用于本轮新回复。按priority从小到大选择，冲突只用优先的一种短标记，不嵌套短标记。加粗用**文字**，斜体用*文字*；其余严格用{code}文字{/code}，不显示标签说明。不改写剧情，不编造事实；未命中规则不加短标记。\n"+JSON.stringify(rules.map((r,priority)=>({priority,code:r.id==="b"?"**":r.id==="i"?"*":r.id,rule:r.instruction.trim()})))
    : "本轮正文短标记样式暂时关闭。请勿沿用历史中的{rb}、{yb}等短标记，直接输出普通Markdown正文；原生加粗、斜体仍可正常使用。此状态只作用于本轮新回复，不改变故事内容。";
  const index=messages.findIndex(m=>m.role==="user"); if(index<0)return messages;
  const call="call_body_styles",name="plugin_body_styles";
  return [...messages.slice(0,index+1),
    {role:"assistant",content:null,tool_calls:[{id:call,type:"function",function:{name,arguments:"{}"}}]},
    {role:"tool",tool_call_id:call,name,content},...messages.slice(index+1)];
}
