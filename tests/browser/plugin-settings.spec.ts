import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultPlugins } from "../../src/shared/plugins";

for (const mobile of [false, true])
  test(`plugin settings layout, built-in protection and k units (${mobile ? "phone" : "desktop"})`, async ({
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
    await page.evaluate(async (plugins) => {
      const settings = (await (await fetch("/api/settings")).json()) as Record<
        string,
        unknown
      >;
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...settings, plugins }),
      });
      if (!response.ok) throw Error("settings fixture failed");
    }, defaultPlugins());
    await page.reload();
    if (mobile)
      await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.getByRole("button", { name: "账户菜单", exact: true }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page
      .locator(".settings-menu")
      .getByRole("button", { name: "插件", exact: true })
      .click();
    const list = page.getByRole("list", { name: "插件默认配置", exact: true });
    await expect(list.locator("li")).toHaveCount(4);
    await expect(list.getByText("内置", { exact: true })).toHaveCount(4);
    await expect(list.getByRole("button", { name: /^删除插件 / })).toHaveCount(
      0,
    );
    for (const theme of ["dark", "light"]) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      const geometry = await list.locator("li").evaluateAll((rows) =>
        rows.map((row) => {
          const box = row.getBoundingClientRect(),
            info = row
              .querySelector(".plugin-definition-info")!
              .getBoundingClientRect(),
            actions = row
              .querySelector(".plugin-definition-actions")!
              .getBoundingClientRect(),
            buttons = Array.from(row.querySelectorAll("button")).map((b) =>
              b.getBoundingClientRect(),
            );
          return {
            height: box.height,
            infoLeft: info.left - box.left,
            actionsRight: box.right - actions.right,
            separated: info.right <= actions.left + 1,
            horizontal: Math.abs(buttons[0]!.top - buttons[1]!.top) < 2,
          };
        }),
      );
      for (const row of geometry) {
        expect(row.height).toBeLessThan(112);
        expect(row.infoLeft).toBeLessThan(25);
        expect(row.actionsRight).toBeLessThan(25);
        expect(row.separated).toBe(true);
        expect(row.horizontal).toBe(true);
      }
      await page.screenshot({
        path: `test-results/plugin-settings-${mobile ? "phone" : "desktop"}-${theme}-${test.info().project.name}.png`,
      });
    }
    await list
      .getByRole("button", { name: "编辑插件 提问澄清", exact: true })
      .click();
    let editor = page.getByRole("dialog", {
      name: "全局 · 提问澄清",
      exact: true,
    });
    const sticky = await editor.evaluate((el) => {
      const scroller = el.querySelector(".settings-form-scroll")!;
      const footer = el.querySelector("footer")!;
      const before = footer.getBoundingClientRect();
      const viewport = el.getBoundingClientRect();
      scroller.scrollTop = scroller.scrollHeight;
      const after = footer.getBoundingClientRect();
      return {
        visible: before.top >= viewport.top && before.bottom <= viewport.bottom,
        stable: Math.abs(before.top - after.top) < 1,
        scrolls: scroller.scrollHeight > scroller.clientHeight,
      };
    });
    expect(sticky).toEqual({ visible: true, stable: true, scrolls: true });
    await expect(
      editor.getByLabel("高水位（k Token）", { exact: true }),
    ).toHaveCount(0);
    await expect(
      editor.getByLabel("插件历史范围", { exact: true }),
    ).toHaveCount(0);
    await expect(
      editor.getByLabel("插件独立 system", { exact: true }),
    ).toHaveValue("");
    await expect(
      editor.getByLabel("最近原始 UA 轮数", { exact: true }),
    ).toHaveValue("3");
    await editor.getByLabel("最近原始 UA 轮数", { exact: true }).fill("0");
    await editor
      .getByLabel("插件独立 system", { exact: true })
      .fill("独立系统要求");
    await expect(
      editor.getByLabel("插件流式输出", { exact: true }),
    ).toBeChecked();
    await editor.getByLabel("插件流式输出", { exact: true }).uncheck();
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await expect(editor).toHaveCount(0);
    const saved = await page.evaluate(
      async () => (await (await fetch("/api/settings")).json()) as Promise<any>,
    );
    expect(
      saved.plugins.find((p: any) => p.id === "builtin-clarify"),
    ).toMatchObject({
      rawRounds: 0,
      system: "独立系统要求",
      stream: false,
    });
    await list
      .getByRole("button", { name: "编辑插件 提问澄清", exact: true })
      .click();
    await expect(
      editor.getByLabel("插件流式输出", { exact: true }),
    ).not.toBeChecked();
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    await list
      .getByRole("button", { name: "编辑插件 写前分析", exact: true })
      .click();
    editor = page.getByRole("dialog", {
      name: "全局 · 写前分析",
      exact: true,
    });
    await expect(
      editor.getByLabel("插件流式输出", { exact: true }),
    ).toBeChecked();
    await editor.getByLabel("插件流式输出", { exact: true }).uncheck();
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await list
      .getByRole("button", { name: "编辑插件 重写提示", exact: true })
      .click();
    editor = page.getByRole("dialog", {
      name: "全局 · 重写提示",
      exact: true,
    });
    await expect(
      editor.getByLabel("插件任务提示词", { exact: true }),
    ).toHaveValue("");
    await expect(
      editor.getByLabel("插件思考强度", { exact: true }),
    ).toHaveValue("inherit");
    await expect(
      editor.getByLabel("开头 user（U0）", { exact: true }),
    ).toHaveValue("好的");
    await expect(
      editor.getByLabel("高水位（k Token）", { exact: true }),
    ).toHaveCount(0);
    await expect(
      editor.getByLabel("最近完整问答对数", { exact: true }),
    ).toHaveCount(0);
    await editor.getByLabel("开头 user（U0）", { exact: true }).fill("开始吧");
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await list
      .getByRole("button", { name: "编辑插件 重写提示", exact: true })
      .click();
    editor = page.getByRole("dialog", {
      name: "全局 · 重写提示",
      exact: true,
    });
    await expect(
      editor.getByLabel("开头 user（U0）", { exact: true }),
    ).toHaveValue("开始吧");
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    await list
      .getByRole("button", { name: "复制插件 写前分析", exact: true })
      .click();
    editor = page.getByRole("dialog", {
      name: "全局 · 写前分析 副本",
      exact: true,
    });
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await expect(list.locator("li")).toHaveCount(5);
    await list
      .getByRole("button", { name: "删除插件 写前分析 副本", exact: true })
      .click();
    await expect(list.locator("li")).toHaveCount(4);
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
