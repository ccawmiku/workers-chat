import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
for (const mobile of [false, true])
  test(`settings page, accent persistence and theme defaults (${mobile ? "phone" : "desktop"})`, async ({
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
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await page.getByLabel("访问密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.locator(".new-chat").waitFor({ state: "attached" });
    const open = async () => {
      if (mobile)
        await page
          .getByRole("button", { name: "打开导航", exact: true })
          .click();
      await page.getByRole("button", { name: "账户菜单", exact: true }).click();
      await page.getByRole("button", { name: "外观", exact: true }).click();
    };
    await open();
    const dialog = page.getByRole("dialog", { name: "设置", exact: true });
    const rect = await dialog.boundingBox();
    expect(rect?.x).toBe(0);
    expect(rect?.width).toBe(mobile ? 390 : 1440);
    await page.getByRole("button", { name: "浅色", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const colors = () =>
      page.evaluate(() => {
        const s = getComputedStyle(document.documentElement);
        return {
          bg: s.getPropertyValue("--bg").trim(),
          ink: s.getPropertyValue("--text").trim(),
          accent: s.getPropertyValue("--accent").trim(),
          accentInk: s.getPropertyValue("--accent-ink").trim(),
        };
      });
    expect(await colors()).toMatchObject({
      bg: "#fcfcfc",
      ink: "#0d0d0d",
      accent: "#f077af",
    });
    await page.locator(".accent-picker summary").click();
    await page.getByRole("button", { name: "蓝色", exact: true }).click();
    expect(await colors()).toMatchObject({
      accent: "#4169e1",
      accentInk: "#ffffff",
    });
    await page.getByRole("button", { name: "深色", exact: true }).click();
    expect(await colors()).toMatchObject({
      bg: "#000000",
      ink: "#ededed",
      accent: "#4169e1",
    });
    await page.locator(".accent-picker summary").click();
    await page.getByLabel("自定义强调色", { exact: true }).fill("#22aa66");
    await page.locator(".appearance-settings h2").click();
    expect(await colors()).toMatchObject({ accent: "#22aa66" });
    await page.getByLabel("背景颜色", { exact: true }).fill("#101010");
    expect(await colors()).toMatchObject({ bg: "#101010" });
    if (!mobile) {
      await page.getByLabel("搜索设置").fill("模型");
      await expect(
        page
          .locator(".settings-menu")
          .getByRole("button", { name: "模型", exact: true }),
      ).toBeVisible();
      await expect(
        page
          .locator(".settings-menu")
          .getByRole("button", { name: "服务商", exact: true }),
      ).toHaveCount(0);
      await page.getByLabel("搜索设置").fill("");
    }
    await page.screenshot({
      path: `test-results/appearance-${mobile ? "phone" : "desktop"}-${test.info().project.name}.png`,
    });
    await page.getByRole("button", { name: "返回应用", exact: true }).click();
    await page.reload();
    await expect
      .poll(colors)
      .toMatchObject({ accent: "#22aa66", bg: "#101010" });
    await open();
    await page.getByText("高级", { exact: true }).click();
    await page
      .getByRole("button", { name: "恢复默认外观", exact: true })
      .click();
    expect(await colors()).toMatchObject({
      bg: "#000000",
      ink: "#ededed",
      accent: "#f077af",
    });
    await page.getByRole("button", { name: "跟随系统", exact: true }).click();
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  });
