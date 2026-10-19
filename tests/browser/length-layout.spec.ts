import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

for (const phone of [false, true])
  test(`compact panels and local length composer (${phone ? "phone" : "desktop"})`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.setViewportSize(
      phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
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
    const id = await page.evaluate(async () => {
      const providerId = crypto.randomUUID();
      const post = async (path: string, body: unknown) => {
        const r = await fetch("/api" + path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw Error("fixture status " + r.status);
        return r.json();
      };
      await post("/settings/import", {
        mode: "replace",
        data: {
          format: "workers-chat.settings",
          version: 1,
          settings: {
            defaultModel: { providerId, modelId: "local-length-fixture" },
          },
          providers: [
            {
              id: providerId,
              name: "Local",
              baseUrl: "https://length-fixture.invalid/v1",
              prefix: "",
              models: [
                {
                  id: "local-length-fixture",
                  enabled: true,
                  capacity: 1048576,
                  parameters: {},
                },
              ],
            },
          ],
        },
      });
      const chat = (await post("/chats", {})) as { id: string };
      localStorage.setItem("lastChat", chat.id);
      localStorage.removeItem("appearance");
      return chat.id as string;
    });
    await page.reload();
    await expect(page.locator(".composer textarea")).toBeVisible();
    if (phone)
      await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.getByRole("button", { name: "账户菜单", exact: true }).click();
    const account = page.getByRole("dialog", { name: "账户菜单", exact: true });
    await expect(account).toBeVisible();
    expect((await account.boundingBox())!.width).toBe(252);
    expect(
      await page
        .locator(".account-trigger .account-avatar")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe("rgb(240, 119, 175)");
    await page.keyboard.press("Escape");
    if (phone)
      await page.getByRole("button", { name: "收起导航", exact: true }).click();
    await page
      .getByRole("button", { name: "当前聊天设置", exact: true })
      .click();
    const panel = page.locator(".parameters");
    const assertTabs = async () => {
      const tabs = await panel.locator('[role="tab"]').all();
      const a = (await tabs[0]!.boundingBox())!,
        b = (await tabs[1]!.boundingBox())!;
      expect(Math.abs(a.y - b.y)).toBeLessThan(1);
      expect(b.x).toBeGreaterThanOrEqual(a.x + a.width - 1);
    };
    await assertTabs(); // The old initial grid stacks these before selecting overview.
    await panel.getByRole("tab", { name: "分支总览", exact: true }).click();
    await assertTabs();
    await panel.getByRole("tab", { name: "当前聊天设置", exact: true }).click();
    await assertTabs();
    await expect(
      panel.getByRole("button", { name: "摘要设置", exact: true }),
    ).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "补齐本分支全部摘要", exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByText("发送的对话轮数", { exact: true }),
    ).toHaveCount(0);
    const requirement = panel.getByLabel("每轮默认字数要求", { exact: true });
    await requirement.fill("3000字左右");
    await requirement.blur();
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/chats/" + id)).json()).chat
            .lengthGuidance?.requirement,
      )
      .toBe("3000字左右");
    await panel.getByLabel("启用字数要求", { exact: true }).check();
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/chats/" + id)).json()).chat
            .lengthGuidance?.enabled,
      )
      .toBe(true);
    await requirement.fill("");
    await requirement.blur();
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/chats/" + id)).json()).chat
            .lengthGuidance?.requirement,
      )
      .toBe("");
    await page.screenshot({
      path: `test-results/compact-panel-${phone ? "phone" : "desktop"}-${test.info().project.name}.png`,
    });
    await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    await page.getByRole("button", { name: "插件", exact: true }).click();
    await expect(
      page.getByLabel("启用字数要求", { exact: true }),
    ).toBeChecked();
    const pickerToggle = page.getByLabel("启用字数要求", { exact: true });
    await pickerToggle.uncheck();
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/chats/" + id)).json()).chat
            .lengthGuidance?.enabled,
      )
      .toBe(false);
    await pickerToggle.check();
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/chats/" + id)).json()).chat
            .lengthGuidance?.enabled,
      )
      .toBe(true);

    await page.getByRole("button", { name: "关闭插件列表" }).click();
    await expect(
      page.getByRole("button", { name: "字数要求上下文", exact: true }),
    ).toHaveCount(0);
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.fill("真实问题，下一步先填写字数");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".composer")).toHaveClass(/length-reply/);
    await expect(composer).toHaveValue("");
    await expect(composer).toHaveAttribute("placeholder", /字数要求/);
    const original = await (await page.request.get("/api/chats/" + id)).json();
    expect(original.job).toBeNull();
    let submitted = "not sent";
    await page.route("**/api/chats/" + id + "/plugins", async (route) => {
      const body = route.request().postDataJSON();
      if (body.action !== "length-answer") return route.continue();
      submitted = body.content;
      const snapshot = structuredClone(original),
        aid = crypto.randomUUID();
      snapshot.pluginState.flows.at(-1).status = "main";
      delete snapshot.pluginState.flows.at(-1).lengthWaiting;
      delete snapshot.chat.pluginPending;
      snapshot.chat.messages[aid] = {
        id: aid,
        parentId: snapshot.chat.currentId,
        role: "assistant",
        content: "本地长度工具流程验证完成",
        status: "complete",
        createdAt: Date.now(),
      };
      snapshot.chat.currentId = aid;
      await route.fulfill({ json: { ok: true, snapshot } });
    });
    await composer.fill("多写点，结尾完整");
    await page.screenshot({
      path: `test-results/length-composer-${phone ? "phone" : "desktop"}-${test.info().project.name}.png`,
    });
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => submitted).toBe("多写点，结尾完整");
    await expect(page.locator(".composer")).not.toHaveClass(/length-reply/);
    await expect(composer).toHaveValue("");
    await expect(
      page.locator(".message.assistant .markdown").last(),
    ).toContainText("本地长度工具流程验证完成");
    await page.unroute("**/api/chats/" + id + "/plugins");
    await page.request.post("/api/chats/" + id + "/plugins", {
      data: { action: "cancel" },
    });
    expect(errors).toEqual([]);
  });
