import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

async function atBottom(page: Page) {
  return page
    .locator(".message-scroll")
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}
async function offset(page: Page, id: string) {
  return page
    .locator(`[data-message-id="${id}"]`)
    .evaluate(
      (el) =>
        el.getBoundingClientRect().top -
        document.querySelector(".message-scroll")!.getBoundingClientRect().top,
    );
}
async function edgeError(page: Page) {
  return page.locator(".owui-overview").evaluate((root) => {
    let max = 0;
    for (const edge of root.querySelectorAll<SVGGElement>(
      ".svelte-flow__edge",
    )) {
      const path = edge.querySelector<SVGPathElement>(
        ".svelte-flow__edge-path",
      )!;
      const [source, target] = edge.dataset.id!.split("-");
      const matrix = path.getScreenCTM()!;
      for (const [node, type, position] of [
        [source, "source", 0],
        [target, "target", path.getTotalLength()],
      ] as const) {
        const handle = root.querySelector(`[data-nodeid="${node}"].${type}`)!;
        const box = handle.getBoundingClientRect(),
          point = path.getPointAtLength(position).matrixTransform(matrix);
        const side = handle.classList.contains("svelte-flow__handle-right")
          ? "right"
          : handle.classList.contains("svelte-flow__handle-left")
            ? "left"
            : handle.classList.contains("svelte-flow__handle-bottom")
              ? "bottom"
              : "top";
        const x =
          side === "right"
            ? box.right
            : side === "left"
              ? box.left
              : box.x + box.width / 2;
        const y =
          side === "bottom"
            ? box.bottom
            : side === "top"
              ? box.top
              : box.y + box.height / 2;
        const wrapper = root.querySelector(
          `[data-id="${node}"].svelte-flow__node`,
        )!;
        const card = wrapper.querySelector(".h-20")!;
        max = Math.max(
          max,
          Math.hypot(point.x - x, point.y - y),
          Math.abs(
            wrapper.getBoundingClientRect().height -
              card.getBoundingClientRect().height,
          ),
        );
      }
    }
    return max;
  });
}

for (const mobile of [false, true])
  test(`overview targets, edge geometry, old reply editing and branch scrolling (${mobile ? "phone" : "desktop"})`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    const { password } = JSON.parse(
      await readFile(
        join(homedir(), ".config/workers-chat/local-login.json"),
        "utf8",
      ),
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let modelRequests = 0;
    await page.route(
      /\/api\/chats\/[^/]+\/(send|regenerate|retry|continue|title)$/,
      async (route) => {
        modelRequests++;
        await route.fulfill({
          status: 400,
          json: { error: "No model calls in navigation fixture" },
        });
      },
    );
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    await page.goto("/");
    await page.getByLabel("访问密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.locator(".new-chat").waitFor({ state: "attached" });
    const id = await page.evaluate(async () => {
      const messages: Record<string, unknown> = {};
      for (let index = 0; index < 8; index++) {
        messages["u" + index] = {
          id: "u" + index,
          parentId: index ? "a" + (index - 1) : null,
          role: "user",
          content: `问题 ${index} 的具体内容`,
          timestamp: 1700000000 + index * 2,
        };
        messages["a" + index] = {
          id: "a" + index,
          parentId: "u" + index,
          role: "assistant",
          content:
            `回答 ${index}\n\n` +
            Array.from(
              { length: 18 },
              (_, line) =>
                `第 ${line + 1} 行：用于验证长对话定位与编辑之后保留当前位置。`,
            ).join("\n\n"),
          timestamp: 1700000001 + index * 2,
        };
      }
      messages.b4 = {
        id: "b4",
        parentId: "u4",
        role: "assistant",
        content: "另一条分支回答",
        timestamp: 1700000100,
      };
      messages.v5 = {
        id: "v5",
        parentId: "b4",
        role: "user",
        content: "分支后续问题",
        timestamp: 1700000101,
      };
      messages.b5 = {
        id: "b5",
        parentId: "v5",
        role: "assistant",
        content: "分支的末尾回答",
        timestamp: 1700000102,
      };
      const response = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: {
            chat: {
              title: "定位和编辑验证",
              history: { currentId: "a7", messages },
            },
          },
        }),
      });
      if (!response.ok) throw Error("Fixture import failed");
      const id = ((await response.json()) as { ids: string[] }).ids[0]!;
      localStorage.setItem("lastChat", id);
      return id as string;
    });
    await page.reload();
    await expect(page.locator(".chat-row.selected .chat-title")).toHaveText("定位和编辑验证");
    await expect.poll(() => atBottom(page)).toBeLessThan(2);
    const timeline = page.getByRole("navigation", {
        name: "对话导航",
        exact: true,
      }),
      tick = timeline.locator(".timeline-tick").first();
    await expect(timeline.locator(".timeline-tick")).toHaveCount(8);
    if (mobile) await tick.click();
    else await tick.hover();
    const preview = page.getByRole("dialog", {
      name: "第1轮预览",
      exact: true,
    });
    await expect(preview).toBeVisible();
    await expect(preview.getByRole("button", { name: /书签/ })).toHaveCount(0);
    await page.screenshot({
      path: `docs/screenshots/conversation-timeline-${mobile ? "phone" : "desktop"}.png`,
    });
    if (mobile)
      await preview
        .getByRole("button", { name: "跳转到第1轮", exact: true })
        .click();
    else await tick.click();
    await expect.poll(() => offset(page, "u0")).toBeGreaterThanOrEqual(15);
    await expect.poll(() => offset(page, "u0")).toBeLessThan(24);
    await expect(preview).toHaveCount(0);
    await page
      .locator(".message-scroll")
      .evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect.poll(() => atBottom(page)).toBeLessThan(2);

    await page
      .getByRole("button", { name: "当前聊天设置", exact: true })
      .click();
    await page.getByRole("tab", { name: "分支总览", exact: true }).click();
    await expect(page.locator(".svelte-flow__node")).toHaveCount(19);
    for (const name of ["Horizontal Layout", "Vertical Layout"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await expect.poll(() => edgeError(page)).toBeLessThan(2);
    }
    await page.getByRole("button", { name: "fit view", exact: true }).click();
    const controls = page.locator(".svelte-flow__controls button svg");
    expect(await controls.count()).toBeGreaterThanOrEqual(6);
    for (const icon of await controls.all())
      await expect(icon).toHaveAttribute("class", /lucide/);

    await page.locator('.svelte-flow__node[data-id="u2"]').click();
    if (mobile) await expect(page.locator(".parameters")).toHaveCount(0);
    else
      await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    await expect.poll(() => offset(page, "u2")).toBeGreaterThanOrEqual(15);
    await expect.poll(() => offset(page, "u2")).toBeLessThan(24);
    await expect(page.locator('[data-message-id="b5"]')).toHaveCount(1);
    await page
      .locator('[data-message-id="b4"]')
      .getByRole("button", { name: "上个版本", exact: true })
      .click();
    await expect(page.locator('[data-message-id="a7"]')).toHaveCount(1);
    await expect.poll(() => atBottom(page)).toBeLessThan(2);
    const old = page.locator('[data-message-id="a1"]');
    await old.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await old.getByRole("button", { name: "编辑消息", exact: true }).click();
    const before = await offset(page, "a1");
    expect(before).toBeGreaterThanOrEqual(15);
    await page.getByRole("button", { name: "全屏编辑", exact: true }).click();
    const editor = page.getByRole("dialog", {
      name: "全屏编辑消息",
      exact: true,
    });
    await expect(editor).toBeVisible();
    await editor.screenshot({
      path: `docs/screenshots/reply-editor-${mobile ? "phone" : "desktop"}.png`,
    });
    const bounds = await editor.boundingBox();
    expect(bounds!.height).toBeGreaterThan(page.viewportSize()!.height * 0.9);
    await editor
      .getByLabel("编辑消息正文", { exact: true })
      .fill(
        "旧位置的回答已修改，后面的问答保持原路线。\n\n" +
          "修改后的段落。\n\n".repeat(12),
      );
    const editEndpoint = "**/api/chats/" + id + "/edit";
    await page.route(editEndpoint, (route) =>
      route.fulfill({ status: 409, json: { error: "编辑保存失败测试" } }),
    );
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await expect(editor.getByRole("alert")).toHaveText("编辑保存失败测试");
    await expect(
      editor.getByLabel("编辑消息正文", { exact: true }),
    ).toHaveValue(/旧位置的回答已修改/);
    await page.unroute(editEndpoint);
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(old.locator(".markdown")).toContainText("旧位置的回答已修改");
    await expect(page.locator('[data-message-id="a7"]')).toHaveCount(1);
    expect(Math.abs((await offset(page, "a1")) - before)).toBeLessThan(3);
    expect(await atBottom(page)).toBeGreaterThan(1000);
    const current = await page.evaluate(
      async (chatId) =>
        (
          (await (await fetch("/api/chats/" + chatId)).json()) as {
            chat: { currentId: string };
          }
        ).chat.currentId,
      id,
    );
    expect(current).toBe("a7");
    await page
      .locator('[data-message-id="a5"]')
      .getByRole("button", { name: "从这里 Fork", exact: true })
      .click();
    await expect(page.locator(".chat-row.selected .chat-title")).toHaveText(
      /^定位和编辑验证 · 分支\d{2,}$/,
    );
    await expect.poll(() => atBottom(page)).toBeLessThan(2);
    if (mobile)
      await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.getByRole("button", { name: "账户菜单", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "导入聊天", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "聊天数据", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "导出全部聊天（含归档）", exact: true }),
    ).toBeVisible();
    const choosing = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "导入 OpenWebUI JSON", exact: true })
      .click();
    const chooser = await choosing;
    await chooser.setFiles({
      name: "global-import.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify([
          {
            chat: {
              title: "整体设置导入预览",
              messages: [{ role: "user", content: "仅验证预览" }],
            },
          },
        ]),
      ),
    });
    await expect(
      page.getByRole("dialog", { name: "设置", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: "导入预览", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    expect(modelRequests).toBe(0);
    expect(errors).toEqual([]);
  });
