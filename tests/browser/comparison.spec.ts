import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
for (const mobile of [false, true])
  test(`isolated side-by-side comparison, model parameters, overview and disable (${mobile ? "phone" : "desktop"})`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1500, height: 1000 },
    );
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
    await page.getByLabel("消息", { exact: true }).waitFor();
    const { id, providerId } = await page.evaluate(async () => {
      const providerId = crypto.randomUUID();
      const api = async (path: string, method = "GET", body?: unknown) => {
        const r = await fetch("/api" + path, {
          method,
          headers: { "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!r.ok) throw Error("fixture " + r.status);
        return r.json() as Promise<any>;
      };
      await api("/settings/import", "POST", {
        mode: "replace",
        data: {
          format: "workers-chat.settings",
          version: 1,
          settings: { defaultModel: { providerId, modelId: "main-fixture" } },
          providers: [
            {
              id: providerId,
              name: "comparison fixture",
              prefix: "T/",
              baseUrl: "https://comparison-fixture.invalid/v1",
              models: ["main-fixture", "comparison-fixture"].map((id) => ({
                id,
                enabled: true,
                capacity: 100000,
                parameters: {},
              })),
            },
          ],
        },
      });
      const c = await api("/chats", "POST", {});
      await api("/chats/" + c.id, "PATCH", { title: "对比窗口测试" });
      localStorage.setItem("lastChat", c.id);
      localStorage.setItem("device-direct", "true");
      return { id: c.id, providerId };
    });
    await page.addInitScript(() => {
      const original = window.fetch.bind(window),
        ledger: any[] = [];
      (window as any).comparisonLedger = ledger;
      window.fetch = async (input, init) => {
        if (!String(input).startsWith("https://comparison-fixture.invalid"))
          return original(input, init);
        const b = JSON.parse(String(init?.body || "{}"));
        const all = b.messages.map((m: any) => m.content || "").join("\n");
        if (all.includes("你负责将本轮回复提炼"))
          return Response.json({
            choices: [
              {
                message: { content: '{"summary":"这是本轮测试回复的摘要。"}' },
                finish_reason: "stop",
              },
            ],
          });
        ledger.push(b);
        const isComparison = b.model === "comparison-fixture",
          n = ledger.filter((v) => v.model === b.model).length;
        const content = (isComparison ? "独立对比回复" : "主窗口回复") + n;
        return new Response(
          new ReadableStream({
            start(c) {
              const e = new TextEncoder();
              c.enqueue(
                e.encode(
                  "data: " +
                    JSON.stringify({
                      choices: [{ delta: { content: content.slice(0, 3) } }],
                    }) +
                    "\n\n",
                ),
              );
              setTimeout(() => {
                c.enqueue(
                  e.encode(
                    "data: " +
                      JSON.stringify({
                        choices: [
                          {
                            delta: { content: content.slice(3) },
                            finish_reason: "stop",
                          },
                        ],
                        usage: {
                          input_tokens: 100,
                          output_tokens: 20,
                          cached_tokens: 80,
                        },
                      }) +
                      "\n\ndata: [DONE]\n\n",
                  ),
                );
                c.close();
              }, 350);
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      };
    });
    await page.reload();
    await page
      .getByRole("button", { name: "当前聊天设置", exact: true })
      .click();
    const panel = page.locator(".parameters");
    await panel.getByLabel("开启对比", { exact: true }).click();
    await expect(panel.getByLabel("开启对比", { exact: true })).toBeChecked();
    await expect(page.getByLabel("对比窗口", { exact: true })).toBeVisible();
    await panel
      .getByLabel("对比模型", { exact: true })
      .selectOption(
        JSON.stringify({ providerId, modelId: "comparison-fixture" }),
      );
    await panel.getByLabel("对比温度", { exact: true }).fill("0.2");
    await panel.getByLabel("对比温度", { exact: true }).blur();
    await expect
      .poll(async () =>
        page.evaluate(
          async (id) =>
            ((await (await fetch("/api/chats/" + id)).json()) as any).chat
              .comparison.parameters.temperature,
          id,
        ),
      )
      .toBe(0.2);
    await panel.getByLabel("对比上下文", { exact: true }).selectOption("plain");
    await expect(panel.getByLabel("对比上下文", { exact: true })).toHaveValue(
      "plain",
    );
    await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    const send = async (text: string) => {
      await page.getByLabel("消息", { exact: true }).fill(text);
      await page.getByRole("button", { name: "发送", exact: true }).click();
      const confirm = page.getByRole("button", {
        name: "继续发送",
        exact: true,
      });
      if (await confirm.isVisible()) await confirm.click();
    };
    await send("FIRST_MAIN_PROMPT");
    await expect(
      page.locator("main .message.assistant .markdown"),
    ).toContainText("主窗口回复1");
    await expect(
      page.locator(".comparison-pane .comparison-answer"),
    ).toContainText("独立对比回复1");
    expect(
      await page.locator(".conversation-workspace").evaluate((el) => {
        const left = el.querySelector("main")!.getBoundingClientRect(),
          right = el.querySelector(".comparison-pane")!.getBoundingClientRect();
        return left.right <= right.left + 1;
      }),
    ).toBe(true);
    const first = await page.evaluate(
      async (id) =>
        ((await (await fetch("/api/chats/" + id)).json()) as any).chat
          .comparisonRuns[0],
      id,
    );
    await page.evaluate(async (first) => {
      const c = (
        (await (await fetch("/api/chats/" + first.chatId)).json()) as any
      ).chat;
      await fetch("/api/chats/" + first.chatId + "/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageId: c.currentId,
          content: "SHOULD_NOT_ENTER_SECOND_COMPARISON",
        }),
      });
    }, first);
    await send("SECOND_MAIN_PROMPT");
    await expect(
      page.locator("main .message.assistant .markdown").last(),
    ).toContainText("主窗口回复2");
    await expect(
      page.locator(".comparison-pane .comparison-answer"),
    ).toContainText("独立对比回复2");
    const calls = await page.evaluate(() => (window as any).comparisonLedger);
    expect(
      calls.filter((c: any) => c.model === "comparison-fixture"),
    ).toHaveLength(2);
    const second = calls.filter(
      (c: any) => c.model === "comparison-fixture",
    )[1];
    expect(second.temperature).toBe(0.2);
    expect(JSON.stringify(second)).toContain("FIRST_MAIN_PROMPT");
    expect(JSON.stringify(second)).not.toContain(
      "SHOULD_NOT_ENTER_SECOND_COMPARISON",
    );
    await page
      .getByRole("button", { name: "当前聊天设置", exact: true })
      .click();
    await page.getByRole("tab", { name: "分支总览", exact: true }).click();
    await expect(page.locator(".comparison-branches button")).toHaveCount(2);
    await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    await page.screenshot({
      path: `test-results/comparison-${mobile ? "phone" : "desktop"}-${test.info().project.name}.png`,
    });
    await page.reload();
    await expect(page.locator(".comparison-answer")).toContainText("独立对比回复2");
    await page
      .getByRole("button", { name: "当前聊天设置", exact: true })
      .click();
    await page.getByRole("tab", { name: "当前聊天设置", exact: true }).click();
    await panel.getByLabel("开启对比", { exact: true }).click();
    await expect(
      panel.getByLabel("开启对比", { exact: true }),
    ).not.toBeChecked();
    await expect(page.locator(".comparison-pane")).toHaveCount(0);
    await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    await expect(page.locator(".app-version")).toHaveText("v1.2.0");
    expect(errors).toEqual([]);
  });
