import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

test("upward gestures pause a live reply even within 100px of bottom, explicit return resumes", async ({ page }) => {
  test.setTimeout(60000);
  const { password } = JSON.parse(await readFile(join(homedir(), ".config/workers-chat/local-login.json"), "utf8"));
  await page.goto("/");
  await page.getByLabel("访问密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.locator(".new-chat").waitFor();
  await page.evaluate(async () => {
    const providerId = crypto.randomUUID();
    const response = await fetch("/api/settings/import", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "merge", data: {
        format: "workers-chat.settings", version: 1,
        settings: { defaultModel: { providerId, modelId: "scroll-fixture" } },
        providers: [{ id: providerId, name: "滚动测试", apiKey: "synthetic-scroll-key", prefix: "", baseUrl: "https://scroll-fixture.invalid/v1", models: [{id:"scroll-fixture",enabled:true,capacity:1048576,parameters:{}}] }],
      }}),
    });
    if (!response.ok) throw Error("scroll fixture setup");
  });
  await page.reload();
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    (window as any).appendScrollFixture = null;
    window.fetch = async (input, init) => {
      if (!String(input).startsWith("https://scroll-fixture.invalid/")) return original(input, init);
      const body = JSON.parse(String(init?.body));
      if (body.messages?.[0]?.content?.includes("<chat_history>"))
        return Response.json({choices:[{message:{content:'{"title":"滚动测试"}'}}]});
      return new Response(new ReadableStream({start(controller) {
        const send = (content:string) => controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify({choices:[{delta:{content}}]}) + "\n\n"));
        (window as any).appendScrollFixture = (content:string, done=false) => {
          send(content);
          if (done) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')); controller.close(); }
        };
        send(Array.from({length:80},(_,i)=>`第${i}段：这是滚动测试的持续回复。`).join("\n\n"));
      }}), {headers:{"Content-Type":"text/event-stream"}});
    };
  });
  await page.getByRole("button",{name:"账户菜单",exact:true}).click();
  await page.getByRole("button",{name:"设置",exact:true}).click();
  await page.getByRole("button",{name:"连接",exact:true}).click();
  await page.getByLabel("此设备直连",{exact:true}).check();
  await page.getByRole("button",{name:"关闭",exact:true}).click();
  await page.locator(".new-chat").click();
  await page.getByLabel("消息",{exact:true}).fill("测试上滑暂停跟随");
  await page.getByRole("button",{name:"发送",exact:true}).click();
  await page.getByLabel("直连验证密码",{exact:true}).fill(password);
  await page.getByRole("button",{name:"验证并连接",exact:true}).click();
  const scroll=page.locator(".message-scroll");
  const position=()=>scroll.evaluate(e=>({top:e.scrollTop,gap:e.scrollHeight-e.clientHeight-e.scrollTop}));
  await expect.poll(async()=>(await position()).top).toBeGreaterThan(400);
  await expect.poll(async()=>(await position()).gap).toBeLessThan(4);
  await scroll.hover(); await page.mouse.wheel(0,-65);
  await expect(page.getByRole("button",{name:"回到底部",exact:true})).toBeVisible();
  await expect.poll(async()=>(await position()).gap).toBeGreaterThan(40);
  const paused=(await position()).top;
  await page.evaluate(()=>(window as any).appendScrollFixture("\n\n新段落一\n\n新段落二"));
  await expect(page.locator(".message.assistant .markdown")).toContainText("新段落二");
  expect(Math.abs((await position()).top-paused)).toBeLessThan(4);
  await page.mouse.wheel(0,100000);
  await expect.poll(async()=>(await position()).gap).toBeLessThan(4);
  await page.evaluate(()=>(window as any).appendScrollFixture("\n\n恢复跟随的新段落"));
  await expect(page.locator(".message.assistant .markdown")).toContainText("恢复跟随");
  await expect.poll(async()=>(await position()).gap).toBeLessThan(4);
  await page.mouse.wheel(0,-65);
  await page.getByRole("button",{name:"回到底部",exact:true}).click();
  await page.evaluate(()=>(window as any).appendScrollFixture("\n\n最终完整段落",true));
  await expect(page.locator(".message.assistant .markdown")).toContainText("最终完整段落");
  await expect.poll(async()=>(await position()).gap).toBeLessThan(4);
});
