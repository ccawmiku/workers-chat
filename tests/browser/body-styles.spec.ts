import {test,expect} from "@playwright/test";
import {readFile} from "node:fs/promises";
import {homedir} from "node:os";
import {join} from "node:path";
import {defaultBodyStyles} from "../../src/shared/body-styles";
test("per-chat body styles preview/save, safe rendering and disabled tool",async({page},info)=>{
  const phone=info.project.name.includes("mobile");
  await page.setViewportSize(phone?{width:390,height:844}:{width:1440,height:1000});
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  const {password}=JSON.parse(await readFile(join(homedir(),".config/workers-chat/local-login.json"),"utf8"));
  await page.goto("/");await page.getByLabel("访问密码",{exact:true}).fill(password);await page.getByRole("button",{name:"登录",exact:true}).click();await page.locator(".new-chat").waitFor({state:"attached"});
  const config=defaultBodyStyles();config.enabled=true;config.rules.find(r=>r.id==="rb")!.instruction="人物说话";
  const id=await page.evaluate(async config=>{
    async function post(path:string,data:unknown){const r=await fetch("/api"+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});if(!r.ok)throw Error("fixture "+r.status);return r.json() as Promise<any>;}
    const providerId=crypto.randomUUID();await post("/settings/import",{mode:"replace",data:{format:"workers-chat.settings",version:1,settings:{defaultModel:{providerId,modelId:"style-fixture"}},providers:[{id:providerId,name:"Local",baseUrl:"https://style-fixture.invalid/v1",models:[{id:"style-fixture",enabled:true,capacity:32768,parameters:{}}]}]}});
    const result=await post("/import",{data:{title:"正文样式验证",workers_chat_body_styles:config,messages:[{id:"u",role:"user",content:"请描述茶室。"},{id:"a",role:"assistant",content:'{rb}**你好**{/rb}，<font color="red" size="5">文字</font>',workers_chat_style_tagged:true}]}});
    localStorage.setItem("lastChat",result.ids[0]);return result.ids[0];
  },config);
  await page.reload();const text=page.locator(".message.assistant .markdown");await expect(text).toContainText("你好");await expect(text).not.toContainText("{rb}");
  const colored=text.locator("strong span");await expect(colored).toHaveCount(1);expect(await colored.evaluate(e=>getComputedStyle(e).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  expect(await text.locator('span').filter({hasText:/^文字$/}).evaluate(e=>getComputedStyle(e).color)).toBe("rgb(255, 0, 0)");
  await page.getByRole("button",{name:"当前聊天设置",exact:true}).click();await page.locator(".body-style-settings > summary").click();
  const settings=page.locator(".body-style-settings");await expect(settings.locator(".style-rule")).toHaveCount(10);
  await settings.getByLabel("浅红背景用途",{exact:true}).fill("人物明确说出口的话");await settings.getByLabel("启用正文样式",{exact:true}).uncheck();
  await settings.getByRole("button",{name:"保存",exact:true}).click();await expect(settings.getByRole("status")).toHaveText("已保存到此聊天");
  const saved=await (await page.request.get("/api/chats/"+id)).json();expect(saved.chat.bodyStyles.enabled).toBe(false);expect(saved.chat.bodyStyles.rules.find((r:{id:string})=>r.id==="rb").instruction).toBe("人物明确说出口的话");
  const preview=await page.evaluate(async id=>{const r=await fetch("/api/chats/"+id+"/preview",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({draft:"继续"})});if(!r.ok)throw Error("preview "+r.status);return r.json() as Promise<any>;},id);
  expect(preview.messages.filter((m:{name?:string})=>m.name==="plugin_body_styles")).toHaveLength(1);expect(JSON.stringify(preview)).toContain("暂时关闭");
  await page.screenshot({path:`test-results/body-styles-${info.project.name}.png`});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.getByRole("button",{name:"返回聊天",exact:true}).click();await expect(colored).toHaveCount(1);expect(await colored.evaluate(e=>getComputedStyle(e).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  expect(errors).toEqual([]);
});
