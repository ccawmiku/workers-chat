import { defaultPlugins, emptyPluginState } from "../../src/shared/plugins";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  summarySourceKey,
  defaultSummaryConfig,
  type SummaryState,
} from "../../src/shared/summaries";
import type { Chat } from "../../src/shared/chat";
for (const mobile of [false, true])
  test(`summary cards, manual replacement, temperature and pending-send confirmation (${mobile ? "phone" : "desktop"})`, async ({
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
    const chat = await page.evaluate(async () => {
      const api = async (path: string, method = "GET", body?: unknown) => {
        const r = await fetch("/api" + path, {
          method,
          headers: { "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!r.ok) throw Error("fixture " + r.status);
        return r.json() as Promise<any>;
      };
      const c = await api("/chats", "POST", {});
      await api("/chats/" + c.id, "PATCH", { title: "摘要组件测试" });
      const providerId = crypto.randomUUID();
      await api("/settings/import", "POST", {
        mode: "merge",
        data: {
          format: "workers-chat.settings",
          version: 1,
          settings: {
            defaultModel: { providerId, modelId: "summary-fixture" },
          },
          providers: [
            {
              id: providerId,
              name: "摘要组件测试接口",
              baseUrl: "https://summary-fixture.invalid/v1",
              prefix: "",
              models: [
                {
                  id: "summary-fixture",
                  enabled: true,
                  capacity: 1000000,
                  parameters: {},
                },
              ],
            },
          ],
        },
      });
      const imported = await api("/import", "POST", {
        data: {
          title: "摘要组件测试",
          messages: [
            { id: "su1", role: "user", content: "第一个要求" },
            { id: "sa1", role: "assistant", content: "第一条完整回复。" },
            { id: "su2", role: "user", content: "第二个要求" },
            { id: "sa2", role: "assistant", content: "第二条完整回复。" },
          ],
        },
      });
      localStorage.setItem("lastChat", imported.ids[0]);
      return (await api("/chats/" + imported.ids[0])).chat as Chat;
    });
    const state: SummaryState = {
      runs: ["sa1", "sa2"].map((messageId, i) => ({
        id: "summary" + i,
        messageId,
        sourceKey: summarySourceKey(chat, messageId),
        status: "complete",
        output: JSON.stringify({ summary: "已采用摘要" + i }),
        summary: "已采用摘要" + i,
        warning: "摘要字数提示，仅用于对比度验证",
        createdAt: Date.now(),
        elapsedMs: 2000,
        config: defaultSummaryConfig(),
        model: chat.model ?? undefined,
        inputTokens: 18929,
        usage: {
          input_tokens: 18929,
          cached_tokens: 16247,
          output_tokens: 424,
          completion_tokens_details: { reasoning_tokens: 100 },
          total_tokens: 19353,
          cache_hit_rate: "85.8%",
        },
      })),
    };
    let pending = false,
      rejectOnce = true,
      confirmed = false,
      backfilled = false;
    const decorate = (snapshot: any) => ({
      ...snapshot,
      chat: {
        ...snapshot.chat,
        plugins: defaultPlugins().map((p) => ({ id: p.id, enabled: true })),
      },
      pluginState: emptyPluginState(),
      summaryState: state,
      postJobs: pending
        ? [
            {
              id: "fake-summary-pending",
              kind: "summary",
              runId: "fake-summary-pending",
              messageId: "sa2",
            },
          ]
        : [],
    });
    await page.route("**/api/bootstrap*", async (route) => {
      const r = await route.fetch(),
        v = await r.json();
      if (v.current?.chat?.id === chat.id) v.current = decorate(v.current);
      await route.fulfill({ response: r, json: v });
    });
    await page.route("**/api/chats/" + chat.id, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const r = await route.fetch();
      await route.fulfill({ response: r, json: decorate(await r.json()) });
    });
    await page.route(
      "**/api/chats/" + chat.id + "/summaries",
      async (route) => {
        const b = route.request().postDataJSON();
        if (b.action === "request")
          return route.fulfill({
            json: {
              model: "summary-fixture",
              stream: true,
              messages: [
                { role: "system", content: "summary system" },
                { role: "user", content: "summary context snapshot" },
              ],
            },
          });
        if (b.action === "backfill") backfilled = true;
        if (b.action === "configure") return route.fallback();
        if (b.action === "regenerate") {
          const old = state.runs.findLast(
            (r) => r.messageId === b.messageId && r.status === "complete",
          )!;
          state.runs.push({
            ...old,
            id: crypto.randomUUID(),
            status: "candidate",
            replaces: old.id,
            summary: "待确认的新摘要",
            output: '{"summary":"待确认的新摘要"}',
          });
          return route.fulfill({ json: { jobId: state.runs.at(-1)!.id } });
        }
        if (b.action === "discard-candidates")
          state.runs = state.runs.filter(
            (r) => r.status !== "candidate" || !b.runIds.includes(r.id),
          );
        if (b.action === "accept") {
          if (rejectOnce) {
            rejectOnce = false;
            return route.fulfill({
              status: 409,
              json: { error: "模拟并发更新，请重试确认" },
            });
          }
          for (const r of state.runs)
            if (r.messageId === "sa2" && r.status === "complete")
              r.status = "superseded";
          state.runs.find((r) => r.id === b.runId)!.status = "complete";
        }
        if (b.action === "dismiss")
          state.runs.find((r) => r.id === b.runId)!.status = "superseded";
        await route.fulfill({ json: { ok: true } });
      },
    );
    await page.reload();
    await expect(page.locator(".reply-summary")).toHaveCount(2);
    await expect(page.locator(".reply-summary").first()).not.toHaveAttribute(
      "open",
    );
    await expect(page.locator(".reply-summary").last()).toHaveAttribute("open");
    const latest = page.locator(".reply-summary").last();
    await expect(latest).toContainText("输入 18.9k");
    await expect(latest).toContainText("输出 424");
    await expect(latest).toContainText("缓存率 85.8%");
    await expect(latest.locator(".plugin-usage .usage-ring")).toHaveCount(1);
    const composition = page.locator(".summary-context-chip .usage-ring");
    await expect(composition.locator(".usage-segment")).toHaveCount(4);
    expect(
      await composition
        .locator(".usage-segment")
        .evaluateAll((segments) =>
          segments.map((s) => Number(s.getAttribute("data-tokens"))),
        ),
    ).toEqual([2682, 16247, 100, 324]);
    const colors = await composition
      .locator(".usage-segment")
      .evaluateAll((segments) =>
        segments.map((s) => getComputedStyle(s).color),
      );
    expect(colors).toEqual([
      "rgb(37, 99, 235)",
      "rgb(147, 197, 253)",
      "rgb(250, 204, 21)",
      "rgb(240, 119, 175)",
    ]);
    const arcs = await composition
      .locator(".usage-segment")
      .evaluateAll((nodes) =>
        nodes.map((n) => ({
          dash: n.getAttribute("stroke-dasharray")!,
          offset: Number(n.getAttribute("stroke-dashoffset")),
        })),
      );
    expect(
      arcs.reduce((sum, a) => sum + Number(a.dash.split(" ")[0]), 0),
    ).toBeCloseTo(100, 4);
    expect(arcs[0]!.offset).toBe(0);
    expect(arcs[1]!.offset).toBeLessThan(0);
    const chips = page.locator(".plugin-chip");
    await expect(chips).toHaveCount(5);
    const dimensions = await chips.evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect(),
          bars = node.querySelectorAll(".plugin-context-ring");
        return {
          height: r.height,
          capacity: bars[0]!.getBoundingClientRect().y - r.y,
          composition:
            node.querySelector(".usage-ring")!.getBoundingClientRect().y - r.y,
        };
      }),
    );
    expect(new Set(dimensions.map((v) => v.height)).size).toBe(1);
    expect(dimensions[0]!.height).toBeLessThanOrEqual(60);
    expect(new Set(dimensions.map((v) => v.capacity)).size).toBe(1);
    expect(new Set(dimensions.map((v) => v.composition)).size).toBe(1);
    await expect(page.locator(".plugin-chips")).not.toContainText(
      /截\s*\d+\s*条/,
    );
    const warning = latest.locator(".du-alert-warning");
    expect(
      await warning.evaluate((node) => {
        const style = getComputedStyle(node),
          parse = (s: string) =>
            s
              .match(/[\d.]+/g)!
              .slice(0, 3)
              .map(Number);
        const luminance = (c: number[]) =>
          c
            .map((x) => {
              x /= 255;
              return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
            })
            .reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i]!, 0);
        const fg = luminance(parse(style.color)),
          bg = luminance(parse(style.backgroundColor));
        return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      }),
    ).toBeGreaterThan(4.5);
    await page.getByRole("button", { name: "插件", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "运行 追问建议", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "关闭插件列表", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "回复摘要上下文", exact: true }),
    ).toContainText("18.9k");
    await page
      .getByRole("button", { name: "回复摘要上下文", exact: true })
      .click();
    const context = page.getByRole("dialog", {
      name: "回复摘要 · 上下文",
      exact: true,
    });
    await expect(context).toContainText("缓存率 85.8%");
    await context
      .getByRole("button", { name: "选择插件上下文消息", exact: true })
      .click();
    await context
      .getByRole("list", { name: "上下文消息类型", exact: true })
      .getByRole("button")
      .last()
      .click();
    await expect(context.locator(".plugin-request-preview")).toHaveText(
      "summary context snapshot",
    );
    await context
      .getByRole("button", { name: "关闭插件窗口", exact: true })
      .click();
    await expect(page.locator(".message-actions .usage-ring")).toHaveCount(0);
    await expect(
      page.locator(
        ".message.assistant > .message-body > .message-meta .message-model > .usage-ring",
      ),
    ).toHaveCount(2);
    await page
      .getByRole("button", { name: "当前聊天设置", exact: true })
      .click();
    await page
      .locator(".panel-content")
      .getByRole("button", { name: "补齐本分支全部摘要", exact: true })
      .click();
    await expect.poll(() => backfilled).toBe(true);
    await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    await latest
      .getByRole("button", { name: "重新生成摘要", exact: true })
      .click();
    let dialog = page.getByRole("dialog", {
      name: "确认替换摘要",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("已采用摘要1");
    await expect(dialog).toContainText("待确认的新摘要");
    await dialog.getByRole("button", { name: "确认替换", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("alert")).toContainText("模拟并发更新");
    await dialog.getByRole("button", { name: "确认替换", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(latest.locator(".summary-text")).toHaveText("待确认的新摘要");
    await latest
      .getByRole("button", { name: "重新生成摘要", exact: true })
      .click();
    dialog = page.getByRole("dialog", { name: "确认替换摘要", exact: true });
    await expect(dialog).toBeVisible();
    const abandoned = state.runs.findLast((r) => r.status === "candidate")!.id;
    await page.reload();
    await expect(page.locator(".reply-summary")).toHaveCount(2);
    await expect(
      page.getByRole("dialog", { name: "确认替换摘要", exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() => state.runs.some((r) => r.id === abandoned))
      .toBe(false);
    await expect(latest.locator(".summary-text")).toHaveText("待确认的新摘要");
    await expect(
      latest.getByRole("button", { name: "查看新摘要", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "插件", exact: true }).click();
    await page.getByRole("button", { name: "摘要设置", exact: true }).click();
    const settings = page.getByRole("dialog", {
      name: "当前聊天 · 回复摘要",
      exact: true,
    });
    await expect(
      settings
        .getByRole("button", { name: "取消", exact: true })
        .locator("svg"),
    ).toHaveCount(1);
    await expect(settings.getByLabel("温度", { exact: true })).toHaveValue(
      "0.3",
    );
    await expect(settings.getByLabel("摘要思考强度")).toHaveValue("inherit");
    await settings.getByLabel("温度", { exact: true }).fill("0.6");
    await settings.getByLabel("摘要流式输出").uncheck();
    await settings.getByRole("button", { name: "保存", exact: true }).click();
    await expect(settings).toHaveCount(0);
    await page
      .getByRole("button", { name: "关闭插件列表", exact: true })
      .click();
    pending = true;
    await page.reload();
    await page.getByLabel("消息", { exact: true }).fill("保留这个新草稿");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    dialog = page.getByRole("dialog", {
      name: "仍有摘要或追问正在生成",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "暂不发送", exact: true }).click();
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue(
      "保留这个新草稿",
    );
    await page.route("**/api/chats/" + chat.id + "/send", async (route) => {
      confirmed = route.request().postDataJSON().confirmPost === true;
      pending = false;
      await route.fulfill({ json: { jobId: "fixture-sent" } });
    });
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await dialog.getByRole("button", { name: "继续发送", exact: true }).click();
    await expect.poll(() => confirmed).toBe(true);
    await expect(dialog).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/summaries-${mobile ? "phone" : "desktop"}-${test.info().project.name}.png`,
    });
  });
