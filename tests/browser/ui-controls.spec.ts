import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

for (const mobile of [false, true]) {
  test(`account menu, context turns and composer popovers (${mobile ? "phone" : "desktop"})`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    let generations = 0;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(
      /\/api\/chats\/[^/]+\/(send|regenerate|retry|continue|title)$/,
      async (route) => {
        generations++;
        await route.fulfill({
          status: 400,
          json: { error: "Synthetic UI test only" },
        });
      },
    );
    const { password } = JSON.parse(
      await readFile(
        join(homedir(), ".config/workers-chat/local-login.json"),
        "utf8",
      ),
    );
    await page.goto("/");
    await page.getByLabel("访问密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.locator(".new-chat").waitFor({ state: "attached" });
    const id = await page.evaluate(async () => {
      const post = async (path: string, body: unknown) => {
        const response = await fetch("/api" + path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok)
          throw Error("Fixture setup failed " + response.status);
        return (await response.json()) as { ids: string[] };
      };
      const providerId = crypto.randomUUID();
      await post("/settings/import", {
        mode: "replace",
        data: {
          format: "workers-chat.settings",
          version: 1,
          settings: { defaultModel: { providerId, modelId: "fixture-model" } },
          providers: [
            {
              id: providerId,
              name: "UI测试",
              baseUrl: "https://ui-fixture.invalid/v1",
              prefix: "UI/",
              models: [
                {
                  id: "fixture-model",
                  enabled: true,
                  capacity: 1048576,
                  parameters: {},
                },
              ],
            },
          ],
        },
      });
      const result = await post("/import", {
        data: [
          {
            chat: {
              title: "界面组件验证",
              history: {
                currentId: "a2",
                messages: {
                  u1: {
                    id: "u1",
                    parentId: null,
                    role: "user",
                    content: "第一轮问题",
                  },
                  a1: {
                    id: "a1",
                    parentId: "u1",
                    role: "assistant",
                    content: "第一轮回答",
                  },
                  u2: {
                    id: "u2",
                    parentId: "a1",
                    role: "user",
                    content: "第二轮问题",
                  },
                  a2: {
                    id: "a2",
                    parentId: "u2",
                    role: "assistant",
                    content: "第二轮回答",
                    usage: {
                      input_tokens: 5982,
                      output_tokens: 245,
                      total_tokens: 6227,
                      cached_tokens: 4908,
                      cache_hit_rate: "82.0%",
                    },
                  },
                },
              },
            },
          },
        ],
      });
      localStorage.setItem("lastChat", result.ids[0]);
      return result.ids[0] as string;
    });
    await page.evaluate(
      (line) =>
        localStorage.setItem(
          "appearance",
          JSON.stringify({
            theme: "system",
            font: 16,
            width: 800,
            line,
            collapse: true,
            enter: true,
          }),
        ),
      mobile ? 1.7 : 1.8,
    );
    await page.reload();
    await expect(page.locator(".chat-row.selected .chat-title")).toHaveText("界面组件验证");
    expect(
      await page
        .locator("article.assistant .markdown p")
        .first()
        .evaluate(
          (el) =>
            parseFloat(getComputedStyle(el).lineHeight) /
            parseFloat(getComputedStyle(el).fontSize),
        ),
    ).toBeCloseTo(mobile ? 1.7 : 1.6, 1);
    expect(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem("appearance")!).densityVersion,
      ),
    ).toBe(2);

    await expect(
      page
        .locator("article.assistant")
        .last()
        .getByRole("button", { name: "继续回答", exact: true })
        .locator("svg.lucide-circle-play"),
    ).toHaveCount(1);
    await expect(page.locator(".message-meta").last()).not.toContainText(
      "（实际）",
    );
    expect(
      await page
        .locator("article.assistant .markdown p")
        .first()
        .evaluate((el) => getComputedStyle(el).textAlign),
    ).toBe("justify");
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
      "href",
      "/favicon.svg",
    );
    await expect(
      page.locator("article.assistant").last().locator(".message-meta"),
    ).toContainText("缓存率 82.0%");
    await expect(
      page.locator("article.assistant").last().locator(".message-meta"),
    ).not.toContainText("缓存 4,908");
    await expect(
      page.locator("article.assistant").first().locator(".message-meta"),
    ).not.toContainText("缓存率");
    if (mobile)
      await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.getByRole("button", { name: "账户菜单", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "账户菜单", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `docs/screenshots/account-${mobile ? "mobile" : "desktop"}.png`,
    });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    const bounds = await settings.boundingBox();
    expect(bounds!.width).toBeGreaterThan(page.viewportSize()!.width * 0.9);
    expect(bounds!.height).toBeGreaterThan(page.viewportSize()!.height * 0.85);
    await page.getByRole("button", { name: "模型", exact: true }).click();
    await page.screenshot({
      path: `docs/screenshots/settings-${mobile ? "mobile" : "desktop"}.png`,
    });
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    if (mobile)
      await page.getByRole("button", { name: "收起导航", exact: true }).click();
    await expect(
      page.getByText("AI 的回答可能有误，请核实重要信息。", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "消息操作", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "聊天管理", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("删除消息与后续分支", { exact: true }),
    ).toHaveCount(0);
    for (const zoom of [0.8, 1, 1.25]) {
      await page.locator(".composer").evaluate((element, value) => {
        element.style.zoom = String(value);
      }, zoom);
      const ring = page.locator("svg.context-ring");
      await expect(ring).toHaveCount(1);
      const box = await ring.boundingBox();
      expect(Math.abs(box!.width - box!.height)).toBeLessThan(0.1);
      expect(
        await ring.evaluate(
          (element) => getComputedStyle(element, "::after").content,
        ),
      ).toBe("none");
    }
    await page.locator(".composer").evaluate((element) => {
      element.style.zoom = "1";
    });

    await expect(
      page.getByRole("button", { name: "移除本轮上下文", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "加入本轮上下文", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "上下文使用量", exact: true })
      .click();
    const context = page.getByRole("tooltip", {
      name: "上下文使用量",
      exact: true,
    });
    await expect(context).toContainText("背景信息窗口：");
    await expect(context).not.toContainText("本地估算");
    await expect(context).toContainText("已用（剩余");
    await page.screenshot({
      path: `docs/screenshots/context-${mobile ? "mobile" : "desktop"}.png`,
    });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "思考强度", exact: true }).click();
    const slider = page.getByRole("slider", {
      name: "思考强度滑块",
      exact: true,
    });
    await slider.focus();
    await slider.press("Home");
    await expect(page.locator(".effort-trigger")).toHaveText("无");
    await page.getByRole("button", { name: "跟随接口", exact: true }).click();
    await slider.focus();
    await slider.press("Home");
    await expect(page.locator(".effort-trigger")).toHaveText("无");
    await expect
      .poll(async () =>
        page.evaluate(
          async (id) =>
            (
              (await (await fetch("/api/chats/" + id)).json()) as {
                chat: { effort: string };
              }
            ).chat.effort,
          id,
        ),
      )
      .toBe("none");
    await page.getByRole("button", { name: "跟随接口", exact: true }).click();
    await expect(page.locator(".effort-trigger")).toHaveText("跟随接口");
    await expect(page.locator(".effort-track")).toHaveClass(/inherited/);
    await expect(
      page.getByRole("button", { name: "跟随接口", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () =>
        page.evaluate(
          async (id) =>
            (
              (await (await fetch("/api/chats/" + id)).json()) as {
                chat: { effort: string };
              }
            ).chat.effort,
          id,
        ),
      )
      .toBe("inherit");
    expect(
      await slider.evaluate((el) =>
        getComputedStyle(el).getPropertyValue("--du-range-fill").trim(),
      ),
    ).toBe("0");
    expect(await slider.evaluate((el) => getComputedStyle(el).color)).toBe(
      await slider
        .evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue("--muted")
            .trim(),
        )
        .then(async (color) =>
          page.evaluate((color) => {
            const el = document.createElement("span");
            el.style.color = color;
            document.body.appendChild(el);
            const normalized = getComputedStyle(el).color;
            el.remove();
            return normalized;
          }, color),
        ),
    );
    await slider.focus();
    await slider.press("ArrowRight");
    await expect(page.locator(".effort-trigger")).toHaveText("低");
    await slider.press("End");
    await expect(page.locator(".effort-trigger")).toHaveText("最高");
    await slider.press("ArrowLeft");
    await expect(page.locator(".effort-trigger")).toHaveText("高");
    await page.evaluate(
      () => (document.documentElement.dataset.theme = "dark"),
    );
    await page.screenshot({
      path: `docs/screenshots/effort-${mobile ? "mobile" : "desktop"}.png`,
    });
    const popoverBounds = await page
      .getByRole("dialog", { name: "思考强度", exact: true })
      .boundingBox();
    expect(popoverBounds!.x).toBeGreaterThanOrEqual(0);
    expect(popoverBounds!.x + popoverBounds!.width).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
    await page
      .getByRole("button", { name: "恢复最高思考强度", exact: true })
      .click();
    await expect(page.locator(".effort-trigger")).toHaveText("最高");
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "思考强度", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "当前聊天设置", exact: true })
      .click();
    const panel = page.locator(".parameters");
    await expect(panel.locator("h3").first()).toHaveText("系统提示词");
    const parameter = panel.locator(".parameter").first();
    const nameBox = (await parameter.locator(".parameter-name").boundingBox())!,
      rangeBox = (await parameter.getByRole("slider").boundingBox())!,
      numberBox = (await parameter
        .locator("input[type=number]")
        .boundingBox())!;
    expect(
      Math.abs(
        nameBox.y + nameBox.height / 2 - rangeBox.y - rangeBox.height / 2,
      ),
    ).toBeLessThan(2);
    expect(
      Math.abs(
        numberBox.y + numberBox.height / 2 - rangeBox.y - rangeBox.height / 2,
      ),
    ).toBeLessThan(2);
    expect(rangeBox.height).toBe(12);
    expect(
      await parameter
        .getByRole("slider")
        .evaluate((el) =>
          getComputedStyle(el).getPropertyValue("--du-range-thumb-size").trim(),
        ),
    ).toBe("12px");
    await page.screenshot({
      path: `docs/screenshots/compact-parameters-${mobile ? "mobile" : "desktop"}.png`,
    });

    for (const name of [
      "重命名聊天",
      "重新生成标题",
      "置顶聊天",
      "归档聊天",
      "移入回收站",
      "预览下次请求",
      "导出全部聊天（含归档）",
      "导入 OpenWebUI JSON",
    ])
      await expect(
        panel.getByRole("button", { name, exact: true }),
      ).toHaveCount(0);
    await expect(
      panel.getByText("停止的部分纳入上下文", { exact: true }),
    ).toHaveCount(0);
    await expect(panel.getByLabel("移动聊天", { exact: true })).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "导出当前路线 Markdown", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    if (mobile) {
      for (const viewport of [
        { width: 320, height: 740 },
        { width: 844, height: 390 },
        { width: 390, height: 360 },
      ]) {
        await page.setViewportSize(viewport);
        await page
          .getByRole("button", { name: "思考强度", exact: true })
          .click();
        const box = await page
          .getByRole("dialog", { name: "思考强度", exact: true })
          .boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
        expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
        await page.keyboard.press("Escape");
      }
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    expect(generations).toBe(0);
    expect(errors).toEqual([]);
  });
}
