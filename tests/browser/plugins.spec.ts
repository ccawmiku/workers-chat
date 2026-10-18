import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultPlugins } from "../../src/shared/plugins";
for (const mobile of [false, true])
  test(`four plugin flows, draft safety, live preview and grouping (${mobile ? "phone" : "desktop"})`, async ({
    page,
  }) => {
    test.setTimeout(150000);
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
    page.on("pageerror", (e) => errors.push(e.stack || e.message));
    await page.goto("/");
    await page.getByLabel("访问密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.locator(".new-chat").waitFor({ state: "attached" });
    const id = await page.evaluate(
      async (plugins) => {
        const providerId = crypto.randomUUID();
        const api = async (path: string, method = "GET", body?: unknown) => {
          const r = await fetch("/api" + path, {
            method,
            headers: { "Content-Type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          if (!r.ok) throw Error("fixture " + path + " " + r.status);
          return r.json() as Promise<any>;
        };
        await api("/settings/import", "POST", {
          mode: "replace",
          data: {
            format: "workers-chat.settings",
            version: 1,
            settings: {
              defaultModel: { providerId, modelId: "plugin-model" },
              plugins,
              pluginFallbackModels: [{ providerId, modelId: "plugin-spare" }],
            },
            providers: [
              {
                id: providerId,
                name: "插件合成接口",
                baseUrl: "https://plugin-fixture.invalid/v1",
                prefix: "FX/",
                models: [
                  {
                    id: "plugin-spare",
                    enabled: true,
                    capacity: 1048576,
                    parameters: {},
                  },
                  {
                    id: "plugin-model",
                    enabled: true,
                    capacity: 1048576,
                    parameters: {},
                  },
                ],
              },
            ],
          },
        });
        const chat = await api("/chats", "POST", {});
        await api("/chats/" + chat.id, "PATCH", {
          title: "四插件实际界面测试",
        });
        localStorage.removeItem("plugin-chips-collapsed");
        localStorage.setItem("lastChat", chat.id);
        localStorage.setItem("device-direct", "true");
        return chat.id;
      },
      defaultPlugins().map((p) => ({
        ...p,
        stream: mobile || !["analysis", "clarify"].includes(p.kind),
      })),
    );
    await page.addInitScript(() => {
      const original = window.fetch.bind(window),
        ledger: { kind: string; messages: unknown[] }[] = [];
      (window as any).pluginLedger = ledger;
      window.fetch = async (input, init) => {
        if (!String(input).startsWith("https://plugin-fixture.invalid/v1"))
          return original(input, init);
        const body = JSON.parse(String(init?.body || "{}")),
          messages = body.messages as { content: string | null }[];
        const last = messages.at(-1)?.content ?? "",
          all = messages.map((m) => m.content ?? "").join("\n");
        let kind = "main",
          content = "主回答已结合目标、约束和澄清结果完成。";
        let part: any;
        try {
          part = JSON.parse(last);
        } catch {}
        if (part?.output_contract) {
          kind = "section";
          content = JSON.stringify({
            type: part.target?.type ?? "服装状态",
            content: part.user_requirement || "这是一条重新整理的已有状态。",
            instruction: "只记录历史已经明确的服装状态",
          });
        } else if (
          last.includes("JSON Schema：") &&
          !last.includes('"questions"')
        ) {
          kind = "analysis";
          content = JSON.stringify({
            character_thoughts: "none",
            scene_state: "none",
            action_state: "none",
            knowledge_boundaries: "none",
          });
        } else if (last.includes("只提出必要、未回答且未明确跳过的澄清问题")) {
          kind = "clarify";
          content = JSON.stringify({
            questions:
              ledger.some((l) => l.kind === "clarify") ||
              messages.some((m) => (m as any).role === "tool")
                ? [
                    {
                      id: "q3",
                      question: "后续希望优先处理哪一项？",
                      multiple: false,
                      options: [
                        { id: "A", text: "延续互动" },
                        { id: "B", text: "解释背景" },
                        { id: "C", text: "推进动作" },
                        { id: "D", text: "暂不指定" },
                      ],
                    },
                  ]
                : [
                    {
                      id: "q1",
                      question: "希望采用哪种风格？",
                      multiple: false,
                      options: [
                        { id: "A", text: "轻松" },
                        { id: "B", text: "正式" },
                        { id: "C", text: "其他" },
                        { id: "D", text: "不限定" },
                      ],
                    },
                    {
                      id: "q2",
                      question: "需要哪些已有角色？",
                      multiple: true,
                      options: [
                        { id: "A", text: "甲" },
                        { id: "B", text: "乙" },
                        { id: "C", text: "都不指定" },
                        { id: "D", text: "其他角色" },
                      ],
                    },
                  ],
          });
        } else if (all.includes('"suggestions"')) {
          kind = "suggest";
          content = JSON.stringify({
            suggestions: ["再给我一个例子", "换成更简短的版本", "加入新的场景"],
          });
        } else if (last.includes('"prompt1"')) {
          kind = "rewrite";
          content = JSON.stringify({
            prompt1: ledger.some((l) => l.kind === "rewrite")
              ? "保留旧草稿"
              : "请保留旧草稿",
            prompt2: "我原来的草稿保留",
            prompt3: "旧草稿不要动",
          });
        }
        ledger.push({ kind, messages, model: body.model } as any);
        if (kind === "rewrite" && (window as any).failRewriteOnce) {
          (window as any).failRewriteOnce = false;
          return Response.json(
            { error: { message: "synthetic model failure" } },
            { status: 400 },
          );
        }
        if (!body.stream)
          return Response.json({
            choices: [{ message: { content }, finish_reason: "stop" }],
            usage: {
              input_tokens: 1500,
              output_tokens: 424,
              cache_hit_rate: "80.0%",
            },
          });
        return new Response(
          new ReadableStream({
            start(c) {
              const e = new TextEncoder();
              c.enqueue(
                e.encode(
                  "data: " +
                    JSON.stringify({
                      choices: [{ delta: { content: content.slice(0, 3) } }],
                    }) +
                    "\n\n",
                ),
              );
              setTimeout(
                () => {
                  c.enqueue(
                    e.encode(
                      "data: " +
                        JSON.stringify({
                          choices: [
                            {
                              delta: { content: content.slice(3) },
                              finish_reason: "stop",
                            },
                          ],
                          usage: {
                            input_tokens: 1500,
                            output_tokens: 424,
                            cached_tokens: kind === "main" ? 1287 : 80,
                            cache_hit_rate:
                              kind === "suggest"
                                ? 22
                                : kind === "rewrite"
                                  ? "22"
                                  : kind === "main"
                                    ? undefined
                                    : "80.0%",
                          },
                        }) +
                        "\n\ndata: [DONE]\n\n",
                    ),
                  );
                  c.close();
                },
                kind === "rewrite" ? 1200 : 200,
              );
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      };
    });
    await page.reload();
    await expect(page.locator(".chat-row.selected .chat-title")).toHaveText(
      "四插件实际界面测试",
    );
    await expect(
      page
        .locator(".composer-controls")
        .getByRole("button", { name: "插件", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "插件", exact: true }).click();
    for (const name of ["写前分析", "补充提问", "追问建议", "重写提示"]) {
      await page.getByLabel("启用 " + name, { exact: true }).check();
      await expect(
        page.getByRole("button", { name: name + "上下文", exact: true }),
      ).toBeVisible();
    }
    await expect(
      page.getByRole("button", { name: "上移 追问建议", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "上移 重写提示",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^(上移|下移) / }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "关闭插件列表" }).click();
    await expect(page.locator(".plugin-chips .plugin-chip")).toHaveCount(5);
    await expect(page.locator("main > header")).toHaveCount(0);
    expect(
      await page
        .locator(".model-trigger > span")
        .evaluate((el) => el.getBoundingClientRect().width),
    ).toBeGreaterThan(40);
    await page
      .getByRole("button", { name: "折叠插件上下文", exact: true })
      .click();
    expect(
      await page
        .locator(".plugin-chip")
        .first()
        .evaluate((el) => el.getBoundingClientRect().height),
    ).toBeLessThanOrEqual(28);
    expect(
      await page.evaluate(() => localStorage.getItem("plugin-chips-collapsed")),
    ).toBe("1");
    await expect(
      page.locator(".plugin-chips .plugin-context-ring"),
    ).toHaveCount(5);
    await expect(page.locator(".plugin-chips .usage-ring")).toHaveCount(5);
    for (const ring of await page.locator(".plugin-chips svg").all())
      await expect(ring).toBeVisible();
    expect(
      await page
        .locator(".plugin-chip")
        .first()
        .evaluate((el) => getComputedStyle(el).borderTopWidth),
    ).toBe("0px");
    await page.screenshot({
      path: `test-results/collapsed-rings-${mobile ? "phone" : "desktop"}-${test.info().project.name}.png`,
    });

    await page
      .getByRole("button", { name: "展开插件上下文", exact: true })
      .click();
    const placement = await page
      .locator(".composer-area")
      .evaluate((wrapper) => {
        const bar = wrapper
            .querySelector(".plugin-bar")!
            .getBoundingClientRect(),
          composer = wrapper
            .querySelector(".composer")!
            .getBoundingClientRect(),
          plugin = wrapper
            .querySelector(".plugin-menu-button")!
            .getBoundingClientRect(),
          rewrite = wrapper
            .querySelector(".composer-rewrite-entry button")!
            .getBoundingClientRect();
        return {
          above: bar.bottom <= composer.top,
          gap: rewrite.left - plugin.right,
        };
      });
    expect(placement.above).toBe(true);
    expect(placement.gap).toBeGreaterThanOrEqual(0);
    expect(placement.gap).toBeLessThan(16);
    let previewAPIs = 0;
    const counter = (r: any) => {
      if (r.url().includes("/api/") && !r.url().endsWith("/draft"))
        previewAPIs++;
    };
    page.on("request", counter);
    await page.getByLabel("消息", { exact: true }).fill("写一个短故事");
    await page
      .getByRole("button", { name: "写前分析上下文", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "写前分析 · 上下文", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("总输入／模型容量", { exact: true }),
    ).toBeVisible();
    const progress = page.getByLabel("插件上下文用量", { exact: true });
    expect(
      await progress.evaluate((el) => getComputedStyle(el).appearance),
    ).toBe("none");
    expect(
      await progress.evaluate(
        (el) =>
          el.getBoundingClientRect().width /
          el.parentElement!.getBoundingClientRect().width,
      ),
    ).toBeGreaterThan(0.85);
    await page.screenshot({
      path: `test-results/plugin-context-${mobile ? "phone" : "desktop"}-${test.info().project.name}.png`,
    });
    await page
      .getByRole("button", { name: "选择插件上下文消息", exact: true })
      .click();
    const messageMenu = page.getByRole("list", {
      name: "上下文消息类型",
      exact: true,
    });
    await expect(messageMenu.locator(".plugin-role")).toHaveCount(1);
    await expect(messageMenu.locator(".plugin-role-user")).toHaveText("user");
    await messageMenu.getByRole("button").first().click();
    await expect(page.locator(".plugin-context-text")).toContainText(
      "写一个短故事",
    );
    await page
      .getByRole("button", { name: "关闭插件窗口", exact: true })
      .click();
    expect(previewAPIs).toBe(0);
    page.off("request", counter);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".plugin-reply")).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".plugin-question[open]")).toContainText(
      "哪种风格",
    );
    await expect(
      page.locator(".plugin-question[open] .question-options button"),
    ).toHaveCount(10);
    await expect(
      page.locator(".plugin-question[open] .plugin-usage"),
    ).toContainText("缓存率 80.0%");
    expect(
      await page.evaluate(() =>
        (window as any).pluginLedger.map((x: any) => x.kind),
      ),
    ).toEqual(["clarify"]);
    await page.screenshot({
      path: `test-results/plugins-${mobile ? "phone" : "desktop"}.png`,
    });
    if (mobile) {
      await page.reload();
      await expect(page.locator(".plugin-reply")).toBeVisible();
      expect(await page.evaluate(() => (window as any).pluginLedger)).toEqual(
        [],
      );
    }
    const questionBoxes = await page
      .locator(".question-section")
      .evaluateAll((nodes) =>
        nodes.map((n) => {
          const r = n.getBoundingClientRect();
          return { x: r.x, y: r.y };
        }),
      );
    if (mobile)
      expect(questionBoxes[1]!.y).toBeGreaterThan(questionBoxes[0]!.y);
    else
      expect(Math.abs(questionBoxes[0]!.y - questionBoxes[1]!.y)).toBeLessThan(
        2,
      );
    await expect(page.getByLabel("反复问", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "提交并继续", exact: true }),
    ).toBeVisible();
    await page
      .locator(".question-section")
      .first()
      .getByRole("button", { name: "A 轻松", exact: true })
      .click();
    await expect
      .poll(() =>
        page
          .locator(".question-section")
          .first()
          .evaluate((node) => {
            const selected = node.querySelector('[aria-pressed="true"]')!;
            const plain = node.querySelector('[aria-pressed="false"]')!;
            return (
              getComputedStyle(selected).backgroundColor !==
              getComputedStyle(plain).backgroundColor
            );
          }),
      )
      .toBe(true);
    const skip = page
      .locator(".question-section")
      .nth(1)
      .getByRole("button", { name: "跳过本题", exact: true });
    await skip.click();
    await expect(skip).toHaveAttribute("aria-pressed", "true");
    await expect(skip).toHaveClass(/du-btn-primary/);
    await page.getByLabel("消息", { exact: true }).fill("**轻松幽默**");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(
      page
        .locator(".plugin-question[open]")
        .getByText("后续希望优先处理哪一项？", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".plugin-question[open]")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "提交并结束", exact: true }),
    ).toHaveClass(/du-btn-primary/);
    await page.getByRole("button", { name: "提交并结束", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "确认并继续", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("button", { name: "编辑 JSON", exact: true })
        .evaluate((el) => el.nextElementSibling?.textContent),
    ).resolves.toBe("确认并继续");
    await expect(page.locator(".composer.plugin-reply")).toHaveCount(0);
    await expect(page.locator(".message.assistant")).toHaveCount(0);
    await expect(
      page.locator(".plugin-result:not(.plugin-question)[open] .plugin-usage"),
    ).toContainText("缓存率 80.0%");
    const sceneCard = page.locator('.analysis-section[aria-label="场景记录"]');
    await expect(sceneCard).toBeVisible();
    await sceneCard
      .getByRole("button", { name: "重新生成此块", exact: true })
      .click();
    let candidate = page.getByLabel("分块结果对比", { exact: true });
    await expect(candidate).toContainText("缓存率 80.0%");
    await expect(candidate).toContainText("这是一条重新整理的已有状态。");
    await candidate
      .getByRole("button", { name: "确认替换此块", exact: true })
      .click();
    await expect(sceneCard).toContainText("这是一条重新整理的已有状态。");
    await page
      .locator('.analysis-section[aria-label="动作记录"]')
      .getByRole("button", { name: "重新生成此块", exact: true })
      .click();
    await expect(candidate).toContainText("这是一条重新整理的已有状态。");
    await page.reload();
    await expect(
      page.getByRole("button", { name: "新增类型", exact: true }),
    ).toBeVisible();
    await expect(candidate).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).pluginLedger)).toEqual([]);
    await page.getByLabel("消息", { exact: true }).fill("保留主聊天草稿");
    await sceneCard
      .getByRole("button", { name: "附要求修改", exact: true })
      .click();
    await expect(page.getByLabel("消息", { exact: true })).toHaveAttribute(
      "placeholder",
      /修改「场景记录」/,
    );
    await page.getByLabel("消息", { exact: true }).fill("只强调已经存在的门");
    await page.getByRole("button", { name: "取消操作", exact: true }).click();
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue(
      "保留主聊天草稿",
    );
    await page.getByRole("button", { name: "新增类型", exact: true }).click();
    await page
      .getByLabel("消息", { exact: true })
      .fill("增加服装状态，关注角色甲的外套");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(candidate).toContainText("增加服装状态，关注角色甲的外套");
    await candidate.getByRole("checkbox").check();
    await expect(
      candidate.getByLabel("保存类型通用规则", { exact: true }),
    ).toHaveValue("只记录历史已经明确的服装状态");
    await candidate
      .getByRole("button", { name: "确认替换并添加", exact: true })
      .click();
    await expect(
      page.locator('.analysis-section[aria-label="服装状态"]'),
    ).toBeVisible();
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue(
      "保留主聊天草稿",
    );
    await expect(
      page.getByLabel("添加已保存类型", { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("添加已保存类型", { exact: true })
      .selectOption({ label: "服装状态" });
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue(
      /通用规则：只记录历史已经明确的服装状态/,
    );
    await page.getByRole("button", { name: "取消操作", exact: true }).click();
    await sceneCard.getByRole("button", { name: "编辑", exact: true }).click();
    await sceneCard
      .getByLabel("编辑分块正文", { exact: true })
      .fill("手动编辑的场景记录");
    await sceneCard
      .getByRole("button", { name: "保存此块", exact: true })
      .click();
    await expect(sceneCard).toContainText("手动编辑的场景记录");
    await page.reload();
    await expect(
      page.getByRole("button", { name: "确认并继续", exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => (window as any).pluginLedger)).toEqual([]);
    await page
      .getByRole("button", { name: "全部重新生成", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "确认并继续", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "确认替换结果", exact: true })
      .click();
    await expect(
      page.locator('.analysis-section[aria-label="服装状态"]'),
    ).toHaveCount(0);
    await expect(sceneCard).not.toContainText("手动编辑的场景记录");
    await expect(page.locator(".message.assistant")).toHaveCount(0);
    await page.getByRole("button", { name: "确认并继续", exact: true }).click();
    await expect(page.locator(".message.assistant .markdown")).toContainText(
      "主回答已结合",
    );
    await expect(
      page.locator(".message.assistant .message-meta").first(),
    ).toContainText("缓存率 85.8%");
    await expect(
      page.locator(".message.assistant .message-meta").first(),
    ).toContainText("输入 1.5k");
    await expect(
      page.locator(".message.assistant .message-meta").first(),
    ).toContainText("输出 424");
    await expect(
      page.getByRole("button", { name: "再给我一个例子", exact: false }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.locator(".plugin-suggestions .plugin-usage"),
    ).toContainText("缓存率 22%");
    await expect(page.locator(".plugin-answer .markdown strong")).toHaveText(
      "轻松幽默",
    );
    await expect(page.locator(".plugin-question[open]")).toHaveCount(0);
    await page
      .getByRole("button", { name: "追问建议上下文", exact: true })
      .click();
    await page
      .getByRole("button", { name: "选择插件上下文消息", exact: true })
      .click();
    const typedMenu = page.getByRole("list", {
      name: "上下文消息类型",
      exact: true,
    });
    for (const role of ["user", "assistant"])
      await expect(
        typedMenu.locator(".plugin-role-" + role).first(),
      ).toBeVisible();
    const colors = await typedMenu
      .locator(".plugin-role")
      .evaluateAll((badges) => [
        ...new Set(badges.map((b) => getComputedStyle(b).color)),
      ]);
    expect(colors).toHaveLength(2);
    await page.screenshot({
      path: `test-results/plugin-message-types-${mobile ? "phone" : "desktop"}-${test.info().project.name}.png`,
    });
    await typedMenu.getByRole("button").last().click();
    await expect(page.locator(".plugin-context-text")).toContainText(
      "主回答已结合",
    );
    await page
      .getByRole("button", { name: "关闭插件窗口", exact: true })
      .click();
    expect(
      await page.evaluate(() =>
        (window as any).pluginLedger.map((x: any) => x.kind),
      ),
    ).toEqual(["analysis", "main", "suggest"]);
    const analysisCall = await page.evaluate(() =>
      (window as any).pluginLedger.find((l: any) => l.kind === "analysis"),
    );
    expect(
      analysisCall.messages.filter((m: any) => m.role === "tool"),
    ).toHaveLength(1);
    expect(JSON.stringify(analysisCall.messages)).toContain("轻松幽默");
    expect(JSON.stringify(analysisCall.messages)).toContain("哪种风格");
    expect(JSON.stringify(analysisCall.messages)).not.toContain(
      "后续希望优先处理哪一项？",
    );
    const transmitted = analysisCall.messages.filter(
      (m: any) => m.role === "tool",
    );
    expect(JSON.stringify(transmitted)).not.toContain('"options"');

    await expect(page.locator(".plugin-chips")).not.toContainText("预计");
    for (const value of await page.locator(".plugin-chip b").allTextContents())
      expect(value).toMatch(/^(?:\d+|\d+\.\dk|待回复)$/);
    await page.getByLabel("消息", { exact: true }).fill("保留的旧草稿");
    await page
      .getByRole("button", { name: "再给我一个例子", exact: false })
      .click();
    await expect(
      page.getByRole("dialog", { name: "替换当前草稿", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue(
      "保留的旧草稿",
    );
    const rewriteButton = page
      .locator(".composer-rewrite-entry")
      .getByRole("button", { name: "重写提示", exact: true });
    await rewriteButton.click();
    await expect(rewriteButton.locator(".du-loading")).toBeVisible();
    await expect(
      page.getByRole("dialog", {
        name: "重写提示 · 对比",
        exact: true,
      }),
    ).toBeVisible({ timeout: 15000 });
    let comparison = page.getByRole("dialog", {
      name: "重写提示 · 对比",
      exact: true,
    });
    await expect(comparison.locator(".plugin-usage")).toContainText(
      "缓存率 22%",
    );
    await expect(comparison.getByRole("radio")).toHaveCount(3);
    await expect(comparison.locator(".rewrite-candidate-text")).toHaveCount(3);
    const columns = await comparison
      .locator(".rewrite-selection")
      .evaluate((el) => {
        const original = el
            .querySelector(".rewrite-original")!
            .getBoundingClientRect(),
          candidates = el
            .querySelector(".rewrite-candidates")!
            .getBoundingClientRect();
        return {
          side: original.right <= candidates.left,
          stack: original.bottom <= candidates.top,
        };
      });
    expect(mobile ? columns.stack : columns.side).toBe(true);
    await expect(
      comparison.getByRole("button", { name: "确认替换", exact: true }),
    ).toBeDisabled();
    await comparison
      .getByRole("radio", { name: "候选 1", exact: true })
      .check();
    const choiceGeometry = await comparison
      .locator(".rewrite-candidate")
      .first()
      .evaluate((el) => {
        const radio = el.querySelector("input")!,
          text = el.querySelector(".rewrite-candidate-heading span")!;
        const r = radio.getBoundingClientRect(),
          t = text.getBoundingClientRect();
        return {
          horizontal: r.right <= t.left,
          aligned: Math.abs(r.top - t.top) < 5,
          round:
            parseFloat(getComputedStyle(radio).borderRadius) >= r.width / 2,
        };
      });
    expect(choiceGeometry.horizontal).toBe(true);
    expect(choiceGeometry.aligned).toBe(true);
    expect(choiceGeometry.round).toBe(true);
    await page.screenshot({
      path: `test-results/rewrite-choice-${mobile ? "phone" : "desktop"}.png`,
    });
    await expect(
      comparison.locator(
        ".rewrite-candidate:has(input:checked) .rewrite-candidate-text",
      ),
    ).toHaveText("请保留旧草稿");
    const regenerate = comparison.getByRole("button", {
      name: "重新生成结果",
      exact: true,
    });
    await regenerate.click();
    await expect(regenerate.locator(".du-loading")).toBeVisible();
    await expect(comparison.getByRole("radio", { checked: true })).toHaveCount(
      0,
    );
    await expect(
      comparison.getByRole("button", { name: "确认替换", exact: true }),
    ).toBeDisabled();
    await comparison
      .getByRole("radio", { name: "候选 1", exact: true })
      .check();
    await expect(
      comparison.locator(
        ".rewrite-candidate:has(input:checked) .rewrite-candidate-text",
      ),
    ).toHaveText("保留旧草稿");
    await comparison
      .getByRole("radio", { name: "候选 2", exact: true })
      .check();
    await expect(comparison.getByRole("radio", { checked: true })).toHaveCount(
      1,
    );
    await expect(
      comparison.locator(
        ".rewrite-candidate:has(input:checked) .rewrite-candidate-text",
      ),
    ).toHaveText("我原来的草稿保留");
    await page.getByRole("button", { name: "确认替换", exact: true }).click();
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue(
      "我原来的草稿保留",
    );
    const result = await page.evaluate(async (id) => {
      const r = await fetch("/api/chats/" + id);
      return r.json() as Promise<any>;
    }, id);
    expect(Object.values(result.chat.messages)).toHaveLength(2);
    expect(
      result.pluginState.runs.filter(
        (r: any) => r.status === "answered" && r.answer?.trim(),
      ),
    ).toHaveLength(2);
    expect(
      Object.values(result.chat.messages)
        .map((m: any) => m.content)
        .join("\n"),
    ).not.toContain("轻松幽默");
    expect(
      result.chat.messages[result.chat.currentId].toolContext.messages.filter(
        (m: any) => m.role === "tool",
      ),
    ).toHaveLength(2);
    const cleanExport = await page.evaluate(
      async (id) => await (await fetch("/api/chats/" + id + "/export")).json(),
      id,
    );
    expect(JSON.stringify(cleanExport)).not.toMatch(/轻松幽默|toolContext/);
    const cachedBar = page
      .locator(
        ".message.assistant > .message-body > .message-meta .usage-cached",
      )
      .first();
    await expect(cachedBar).toHaveAttribute("data-tokens", "1287");
    expect(await cachedBar.evaluate((el) => getComputedStyle(el).color)).toBe(
      "rgb(147, 197, 253)",
    );
    const originalUser = page.locator(".message.user").first();
    await originalUser
      .getByRole("button", { name: "编辑消息", exact: true })
      .click();
    await page.getByLabel("编辑消息正文", { exact: true }).fill("请保留旧草稿");
    await page.getByRole("button", { name: "全屏编辑", exact: true }).click();
    const messageEditor = page.getByRole("dialog", {
      name: "全屏编辑消息",
      exact: true,
    });
    await messageEditor
      .getByRole("button", { name: "重写提示", exact: true })
      .click();
    await expect(messageEditor.locator(".du-loading")).toBeVisible();
    await expect(comparison).toBeVisible();
    await expect(
      comparison.getByLabel("原用户请求", { exact: true }),
    ).toHaveValue("请保留旧草稿");
    await comparison
      .getByRole("radio", { name: "候选 1", exact: true })
      .check();
    await expect(
      comparison.locator(
        ".rewrite-candidate:has(input:checked) .rewrite-candidate-text",
      ),
    ).toHaveText("保留旧草稿");
    const editedCall = await page.evaluate(() =>
      (window as any).pluginLedger.at(-1),
    );
    expect(editedCall.messages.map((m: any) => m.role)).toEqual(["user"]);
    expect(editedCall.messages.at(-1).content).toContain("请保留旧草稿");
    expect(editedCall.messages.at(-1).content).toMatch(/^好的/);
    expect(JSON.stringify(editedCall.messages)).not.toContain("主回答已结合");
    await comparison
      .getByRole("button", { name: "确认替换", exact: true })
      .click();
    await expect(
      messageEditor.getByLabel("编辑消息正文", { exact: true }),
    ).toHaveValue("保留旧草稿");
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue(
      "我原来的草稿保留",
    );
    await messageEditor
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await expect(
      originalUser.locator(".message-body > .markdown"),
    ).toContainText("写一个短故事");
    await page.evaluate(() => {
      (window as any).failRewriteOnce = true;
    });
    await rewriteButton.click();
    const fallback = page
      .locator(".plugin-flow-controls[role=alert]")
      .getByRole("button", { name: "切换备用模型", exact: true });
    await expect(fallback).toBeVisible();
    await fallback.click();
    await page
      .getByLabel("本次备用模型", { exact: true })
      .selectOption({ label: "FX/plugin-spare · 插件合成接口" });
    await expect(comparison).toBeVisible();
    await expect(comparison.locator(".plugin-usage")).toContainText(
      "plugin-spare",
    );
    expect(
      await page.evaluate(() => (window as any).pluginLedger.at(-1).model),
    ).toBe("plugin-spare");
    await comparison.getByRole("button", { name: "取消", exact: true }).click();
    await page
      .locator(".message.assistant")
      .getByRole("button", { name: "删除消息", exact: true })
      .click();
    let deletion = page.getByRole("dialog", { name: "删除消息", exact: true });
    await deletion.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.locator(".message.assistant")).toHaveCount(1);
    await originalUser
      .getByRole("button", { name: "删除消息", exact: true })
      .click();
    await expect(deletion).toContainText("下一层的 1 条消息");
    await deletion.getByRole("button", { name: "删除", exact: true }).click();
    await expect(page.locator(".message")).toHaveCount(0);
    const afterDelete = await page.evaluate(
      async (id) =>
        (await (await fetch("/api/chats/" + id)).json()) as Promise<any>,
      id,
    );
    expect(afterDelete.pluginState.runs).toHaveLength(0);
    expect(afterDelete.chat.draft).toBe("我原来的草稿保留");
    if (mobile)
      await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.getByRole("button", { name: "新建分组", exact: true }).click();
    await page.getByLabel("分组名称", { exact: true }).fill("插件测试组");
    await page.getByRole("button", { name: "确认", exact: true }).click();
    await page
      .locator(".chat-row.selected")
      .getByRole("button", { name: "管理 四插件实际界面测试", exact: true })
      .click();
    await page.getByRole("button", { name: "移进分组", exact: true }).click();
    await page
      .getByRole("dialog", { name: "移进分组", exact: true })
      .getByRole("button", { name: "插件测试组", exact: true })
      .first()
      .click();
    await page
      .locator(".chat-row.selected")
      .getByRole("button", { name: "管理 四插件实际界面测试", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "移出分组", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "移出分组", exact: true }).click();
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
