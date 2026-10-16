import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultPlugins } from "../../src/shared/plugins";
for (const mobile of [false, true])
  test(`four plugin flows, draft safety, live preview and grouping (${mobile ? "phone" : "desktop"})`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
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
    await page.locator(".new-chat").waitFor({ state: "attached" });
    const id = await page.evaluate(async (plugins) => {
      const providerId = crypto.randomUUID();
      const api = async (path: string, method = "GET", body?: unknown) => {
        const r = await fetch("/api" + path, {
          method,
          headers: { "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!r.ok) throw Error("fixture " + path + " " + r.status);
        return r.json() as Promise<any>;
      };
      await api("/settings/import", "POST", {
        mode: "replace",
        data: {
          format: "workers-chat.settings",
          version: 1,
          settings: {
            defaultModel: { providerId, modelId: "plugin-model" },
            plugins,
          },
          providers: [
            {
              id: providerId,
              name: "插件合成接口",
              baseUrl: "https://plugin-fixture.invalid/v1",
              prefix: "FX/",
              models: [
                {
                  id: "plugin-model",
                  enabled: true,
                  capacity: 1048576,
                  parameters: {},
                },
              ],
            },
          ],
        },
      });
      const chat = await api("/chats", "POST", {});
      await api("/chats/" + chat.id, "PATCH", { title: "四插件实际界面测试" });
      localStorage.setItem("lastChat", chat.id);
      localStorage.setItem("device-direct", "true");
      return chat.id;
    }, defaultPlugins());
    await page.addInitScript(() => {
      const original = window.fetch.bind(window),
        ledger: { kind: string; messages: unknown[] }[] = [];
      (window as any).pluginLedger = ledger;
      window.fetch = async (input, init) => {
        if (!String(input).startsWith("https://plugin-fixture.invalid/v1"))
          return original(input, init);
        const body = JSON.parse(String(init?.body || "{}")),
          messages = body.messages as { content: string | null }[];
        const last = messages.at(-1)?.content ?? "",
          all = messages.map((m) => m.content ?? "").join("\n");
        let kind = "main",
          content = "主回答已结合目标、约束和澄清结果完成。";
        if (last.includes("JSON Schema：")) {
          kind = "analysis";
          content = JSON.stringify({
            goals: ["故事"],
            constraints: ["简短"],
            plan: ["开始"],
          });
        } else if (last.includes("提出一批具体、必要的澄清问题")) {
          kind = "clarify";
          content = "1. 请问希望采用哪种风格？";
        } else if (all.includes('"suggestions"')) {
          kind = "suggest";
          content = JSON.stringify({
            suggestions: ["再给我一个例子", "换成更简短的版本", "加入新的场景"],
          });
        } else if (all.includes("这不是润色")) {
          kind = "rewrite";
          content = "请围绕既定目标重新设计情节，加入明确的场景与人物动机。";
        }
        ledger.push({ kind, messages });
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
                          cached_tokens: 80,
                          cache_hit_rate: "80.0%",
                        },
                      }) +
                      "\n\ndata: [DONE]\n\n",
                  ),
                );
                c.close();
              }, 200);
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      };
    });
    await page.reload();
    await expect(page.locator(".header-title")).toHaveText(
      "四插件实际界面测试",
    );
    await expect(
      page
        .locator(".composer-controls")
        .getByRole("button", { name: "插件", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "插件", exact: true }).click();
    for (const name of [
      "JSON 分析",
      "提问澄清",
      "追问建议",
      "重新生成 user 提示",
    ]) {
      await page.getByLabel("启用 " + name, { exact: true }).check();
      await expect(
        page.getByRole("button", { name: name + "上下文", exact: true }),
      ).toBeVisible();
    }
    await expect(
      page.getByRole("button", { name: "上移 追问建议", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "上移 重新生成 user 提示",
        exact: true,
      }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "上移 提问澄清", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "上移 提问澄清", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "下移 提问澄清", exact: true })
      .click();
    await page.getByRole("button", { name: "关闭插件列表" }).click();
    let previewAPIs = 0;
    const counter = (r: any) => {
      if (r.url().includes("/api/") && !r.url().endsWith("/draft"))
        previewAPIs++;
    };
    page.on("request", counter);
    await page.getByLabel("消息", { exact: true }).fill("写一个短故事");
    await page
      .getByRole("button", { name: "JSON 分析上下文", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "JSON 分析 · 上下文", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("总输入／模型容量", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "关闭插件窗口", exact: true })
      .click();
    expect(previewAPIs).toBe(0);
    page.off("request", counter);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".plugin-reply")).toBeVisible();
    await expect(page.locator(".plugin-question[open]")).toContainText(
      "哪种风格",
    );
    expect(
      await page.evaluate(() =>
        (window as any).pluginLedger.map((x: any) => x.kind),
      ),
    ).toEqual(["analysis", "clarify"]);
    await page.screenshot({
      path: `test-results/plugins-${mobile ? "phone" : "desktop"}.png`,
    });
    if (mobile) {
      await page.reload();
      await expect(page.locator(".plugin-reply")).toBeVisible();
      expect(await page.evaluate(() => (window as any).pluginLedger)).toEqual(
        [],
      );
    }
    await page.getByLabel("消息", { exact: true }).fill("轻松幽默");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".message.assistant .markdown")).toContainText(
      "主回答已结合",
    );
    await expect(
      page.getByRole("button", { name: "再给我一个例子", exact: false }),
    ).toBeVisible();
    await expect(page.locator(".plugin-question[open]")).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        (window as any).pluginLedger.map((x: any) => x.kind),
      ),
    ).toEqual(
      mobile ? ["main", "suggest"] : ["analysis", "clarify", "main", "suggest"],
    );
    await page.getByLabel("消息", { exact: true }).fill("保留的旧草稿");
    await page
      .getByRole("button", { name: "再给我一个例子", exact: false })
      .click();
    await expect(
      page.getByRole("dialog", { name: "替换当前草稿", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue(
      "保留的旧草稿",
    );
    await page
      .getByRole("button", { name: "重新生成 user 提示", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", {
        name: "重新生成 user 提示 · 对比",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByLabel("新用户请求", { exact: true })
      .fill("我手动确认的新要求");
    await page.getByRole("button", { name: "确认替换", exact: true }).click();
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue(
      "我手动确认的新要求",
    );
    const result = await page.evaluate(async (id) => {
      const r = await fetch("/api/chats/" + id);
      return r.json() as Promise<any>;
    }, id);
    expect(Object.values(result.chat.messages)).toHaveLength(2);
    expect(
      result.pluginState.runs.filter((r: any) => r.status === "answered"),
    ).toHaveLength(1);
    expect(JSON.stringify(result.chat.messages)).not.toContain("轻松幽默");
    if (mobile)
      await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.getByRole("button", { name: "新建分组", exact: true }).click();
    await page.getByLabel("分组名称", { exact: true }).fill("插件测试组");
    await page.getByRole("button", { name: "确认", exact: true }).click();
    await page
      .locator(".chat-row.selected")
      .getByRole("button", { name: "管理 四插件实际界面测试", exact: true })
      .click();
    await page.getByRole("button", { name: "移进分组", exact: true }).click();
    await page
      .getByRole("dialog", { name: "移进分组", exact: true })
      .getByRole("button", { name: "插件测试组", exact: true })
      .first()
      .click();
    await page
      .locator(".chat-row.selected")
      .getByRole("button", { name: "管理 四插件实际界面测试", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "移出分组", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "移出分组", exact: true }).click();
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
