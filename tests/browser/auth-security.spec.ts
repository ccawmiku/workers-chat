import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

test("failed-login warning survives refresh, dismisses locally, and a ban counts down without requests", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { password } = JSON.parse(
    await readFile(
      join(homedir(), ".config/workers-chat/local-login.json"),
      "utf8",
    ),
  );
  await page.goto("/");
  await page
    .getByLabel("访问密码", { exact: true })
    .fill("synthetic-wrong-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("密码或恢复码错误");
  await page.getByLabel("访问密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".login-security-notice")).toContainText(
    "尝试登录，但未成功",
  );
  await expect(page.locator(".login-security-notice")).toContainText(
    /\d{4}\/\d+\/\d+/,
  );
  await page.reload();
  await expect(page.locator(".login-security-notice")).toBeVisible();
  await page.getByRole("button", { name: "关闭登录安全提醒" }).click();
  await page.reload();
  await expect(page.locator(".new-chat")).toBeAttached();
  await expect(page.locator(".login-security-notice")).toHaveCount(0);
  await page.evaluate(() =>
    fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
  );
  await page.reload();
  let attempts = 0;
  await page.route("**/api/auth/login", async (route) => {
    attempts++;
    await route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({
        error: "此 IP 已临时封禁",
        retryAt: Date.now() + 2000,
      }),
    });
  });
  await page.getByLabel("访问密码", { exact: true }).fill("fixture");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "暂时封禁", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "登录", exact: true }),
  ).toBeEnabled();
  expect(attempts).toBe(1);
});
