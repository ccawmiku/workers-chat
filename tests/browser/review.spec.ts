import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Chat } from "../../src/shared/chat";

test("large imports and delayed send preserve newer cloud drafts", async ({
  page,
}) => {
  test.setTimeout(60000);
  const credential = JSON.parse(
    await readFile(
      join(homedir(), ".config/workers-chat/local-login.json"),
      "utf8",
    ),
  ) as { password: string };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Corrupt device preferences must not prevent even the login screen loading.
  await page.addInitScript(() => localStorage.setItem("appearance", "{broken"));
  let releaseConfig!: () => void;
  const configGate = new Promise<void>((resolve) => {
    releaseConfig = resolve;
  });
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "GET") await configGate;
    await route.continue();
  });
  await page.goto("/");
  await page.getByLabel("访问密码", { exact: true }).fill(credential.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.locator(".new-chat").waitFor();
  await expect(page.getByLabel("消息", { exact: true })).toBeDisabled();
  releaseConfig();
  await page.getByLabel("消息", { exact: true }).fill("未点击新聊天的首个草稿");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("lastChat")))
    .not.toBeNull();
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (
            (await (
              await fetch("/api/chats/" + localStorage.getItem("lastChat"))
            ).json()) as { chat: Chat }
          ).chat.draft,
      ),
    )
    .toBe("未点击新聊天的首个草稿");
  const prefix = "批量核验 " + randomUUID().slice(0, 8) + " ";
  const rows = Array.from({ length: 15 }, (_, index) => ({
    title: prefix + index,
    messages: [
      { id: "u", role: "user", parentId: null, content: "独立的测试消息" },
    ],
  }));
  const file = [...rows, { invalid: true }];
  await page.getByLabel("聊天导入文件", { exact: true }).setInputFiles({
    name: "many-chats.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(file)),
  });
  await expect(page.getByRole("dialog", { name: "导入预览" })).toContainText(
    "15 个聊天",
  );
  await page
    .getByRole("button", { name: "确认导入有效聊天", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: /^已导入/ }),
  ).toHaveText("已导入 15 个聊天，失败 1 项。");
  await page.getByRole("button", { name: "关闭导入结果", exact: true }).click();
  const id = await page.evaluate(async (prefix) => {
    const chats = (await (await fetch("/api/chats")).json()) as Chat[];
    const imported = chats.filter((chat) => chat.title.startsWith(prefix));
    if (imported.length !== 15) throw new Error("import count mismatch");
    const providerId = crypto.randomUUID();
    const response = await fetch("/api/settings/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "replace",
        data: {
          format: "workers-chat.settings",
          version: 1,
          providers: [
            {
              id: providerId,
              name: "离线测试",
              baseUrl: "https://fixture.invalid/v1",
              prefix: "",
              models: [
                {
                  id: "fixture",
                  enabled: true,
                  capacity: 1048576,
                  parameters: {},
                },
              ],
            },
          ],
          settings: {
            defaultModel: { providerId, modelId: "fixture" },
            parameters: {},
            templates: [],
            titleModel: null,
            titlePrompt: "fixture",
          },
        },
      }),
    });
    if (!response.ok) throw new Error("fixture settings failed");
    return imported[0]!.id;
  }, prefix);
  await page.evaluate((id) => localStorage.setItem("lastChat", id), id);
  await page.reload();
  const composer = page.getByLabel("消息", { exact: true });
  await expect(page.locator(".header-title")).toContainText(prefix);
  let releaseDraft!: () => void,
    releaseSend!: () => void,
    observedDraft!: () => void,
    observedSend!: () => void;
  const draftGate = new Promise<void>((resolve) => {
    releaseDraft = resolve;
  });
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const draftStarted = new Promise<void>((resolve) => {
    observedDraft = resolve;
  });
  const sendStarted = new Promise<void>((resolve) => {
    observedSend = resolve;
  });
  let calls = 0;
  await page.route("**/api/chats/" + id + "/draft", async (route) => {
    if (route.request().postDataJSON().draft === "待发送的文字") {
      observedDraft();
      await draftGate;
    }
    await route.continue();
  });
  await page.route("**/api/chats/" + id + "/send", async (route) => {
    calls++;
    expect(route.request().postDataJSON().content).toBe("待发送的文字");
    observedSend();
    await sendGate;
    // Simulate the server's atomic draft clear without invoking any model.
    const cleared = await page.request.put("/api/chats/" + id + "/draft", {
      headers: { Origin: "http://localhost:5173" },
      data: { draft: "" },
    });
    expect(cleared.ok()).toBe(true);
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ jobId: "offline-fixture" }),
    });
  });
  await composer.fill("待发送的文字");
  await draftStarted;
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await composer.fill("提交期间继续编辑的新草稿");
  expect(calls).toBe(0);
  releaseDraft();
  await sendStarted;
  releaseSend();
  await expect(composer).toHaveValue("提交期间继续编辑的新草稿");
  await expect
    .poll(() =>
      page.evaluate(
        async (id) =>
          ((await (await fetch("/api/chats/" + id)).json()) as { chat: Chat })
            .chat.draft,
        id,
      ),
    )
    .toBe("提交期间继续编辑的新草稿");
  expect(calls).toBe(1);
  await page.reload();
  await expect(composer).toHaveValue("提交期间继续编辑的新草稿");
  let releaseKey!: () => void, observedKey!: () => void;
  const keyGate = new Promise<void>((resolve) => {
    releaseKey = resolve;
  });
  const keyStarted = new Promise<void>((resolve) => {
    observedKey = resolve;
  });
  await page.route("**/api/providers/*/key", async (route) => {
    observedKey();
    await keyGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiKey: "synthetic-display-key" }),
    });
  });
  await page.getByRole("button", { name: "账户菜单", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("button", { name: "查看 离线测试 密钥", exact: true })
    .click();
  await page
    .getByLabel("密钥查看密码", { exact: true })
    .fill("synthetic mock password");
  await page.getByRole("button", { name: "验证并显示", exact: true }).click();
  await keyStarted;
  await page.getByRole("button", { name: "关闭密钥窗口", exact: true }).click();
  releaseKey();
  await page.waitForResponse((response) =>
    /\/api\/providers\/[^/]+\/key$/.test(new URL(response.url()).pathname),
  );
  await page
    .getByRole("button", { name: "查看 离线测试 密钥", exact: true })
    .click();
  await expect(page.getByLabel("密钥查看密码", { exact: true })).toBeVisible();
  await expect(page.locator(".revealed-key")).toHaveCount(0);
  await page.getByRole("button", { name: "关闭密钥窗口", exact: true }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.evaluate(async () => {
    const settings = (await (await fetch("/api/settings")).json()) as Record<
      string,
      unknown
    >;
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...settings, defaultModel: null }),
    });
  });
  await page.reload();
  await expect(
    page.getByText(
      "没有可用的当前模型或默认模型，请在设置中添加服务商并选择有效的默认模型。",
      { exact: true },
    ),
  ).toBeVisible();
  await composer.fill("没有默认模型时不可发送");
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeDisabled();
  await composer.press("Enter");
  expect(calls).toBe(1);
  expect(errors).toEqual([]);
});
