import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

test.use({
  viewport: { width: 320, height: 740 },
  isMobile: true,
  hasTouch: true,
});

async function seed(page: Page) {
  const { password } = JSON.parse(
    await readFile(
      join(homedir(), ".config/workers-chat/local-login.json"),
      "utf8",
    ),
  ) as { password: string };
  await page.goto("/");
  await page.getByLabel("访问密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).tap();
  await page.locator(".new-chat").waitFor({ state: "attached" });
  const ids = await page.evaluate(async () => {
    async function post(path: string, body: unknown) {
      const response = await fetch("/api" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok)
        throw new Error("mobile fixture setup failed: " + response.status);
      return await response.json();
    }
    const providerId = crypto.randomUUID();
    await post("/settings/import", {
      mode: "replace",
      data: {
        format: "workers-chat.settings",
        version: 1,
        settings: {
          defaultModel: {
            providerId,
            modelId: "mobile-test-model-with-a-long-name",
          },
        },
        providers: [
          {
            id: providerId,
            name: "手机测试服务商",
            baseUrl: "https://fixture.invalid/v1",
            prefix: "Mobile/",
            models: [
              {
                id: "mobile-test-model-with-a-long-name",
                enabled: true,
                capacity: 1048576,
                parameters: {},
              },
            ],
          },
        ],
      },
    });
    const result = (await post("/import", {
      data: [0, 1].map((index) => ({
        chat: {
          title: "独立手机测试 " + index,
          history: {
            currentId: "a",
            messages: {
              u: {
                id: "u",
                parentId: null,
                role: "user",
                content: "手机构造测试 " + index,
              },
              a: {
                id: "a",
                parentId: "u",
                role: "assistant",
                content: index
                  ? "另一个聊天的独立回答"
                  : "## 长消息\n\n" +
                    "一段用于测试触摸滚动的文字。\n\n".repeat(80) +
                    "\n```text\n" +
                    "long-code-".repeat(100) +
                    "\n```\n\n|列一|列二|列三|\n|---|---|---|\n|" +
                    "wide-table-".repeat(30) +
                    "|内容|内容|\n",
              },
            },
          },
        },
      })),
    })) as { ids: string[] };
    localStorage.setItem("lastChat", result.ids[0]!);
    localStorage.setItem("sidebarWidth", "190");
    return result.ids;
  });
  await page.reload();
  await expect(page.locator(".chat-row.selected .chat-title")).toHaveText("独立手机测试 0");
  return ids;
}

async function inViewport(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  const size = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(size.width + 1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(size.height + 1);
}

test("touch phone: narrow content, rotation, newline, menus and saved drafts", async ({
  page,
}, testInfo) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let sends = 0;
  // A regression must never escape to a real upstream, including unexpected Enter sends.
  await page.route("**/api/chats/*/send", async (route) => {
    sends++;
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "synthetic test only" }),
    });
  });
  await seed(page);
  await inViewport(page, ".composer");
  await inViewport(page, ".composer-model-settings");
  await inViewport(page, ".send-button");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.locator(".model-trigger").tap();
  await expect(page.getByLabel("搜索模型", { exact: true })).not.toBeFocused();
  await inViewport(page, ".model-popover");
  await page.getByLabel("搜索模型", { exact: true }).tap();
  await expect(page.getByLabel("搜索模型", { exact: true })).toBeFocused();
  await page.locator(".model-trigger").tap();
  const input = page.getByLabel("消息", { exact: true });
  await input.fill("手机第一行");
  await input.press("End");
  await input.press("Enter");
  await expect(input).toHaveValue("手机第一行\n");
  await page.setViewportSize({ width: 844, height: 390 });
  await input.fill("横屏第一行");
  await input.press("End");
  await input.press("Enter");
  await expect(input).toHaveValue("横屏第一行\n");
  expect(sends).toBe(0);
  await page.locator(".model-trigger").tap();
  await expect(page.getByLabel("搜索模型", { exact: true })).not.toBeFocused();
  await inViewport(page, ".model-popover");
  await page.locator(".model-trigger").tap();
  await page.setViewportSize({ width: 390, height: 360 });
  await page.getByRole("button", { name: "当前聊天设置", exact: true }).tap();
  await inViewport(page, ".parameters");
  await page.getByRole("button", { name: "返回聊天", exact: true }).tap();
  await page
    .locator(".message.assistant")
    .getByRole("button", { name: "消息详情", exact: true })
    .tap();
  await inViewport(page, ".modal");
  await page.getByRole("button", { name: "关闭", exact: true }).tap();
  await page.setViewportSize({ width: 390, height: 844 });
  if (testInfo.project.name === "chromium") {
    const session = await page.context().newCDPSession(page);
    await page.locator(".message-scroll").evaluate((element) => {
      element.scrollTop = 0;
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 160, y: 350 }],
    });
    for (const y of [320, 280, 240, 190, 150]) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: 160, y }],
      });
      await page.waitForTimeout(20);
    }
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect
      .poll(() =>
        page
          .locator(".message-scroll")
          .evaluate((element) => element.scrollTop),
      )
      .toBeGreaterThan(60);
    await expect(page.locator(".message-actions.visible")).toHaveCount(0);
    // A real browser touch hold, in addition to the deterministic pointer timer cases below.
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 160, y: 250 }],
    });
    await expect(page.locator(".message-actions.visible")).toBeVisible();
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.keyboard.press("Escape");
    await session.detach();
  }
  // Pointer sequences exercise the hold timer and scroll cancellation without relying on OS timing.
  const message = page.locator(".message.assistant .message-body");
  await message.dispatchEvent("pointerdown", {
    pointerType: "touch",
    clientX: 100,
    clientY: 100,
  });
  await message.dispatchEvent("pointermove", {
    pointerType: "touch",
    clientX: 100,
    clientY: 130,
  });
  await page.waitForTimeout(550);
  await expect(page.locator(".message-actions.visible")).toHaveCount(0);
  await message.dispatchEvent("pointerdown", {
    pointerType: "touch",
    clientX: 100,
    clientY: 100,
  });
  await expect(page.locator(".message-actions.visible")).toBeVisible();
  await message.dispatchEvent("pointerup", { pointerType: "touch" });
  await page.keyboard.press("Escape");
  await input.fill("手机云端草稿\n第二行");
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (
            (await (
              await fetch("/api/chats/" + localStorage.getItem("lastChat"))
            ).json()) as { chat: { draft: string } }
          ).chat.draft,
      ),
    )
    .toBe("手机云端草稿\n第二行");
  await page.reload();
  await expect(input).toHaveValue("手机云端草稿\n第二行");
  await page.screenshot({
    path: `docs/screenshots/mobile-touch-${testInfo.project.name}.png`,
  });
  expect(errors).toEqual([]);
  expect(sends).toBe(0);
});

test("mobile boundary navigation discards another chat's message editor", async ({
  page,
}) => {
  await seed(page);
  await page
    .locator(".message.user")
    .getByRole("button", { name: "编辑消息", exact: true })
    .tap();
  await page
    .locator(".edit-area textarea")
    .fill("不能带到另一个聊天的编辑内容");
  await page.setViewportSize({ width: 760, height: 844 });
  await page.getByRole("button", { name: "打开导航", exact: true }).tap();
  expect((await page.locator(".sidebar").boundingBox())!.width).toBe(280);
  // CSS must switch widths on rotation even when React has no state update.
  await page.setViewportSize({ width: 844, height: 390 });
  await expect
    .poll(async () => (await page.locator(".sidebar").boundingBox())!.width)
    .toBe(190);
  await page.setViewportSize({ width: 760, height: 844 });
  await expect
    .poll(async () => (await page.locator(".sidebar").boundingBox())!.width)
    .toBe(280);
  await page
    .locator(".chat-title")
    .filter({ hasText: "独立手机测试 1" })
    .first()
    .tap();
  await expect(page.locator(".chat-row.selected .chat-title")).toHaveText("独立手机测试 1");
  await expect(page.locator(".sidebar-scrim")).toHaveCount(0);
  await expect(page.locator(".edit-area")).toHaveCount(0);
  await expect(page.locator(".message.user")).toContainText("手机构造测试 1");
});
