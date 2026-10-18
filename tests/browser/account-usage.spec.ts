import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountUsage } from "../../src/shared/account-usage";
for (const mobile of [false, true])
  test(`account quota sidebar, settings and request reuse (${mobile ? "phone" : "desktop"})`, async ({
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
    await page.goto("/");
    await page.getByLabel("访问密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.locator(".new-chat").waitFor({ state: "attached" });
    const now = Date.now();
    const fixture: AccountUsage = {
      status: "ok",
      scope: "account",
      day: "2026-10-18",
      fetchedAt: now,
      nextRefreshAt: now - 1,
      resetAt: Date.UTC(2026, 9, 19),
      metrics: [
        {
          id: "w",
          product: "Workers",
          name: "请求统计",
          value: 10000,
          limit: 100000,
          unit: "count",
          period: "day",
        },
        {
          id: "do",
          product: "Durable Objects",
          name: "内存驻留时长",
          value: 14620.54,
          limit: 13000,
          unit: "gbs",
          period: "day",
        },
        {
          id: "d1",
          product: "D1",
          name: "读取行数",
          value: 10000,
          limit: 5000000,
          unit: "count",
          period: "day",
        },
        {
          id: "wf",
          product: "Workflows",
          name: "步骤（step.do）",
          value: 42,
          limit: 3000,
          unit: "count",
          period: "day",
        },
        {
          id: "wf-storage",
          product: "Workflows",
          name: "状态存储",
          value: null,
          limit: 1e9,
          unit: "bytes",
          period: "storage",
        },
      ],
    };
    for (const endpoint of ["bootstrap", "navigation"])
      await page.route("**/api/" + endpoint + "*", async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          json: { ...(await response.json()), accountUsage: fixture },
        });
      });
    let refreshes = 0;
    await page.route("**/api/account-usage?refresh=1", async (route) => {
      refreshes++;
      fixture.status = "stale";
      fixture.nextRefreshAt = Date.now() + 60000;
      fixture.message = "统计暂时不可用，显示上次数据。";
      await route.fulfill({ json: fixture });
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.reload();
    if (mobile)
      await page.getByRole("button", { name: "打开导航", exact: true }).click();
    const sidebar = page.getByRole("button", {
      name: "查看账号额度",
      exact: true,
    });
    await expect(sidebar).toContainText("112.5%");
    await expect(sidebar.locator(".quota-mini")).toHaveCount(4);
    expect(refreshes).toBe(0);
    const footer = await page.locator(".nav-footer").evaluate((el) => {
      const children = Array.from(el.children).map((n) =>
        n.getBoundingClientRect(),
      );
      return {
        stacked: children[0]!.bottom <= children[1]!.top,
        aligned: Math.abs(children[0]!.left - children[1]!.left) < 2,
        widths: children.every((r) => r.width > 180),
      };
    });
    expect(footer).toEqual({ stacked: true, aligned: true, widths: true });
    await sidebar.click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await expect(
      settings.getByRole("heading", { name: "账号额度", exact: true }),
    ).toBeVisible();
    await expect(settings.locator(".quota-product")).toHaveCount(4);
    await expect(settings).toContainText("整个 Cloudflare 账号");
    await expect(settings).toContainText("14.6k GB·s");
    await expect(settings).toContainText("暂无数据");
    await expect(settings.locator(".quota-high-text")).toHaveText("112.5%");
    await expect(settings.locator(".quota-high")).toHaveAttribute(
      "value",
      "100",
    );
    expect(refreshes).toBe(0);
    await settings
      .getByRole("button", { name: "刷新额度", exact: true })
      .click();
    await expect(settings.getByRole("status")).toContainText("显示上次数据");
    expect(refreshes).toBe(1);
    await settings
      .getByRole("button", { name: "刷新额度", exact: true })
      .click();
    expect(refreshes).toBe(1);
    await settings
      .getByRole("button", { name: "返回应用", exact: true })
      .click();
    await expect(sidebar).toContainText("显示上次数据");
    await sidebar.click();
    expect(refreshes).toBe(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/account-quota-${mobile ? "phone" : "desktop"}-${test.info().project.name}.png`,
    });
    expect(errors).toEqual([]);
  });
