import {describe,it,expect} from "vitest";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {StyledMarkdown} from "../src/client/styled-markdown";
import {defaultBodyStyles,parseBodyStyles,stripStyleMarkers,styledMarkdown} from "../src/shared/body-styles";
import {newChat,addMessage,contextMessages} from "../src/shared/chat";
import {exportChat,importChats} from "../src/shared/exchange";
import {comparisonFork,defaultComparison} from "../src/shared/comparison";
const config=defaultBodyStyles();config.enabled=true;config.rules.find(r=>r.id==="rb")!.instruction="主角说的话";
const render=(text:string,tagged=true)=>renderToStaticMarkup(React.createElement(StyledMarkdown,{config,tagged,children:text}));
describe("正文样式",()=>{
  it("renders short markers, native emphasis, safe HTML colors/size and table backgrounds",()=>{
    const html=render('{rb}**你好**{rb/}，<font color="red" size="5">文字</font>\n\n<table><tr><td bgcolor="#ffff00">背景</td></tr></table>');
    expect(html).not.toContain("{rb}");expect(html).toContain("background-color:color-mix");
    expect(html).toContain("<strong>");expect(html).toContain("color:red");expect(html).toContain("font-size:1.4em");expect(html).toContain("background-color:#ffff00");
  });
  it("keeps code literal, preserves unfinished streaming text and disables only short styles for new replies",()=>{
    expect(render('`{rb}code{rb/}`')).toContain("{rb}code{rb/}");
    expect(render('{rb}尚未结束')).toContain("尚未结束");
    expect(render('{rb}正文{rb/}',false)).toBe("<p>正文</p>");
    expect(stripStyleMarkers('a{rb}正文{rb/}\n```txt\n{rb}code{rb/}\n```')).toContain('```txt\n{rb}code{rb/}');
    expect(render('<span style="color:blue">HTML</span>',false)).toContain("color:blue");
  });
  it("drops active HTML, event handlers, URL styles and layout CSS",()=>{
    const html=render('<script>alert(1)</script><iframe src="https://bad.invalid"></iframe><span onclick="alert(1)" style="position:fixed;color:red;background-image:url(https://bad.invalid)">文字</span>');
    expect(html).not.toMatch(/alert|iframe|onclick|position|bad\.invalid|background-image/);expect(html).toContain("文字");
  });
  it("injects one stable tool, includes off instructions, and strips styles in pure comparisons",()=>{
    const c=newChat();c.bodyStyles=structuredClone(config);addMessage(c,"user","第一轮");const a=addMessage(c,"assistant","{rb}你好{rb/}");a.styleTagged=true;addMessage(c,"user","第二轮");
    const messages=contextMessages(c);expect(messages.filter(m=>m.name==="plugin_body_styles")).toHaveLength(1);
    expect(messages.find(m=>m.name==="plugin_body_styles")!.content).toContain("主角说的话");
    c.bodyStyles.enabled=false;expect(contextMessages(c).find(m=>m.role==="tool")!.content).toContain("暂时关闭");
    const fork=comparisonFork(c,{...defaultComparison(),mode:"plain"},[]);
    expect(JSON.stringify(contextMessages(fork))).not.toMatch(/plugin_body_styles|\{rb\}/);
    expect(c.messages[a.id]!.content).toBe("{rb}你好{rb/}");
  });
  it("round-trips per-chat rules and render flags, exports portable HTML and rejects added/deleted types",()=>{
    const c=newChat();c.bodyStyles=structuredClone(config);addMessage(c,"user","问");const a=addMessage(c,"assistant","{rb}答{rb/}");a.styleTagged=true;
    const restored=importChats(exportChat(c)).chats[0]!;expect(restored.bodyStyles).toEqual(c.bodyStyles);expect(restored.messages[a.id]!.styleTagged).toBe(true);
    expect(styledMarkdown(a.content,config,true)).toContain('<span style="background-color:');
    expect(()=>parseBodyStyles({...config,rules:config.rules.slice(1)})).toThrow();
    expect(()=>parseBodyStyles({...config,rules:[...config.rules.slice(1),config.rules[1]]})).toThrow();
  });
});
