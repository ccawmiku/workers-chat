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
  await page.getByText("选择系统模板（可多选）", { exact: true }).click();
  await page.getByLabel("再拆解步骤", { exact: false }).check();
  await page.getByLabel("先定义目标", { exact: false }).check();
  await page.getByRole("button", { name: "应用所选模板", exact: true }).click();
  await expect(page.locator(".template-card")).toHaveCount(2);
  await expect(page.locator(".template-card").first()).toContainText(
    "再拆解步骤",
  );
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
  await page.getByRole("button", { name: "多选聊天", exact: true }).click();
  await expect(page.getByText("已选 0 项", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "全选当前列表", exact: true }).click();
  await expect(page.locator(".batch-bar")).not.toContainText("已选 0 项");
  await page.getByRole("button", { name: "取消多选", exact: true }).click();
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
    await fetch("/api/chats/" + id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unread: true }) });
    document.dispatchEvent(new Event("visibilitychange"));
  }, mobileId);
  await expect.poll(() => page.evaluate(async (id) => (await (await fetch("/api/chats/" + id)).json() as { chat: Chat }).chat.unread, mobileId)).toBe(false);
  await assistant.dispatchEvent("pointerdown", {
    pointerType: "touch",
    clientX: 100,
    clientY: 180,
  });
  await expect(
    page.getByRole("button", { name: "关闭菜单", exact: true }),
  ).toBeVisible();
  await assistant.dispatchEvent("pointerup", { pointerType: "touch" });
  await page.screenshot({ path: "docs/screenshots/mobile-actions.png" });
  await page.getByRole("button", { name: "关闭菜单", exact: true }).click();
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
