import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Provider } from "../../src/shared/chat";

for (const mobile of [false, true])
  test(`provider editor and model cards (${mobile ? "phone" : "desktop"})`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    const { password } = JSON.parse(
      await readFile(
        join(homedir(), ".config/workers-chat/local-login.json"),
        "utf8",
      ),
    );
    const errors: string[] = [],
      refreshed: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await page.getByLabel("访问密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.locator(".new-chat").waitFor({ state: "attached" });
    const id = await page.evaluate(async () => {
      const id = crypto.randomUUID();
      await fetch("/api/settings/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "replace",
          data: {
            format: "workers-chat.settings",
            version: 1,
            settings: { defaultModel: { providerId: id, modelId: "first" } },
            providers: [
              {
                id,
                name: "测试接口",
                baseUrl: "https://offline-fixture.invalid/v1",
                prefix: "FX/",
                models: [
                  {
                    id: "first",
                    enabled: true,
                    capacity: 1048576,
                    parameters: {},
                  },
                  {
                    id: "second",
                    enabled: false,
                    capacity: 1048576,
                    parameters: {},
                  },
                ],
              },
            ],
          },
        }),
      });
      return id;
    });
    await page.reload();
    await page.route("**/api/providers", async (route) => {
      if (
        route.request().method() === "POST" &&
        route.request().postDataJSON().refreshModels === true
      ) {
        refreshed.push(route.request().url());
        await route.fulfill({
          status: 400,
          json: { error: "合成检查：上游暂时不可用" },
        });
      } else await route.continue();
    });
    if (mobile)
      await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.getByRole("button", { name: "账户菜单", exact: true }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.locator(".providers-page form")).toHaveCount(0);
    await page
      .getByRole("button", { name: "编辑 测试接口", exact: true })
      .click();
    let editor = page.getByRole("dialog", { name: "编辑服务商", exact: true });
    await editor.getByLabel("名称", { exact: true }).fill("调整后的接口");
    await editor
      .getByRole("button", { name: "保存并刷新模型", exact: true })
      .click();
    await expect(editor.getByRole("alert")).toContainText("上游暂时不可用");
    await expect(editor.getByLabel("名称", { exact: true })).toHaveValue(
      "调整后的接口",
    );
    await editor.getByRole("button", { name: "保存更改", exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(refreshed).toHaveLength(1);
    const provider = await page.evaluate(
      async (id) =>
        ((await (await fetch("/api/providers")).json()) as Provider[]).find(
          (p) => p.id === id,
        )!,
      id,
    );
    expect(provider.name).toBe("调整后的接口");
    expect(provider.models).toHaveLength(2);
    expect(provider.models[0]!.enabled).toBe(true);
    await page.screenshot({
      path: `docs/screenshots/providers-${mobile ? "mobile" : "desktop"}.png`,
    });
    if (!mobile) {
      const row = page.locator(".provider-item"),
        info = await row.locator(".provider-identity").boundingBox(),
        actions = await row.locator(".provider-actions").boundingBox();
      expect(actions!.x).toBeGreaterThan(info!.x + info!.width);
      expect(
        Math.abs(actions!.y + actions!.height / 2 - info!.y - info!.height / 2),
      ).toBeLessThan(3);
    }
    await page.getByRole("button", { name: "添加服务商", exact: true }).click();
    editor = page.getByRole("dialog", { name: "添加服务商", exact: true });
    await editor.getByLabel("名称", { exact: true }).fill("稍后连接");
    await editor
      .getByLabel("接口地址（Base URL）", { exact: true })
      .fill("https://later-fixture.invalid/v1");
    await editor.getByRole("button", { name: "仅保存", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(
      page.locator(".provider-item").filter({ hasText: "稍后连接" }),
    ).toContainText("0 个模型");
    expect(refreshed).toHaveLength(1);
    await page.getByRole("button", { name: "添加服务商", exact: true }).click();
    editor = page.getByRole("dialog", { name: "添加服务商", exact: true });
    await editor.getByLabel("名称", { exact: true }).fill("取消的内容");
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.locator(".provider-item")).toHaveCount(2);
    await page.getByRole("button", { name: "模型", exact: true }).click();
    await expect(page.locator(".model-entry")).toHaveCount(2);
    const cards = page.locator(".model-entry"),
      first = (await cards.nth(0).boundingBox())!,
      second = (await cards.nth(1).boundingBox())!;
    if (mobile) {
      expect(Math.abs(first.x - second.x)).toBeLessThan(1);
      expect(second.y).toBeGreaterThan(first.y);
    } else {
      expect(second.x).toBeGreaterThan(first.x + first.width);
      expect(Math.abs(first.y - second.y)).toBeLessThan(1);
    }
    await expect(
      cards.first().getByLabel("first上下文预算", { exact: true }),
    ).not.toBeVisible();
    await cards.first().getByText("模型设置", { exact: true }).click();
    await cards
      .first()
      .getByLabel("first上下文预算", { exact: true })
      .fill("32000");
    await cards.first().getByLabel("first上下文预算", { exact: true }).blur();
    await expect
      .poll(async () =>
        page.evaluate(
          async (id) =>
            ((await (await fetch("/api/providers")).json()) as Provider[]).find(
              (p) => p.id === id,
            )!.models[0]!.capacity,
          id,
        ),
      )
      .toBe(32000);
    await page.screenshot({
      path: `docs/screenshots/model-cards-${mobile ? "mobile" : "desktop"}.png`,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    expect(errors).toEqual([]);
  });
