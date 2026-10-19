import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
test("phone starts at normal scale, keeps navigation left with no chat, and editable controls at least 16px", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  try {
    const page = await context.newPage(),
      errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const { password } = JSON.parse(
      await readFile(
        join(homedir(), ".config/workers-chat/local-login.json"),
        "utf8",
      ),
    );
    await page.goto("http://localhost:5173");
    const input = page.getByLabel("访问密码", { exact: true });
    await input.focus();
    expect(
      await input.evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
    ).toBeGreaterThanOrEqual(16);
    await input.fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("button", { name: "打开导航", exact: true }).waitFor();
    await expect(
      page.getByRole("button", { name: "当前聊天设置", exact: true }),
    ).toHaveCount(0);
    expect(
      (await page
        .getByRole("button", { name: "打开导航", exact: true })
        .boundingBox())!.x,
    ).toBeLessThan(40);
    await page.evaluate(() =>
      document.documentElement.style.setProperty("--font-size", "12px"),
    );
    const composer = page.getByLabel("消息", { exact: true });
    await composer.focus();
    expect(
      await composer.evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
    ).toBeGreaterThanOrEqual(16);
    expect(
      await page.evaluate(() => window.visualViewport?.scale ?? 1),
    ).toBeCloseTo(1, 2);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await page.locator('meta[name="viewport"]').getAttribute("content"),
    ).not.toMatch(/user-scalable=no|maximum-scale=1/);
    await page.screenshot({
      path: `test-results/mobile-viewport-${test.info().project.name}.png`,
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
