import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Chat } from "../../src/shared/chat";

test("device streams paint before completion, unlock once, save, title, stop and report CORS without replay", async ({
  page,
}) => {
  test.setTimeout(60000);
  const { password } = JSON.parse(
    await readFile(
      join(homedir(), ".config/workers-chat/local-login.json"),
      "utf8",
    ),
  );
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByLabel("访问密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.locator(".new-chat").waitFor();
  await page.evaluate(async () => {
    const providerId = crypto.randomUUID();
    const result = await fetch("/api/settings/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "replace",
        data: {
          format: "workers-chat.settings",
          version: 1,
          settings: { defaultModel: { providerId, modelId: "fixture-device" } },
          providers: [
            {
              id: providerId,
              name: "设备直连测试",
              prefix: "D/",
              baseUrl: "https://device-fixture.invalid/v1",
              apiKey: "synthetic-device-key",
              models: [
                {
                  id: "fixture-device",
                  enabled: true,
                  capacity: 1048576,
                  parameters: {},
                },
              ],
            },
          ],
        },
      }),
    });
    if (!result.ok) throw Error("Device fixture setup failed");
  });
  await page.reload();
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    const state = {
      calls: 0,
      titles: 0,
      fail: false,
      credentials: [] as string[],
    };
    (window as unknown as { directFixture: typeof state }).directFixture =
      state;
    window.fetch = async (input, init) => {
      if (!String(input).startsWith("https://device-fixture.invalid/v1"))
        return original(input, init);
      if (init?.credentials !== "omit" || init.redirect !== "error")
        throw Error("Unsafe direct request options");
      state.credentials.push(
        String(new Headers(init.headers).get("Authorization")),
      );
      const body = JSON.parse(String(init.body || "{}"));
      if (String(input).endsWith("/models"))
        return Response.json({ data: [{ id: "fixture-device" }] });
      if (body.messages?.[0]?.content?.includes("<chat_history>")) {
        state.titles++;
        return Response.json({
          choices: [
            { message: { content: JSON.stringify({ title: "📱 直连测试" }) } },
          ],
        });
      }
      state.calls++;
      if (state.fail) throw TypeError("Failed to fetch");
      const timers: ReturnType<typeof setTimeout>[] = [];
      return new Response(
        new ReadableStream({
          start(controller) {
            const send = (data: unknown) =>
              controller.enqueue(
                new TextEncoder().encode(
                  "data: " + JSON.stringify(data) + "\n\n",
                ),
              );
            send({ choices: [{ delta: { content: "第一段即时内容" } }] });
            timers.push(
              setTimeout(
                () =>
                  send({
                    choices: [{ delta: { content: "，第二段完整回答" } }],
                  }),
                600,
              ),
            );
            timers.push(
              setTimeout(() => {
                send({
                  choices: [{ delta: {}, finish_reason: "stop" }],
                  usage: { total_tokens: 25 },
                });
                controller.enqueue(
                  new TextEncoder().encode("data: [DONE]\n\n"),
                );
                controller.close();
              }, 2200),
            );
          },
          cancel() {
            for (const timer of timers) clearTimeout(timer);
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    };
  });
  await page.getByRole("button", { name: "账户菜单", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.getByLabel("此设备直连", { exact: true }).check();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".new-chat").click();
  await page.getByLabel("消息", { exact: true }).fill("测试直连流式");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByLabel("直连验证密码", { exact: true })).toHaveCount(0);
  await expect(page.locator(".message.assistant .markdown")).toHaveText(
    "第一段即时内容",
  );
  await expect(
    page.getByRole("button", { name: "停止生成", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".chat-row.selected .chat-title")).toHaveText(
    "📱 直连测试",
  );
  await expect(page.locator(".message.assistant .markdown")).toHaveText(
    "第一段即时内容，第二段完整回答",
  );
  const saved = await page.evaluate(
    async () =>
      (await (
        await fetch("/api/chats/" + localStorage.getItem("lastChat"))
      ).json()) as { chat: Chat },
  );
  expect(
    Object.values(saved.chat.messages).find((m) => m.role === "assistant")
      ?.usage,
  ).toMatchObject({ total_tokens: 25 });
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "synthetic-device-key",
  );
  const sendNext = async () => {
    const before = await page.evaluate(
      () =>
        (window as unknown as { directFixture: { calls: number } })
          .directFixture.calls,
    );
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const confirmation = page.getByRole("button", {
      name: "继续发送",
      exact: true,
    });
    await expect
      .poll(
        async () =>
          (await confirmation.isVisible()) ||
          (await page.evaluate(
            (previous) =>
              (window as unknown as { directFixture: { calls: number } })
                .directFixture.calls > previous,
            before,
          )),
      )
      .toBe(true);
    if (await confirmation.isVisible()) await confirmation.click();
  };
  // A snapshot requested during streaming returns only after /finish. It must
  // not replace the complete local answer or satisfy the final fresh refresh.
  let releaseSnapshot!: () => void;
  const snapshotGate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  let held = false;
  await page.route(/\/api\/chats\/[^/?]+$/, async (route) => {
    if (route.request().method() !== "GET" || held) return route.continue();
    held = true;
    const response = await route.fetch();
    await snapshotGate;
    await route.fulfill({ response });
  });
  const finishResponse = page.waitForResponse(
    (r) =>
      /\/api\/device\/jobs\/[^/]+\/finish$/.test(r.url()) && r.status() === 200,
  );
  await page.getByLabel("消息", { exact: true }).fill("快照不能覆盖完整回答");
  await sendNext();
  await expect(
    page.locator(".message.assistant .markdown").last(),
  ).toContainText("第一段即时内容");
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect.poll(() => held).toBe(true);
  await finishResponse;
  releaseSnapshot();
  await expect(
    page.getByRole("button", { name: "停止生成", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".message.assistant .markdown").last()).toHaveText(
    "第一段即时内容，第二段完整回答",
  );
  await page.unroute(/\/api\/chats\/[^/?]+$/);
  let rejectedSave = false;
  await page.route(/\/api\/device\/jobs\/[^/]+\/finish$/, async (route) => {
    if (!rejectedSave) {
      rejectedSave = true;
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByLabel("消息", { exact: true }).fill("保存失败保留文字");
  await sendNext();
  await expect(
    page.getByRole("button", { name: "重试保存回答", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".message.assistant .markdown").last()).toHaveText(
    "第一段即时内容，第二段完整回答",
  );
  await page.getByRole("button", { name: "重试保存回答", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "重试保存回答", exact: true }),
  ).toHaveCount(0);
  await page.unroute(/\/api\/device\/jobs\/[^/]+\/finish$/);
  await page.getByLabel("消息", { exact: true }).fill("停止直连");
  await sendNext();
  await expect(
    page.locator(".message.assistant .markdown").last(),
  ).toContainText("第一段即时内容");
  await page.getByRole("button", { name: "停止生成", exact: true }).click();
  await expect(page.locator(".message.assistant").last()).toContainText(
    "已停止",
  );
  await page.evaluate(() => {
    (
      window as unknown as { directFixture: { fail: boolean } }
    ).directFixture.fail = true;
  });
  await page.getByLabel("消息", { exact: true }).fill("跨域拒绝时不重复发送");
  await sendNext();
  await expect(page.locator(".message.assistant").last()).toContainText("CORS");
  const state = await page.evaluate(
    () =>
      (
        window as unknown as {
          directFixture: {
            calls: number;
            titles: number;
            credentials: string[];
          };
        }
      ).directFixture,
  );
  expect(state.calls).toBe(5);
  expect(state.titles).toBe(1);
  expect(
    state.credentials.every((key) => key === "Bearer synthetic-device-key"),
  ).toBe(true);
  expect(errors).toEqual([]);
});
