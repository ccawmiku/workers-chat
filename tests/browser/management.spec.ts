import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Chat, Provider, Settings } from "../../src/shared/chat";

test("settings restore, model identity, template copies, groups and mobile long press", async ({
  page,
}) => {
  test.setTimeout(60000);
  const credential = JSON.parse(
    await readFile(
      join(homedir(), ".config/workers-chat/local-login.json"),
      "utf8",
    ),
  ) as { password: string };
  const errors: string[] = [],
    generationRequests: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (
      /\/api\/chats\/[^/]+\/(send|regenerate|retry|continue|title)$/.test(
        new URL(r.url()).pathname,
      )
    )
      generationRequests.push(r.url());
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByLabel("访问密码", { exact: true }).fill(credential.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.locator(".new-chat").waitFor();
  const ids = [randomUUID(), randomUUID()];
  const backup = {
    format: "workers-chat.settings",
    version: 1,
    createdAt: Date.now(),
    containsKeys: false,
    settings: {
      defaultModel: { providerId: ids[0], modelId: "fixture-model" },
      parameters: { temperature: 0.4 },
      titlePrompt: "测试标题提示词",
      titleModel: null,
      templates: [
        { id: "one", name: "先定义目标", content: "用一句话说明目标。" },
        { id: "two", name: "再拆解步骤", content: "列出可以执行的下一步。" },
      ],
    },
    providers: ids.map((id, index) => ({
      id,
      name: "测试服务商" + (index + 1),
      baseUrl: "https://fixture" + index + ".invalid/v1",
      prefix: index ? "Two/" : "One/",
      models: [
        {
          id: "fixture-model",
          enabled: true,
          capacity: 1048576,
          parameters: {},
        },
      ],
    })),
  };
  await page.getByRole("button", { name: "账户菜单", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "设置备份", exact: true }).click();
  await expect(
    page.getByLabel("包含 API Key", { exact: true }),
  ).not.toBeChecked();
  await page.getByLabel("设置备份文件", { exact: true }).setInputFiles({
    name: "fixture-settings.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(
    page.getByText("2 个服务商，2 个提示词模板。", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("设置恢复方式", { exact: true })
    .selectOption("replace");
  await page.getByRole("button", { name: "确认恢复设置", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("设置已恢复");
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出设置备份", exact: true }).click();
  const download = await downloaded;
  const exported = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(exported.containsKeys).toBe(false);
  expect(exported.providers).toHaveLength(2);
  expect(JSON.stringify(exported)).not.toMatch(
    /apiKey|encryptedKey|password_hash|recovery_hash/,
  );
  await page.screenshot({ path: "docs/screenshots/settings-backup.png" });
  await page.getByRole("button", { name: "生成默认", exact: true }).click();
  await page.getByLabel("温度滑块", { exact: true }).focus();
  await page.getByLabel("温度滑块", { exact: true }).press("ArrowRight");
  await expect
    .poll(async () =>
      page.evaluate(
        async () =>
          ((await (await fetch("/api/settings")).json()) as Settings).parameters
            .temperature,
      ),
    )
    .toBe(0.45);
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByLabel("筛选设置模型", { exact: true }).fill("Two/");
  await expect(page.locator(".model-entry")).toHaveCount(1);
  await page.getByText("模型生成默认值与连通性", { exact: true }).click();
  await page.getByLabel("Top K", { exact: true }).fill("12");
  await page.getByLabel("Top K", { exact: true }).blur();
  await expect
    .poll(async () =>
      page.evaluate(
        async (id) =>
          ((await (await fetch("/api/providers")).json()) as Provider[]).find(
            (p: { id: string }) => p.id === id,
          )!.models[0]!.parameters.top_k,
        ids[1]!,
      ),
    )
    .toBe(12);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".new-chat").click();
  await expect(page.locator(".header-title")).toHaveText("新聊天");
  const chatId = await page.evaluate(() => localStorage.getItem("lastChat"));
  await page.locator(".model-trigger").click();
  await page.getByLabel("搜索模型", { exact: true }).fill("Two/");
  await page
    .locator(".model-options button")
    .filter({ hasText: "Two/fixture-model" })
    .click();
  await expect
    .poll(async () =>
      page.evaluate(
        async (id) =>
          ((await (await fetch("/api/chats/" + id)).json()) as { chat: Chat })
            .chat.model!.providerId,
        chatId,
      ),
    )
    .toBe(ids[1]);
  await expect(page.locator(".model-trigger")).toContainText(
    "Two/fixture-model",
  );
  await page.getByRole("button", { name: "当前聊天设置", exact: true }).click();
  await page
    .getByRole("button", { name: "选择系统提示词模板", exact: true })
    .click();
  await page
    .locator(".prompt-choices")
    .getByRole("button", { name: "先定义目标", exact: true })
    .click();
  await page
    .locator(".prompt-choices")
    .getByRole("button", { name: "再拆解步骤", exact: true })
    .click();
  await expect(page.locator(".prompt-item")).toHaveCount(2);
  await page
    .getByRole("button", { name: "上移提示词 再拆解步骤", exact: true })
    .click();
  await expect(page.locator(".prompt-item").first()).toContainText(
    "再拆解步骤",
  );
  await page.locator(".prompt-name").filter({ hasText: "再拆解步骤" }).click();
  await page
    .getByRole("textbox", { name: "再拆解步骤", exact: true })
    .fill("当前聊天的独立内容。");
  await page.getByRole("textbox", { name: "再拆解步骤", exact: true }).blur();
  await expect
    .poll(async () =>
      page.evaluate(
        async (id) =>
          ((await (await fetch("/api/chats/" + id)).json()) as { chat: Chat })
            .chat.system[0]!.content,
        chatId,
      ),
    )
    .toBe("当前聊天的独立内容。");
  expect(
    await page.evaluate(
      async () =>
        ((await (await fetch("/api/settings")).json()) as Settings)
          .templates[1]!.content,
    ),
  ).toBe("列出可以执行的下一步。");
  await expect(page.locator(".prompt-grip").last()).toBeEnabled();
  const grip = (await page.locator(".prompt-grip").last().boundingBox())!,
    drop = (await page.locator(".prompt-item").first().boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(drop.x + 30, drop.y + 15, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(".prompt-name").first()).toContainText(
    "先定义目标",
  );
  await expect
    .poll(async () =>
      page.evaluate(
        async (id) =>
          (
            (await (await fetch("/api/chats/" + id)).json()) as { chat: Chat }
          ).chat.system.map((t) => t.id),
        chatId,
      ),
    )
    .toEqual(["one", "two"]);
  await page.screenshot({ path: "docs/screenshots/prompts-sorted.png" });
  await page.getByRole("button", { name: "返回聊天", exact: true }).click();
  const separator = page.getByRole("separator", { name: "导航宽度" });
  await separator.focus();
  await separator.press("ArrowRight");
  const width = await separator.getAttribute("aria-valuenow");
  await page.reload();
  await expect(separator).toHaveAttribute("aria-valuenow", width!);
  page.once("dialog", (dialog) => void dialog.accept("测试分组"));
  await page.getByRole("button", { name: "新建分组", exact: true }).click();
  await page
    .getByRole("button", { name: "管理分组 测试分组", exact: true })
    .click();
  page.once("dialog", (dialog) => void dialog.accept("计划"));
  await page.getByRole("button", { name: "重命名分组", exact: true }).click();
  await page
    .getByRole("button", { name: "在 计划 新建聊天", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("lastChat")))
    .not.toBe(chatId);
  const groupedId = await page.evaluate(() => localStorage.getItem("lastChat"));
  await page
    .getByRole("button", { name: "管理分组 计划", exact: true })
    .click();
  await page
    .getByRole("button", { name: "移除分组，聊天回主列表", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "管理分组 计划", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      async (id) =>
        ((await (await fetch("/api/chats/" + id)).json()) as { chat: Chat })
          .chat.groupId,
      groupedId,
    ),
  ).toBeNull();
  await page.getByRole("button", { name: "账户菜单", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "多选聊天", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page
    .locator(".chat-row.selected")
    .getByRole("button", { name: /^管理 / })
    .click();
  const chatMenu = page.getByRole("dialog", { name: "对话菜单" });
  await expect(chatMenu.getByRole("button")).toHaveText([
    "导出 JSON",
    "重命名",
    "重新生成标题",
    "置顶",
    "复制",
    "归档",
    "删除",
  ]);
  await chatMenu.getByRole("button", { name: "复制", exact: true }).click();
  await expect(page.locator(".header-title")).toContainText("副本");
  await expect(page.locator(".batch-bar")).toHaveCount(0);
  const duplicateId = await page.evaluate(() =>
    localStorage.getItem("lastChat"),
  );
  await page
    .locator(".chat-row.selected")
    .getByRole("button", { name: /^管理 / })
    .click();
  await chatMenu.getByRole("button", { name: "归档", exact: true }).click();
  await page
    .getByRole("region", { name: "归档文件夹" })
    .getByRole("button", { name: /归档/ })
    .click();
  await expect(
    page.locator(".archive-contents .chat-row.selected"),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("region", { name: "归档文件夹" })
    .getByRole("button", { name: /归档/ })
    .click();
  await expect(
    page.locator(".archive-contents .chat-row.selected"),
  ).toBeVisible();
  expect(
    await page.evaluate(
      async (id) =>
        (
          (await (await fetch("/api/chats/" + id)).json()) as {
            chat: { archived: boolean };
          }
        ).chat.archived,
      duplicateId,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "账户菜单", exact: true }).click();
  await expect(
    page
      .getByRole("dialog", { name: "账户菜单" })
      .getByRole("button", { name: "归档", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  const mobileId = await page.evaluate(async () => {
    const data = {
      title: "手机分支操作",
      history: {
        currentId: "b",
        messages: {
          u: {
            id: "u",
            role: "user",
            parentId: null,
            content: "手机上怎样选择不同回答？",
          },
          a: {
            id: "a",
            role: "assistant",
            parentId: "u",
            content: "先打开版本列表。",
          },
          b: {
            id: "b",
            role: "assistant",
            parentId: "u",
            content: "长按消息查看操作，点击版本计数可以切换。",
          },
        },
      },
    };
    const response = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
    });
    return ((await response.json()) as { ids: string[] }).ids[0]!;
  });
  await page.evaluate((id) => localStorage.setItem("lastChat", id), mobileId);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const assistant = page.locator("article.assistant").last();
  await expect(assistant).toContainText("长按消息查看操作");
  await page.evaluate(async (id) => {
    await fetch("/api/chats/" + id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unread: true }),
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, mobileId);
  await expect
    .poll(() =>
      page.evaluate(
        async (id) =>
          ((await (await fetch("/api/chats/" + id)).json()) as { chat: Chat })
            .chat.unread,
        mobileId,
      ),
    )
    .toBe(false);
  await assistant.dispatchEvent("pointerdown", {
    pointerType: "touch",
    clientX: 100,
    clientY: 180,
  });
  await expect(assistant.locator(".message-actions.visible")).toBeVisible();
  await assistant.dispatchEvent("pointerup", { pointerType: "touch" });
  await page.screenshot({ path: "docs/screenshots/mobile-actions.png" });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "选择消息版本", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button")
    .filter({ hasText: "先打开版本列表" })
    .click();
  await expect(assistant).toContainText("先打开版本列表。");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(generationRequests).toEqual([]);
  expect(errors).toEqual([]);
});
