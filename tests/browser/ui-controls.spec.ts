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
    await page.reload();
    await expect(page.locator(".header-title")).toHaveText("界面组件验证");
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

    const first = page.locator(".message.assistant").first();
    await first
      .getByRole("button", { name: "移除本轮上下文", exact: true })
      .click();
    await expect(page.locator(".message.excluded")).toHaveCount(2);
    const contents = await page.evaluate(async (chatId) => {
      const response = await fetch("/api/chats/" + chatId + "/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      return (
        (await response.json()) as { messages: { content: string }[] }
      ).messages.map((m: { content: string }) => m.content);
    }, id);
    expect(contents).toEqual(["第二轮问题", "第二轮回答"]);
    await page
      .locator(".message.user")
      .first()
      .getByRole("button", { name: "加入本轮上下文", exact: true })
      .click();
    await expect(page.locator(".message.excluded")).toHaveCount(0);

    await page
      .getByRole("button", { name: "上下文使用量", exact: true })
      .click();
    const context = page.getByRole("tooltip", {
      name: "上下文使用量",
      exact: true,
    });
    await expect(context).toContainText("背景信息窗口：");
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
    await expect(page.locator(".effort-trigger")).toHaveText("跟随接口");
    await slider.press("ArrowRight");
    await expect(page.locator(".effort-trigger")).toHaveText("无");
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
    await expect(page.locator(".parameters .chat-management")).toContainText(
      "重新生成标题",
    );
    await expect(page.locator(".parameters .chat-management")).toContainText(
      "导出完整树 JSON",
    );
    await expect(page.locator(".parameters .chat-management")).toContainText(
      "移入回收站",
    );
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
