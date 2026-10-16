import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

test("repeated questions switch complete user-answer sends on desktop and phone", async ({
  page,
}) => {
  const { password } = JSON.parse(
    await readFile(
      join(homedir(), ".config/workers-chat/local-login.json"),
      "utf8",
    ),
  );
  let generations = 0;
  await page.route(
    /\/api\/chats\/[^/]+\/(send|regenerate|retry|continue|title)$/,
    async (route) => {
      generations++;
      await route.fulfill({
        status: 400,
        json: { error: "Synthetic branch fixture only" },
      });
    },
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByLabel("访问密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.locator(".new-chat").waitFor();
  const id = await page.evaluate(async () => {
    const response = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: [
          {
            chat: {
              title: "重新发送切换验证",
              history: {
                currentId: "a2",
                messages: {
                  u1: {
                    id: "u1",
                    parentId: null,
                    role: "user",
                    content: "完全相同的问题",
                    timestamp: 1700000000,
                  },
                  a1: {
                    id: "a1",
                    parentId: "u1",
                    role: "assistant",
                    content: "第一次发送的回答",
                    timestamp: 1700000001,
                  },
                  u2: {
                    id: "u2",
                    parentId: null,
                    role: "user",
                    content: "完全相同的问题",
                    timestamp: 1700000002,
                  },
                  a2: {
                    id: "a2",
                    parentId: "u2",
                    role: "assistant",
                    content: "重新发送后的回答",
                    timestamp: 1700000003,
                  },
                },
              },
            },
          },
        ],
      }),
    });
    if (!response.ok) throw Error("Branch fixture import failed");
    const result = (await response.json()) as { ids: string[] };
    localStorage.setItem("lastChat", result.ids[0]!);
    return result.ids[0]!;
  });
  await page.reload();
  await expect(page.locator(".header-title")).toHaveText("重新发送切换验证");
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    if (viewport.width < 760 && (await page.locator(".sidebar").isVisible()))
      await page.getByRole("button", { name: "收起导航", exact: true }).click();
    const user = page.locator(".message.user");
    await expect(user).toHaveCount(1);
    await expect(
      user.getByRole("button", { name: "选择消息版本", exact: true }),
    ).toHaveText("2 / 2");
    await expect(page.locator(".message.assistant")).toHaveText(
      /重新发送后的回答/,
    );
    await user.getByRole("button", { name: "上个版本", exact: true }).click();
    await expect(
      user.getByRole("button", { name: "选择消息版本", exact: true }),
    ).toHaveText("1 / 2");
    await expect(page.locator(".message.assistant")).toHaveText(
      /第一次发送的回答/,
    );
    await user.getByRole("button", { name: "下个版本", exact: true }).click();
    await expect(page.locator(".message.assistant")).toHaveText(
      /重新发送后的回答/,
    );
  }
  const result = await page.evaluate(async (chatId) => {
    const response = await fetch("/api/chats/" + chatId);
    return (await response.json()) as {
      chat: { messages: Record<string, unknown> };
    };
  }, id);
  expect(Object.keys(result.chat.messages)).toHaveLength(4);
  expect(generations).toBe(0);
});
test("desktop/mobile login, import, branch navigation and cloud draft", async ({
  page,
}) => {
  const credential = JSON.parse(
    await readFile(
      join(homedir(), ".config/workers-chat/local-login.json"),
      "utf8",
    ),
  ) as { password: string };
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByLabel("访问密码", { exact: true }).fill(credential.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.locator(".new-chat").waitFor();
  const fixture = [
    {
      chat: {
        title: "从想法到清晰的答案",
        timestamp: 1792080000,
        history: {
          currentId: "b",
          messages: {
            u: {
              id: "u",
              parentId: null,
              childrenIds: ["a", "b"],
              role: "user",
              content: "帮我梳理一下，怎样把一个复杂的想法变成可以实施的计划？",
            },
            a: {
              id: "a",
              parentId: "u",
              childrenIds: [],
              role: "assistant",
              content: "从目标开始，逐步分解。",
            },
            b: {
              id: "b",
              parentId: "u",
              childrenIds: [],
              role: "assistant",
              content:
                "## 先把目标说清楚\n\n先用一句话写下你希望看到的结果，然后把它拆成三个层次：\n\n1. **目标**：什么发生了，才算完成？\n2. **路径**：哪些步骤能让你接近结果？\n3. **下一步**：今天就能开始的一件小事。\n\n一个可以实施的计划，不需要一开始就完美。关键是让每一步都能得到反馈。\n\n> 把模糊的问题变成具体的行动，清晰往往会在行动中出现。\n\n```text\n目标 → 拆解 → 行动 → 反馈 → 调整\n```",
              reasoning_content: "上游提供的独立思考示例。",
            },
          },
        },
      },
    },
  ];
  const importedId = await page.evaluate(async (data) => {
    // Keep visual checks independent of settings left by other test runs.
    const providerId = crypto.randomUUID();
    const setup = await fetch("/api/settings/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "replace",
        data: {
          format: "workers-chat.settings",
          version: 1,
          settings: { defaultModel: { providerId, modelId: "Demo" } },
          providers: [
            {
              id: providerId,
              name: "界面构造测试",
              baseUrl: "https://fixture.invalid/v1",
              prefix: "",
              models: [
                {
                  id: "Demo",
                  enabled: true,
                  capacity: 1048576,
                  parameters: {},
                },
              ],
            },
          ],
        },
      }),
    });
    if (!setup.ok) throw new Error("visual fixture settings failed");
    const response = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
    });
    if (!response.ok) throw new Error("fixture import failed");
    return ((await response.json()) as { ids: string[] }).ids[0]!;
  }, fixture);
  await page.evaluate((id) => localStorage.setItem("lastChat", id), importedId);
  await page.reload();
  await expect(page.getByText("先把目标说清楚", { exact: true })).toBeVisible();
  await page
    .getByLabel("消息", { exact: true })
    .fill("把这个方法应用到我的下一个项目。");
  await page.getByRole("button", { name: "账户菜单", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "外观", exact: true }).click();
  await page.getByLabel("主题", { exact: true }).selectOption("dark");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.screenshot({ path: "docs/screenshots/desktop-dark.png" });
  await page
    .locator(".composer")
    .screenshot({ path: "docs/screenshots/composer-dark.png" });
  await page.getByRole("button", { name: "当前聊天设置", exact: true }).click();
  await page.getByRole("tab", { name: "分支总览", exact: true }).click();
  await expect(page.locator(".svelte-flow__node")).toHaveCount(3);
  await page.getByRole("button", { name: "fit view", exact: true }).click();
  await page
    .locator(".parameters")
    .screenshot({ path: "docs/screenshots/overview-dark.png" });
  await page
    .getByRole("button", { name: "Horizontal Layout", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Vertical Layout", exact: true })
    .click();
  await page
    .locator(".svelte-flow__node")
    .filter({ hasText: "从目标开始" })
    .click();
  await expect(
    page
      .locator(".message.assistant .markdown")
      .getByText("从目标开始，逐步分解。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回聊天", exact: true }).click();
  await page.getByRole("button", { name: "账户菜单", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "外观", exact: true }).click();
  await page.getByLabel("主题", { exact: true }).selectOption("light");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.screenshot({ path: "docs/screenshots/desktop-light.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "收起导航", exact: true }).click();
  await page.getByRole("button", { name: "当前聊天设置", exact: true }).click();
  await expect(page.getByText("当前聊天设置", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "分支总览", exact: true }).click();
  await page.getByRole("button", { name: "fit view", exact: true }).click();
  await page
    .locator(".parameters")
    .screenshot({ path: "docs/screenshots/overview-mobile.png" });
  await page.getByRole("button", { name: "返回聊天", exact: true }).click();
  await page.screenshot({ path: "docs/screenshots/mobile-light.png" });
  await page
    .locator(".composer")
    .screenshot({ path: "docs/screenshots/composer-mobile.png" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByLabel("消息", { exact: true }).fill("手机草稿应保存到云端。");
  await expect
    .poll(async () => {
      const result = await page.evaluate(async () => {
        const id = localStorage.getItem("lastChat");
        return (await (await fetch("/api/chats/" + id)).json()) as {
          chat: { draft: string };
        };
      });
      return result.chat.draft;
    })
    .toBe("手机草稿应保存到云端。");
  await page.reload();
  await expect(page.getByLabel("消息", { exact: true })).toHaveValue(
    "手机草稿应保存到云端。",
  );
  expect(errors).toEqual([]);
});
