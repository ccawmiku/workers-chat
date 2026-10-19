import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Plugin } from "unified";
import type { Root as MdRoot } from "mdast";
import type { Root, Element } from "hast";
import type { BodyStyles } from "../shared/body-styles";
import { SHORT_STYLE, styleCSS } from "../shared/body-styles";

type Node = {type:string;value?:string;children?:Node[];data?:Record<string,unknown>};
const shortStyles:Plugin<[{enabled:boolean}],MdRoot> = ({enabled}) => tree => {
  let current="";
  function walk(node:Node) {
    if(["code","inlineCode","html"].includes(node.type))return;
    if(!node.children)return;
    const next:Node[]=[];
    for(const child of node.children) {
      if(child.type!=="text"){walk(child);next.push(child);continue;}
      const source=child.value??""; let at=0;
      const push=(value:string)=>{if(!value)return;
        if(current&&enabled)next.push({type:"html",value:`<span data-style-key="${current}">`});
        next.push({type:"text",value});
        if(current&&enabled)next.push({type:"html",value:"</span>"});
      };
      for(const match of source.matchAll(SHORT_STYLE)) {
        push(source.slice(at,match.index));
        if(match[2]){if(current===match[1])current="";}else current=match[1]!;
        at=match.index!+match[0].length;
      }
      push(source.slice(at));
    }
    node.children=next;
  }
  walk(tree as Node);
};
function safeColor(value:string) {
  return /^(?:#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+-]+\)|red|blue|green|yellow|orange|purple|pink|black|white|gray|grey|cyan|magenta|transparent|inherit)$/i.test(value.trim());
}
function safeDeclarations(source:string) {
  return source.split(";").flatMap(declaration=>{
    const colon=declaration.indexOf(":");if(colon<0)return [];
    const key=declaration.slice(0,colon).trim().toLowerCase(),value=declaration.slice(colon+1).trim();
    if(["color","background-color"].includes(key)&&safeColor(value))return [`${key}:${value}`];
    if(key==="font-size"&&/^(?:\d+(?:\.\d+)?)(?:px|em|rem|%)$/.test(value)) {
      const n=parseFloat(value),unit=value.replace(/[\d.]/g,"");
      if(n>0&&n<=({px:48,em:2,rem:2,"%":200}[unit]??0))return [`${key}:${value}`];
    }
    if(key==="font-weight"&&/^(?:normal|bold|[1-9]00)$/.test(value))return [`${key}:${value}`];
    if(key==="font-style"&&/^(?:normal|italic)$/.test(value))return [`${key}:${value}`];
    return [];
  }).join(";");
}
const restrictStyles:Plugin<[],Root> = () => tree => {
  function walk(node:Root|Element) {
    if(node.type==="element") {
      const p=node.properties,styles=[String(p.style??"")];
      if(node.tagName==="font") {
        node.tagName="span";
        if(typeof p.color==="string"&&safeColor(p.color))styles.push(`color:${p.color}`);
        const size=Number(p.size); if(Number.isInteger(size)&&size>=1&&size<=7)styles.push(`font-size:${[.75,.85,1,1.15,1.4,1.7,2][size-1]}em`);
      }
      if(typeof p.bgColor==="string"&&safeColor(p.bgColor))styles.push(`background-color:${p.bgColor}`);
      if(typeof p.bgcolor==="string"&&safeColor(p.bgcolor))styles.push(`background-color:${p.bgcolor}`);
      const safe=safeDeclarations(styles.join(";"));
      delete p.style;delete p.color;delete p.size;delete p.bgColor;delete p.bgcolor;
      if(safe)p.style=safe;
    }
    if("children"in node)for(const c of node.children)if(c.type==="element")walk(c);
  }
  walk(tree);
};
const schema={...defaultSchema,
  tagNames:[...(defaultSchema.tagNames??[]),"span"],
  strip:[...(defaultSchema.strip??[]),"script","style","iframe","object","embed","svg","math","template"],
  attributes:{...defaultSchema.attributes,"*":[...(defaultSchema.attributes?.["*"]??[]),"style"],span:[...(defaultSchema.attributes?.span??[]),["dataStyleKey",/^(lg|sm|rt|bt|yb|bb|rb|gb)$/]]},
};
export function StyledMarkdown({children,config,tagged=false,components={}}:{
  children:string;config?:BodyStyles;tagged?:boolean;components?:Components;
}) {
  return <Markdown remarkPlugins={[remarkGfm,[shortStyles,{enabled:tagged}]]}
    rehypePlugins={[rehypeRaw,restrictStyles,[rehypeSanitize,schema]]}
    components={{...components,span:({node,children,style})=>{
      const key=String(node?.properties.dataStyleKey??""),rule=tagged?config?.rules.find(r=>r.id===key):undefined;
      return <span style={{...style,...(rule?styleCSS(rule):{})}}>{children}</span>;
    }}}>{children}</Markdown>;
}
