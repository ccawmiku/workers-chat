import type { SettingsBackup } from "../src/shared/backup";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Miniflare, Response as MFResponse } from "miniflare";
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes, pbkdf2Sync } from "node:crypto";
import type { SummaryState, PostJobView } from "../src/shared/summaries";
import { summaryFor } from "../src/shared/summaries";
import type { Chat, Settings, Provider } from "../src/shared/chat";
import {
  defaultPlugins,
  pluginDefaults,
  type PluginState,
  type PluginJobView,
} from "../src/shared/plugins";
const fixturePassword = randomBytes(18).toString("hex"),
  fixtureRecovery = randomBytes(24).toString("hex");
const hash = (s: string) => {
  const salt = randomBytes(16).toString("hex");
  return `pbkdf2:100000:${salt}:${pbkdf2Sync(s, Buffer.from(salt, "hex"), 100000, 32, "sha256").toString("hex")}`;
};
let mf: Miniflare,
  cookie = "",
  provider: Provider,
  settings: Settings;
const summaryCalls: Record<string, unknown>[] = [];
const summaryControls = { delay: 0, output: "", active: 0, maxActive: 0 };
const titleCalls: Record<string, unknown>[] = [];
const upstreamCalls: Record<string, unknown>[] = [],
  controls = { mode: "normal", delay: 0, titleMode: "normal", titleDelay: 0 };
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  useCookie = true,
  origin = "https://chat.test",
  device = false,
) {
  return mf.dispatchFetch("https://chat.test/api" + path, {
    method,
    headers: {
      ...(device ? { "X-Chat-Transport": "device" } : {}),
      ...(useCookie ? { Cookie: cookie } : {}),
      ...(method !== "GET"
        ? { "Content-Type": "application/json", Origin: origin }
        : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function value<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const r = await request(path, method, body);
  const v = await r.json();
  expect(r.status, JSON.stringify(v)).toBeLessThan(400);
  return v as T;
}
async function finished(id: string, timeout = 10000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await value<{
      chat: Chat;
      job: unknown;
      titleJob?: { status: string };
      postJobs?: unknown[];
    }>("/chats/" + id);
    if (
      !result.job &&
      !result.postJobs?.length &&
      !["pending", "running"].includes(result.titleJob?.status ?? "")
    )
      return result.chat;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("job did not complete");
}
type SummarySnapshot = {
  chat: Chat;
  job: unknown;
  pluginJob: PluginJobView | null;
  pluginState: PluginState;
  summaryState: SummaryState;
  postJobs: PostJobView[];
};
async function waitSummary(
  id: string,
  predicate: (s: SummarySnapshot) => boolean,
  timeout = 10000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const s = await value<SummarySnapshot>("/chats/" + id);
    if (predicate(s)) return s;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw Error("summary transition timeout");
}
beforeAll(async () => {
  const built = await build({
    entryPoints: ["src/server/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:*"],
    write: false,
  });
  mf = new Miniflare({
    logRequests: false,
    workers: [
      {
        config: {
          name: "workers-chat",
          compatibilityDate: "2026-10-15",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": { type: "esm", contents: built.outputFiles[0]!.text },
            },
          },
          env: {
            DB: { type: "d1", name: "test-db" },
            PROGRESS: {
              type: "durable-object",
              worker: "workers-chat",
              exportName: "Progress",
            },
            TITLES: {
              type: "workflow",
              name: "test-titles",
              worker: "workers-chat",
              exportName: "TitleGeneration",
            },
            GENERATION: {
              type: "workflow",
              name: "test-generation",
              worker: "workers-chat",
              exportName: "Generation",
            },
            PASSWORD_HASH: { type: "text", value: hash(fixturePassword) },
            RECOVERY_HASH: { type: "text", value: hash(fixtureRecovery) },
            ENCRYPTION_KEY: {
              type: "text",
              value: randomBytes(32).toString("hex"),
            },
            CF_ANALYTICS_TOKEN: {
              type: "text",
              value: "synthetic-analytics-token",
            },
            CF_ANALYTICS_ACCOUNT_ID: { type: "text", value: "1".repeat(32) },
          },
          exports: {
            TitleGeneration: { type: "workflow", name: "test-titles" },
            Progress: { type: "durable-object", storage: "sqlite" },
            Generation: { type: "workflow", name: "test-generation" },
          },
        },
        dev: {
          outboundService: {
            type: "fetcher",
            handler: async (req) => {
              const url = new URL(req.url);
              if (
                url.hostname === "api.cloudflare.com" &&
                url.pathname === "/client/v4/graphql"
              )
                return MFResponse.json({
                  data: {
                    viewer: {
                      accounts: [
                        {
                          workers: [
                            { sum: { requests: 1000, cpuTimeUs: 5000 } },
                          ],
                          doRequests: [{ sum: { requests: 500 } }],
                          doUsage: [
                            {
                              sum: {
                                duration: 14620.54,
                                rowsRead: 1000,
                                rowsWritten: 200,
                              },
                            },
                          ],
                          d1: [{ sum: { rowsRead: 10000, rowsWritten: 100 } }],
                          workflows: [{ sum: { stepCount: 20, cpuTime: 10 } }],
                          workflowStarts: [{ count: 10 }],
                          d1Storage: [{ max: { databaseSizeBytes: 1000 } }],
                          doStorage: [{ max: { storedBytes: 2000 } }],
                        },
                      ],
                    },
                  },
                });
              if (url.pathname.endsWith("/models"))
                return MFResponse.json({
                  data: [{ id: "Gemini3.8flash-low" }, { id: "other" }],
                });
              const payload = (await req.json()) as Record<string, unknown>;
              const messages = payload.messages as {
                role: string;
                content: string;
              }[];
              if (messages[0]?.content?.includes("<chat_history>")) {
                titleCalls.push(payload);
                const titleMode = controls.titleMode,
                  titleDelay = controls.titleDelay;
                if (titleDelay)
                  await new Promise((r) => setTimeout(r, titleDelay));
                if (
                  titleMode === "reject-all" ||
                  (titleMode === "fail-primary" && payload.model === "other")
                )
                  return MFResponse.json(
                    { error: { message: "title fixture rejected" } },
                    { status: 400 },
                  );
                return MFResponse.json({
                  choices: [
                    {
                      message: {
                        content: JSON.stringify({ title: "模型生成的标题" }),
                      },
                    },
                  ],
                });
              }
              if (
                messages.some((m) =>
                  m.content?.includes("本轮回复提炼为 100–150 字"),
                )
              ) {
                summaryCalls.push(payload);
                const delay = summaryControls.delay,
                  output =
                    summaryControls.output ||
                    JSON.stringify({
                      summary:
                        "你与同行者确认了目前的目标和行动安排，双方交换已有信息，保留尚未确定的分歧，准备依据后续沟通继续处理当前事务。",
                    });
                summaryControls.active++;
                summaryControls.maxActive = Math.max(
                  summaryControls.maxActive,
                  summaryControls.active,
                );
                if (delay) await new Promise((r) => setTimeout(r, delay));
                summaryControls.active--;
                const usage = {
                  input_tokens: 18929,
                  output_tokens: 100,
                  cached_tokens: 16247,
                  cache_hit_rate: "85.8%",
                };
                if (!payload.stream)
                  return MFResponse.json({
                    choices: [
                      { message: { content: output }, finish_reason: "stop" },
                    ],
                    usage,
                  });
                return new MFResponse(
                  "data: " +
                    JSON.stringify({
                      choices: [
                        { delta: { content: output }, finish_reason: "stop" },
                      ],
                      usage,
                    }) +
                    "\n\ndata: [DONE]\n\n",
                  { headers: { "Content-Type": "text/event-stream" } },
                );
              }
              upstreamCalls.push(payload);
              let partialTask: any;
              try {
                partialTask = JSON.parse(messages.at(-1)?.content ?? "");
              } catch {}
              if (partialTask?.output_contract) {
                const content =
                  controls.mode === "plugin-invalid"
                    ? "invalid JSON"
                    : JSON.stringify({
                        type: partialTask.target?.type ?? "服装状态",
                        content:
                          partialTask.user_requirement || "重新生成的客观记录",
                        instruction: "仅记录已有服装状态，无资料用 none",
                      });
                const usage = {
                  input_tokens: 1500,
                  output_tokens: 100,
                  cache_hit_rate: "81.2%",
                };
                return payload.stream
                  ? new MFResponse(
                      "data: " +
                        JSON.stringify({
                          choices: [
                            { delta: { content }, finish_reason: "stop" },
                          ],
                          usage,
                        }) +
                        "\n\ndata: [DONE]\n\n",
                      { headers: { "Content-Type": "text/event-stream" } },
                    )
                  : MFResponse.json({
                      choices: [
                        { message: { content }, finish_reason: "stop" },
                      ],
                      usage,
                    });
              }
              const pluginMarker =
                messages.find((m) => m.content?.startsWith("[PLUGIN_TEST_"))
                  ?.content ?? "";
              if (pluginMarker) {
                if (controls.mode === "plugin-http-error")
                  return MFResponse.json(
                    { error: { message: "plugin fixture rejection" } },
                    { status: 400 },
                  );
                const content =
                  controls.mode === "plugin-invalid"
                    ? "invalid JSON"
                    : pluginMarker.startsWith("[PLUGIN_TEST_analysis]")
                      ? !messages
                          .at(-1)
                          ?.content?.split("JSON Schema：")[1]
                          ?.includes('"ABC"')
                        ? JSON.stringify({
                            character_thoughts: [
                              {
                                character: "甲",
                                thought: "我还不知道门外是谁。",
                              },
                            ],
                            scene_state: "茶室内，门关闭。",
                            action_state: "甲已经放下茶杯。",
                            knowledge_boundaries: "甲不知道门外人的身份。",
                          })
                        : '{"ABC":"analysis-result"}'
                      : pluginMarker.startsWith("[PLUGIN_TEST_suggest]")
                        ? '{"suggestions":["用户下一句一","用户下一句二","用户下一句三"]}'
                        : pluginMarker.startsWith("[PLUGIN_TEST_rewrite]")
                          ? '{"prompt1":"重生后的用户要求","prompt2":"换个说法的要求","prompt3":"另一条用户要求"}'
                          : JSON.stringify({
                              questions:
                                controls.mode === "clarify-loop" &&
                                messages.some((m) => m.role === "tool")
                                  ? []
                                  : [
                                      {
                                        id: "q1",
                                        question: "请问你希望采用什么风格？",
                                        multiple: false,
                                        options: [
                                          { id: "A", text: "轻松" },
                                          { id: "B", text: "正式" },
                                          { id: "C", text: "其他" },
                                        ],
                                      },
                                    ],
                            });
                if (!payload.stream)
                  return MFResponse.json({
                    choices: [{ message: { content }, finish_reason: "stop" }],
                    usage: {
                      input_tokens: 1500,
                      output_tokens: 424,
                      cache_hit_rate: "80%",
                    },
                  });
                if (controls.mode === "plugin-slow") {
                  const delay = controls.delay,
                    encode = new TextEncoder();
                  let cancelled = false;
                  return new MFResponse(
                    new ReadableStream({
                      async start(controller) {
                        controller.enqueue(
                          encode.encode(
                            "data: " +
                              JSON.stringify({
                                choices: [
                                  { delta: { content: content.slice(0, 5) } },
                                ],
                              }) +
                              "\n\n",
                          ),
                        );
                        await new Promise((r) => setTimeout(r, delay));
                        if (cancelled) return;
                        controller.enqueue(
                          encode.encode(
                            "data: " +
                              JSON.stringify({
                                choices: [
                                  {
                                    delta: { content: content.slice(5) },
                                    finish_reason: "stop",
                                  },
                                ],
                              }) +
                              "\n\ndata: [DONE]\n\n",
                          ),
                        );
                        controller.close();
                      },
                      cancel() {
                        cancelled = true;
                      },
                    }),
                    { headers: { "Content-Type": "text/event-stream" } },
                  );
                }
                return new MFResponse(
                  "data: " +
                    JSON.stringify({
                      choices: [{ delta: { content }, finish_reason: "stop" }],
                      usage: {
                        input_tokens: 500,
                        cached_tokens: 400,
                        cache_hit_rate: "80%",
                      },
                    }) +
                    "\n\ndata: [DONE]\n\n",
                  { headers: { "Content-Type": "text/event-stream" } },
                );
              }
              const mode = controls.mode,
                delay = controls.delay;
              if (mode === "reject")
                return MFResponse.json(
                  {
                    error: { message: "reasoning_effort max is not supported" },
                  },
                  { status: 400 },
                );
              if (mode === "nonstream-hang")
                return new MFResponse(
                  new ReadableStream({
                    start(controller) {
                      controller.enqueue(
                        new TextEncoder().encode('{"choices":['),
                      );
                    },
                  }),
                  { headers: { "Content-Type": "application/json" } },
                );
              if (!payload.stream)
                return MFResponse.json({
                  choices: [
                    {
                      message: {
                        content: "非流式回答",
                        ...(mode === "nonstream-reasoning"
                          ? { reasoning: "独立思考" }
                          : {}),
                      },
                    },
                  ],
                  usage: {
                    prompt_tokens: 4,
                    completion_tokens: 5,
                    total_tokens: 9,
                  },
                });
              const encode = new TextEncoder();
              if (mode === "split-crlf" || mode === "done-open") {
                const events =
                  'data: {"choices":[{"delta":{"content":"跨块🙂"},"finish_reason":"stop"}]}\r\n\r\n' +
                  'data: {"choices":[],"usage":{"total_tokens":7}}\r\n\r\n' +
                  "data: [DONE]\r\n\r\n";
                const bytes = encode.encode(events);
                return new MFResponse(
                  new ReadableStream({
                    start(controller) {
                      for (let i = 0; i < bytes.length; i++)
                        controller.enqueue(bytes.slice(i, i + 1));
                      if (mode !== "done-open") controller.close();
                    },
                  }),
                  { headers: { "Content-Type": "text/event-stream" } },
                );
              }
              let cancelled = false;
              return new MFResponse(
                new ReadableStream({
                  async start(controller) {
                    controller.enqueue(
                      encode.encode(
                        "data: " +
                          JSON.stringify({
                            choices: [
                              {
                                delta: {
                                  content: "第一部分",
                                  reasoning_content: "上游独立思考",
                                },
                              },
                            ],
                          }) +
                          "\n\n",
                      ),
                    );
                    if (delay) await new Promise((r) => setTimeout(r, delay));
                    if (cancelled) return;
                    controller.enqueue(
                      encode.encode(
                        mode === "partial"
                          ? ""
                          : "data: " +
                              JSON.stringify({
                                choices: [
                                  {
                                    delta: { content: "，完成" },
                                    finish_reason: "stop",
                                  },
                                ],
                                usage: { total_tokens: 9 },
                              }) +
                              "\n\ndata: [DONE]\n\n",
                      ),
                    );
                    controller.close();
                  },
                  cancel() {
                    cancelled = true;
                  },
                }),
                { headers: { "Content-Type": "text/event-stream" } },
              );
            },
          },
        },
      },
    ],
  });
  const db = await mf.getD1Database("DB");
  for (const name of (await readdir("migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    for (const sql of (await readFile("migrations/" + name, "utf8"))
      .trim()
      .split("\n"))
      await db.prepare(sql).run();
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
describe("workerd HTTP + D1 + Workflows", () => {
  it("requires authentication and same-origin mutations, hashes sessions, and never lists API keys", async () => {
    expect((await request("/chats", "GET", undefined, false)).status).toBe(401);
    expect(
      (
        await request(
          "/auth/login",
          "POST",
          { password: fixturePassword },
          false,
          "https://evil.test",
        )
      ).status,
    ).toBe(403);
    const login = await request(
      "/auth/login",
      "POST",
      { password: fixturePassword },
      false,
    );
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    expect(login.headers.get("set-cookie")).toContain("Secure");
    provider = await value<Provider>("/providers", "POST", {
      name: "Fixture",
      baseUrl: "https://upstream.test/v1",
      prefix: "P/",
      apiKey: "synthetic-fixture-key",
    });
    expect(provider.models.every((m) => !m.enabled)).toBe(true);
    expect(JSON.stringify(provider)).not.toMatch(
      /synthetic-fixture-key|encryptedKey/,
    );
    for (const emptyKey of ["", 1])
      expect(
        (
          await request("/providers", "POST", {
            id: provider.id,
            name: provider.name,
            baseUrl: "https://different.test/v1",
            apiKey: emptyKey,
          })
        ).status,
      ).toBe(400);
    expect((await value<Provider[]>("/providers"))[0]!.baseUrl).toBe(
      "https://upstream.test/v1",
    );
    settings = await value<Settings>("/settings");
    settings.defaultModel = {
      providerId: provider.id,
      modelId: "Gemini3.8flash-low",
    };
    await value("/settings", "PUT", settings);
    expect(
      (
        await request("/providers/" + provider.id + "/key", "POST", {
          password: "wrong",
        })
      ).status,
    ).toBe(401);
    expect(
      await value("/providers/" + provider.id + "/key", "POST", {
        password: fixturePassword,
      }),
    ).toEqual({ apiKey: "synthetic-fixture-key" });
    const sessions = await value<{ id: string }[]>("/auth/sessions");
    expect(sessions[0]!.id).not.toBe(cookie.replace("session=", ""));
  });
  it("saves provider metadata offline, preserves models and keys, and keeps device save separate from fetching", async () => {
    const models = provider.models;
    const saved = await value<Provider>("/providers", "POST", {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      prefix: provider.prefix,
      refreshModels: false,
    });
    expect(saved.models).toEqual(models);
    expect(
      await value("/providers/" + provider.id + "/key", "POST", {
        password: fixturePassword,
      }),
    ).toEqual({ apiKey: "synthetic-fixture-key" });
    const changed = await request("/providers", "POST", {
      id: provider.id,
      name: provider.name,
      baseUrl: "https://different.test/v1",
      refreshModels: false,
    });
    expect(changed.status).toBe(400);
    const offline = await request(
      "/providers",
      "POST",
      {
        name: "Offline",
        baseUrl: "https://never-contact.invalid/v1",
        refreshModels: false,
      },
      true,
      "https://chat.test",
      true,
    );
    expect(offline.status).toBe(200);
    const p = (await offline.json()) as Provider;
    expect(p.models).toEqual([]);
    const moved = await value<Provider>("/providers", "POST", {
      id: p.id,
      name: "Offline",
      baseUrl: "https://another-offline.invalid/v1",
      refreshModels: false,
    });
    expect(moved.baseUrl).toBe("https://another-offline.invalid/v1");
    await value("/providers/" + p.id, "DELETE", {});
  });
  it("refreshes and configures ten thousand models without losing identity, settings or keys", async () => {
    const longId = "valid-long-model-" + "x".repeat(983);
    expect(longId).toHaveLength(1000);
    const ids = [
      ...Array.from({ length: 9999 }, (_, i) => "model-" + i),
      longId,
    ];
    const metadata = {
      name: "Large synthetic provider",
      baseUrl: "https://never-contact.invalid/v1",
      prefix: "Large/",
    };
    const before = upstreamCalls.length;
    const saved = await request(
      "/providers",
      "POST",
      {
        ...metadata,
        models: ids.map((id) => ({ id })),
        apiKey: "large-provider-fixture-key",
      },
      true,
      "https://chat.test",
      true,
    );
    expect(saved.status).toBe(200);
    const p = (await saved.json()) as Provider;
    const configured = await value<Provider>(
      "/providers/" + p.id + "/models",
      "PUT",
      {
        models: p.models.map((m, i) => ({
          ...m,
          enabled: true,
          capacity: 32000 + i,
          parameters: { temperature: 0.4 },
        })),
      },
    );
    const refreshed = await request(
      "/providers",
      "POST",
      {
        ...metadata,
        id: p.id,
        models: [...ids.slice(1), "new-model"].reverse().map((id) => ({ id })),
      },
      true,
      "https://chat.test",
      true,
    );
    expect(refreshed.status).toBe(200);
    const current = (await refreshed.json()) as Provider;
    expect(current.models).toHaveLength(10000);
    expect(current.models.find((m) => m.id === longId)).toEqual(
      configured.models.at(-1),
    );
    expect(current.models.find((m) => m.id === "new-model")).toMatchObject({
      enabled: false,
      capacity: 1048576,
    });
    expect(
      await value("/providers/" + p.id + "/key", "POST", {
        password: fixturePassword,
      }),
    ).toEqual({ apiKey: "large-provider-fixture-key" });
    const chat = await value<Chat>("/chats", "POST", {});
    await value("/chats/" + chat.id, "PATCH", {
      model: { providerId: p.id, modelId: longId },
    });
    const preview = await value<Record<string, unknown>>(
      "/chats/" + chat.id + "/preview",
      "POST",
      { draft: "Local preview only" },
    );
    expect(preview.model).toBe(longId);
    try {
      await value("/settings", "PUT", {
        ...settings,
        defaultModel: { providerId: p.id, modelId: longId },
      });
      const backup = await value<SettingsBackup>(
        "/settings/export",
        "POST",
        {},
      );
      expect(backup.settings.defaultModel?.modelId).toBe(longId);
      const scoped = {
        ...backup,
        providers: backup.providers.filter((item) => item.id === p.id),
      };
      expect(
        (
          await request("/settings/import", "POST", {
            mode: "merge",
            data: scoped,
          })
        ).status,
      ).toBe(200);
      expect(upstreamCalls).toHaveLength(before);
    } finally {
      await value("/settings", "PUT", settings);
      await value("/providers/" + p.id, "DELETE", {});
    }
  });
  it("removes context-exclusion and subtree-delete endpoints without losing history", async () => {
    const imported = await value<{ ids: string[] }>("/import", "POST", {
      data: [
        {
          chat: {
            title: "context turn fixture",
            history: {
              currentId: "a2",
              messages: {
                u1: {
                  id: "u1",
                  parentId: null,
                  role: "user",
                  content: "first question",
                },
                a1: {
                  id: "a1",
                  parentId: "u1",
                  role: "assistant",
                  content: "first answer",
                },
                av: {
                  id: "av",
                  parentId: "u1",
                  role: "assistant",
                  content: "answer version",
                },
                u2: {
                  id: "u2",
                  parentId: "a1",
                  role: "user",
                  content: "second question",
                },
                a2: {
                  id: "a2",
                  parentId: "u2",
                  role: "assistant",
                  content: "second answer",
                },
              },
            },
          },
        },
      ],
    });
    const id = imported.ids[0]!;
    expect(
      (await request("/chats/" + id + "/exclude", "POST", { messageId: "a1" }))
        .status,
    ).toBe(404);
    const preview = await value<{ messages: { content: string }[] }>(
      "/chats/" + id + "/preview",
      "POST",
      {},
    );
    expect(preview.messages.map((m) => m.content)).toEqual([
      "first question",
      "first answer",
      "second question",
      "second answer",
    ]);
    expect(
      (
        await request("/chats/" + id + "/delete-subtree", "POST", {
          messageId: "u1",
        })
      ).status,
    ).toBe(404);
  });
  it("finishes a single background call, retains request identity, branches retries and extends continuation versions", async () => {
    const chat = await value<Chat>("/chats", "POST", {}),
      count = upstreamCalls.length;
    await value("/chats/" + chat.id + "/draft", "PUT", { draft: "hello" });
    await value("/chats/" + chat.id + "/send", "POST", { content: "hello" });
    const done = await finished(chat.id);
    expect(done.draft).toBe("");
    expect(upstreamCalls).toHaveLength(count + 1);
    expect(upstreamCalls.at(-1)).toMatchObject({
      model: "Gemini3.8flash-low",
    });
    expect(upstreamCalls.at(-1)).not.toHaveProperty("reasoning_effort");
    expect(upstreamCalls.at(-1)).not.toHaveProperty("max_tokens");
    const reply = done.messages[done.currentId!]!;
    expect(reply.content).toBe("第一部分，完成");
    expect(reply.reasoning).toBe("上游独立思考");
    expect(reply.usage).toEqual({ total_tokens: 9 });
    await value("/chats/" + chat.id);
    expect(upstreamCalls).toHaveLength(count + 1);
    await value("/chats/" + chat.id + "/continue", "POST", {
      messageId: reply.id,
    });
    const continued = await finished(chat.id);
    expect(continued.messages[reply.id]?.content).toBe(reply.content);
    expect(continued.messages[continued.currentId!]?.content).toBe(
      reply.content + "第一部分，完成",
    );
    const lastRequest = upstreamCalls.at(-1)!;
    expect(JSON.stringify(lastRequest)).not.toContain("上游独立思考");
    await value("/chats/" + chat.id + "/regenerate", "POST", {
      messageId: reply.id,
    });
    const regenerated = await finished(chat.id);
    expect(
      Object.values(regenerated.messages).filter((m) => m.role === "assistant"),
    ).toHaveLength(3);
    const regeneratedReply = regenerated.messages[regenerated.currentId!]!;
    const repeatedQuestion = regenerated.messages[regeneratedReply.parentId!]!;
    expect(repeatedQuestion.id).not.toBe(reply.parentId);
    expect(repeatedQuestion).toMatchObject({
      role: "user",
      content: "hello",
      parentId: null,
    });
    expect(upstreamCalls.at(-1)!.messages).toEqual([
      { role: "user", content: "hello" },
    ]);
    await value("/chats/" + chat.id + "/select", "POST", {
      messageId: reply.parentId,
    });
    expect(
      (await value<{ chat: Chat }>("/chats/" + chat.id)).chat.currentId,
    ).toBe(continued.currentId);
    await value("/chats/" + chat.id + "/select", "POST", {
      messageId: repeatedQuestion.id,
    });
    expect(
      (await value<{ chat: Chat }>("/chats/" + chat.id)).chat.currentId,
    ).toBe(regenerated.currentId);
  });
  it("regenerates an earlier question as an independent send while retaining ancestors, followups and drafts", async () => {
    const imported = await value<{ ids: string[] }>("/import", "POST", {
      data: [
        {
          chat: {
            title: "regenerate send fixture",
            history: {
              currentId: "laterA",
              messages: {
                p: {
                  id: "p",
                  parentId: null,
                  role: "user",
                  content: "ancestor question",
                },
                pa: {
                  id: "pa",
                  parentId: "p",
                  role: "assistant",
                  content: "ancestor answer",
                },
                u: {
                  id: "u",
                  parentId: "pa",
                  role: "user",
                  content: "repeat this question",
                },
                a: {
                  id: "a",
                  parentId: "u",
                  role: "assistant",
                  content: "original answer",
                },
                laterU: {
                  id: "laterU",
                  parentId: "a",
                  role: "user",
                  content: "old followup",
                },
                laterA: {
                  id: "laterA",
                  parentId: "laterU",
                  role: "assistant",
                  content: "old followup answer",
                },
              },
            },
          },
        },
      ],
    });
    const id = imported.ids[0]!;
    await value("/chats/" + id + "/draft", "PUT", {
      draft: "keep unsent draft",
    });
    const count = upstreamCalls.length;
    await value("/chats/" + id + "/regenerate", "POST", { messageId: "a" });
    const regenerated = await finished(id);
    expect(upstreamCalls).toHaveLength(count + 1);
    expect(upstreamCalls.at(-1)!.messages).toEqual([
      { role: "user", content: "ancestor question" },
      { role: "assistant", content: "ancestor answer" },
      { role: "user", content: "repeat this question" },
    ]);
    const reply = regenerated.messages[regenerated.currentId!]!;
    const question = regenerated.messages[reply.parentId!]!;
    expect(question).toMatchObject({
      role: "user",
      content: "repeat this question",
      parentId: "pa",
    });
    expect(question.id).not.toBe("u");
    expect(question.excluded).not.toBe(true);
    expect(regenerated.messages.a?.content).toBe("original answer");
    expect(regenerated.messages.laterA?.content).toBe("old followup answer");
    expect(regenerated.draft).toBe("keep unsent draft");
    await value("/chats/" + id + "/select", "POST", { messageId: "u" });
    expect((await value<{ chat: Chat }>("/chats/" + id)).chat.currentId).toBe(
      "laterA",
    );
  });
  it("rejects GET mutations and inherited message IDs without changing saved state", async () => {
    const chat = await value<Chat>("/chats", "POST", {});
    await value("/chats/" + chat.id, "PATCH", { unread: true });
    for (const path of [
      "/auth/logout",
      "/chats/" + chat.id + "/seen",
      "/chats/" + chat.id + "/stop",
    ])
      expect((await request(path)).status).toBe(405);
    expect((await value<{ chat: Chat }>("/chats/" + chat.id)).chat.unread).toBe(
      true,
    );
    expect(
      (
        await request("/chats/" + chat.id + "/edit", "POST", {
          messageId: "__proto__",
          content: "invalid",
        })
      ).status,
    ).toBe(404);
    expect(
      (await value<{ chat: Chat }>("/chats/" + chat.id)).chat.messages,
    ).toEqual({});
  });
  it("rejects oversized import batches before writing and isolates bad entries", async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      title: "Atomic import " + i,
      messages: [{ id: "u", role: "user", content: "fixture", parentId: null }],
    }));
    const before = (await value<Chat[]>("/chats")).length;
    expect((await request("/import", "POST", { data: rows })).status).toBe(413);
    expect((await value<Chat[]>("/chats")).length).toBe(before);
    const result = await value<{ ids: string[]; failures: unknown[] }>(
      "/import",
      "POST",
      { data: [rows[0], { invalid: true }, rows[1]] },
    );
    expect(result.ids).toHaveLength(2);
    expect(result.failures).toHaveLength(1);
  });
  it("reports a missing default model as a configuration error and keeps request previews read-only", async () => {
    const chat = await value<Chat>("/chats", "POST", {}),
      before = upstreamCalls.length;
    await value("/chats/" + chat.id, "PATCH", { model: null });
    await value("/chats/" + chat.id + "/draft", "PUT", {
      draft: "saved draft",
    });
    await value("/settings", "PUT", { ...settings, defaultModel: null });
    try {
      for (const path of ["send", "preview"]) {
        const response = await request(
          "/chats/" + chat.id + "/" + path,
          "POST",
          { content: "do not send", draft: "local preview" },
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: expect.stringContaining("默认模型"),
        });
      }
      expect(upstreamCalls.length).toBe(before);
    } finally {
      await value("/settings", "PUT", settings);
    }
    const preview = await value<{ messages: { content: string }[] }>(
      "/chats/" + chat.id + "/preview",
      "POST",
      { draft: "local preview" },
    );
    expect(preview.messages.at(-1)?.content).toBe("local preview");
    expect((await value<{ chat: Chat }>("/chats/" + chat.id)).chat.draft).toBe(
      "saved draft",
    );
  });
  it("parses CRLF and UTF-8 split across chunks, retaining usage before DONE on an open connection", async () => {
    try {
      for (const mode of ["split-crlf", "done-open"]) {
        controls.mode = mode;
        const chat = await value<Chat>("/chats", "POST", {});
        await value("/chats/" + chat.id, "PATCH", {
          title: "Manual SSE fixture",
        });
        await value("/chats/" + chat.id + "/send", "POST", {
          content: "SSE fixture",
        });
        const done = await finished(chat.id, 5000);
        expect(done.messages[done.currentId!]).toMatchObject({
          status: "complete",
          content: "跨块🙂",
          usage: { total_tokens: 7 },
        });
      }
    } finally {
      controls.mode = "normal";
    }
  });
  it("aborts a pending non-streaming response and saves stopped rather than error", async () => {
    controls.mode = "nonstream-hang";
    const calls = upstreamCalls.length;
    const chat = await value<Chat>("/chats", "POST", {});
    try {
      await value("/chats/" + chat.id, "PATCH", { stream: false });
      const started = await value<{ jobId: string }>(
        "/chats/" + chat.id + "/send",
        "POST",
        { content: "cancel nonstream" },
      );
      const until = Date.now() + 3000;
      while (upstreamCalls.length === calls && Date.now() < until)
        await new Promise((r) => setTimeout(r, 20));
      expect(upstreamCalls.length).toBe(calls + 1);
      await value("/chats/" + chat.id + "/stop", "POST", {});
      expect((await finished(chat.id)).messages).toMatchObject({
        [(await value<{ chat: Chat }>("/chats/" + chat.id)).chat.currentId!]: {
          status: "stopped",
        },
      });
      const bindings = await mf.getBindings<Env>();
      const coordinator = bindings.PROGRESS.getByName(started.jobId);
      await expect
        .poll(() => coordinator.isRunning(), { timeout: 3000 })
        .toBe(false);
    } finally {
      controls.mode = "normal";
    }
  });
  it("keeps explicit upstream errors and partial output without retrying or downgrading parameters", async () => {
    const chat = await value<Chat>("/chats", "POST", {});
    controls.mode = "reject";
    const count = upstreamCalls.length;
    await value("/chats/" + chat.id + "/send", "POST", {
      content: "error please",
    });
    const failed = await finished(chat.id);
    expect(failed.messages[failed.currentId!]?.error).toContain(
      "reasoning_effort max is not supported",
    );
    expect(upstreamCalls).toHaveLength(count + 1);
    controls.mode = "partial";
    await value("/chats/" + chat.id + "/retry", "POST", {
      messageId: failed.currentId,
    });
    const partial = await finished(chat.id);
    expect(partial.messages[partial.currentId!]).toMatchObject({
      content: "第一部分",
      status: "error",
    });
    expect(partial.messages[failed.currentId!]?.status).toBe("error");
    controls.mode = "normal";
  });
  it("supports non-streaming responses with none distinct from omitted reasoning effort", async () => {
    const chat = await value<Chat>("/chats", "POST", {});
    await value("/chats/" + chat.id, "PATCH", {
      stream: false,
      effort: "none",
    });
    await value("/chats/" + chat.id + "/send", "POST", { content: "plain" });
    const done = await finished(chat.id);
    expect(done.messages[done.currentId!]?.content).toBe("非流式回答");
    expect(upstreamCalls.at(-1)).toMatchObject({
      stream: false,
      reasoning_effort: "none",
    });
    await value("/chats/" + chat.id, "PATCH", { effort: "inherit" });
    await value("/chats/" + chat.id + "/send", "POST", { content: "inherit" });
    await finished(chat.id);
    expect(upstreamCalls.at(-1)).not.toHaveProperty("reasoning_effort");
  });
  it("preserves a provider's non-streaming reasoning alias without another upstream request", async () => {
    controls.mode = "nonstream-reasoning";
    try {
      const chat = await value<Chat>("/chats", "POST", {});
      await value("/chats/" + chat.id, "PATCH", {
        title: "Reasoning alias fixture",
        stream: false,
      });
      const before = upstreamCalls.length;
      await value("/chats/" + chat.id + "/send", "POST", { content: "Q" });
      const done = await finished(chat.id);
      expect(done.messages[done.currentId!]?.content).toBe("非流式回答");
      expect(done.messages[done.currentId!]?.reasoning).toBe("独立思考");
      expect(upstreamCalls).toHaveLength(before + 1);
    } finally {
      controls.mode = "normal";
    }
  });
  it("keeps a started workflow alive for more than 30 seconds without a browser connection", async () => {
    controls.mode = "normal";
    controls.delay = 31500;
    const count = upstreamCalls.length,
      chat = await value<Chat>("/chats", "POST", {});
    await value("/chats/" + chat.id + "/send", "POST", {
      content: "long background fixture",
    });
    // There is no browser/client stream; do not keep the original request alive.
    await new Promise((r) => setTimeout(r, 32200));
    const done = await finished(chat.id);
    expect(done.messages[done.currentId!]).toMatchObject({
      content: "第一部分，完成",
      status: "complete",
    });
    expect(upstreamCalls).toHaveLength(count + 1);
    controls.delay = 0;
  }, 40000);
  it("stops with partial output, locks history and preserves an unsent cloud draft", async () => {
    controls.delay = 6000;
    controls.mode = "normal";
    const chat = await value<Chat>("/chats", "POST", {});
    await value("/chats/" + chat.id + "/send", "POST", {
      content: "stop fixture",
    });
    let running: { chat: Chat; job: unknown };
    do {
      await new Promise((r) => setTimeout(r, 50));
      running = await value("/chats/" + chat.id);
    } while (!running.chat.messages[running.chat.currentId!]?.content);
    expect(
      (
        await request("/chats/" + chat.id + "/send", "POST", {
          content: "must not queue",
        })
      ).status,
    ).toBe(409);
    const user = Object.values(running.chat.messages).find(
      (m) => m.role === "user",
    )!;
    expect(
      (
        await request("/chats/" + chat.id + "/edit", "POST", {
          messageId: user.id,
          content: "locked",
        })
      ).status,
    ).toBe(409);
    await value("/chats/" + chat.id + "/draft", "PUT", {
      draft: "unsent draft",
    });
    await value("/chats/" + chat.id, "PATCH", {
      model: { providerId: provider.id, modelId: "other" },
    });
    expect(upstreamCalls.at(-1)?.model).toBe("Gemini3.8flash-low");
    await value("/chats/" + chat.id + "/stop", "POST", {});
    const stopped = await finished(chat.id);
    expect(stopped.messages[stopped.currentId!]).toMatchObject({
      status: "stopped",
      content: "第一部分",
    });
    expect(stopped.draft).toBe("unsent draft");
    controls.delay = 0;
  });
  it("runs independent chats concurrently and captures parameters before later settings changes", async () => {
    const before = upstreamCalls.length,
      left = await value<Chat>("/chats", "POST", {}),
      right = await value<Chat>("/chats", "POST", {});
    controls.delay = 750;
    try {
      await value("/chats/" + left.id, "PATCH", {
        title: "Parallel left",
        effort: "low",
        parameters: { temperature: 0.2 },
      });
      await value("/chats/" + right.id, "PATCH", {
        title: "Parallel right",
        model: { providerId: provider.id, modelId: "other" },
        effort: "none",
      });
      await Promise.all(
        [left, right].map((chat, index) =>
          value("/chats/" + chat.id + "/send", "POST", {
            content: "parallel fixture " + index,
          }),
        ),
      );
      await value("/chats/" + left.id, "PATCH", {
        model: { providerId: provider.id, modelId: "other" },
        effort: "none",
        parameters: { temperature: 0.9 },
      });
      const [a, b] = await Promise.all([finished(left.id), finished(right.id)]);
      expect(a.messages[a.currentId!]?.status).toBe("complete");
      expect(b.messages[b.currentId!]?.status).toBe("complete");
      const calls = upstreamCalls.slice(before);
      expect(calls).toHaveLength(2);
      expect(
        calls.find((c) =>
          JSON.stringify(c.messages).includes("parallel fixture 0"),
        ),
      ).toMatchObject({
        model: "Gemini3.8flash-low",
        reasoning_effort: "low",
        temperature: 0.2,
      });
      expect(
        calls.find((c) =>
          JSON.stringify(c.messages).includes("parallel fixture 1"),
        ),
      ).toMatchObject({ model: "other", reasoning_effort: "none" });
      expect(a.model?.modelId).toBe("other");
      expect(a.messages[a.currentId!]?.request?.effort).toBe("low");
    } finally {
      controls.delay = 0;
    }
  });
  it("rejects stale revisions even after old versions are garbage collected, and stores text beyond D1's row limit", async () => {
    const chat = await value<Chat>("/chats", "POST", {}),
      large = "🙂".repeat(600000);
    await value("/chats/" + chat.id + "/draft", "PUT", { draft: large });
    const result = await value<{ chat: Chat }>("/chats/" + chat.id);
    expect(result.chat.draft).toBe(large);
    const db = await mf.getD1Database("DB");
    const size = await db
      .prepare(
        "SELECT sum(length(value)) AS size FROM document_parts WHERE id=?",
      )
      .bind(chat.id)
      .first<{ size: number }>();
    expect(size!.size).toBeLessThan(10000);
    await value("/chats/" + chat.id, "PATCH", { title: "metadata change" });
    expect((await value<{ chat: Chat }>("/chats/" + chat.id)).chat.draft).toBe(
      large,
    );
    await db
      .prepare("DELETE FROM document_versions WHERE id=? AND revision=1")
      .bind(chat.id)
      .run();
    await expect(
      db
        .prepare("INSERT INTO document_versions VALUES(?,1,?)")
        .bind(chat.id, Date.now())
        .run(),
    ).rejects.toThrow("stale revision");
    const legacy = await value<Chat>("/chats", "POST", {});
    await db
      .prepare(
        "UPDATE document_parts SET value=json_set(value,'$.draft',?) WHERE id=? AND revision=1",
      )
      .bind("legacy draft", legacy.id)
      .run();
    expect(
      (await value<{ chat: Chat }>("/chats/" + legacy.id)).chat.draft,
    ).toBe("legacy draft");
    await value("/chats/" + legacy.id, "PATCH", { title: "Migrated draft" });
    expect(
      (await value<{ chat: Chat }>("/chats/" + legacy.id)).chat.draft,
    ).toBe("legacy draft");
    const current = await db
      .prepare(
        "SELECT p.value FROM document_parts p JOIN documents d ON d.id=p.id AND d.revision=p.revision WHERE d.id=?",
      )
      .bind(legacy.id)
      .first<{ value: string }>();
    expect(JSON.parse(current!.value).draft).toBe("");
  });
  it("authenticates quota access, shares bootstrap/navigation data and rejects user-supplied query mutations", async () => {
    expect(
      (await request("/account-usage", "GET", undefined, false)).status,
    ).toBe(401);
    expect(
      (await request("/account-usage", "POST", { query: "arbitrary mutation" }))
        .status,
    ).toBe(405);
    const direct = await value<{
      scope: string;
      metrics: { id: string; value: number | null; limit: number | null }[];
    }>("/account-usage?refresh=1");
    expect(direct.scope).toBe("account");
    expect(direct.metrics.find((m) => m.id === "do-duration")).toMatchObject({
      value: 14620.54,
      limit: 13000,
    });
    expect(
      direct.metrics.find((m) => m.id === "workflow-storage")?.value,
    ).toBeNull();
    const bootstrap = await value<{ accountUsage: typeof direct }>(
      "/bootstrap",
    );
    const navigation = await value<{ accountUsage: typeof direct }>(
      "/navigation",
    );
    expect(bootstrap.accountUsage).toEqual(direct);
    expect(navigation.accountUsage).toEqual(direct);
    expect(JSON.stringify(direct)).not.toContain("synthetic-analytics-token");
  });
  it("does not rewrite multipart chat snapshots for repeated seen or unchanged validated configuration", async () => {
    const imported = await value<{ ids: string[] }>("/import", "POST", {
      data: {
        title: "snapshot fixture",
        messages: [
          { id: "u", role: "user", content: "question" },
          {
            id: "a",
            role: "assistant",
            content: "original reply ".repeat(50000),
          },
        ],
      },
    });
    const id = imported.ids[0]!,
      db = await mf.getD1Database("DB");
    const state = async () => {
      const head = await db
        .prepare("SELECT revision FROM documents WHERE id=?")
        .bind(id)
        .first<{ revision: number }>();
      const parts = await db
        .prepare(
          "SELECT count(*) AS count,sum(length(value)) AS bytes FROM document_parts WHERE id=?",
        )
        .bind(id)
        .first<{ count: number; bytes: number }>();
      return { ...head, ...parts };
    };
    const chat = (await value<{ chat: Chat }>("/chats/" + id)).chat;
    const before = await state();
    expect(before.count).toBeGreaterThan(1);
    for (let i = 0; i < 3; i++) {
      await value("/chats/" + id + "/seen", "POST", {});
      const unchanged = await value<Chat>("/chats/" + id, "PATCH", {
        parameters: chat.parameters,
        model: chat.model,
        effort: chat.effort,
        stream: chat.stream,
        system: chat.system,
        rounds: chat.rounds ?? null,
      });
      expect(unchanged.updatedAt).toBe(chat.updatedAt);
    }
    expect(await state()).toEqual(before);
    await value("/chats/" + id, "PATCH", { parameters: { temperature: 0.4 } });
    const changed = await state();
    expect(changed.revision).toBe(before.revision! + 1);
    await value("/chats/" + id, "PATCH", { parameters: { temperature: 0.4 } });
    expect(await state()).toEqual(changed);
    const invalid = await request("/chats/" + id, "PATCH", { rounds: 0 });
    expect(invalid.status).toBe(400);
    expect(await state()).toEqual(changed);
    // Same-text explicit renaming still invalidates a pending model title.
    const renamed = await value<Chat>("/chats/" + id, "PATCH", {
      title: chat.title,
    });
    expect(renamed.titleManual).toBe(true);
    expect(renamed.titleRevision).not.toBe(chat.titleRevision);
    expect((await state()).revision).toBe(changed.revision! + 1);
  });
  it("generates an automatic title once and bounds the explicit fallback without overriding a manual rename", async () => {
    const before = titleCalls.length,
      chat = await value<Chat>("/chats", "POST", {});
    await value("/chats/" + chat.id + "/send", "POST", {
      content: "title fixture",
    });
    const completed = await finished(chat.id);
    expect(completed.title).toBe("模型生成的标题");
    expect(titleCalls.length).toBe(before + 1);
    await value("/chats/" + chat.id + "/regenerate", "POST", {
      messageId: completed.currentId,
    });
    await finished(chat.id);
    expect(titleCalls.length).toBe(before + 1);
    settings.titleModel = { providerId: provider.id, modelId: "other" };
    await value("/settings", "PUT", settings);
    controls.titleMode = "fail-primary";
    const fallbackStart = titleCalls.length;
    await value("/chats/" + chat.id + "/title", "POST", {});
    await finished(chat.id);
    expect(titleCalls.slice(fallbackStart).map((c) => c.model)).toEqual([
      "other",
      "Gemini3.8flash-low",
    ]);
    controls.titleMode = "normal";
    controls.titleDelay = 200;
    await value("/chats/" + chat.id + "/title", "POST", {});
    await value("/chats/" + chat.id, "PATCH", { title: "用户保留的标题" });
    const renamed = await finished(chat.id);
    expect(renamed.title).toBe("用户保留的标题");
    expect(await value("/chats/" + chat.id + "/title-status")).toMatchObject({
      status: "superseded",
    });
    controls.titleDelay = 0;
    settings.titleModel = null;
    await value("/settings", "PUT", settings);
  });
  it("uses global title placeholders and keeps title errors separate from saved answers", async () => {
    const imported = await value<{ ids: string[] }>("/import", "POST", {
      data: [
        {
          chat: {
            title: "imported",
            history: {
              currentId: "a2",
              messages: {
                u1: {
                  id: "u1",
                  role: "user",
                  parentId: null,
                  content: "first question",
                },
                a1: {
                  id: "a1",
                  role: "assistant",
                  parentId: "u1",
                  content: "first answer",
                  reasoning_content: "private reasoning",
                },
                u2: {
                  id: "u2",
                  role: "user",
                  parentId: "a1",
                  content: "second question",
                },
                a2: {
                  id: "a2",
                  role: "assistant",
                  parentId: "u2",
                  content: "second answer",
                },
              },
            },
          },
        },
      ],
    });
    const id = imported.ids[0]!;
    await value("/chats/" + id, "PATCH", { titleScope: "first" });
    await value("/chats/" + id + "/title", "POST", {});
    await finished(id);
    const request = titleCalls.at(-1)!;
    const messages = request.messages as { role: string; content: string }[];
    const inserted = messages[0]!.content.match(
      /<chat_history>\s*([\s\S]*?)\s*<\/chat_history>/,
    )![1]!;
    expect(JSON.parse(inserted)).toEqual([
      { role: "user", content: "second question" },
      { role: "assistant", content: "second answer" },
    ]);
    expect(JSON.stringify(request)).not.toContain("private reasoning");
    controls.titleMode = "reject-all";
    const count = titleCalls.length;
    await value("/chats/" + id + "/title", "POST", {});
    const failed = await finished(id);
    expect(failed.messages.a2?.content).toBe("second answer");
    expect(titleCalls.length).toBe(count + 1);
    expect(await value("/chats/" + id + "/title-status")).toMatchObject({
      status: "error",
    });
    await value("/chats/" + id);
    expect(titleCalls.length).toBe(count + 1);
    controls.titleMode = "normal";
  });
  it("runs device generation and titles without server upstream calls or replay", async () => {
    const device = async <T>(path: string, body: unknown): Promise<T> => {
      const response = await request(
        path,
        "POST",
        body,
        true,
        "https://chat.test",
        true,
      );
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBeLessThan(400);
      return result as T;
    };
    const count = upstreamCalls.length,
      titles = titleCalls.length;
    const chat = await value<Chat>("/chats", "POST", {});
    const start = await device<{
      jobId: string;
      direct: {
        request: {
          model: string;
          messages: { role: string; content: string }[];
        };
        messageId: string;
      };
    }>("/chats/" + chat.id + "/send", { content: "device question" });
    expect(start.direct.request.model).toBe("Gemini3.8flash-low");
    expect(JSON.stringify(start)).not.toMatch(
      /encryptedKey|synthetic-fixture-key/,
    );
    expect(
      (
        await request(
          "/device/jobs/" + start.jobId + "/checkpoint",
          "POST",
          {},
          false,
        )
      ).status,
    ).toBe(401);
    await device("/device/jobs/" + start.jobId + "/checkpoint", {
      sequence: 1,
      content: "device ",
      reasoning: "thinking",
    });
    expect(
      (
        await request("/device/jobs/" + start.jobId + "/checkpoint", "POST", {
          sequence: 1,
          content: "older",
          reasoning: "",
        })
      ).status,
    ).toBe(409);
    const read = await value<{ chat: Chat; job: { transport: string } }>(
      "/chats/" + chat.id,
    );
    expect(read.job.transport).toBe("device");
    expect(read.chat.messages[start.direct.messageId]!.content).toBe("device ");
    const finish = await device<{ titleJobId: string }>(
      "/device/jobs/" + start.jobId + "/finish",
      {
        sequence: 2,
        status: "complete",
        content: "device answer",
        reasoning: "thinking",
        usage: { total_tokens: 20 },
      },
    );
    const title = await device<{
      candidates: { request: { messages: { content: string }[] } }[];
    }>("/device/titles/" + finish.titleJobId + "/claim", {});
    expect(JSON.stringify(title)).not.toMatch(
      /encryptedKey|synthetic-fixture-key/,
    );
    expect(title.candidates[0]!.request.messages[0]!.content).toContain(
      "device answer",
    );
    expect(
      await device("/device/titles/" + finish.titleJobId + "/claim", {}),
    ).toBeNull();
    await device("/device/titles/" + finish.titleJobId + "/finish", {
      content: '{"title":"📱 设备直连"}',
    });
    const saved = await finished(chat.id);
    expect(saved.title).toBe("📱 设备直连");
    expect(saved.messages[start.direct.messageId]!.usage).toMatchObject({
      total_tokens: 20,
    });
    expect(upstreamCalls.length).toBe(count);
    expect(titleCalls.length).toBe(titles);
    const copy = await value<Chat>(
      "/chats/" + chat.id + "/duplicate",
      "POST",
      {},
    );
    expect(copy.id).not.toBe(chat.id);
    expect(Object.keys(copy.messages)).toHaveLength(2);
    expect(copy.messages[start.direct.messageId]).toBeUndefined();
    const stopped = await device<{ jobId: string }>(
      "/chats/" + chat.id + "/send",
      { content: "will stop" },
    );
    await device("/device/jobs/" + stopped.jobId + "/checkpoint", {
      sequence: 1,
      content: "partial",
      reasoning: "",
    });
    await value("/chats/" + chat.id + "/stop", "POST", {});
    expect(
      (
        await request("/device/jobs/" + stopped.jobId + "/finish", "POST", {
          sequence: 2,
          status: "complete",
          content: "partial late",
          reasoning: "",
        })
      ).status,
    ).toBe(409);
    expect(
      Object.values((await finished(chat.id)).messages)
        .filter((m) => m.status === "stopped")
        .map((m) => m.content),
    ).toEqual(["partial"]);
    expect(upstreamCalls.length).toBe(count);
  });
  it("exports settings without credentials by default, reauthenticates key export, and restores atomically", async () => {
    const clean = await value<Record<string, unknown>>(
      "/settings/export",
      "POST",
      {},
    );
    expect(JSON.stringify(clean)).not.toMatch(
      /synthetic-fixture-key|encryptedKey|PASSWORD_HASH|recovery_hash/,
    );
    expect(clean.containsKeys).toBe(false);
    const oversized = structuredClone(clean) as { providers: Provider[] };
    oversized.providers = Array.from({ length: 12 }, () => ({
      ...oversized.providers[0]!,
      id: crypto.randomUUID(),
    }));
    expect(
      (
        await request("/settings/import", "POST", {
          data: oversized,
          mode: "replace",
        })
      ).status,
    ).toBe(413);
    expect((await value<Provider[]>("/providers")).map((p) => p.id)).toEqual(
      (clean.providers as Provider[]).map((p) => p.id),
    );
    expect(
      (await request("/settings/export", "POST", { includeKeys: true })).status,
    ).toBe(401);
    const withKeys = await value<{
      providers: (Provider & { apiKey?: string })[];
    }>("/settings/export", "POST", {
      includeKeys: true,
      password: fixturePassword,
    });
    expect(withKeys.providers[0]?.apiKey).toBe("synthetic-fixture-key");
    const invalid = structuredClone(clean) as {
      providers: { baseUrl: string }[];
    };
    invalid.providers[0]!.baseUrl = "http://insecure.test/v1";
    expect(
      (
        await request("/settings/import", "POST", {
          data: invalid,
          mode: "replace",
        })
      ).status,
    ).toBe(400);
    expect(await value("/settings/export", "POST", {})).toMatchObject({
      settings: clean.settings,
      providers: clean.providers,
    });
    const malicious = structuredClone(clean) as { providers: { id: string }[] };
    malicious.providers[0]!.id = "settings";
    expect(
      (
        await request("/settings/import", "POST", {
          data: malicious,
          mode: "merge",
        })
      ).status,
    ).toBe(400);
    const second = await value<Provider>("/providers", "POST", {
      name: "Second fixture",
      baseUrl: "https://second.test/v1",
      prefix: "B/",
    });
    await value("/settings/import", "POST", { data: clean, mode: "merge" });
    expect(
      (await value<Provider[]>("/providers")).some((p) => p.id === second.id),
    ).toBe(true);
    await value("/settings/import", "POST", { data: clean, mode: "replace" });
    expect((await value<Provider[]>("/providers")).map((p) => p.id)).toEqual([
      provider.id,
    ]);
    expect(
      await value("/providers/" + provider.id + "/key", "POST", {
        password: fixturePassword,
      }),
    ).toEqual({ apiKey: "synthetic-fixture-key" });
  });
  it("removes a group without deleting archived or trashed chats and tests a raw provider model explicitly", async () => {
    const group = await value<{ id: string }>("/groups", "POST", {
        name: "group fixture",
      }),
      chat = await value<Chat>("/chats", "POST", { groupId: group.id });
    await value("/groups/" + group.id, "PATCH", { name: "renamed group" });
    expect(await value<{ name: string }[]>("/groups")).toContainEqual(
      expect.objectContaining({ name: "renamed group" }),
    );
    await value("/chats/" + chat.id, "PATCH", {
      archived: true,
      deleted: true,
    });
    await value("/groups/" + group.id, "DELETE", {});
    const removed = await value<{ chat: Chat }>("/chats/" + chat.id);
    expect(removed.chat).toMatchObject({
      groupId: null,
      deleted: true,
      archived: true,
    });
    await value("/chats/" + chat.id, "PATCH", {
      deleted: false,
      archived: false,
    });
    expect(
      (await value<{ chat: Chat }>("/chats/" + chat.id)).chat.groupId,
    ).toBeNull();
    expect(
      (await request("/chats", "POST", { groupId: group.id })).status,
    ).toBe(409);
    const testResult = await value<{ modelId: string }>(
      "/providers/" + provider.id + "/test",
      "POST",
      { modelId: "Gemini3.8flash-low", effort: "low" },
    );
    expect(testResult.modelId).toBe("Gemini3.8flash-low");
    expect(upstreamCalls.at(-1)).toMatchObject({
      model: "Gemini3.8flash-low",
      reasoning_effort: "low",
    });
  });
  it("batches bootstrap/config/navigation without exposing keys or unauthenticated data", async () => {
    expect(
      await (await request("/bootstrap", "GET", undefined, false)).json(),
    ).toEqual({ authenticated: false });
    const chat = await value<Chat>("/chats", "POST", {});
    const boot = await value<{
      authenticated: boolean;
      providers: Record<string, unknown>[];
      current: { chat: Chat };
      chats: Chat[];
      groups: unknown[];
    }>("/bootstrap?chatId=" + chat.id);
    expect(boot.authenticated).toBe(true);
    expect(boot.current.chat.id).toBe(chat.id);
    expect(boot.chats.some((c) => c.id === chat.id)).toBe(true);
    expect(boot.providers.every((p) => !("encryptedKey" in p))).toBe(true);
    const nav = await value("/navigation");
    expect(nav).toEqual({
      chats: await value("/chats"),
      groups: await value("/groups"),
      accountUsage: await value("/account-usage"),
    });
    expect(await value("/config")).toEqual({
      providers: await value("/providers"),
      settings: await value("/settings"),
    });
    expect((await request("/navigation", "GET", undefined, false)).status).toBe(
      401,
    );
  });
  it("pushes incremental generation, reconnects and completes without replaying upstream", async () => {
    controls.delay = 1500;
    controls.mode = "normal";
    const chat = await value<Chat>("/chats", "POST", {});
    await value("/chats/" + chat.id, "PATCH", {
      title: "Synthetic websocket test",
    });
    const count = upstreamCalls.length;
    const { jobId } = await value<{ jobId: string }>(
      "/chats/" + chat.id + "/send",
      "POST",
      { content: "push fixture" },
    );
    const connect = async () => {
      const response = await mf.dispatchFetch(
        "https://chat.test/api/jobs/" + jobId + "/events",
        {
          headers: {
            Cookie: cookie,
            Origin: "https://chat.test",
            Upgrade: "websocket",
          },
        },
      );
      expect(response.status).toBe(101);
      const socket = response.webSocket!;
      socket.accept();
      return socket;
    };
    const first = await connect();
    first.close(1000, "Reconnect fixture");
    const socket = await connect();
    const result = await new Promise<{ content: string; deltas: number }>(
      (resolve, reject) => {
        let content = "",
          deltas = 0;
        const timer = setTimeout(() => reject(Error("push timeout")), 8000);
        socket.addEventListener("message", (event) => {
          const data = JSON.parse(String(event.data));
          if (data.type === "reset") content = "";
          if (data.type === "delta") {
            content += data.content;
            deltas++;
          }
          if (data.type === "done") {
            clearTimeout(timer);
            resolve({ content, deltas });
          }
        });
      },
    );
    const done = await finished(chat.id);
    expect(result.content).toBe("第一部分，完成");
    expect(result.deltas).toBeGreaterThan(0);
    expect(done.messages[done.currentId!]?.content).toBe(result.content);
    expect(upstreamCalls.length).toBe(count + 1);
    expect((await request("/jobs/" + jobId + "/events")).status).toBe(426);
    expect(
      (
        await mf.dispatchFetch(
          "https://chat.test/api/jobs/" + jobId + "/events",
          {
            headers: {
              Cookie: cookie,
              Origin: "https://evil.test",
              Upgrade: "websocket",
            },
          },
        )
      ).status,
    ).toBe(403);
    controls.delay = 0;
  });
  it("freezes partial analysis requests, preserves untouched blocks, guards stale candidates and saves optional templates", async () => {
    controls.mode = "normal";
    const p = {
      ...pluginDefaults("analysis"),
      prompt: "[PLUGIN_TEST_analysis]\n" + pluginDefaults("analysis").prompt,
    };
    await value("/settings", "PUT", { ...settings, plugins: [p] });
    const chat = await value<Chat>("/chats", "POST", {}),
      endpoint = "/chats/" + chat.id + "/plugins";
    await value("/chats/" + chat.id, "PATCH", { title: "section fixture" });
    await value(endpoint, "POST", {
      action: "configure",
      plugins: [{ id: p.id, enabled: true }],
    });
    await value("/chats/" + chat.id + "/send", "POST", {
      content: "描述已有场景",
      debugPlugins: true,
    });
    type S = { pluginState: PluginState; pluginJob: unknown; chat: Chat };
    const wait = async (predicate: (s: S) => boolean) => {
      for (let n = 0; n < 160; n++) {
        const s = await value<S>("/chats/" + chat.id);
        if (predicate(s)) return s;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw Error("section timeout");
    };
    let s = await wait((s) =>
      s.pluginState.runs.some((r) => r.status === "waiting"),
    );
    const original = s.pluginState.runs[0]!,
      initial = JSON.parse(original.output);
    const snapshot = await value<{ messages: unknown[] }>(endpoint, "POST", {
      action: "request",
      runId: original.id,
    });
    await value(endpoint, "POST", {
      action: "section-generate",
      runId: original.id,
      targetId: "scene_state",
      content: "只改场景",
    });
    s = await wait(
      (s) =>
        !s.pluginJob &&
        s.pluginState.runs.some((r) => r.status === "candidate"),
    );
    let candidate = s.pluginState.runs.at(-1)!;
    const partial = await value<{ messages: unknown[] }>(endpoint, "POST", {
      action: "request",
      runId: candidate.id,
    });
    expect(partial.messages.slice(0, -1)).toEqual(
      snapshot.messages.slice(0, -1),
    );
    expect(s.pluginState.runs[0]!.output).toBe(original.output);
    expect(candidate.usage?.cache_hit_rate).toBe("81.2%");
    await value(endpoint, "POST", {
      action: "section-apply",
      runId: candidate.id,
    });
    s = await value<S>("/chats/" + chat.id);
    expect(JSON.parse(s.pluginState.runs[0]!.output)).toEqual({
      ...initial,
      scene_state: "只改场景",
    });
    await value(endpoint, "POST", {
      action: "section-generate",
      runId: original.id,
      targetId: "action_state",
      content: "",
    });
    s = await wait(
      (s) => !s.pluginJob && s.pluginState.runs.at(-1)?.status === "candidate",
    );
    candidate = s.pluginState.runs.at(-1)!;
    await value(endpoint, "POST", {
      action: "section-edit",
      runId: original.id,
      targetId: "scene_state",
      content: "期间手改",
    });
    expect(
      (
        await request(endpoint, "POST", {
          action: "section-apply",
          runId: candidate.id,
        })
      ).status,
    ).toBe(409);
    await value(endpoint, "POST", {
      action: "discard-sections",
      runIds: [candidate.id],
    });
    expect(
      (
        await request(endpoint, "POST", {
          action: "request",
          runId: candidate.id,
        })
      ).status,
    ).toBe(404);
    await value(endpoint, "POST", {
      action: "section-generate",
      runId: original.id,
      targetId: "action_state",
      content: "并发确认检查",
    });
    s = await wait(
      (s) => !s.pluginJob && s.pluginState.runs.at(-1)?.status === "candidate",
    );
    candidate = s.pluginState.runs.at(-1)!;
    await Promise.all([
      request(endpoint, "POST", {
        action: "section-apply",
        runId: candidate.id,
      }),
      request(endpoint, "POST", {
        action: "discard-sections",
        runIds: [candidate.id],
      }),
    ]);
    s = await value<S>("/chats/" + chat.id);
    if (
      s.pluginState.runs.find((r) => r.id === candidate.id)?.status ===
      "complete"
    )
      expect(
        await value(endpoint, "POST", {
          action: "request",
          runId: candidate.id,
        }),
      ).not.toBeNull();
    await value(endpoint, "POST", {
      action: "section-generate",
      runId: original.id,
      targetId: null,
      content: "增加服装状态，本轮关注外套",
    });
    s = await wait(
      (s) => !s.pluginJob && s.pluginState.runs.at(-1)?.status === "candidate",
    );
    candidate = s.pluginState.runs.at(-1)!;
    await value(endpoint, "POST", {
      action: "section-apply",
      runId: candidate.id,
      saveType: true,
      type: "服装状态",
      instruction: "仅记录既有服装",
      scope: "chat",
    });
    s = await value<S>("/chats/" + chat.id);
    expect(s.chat.plugins![0]!.overrides?.analysisTypes?.[0]).toMatchObject({
      type: "服装状态",
      instruction: "仅记录既有服装",
    });
    expect(
      JSON.parse(s.pluginState.runs[0]!.output).additional_sections,
    ).toHaveLength(1);
    await value(endpoint, "POST", {
      action: "regenerate-analysis",
      runId: original.id,
    });
    s = await wait(
      (s) => !s.pluginJob && s.pluginState.runs.at(-1)?.status === "candidate",
    );
    candidate = s.pluginState.runs.at(-1)!;
    expect(JSON.parse(candidate.output).additional_sections).toBeUndefined();
    await value(endpoint, "POST", { action: "replace", runId: candidate.id });
    await value(endpoint, "POST", {
      action: "approve-analysis",
      runId: candidate.id,
    });
    expect(
      (
        await request(endpoint, "POST", {
          action: "section-edit",
          runId: candidate.id,
          targetId: "scene_state",
          content: "不能改历史",
        })
      ).status,
    ).toBe(409);
    await value(endpoint, "POST", { action: "cancel" });
  });
  it("repeats clarification with full submitted answers and skipped questions, waits on an empty batch and retains the main draft", async () => {
    controls.mode = "clarify-loop";
    const p = {
      ...pluginDefaults("clarify"),
      clarifyLoop: true,
      prompt: "[PLUGIN_TEST_clarify]\n" + pluginDefaults("clarify").prompt,
    };
    await value("/settings", "PUT", { ...settings, plugins: [p] });
    const chat = await value<Chat>("/chats", "POST", {}),
      endpoint = "/chats/" + chat.id + "/plugins";
    await value("/chats/" + chat.id, "PATCH", { title: "repeat fixture" });
    await value(endpoint, "POST", {
      action: "configure",
      plugins: [{ id: p.id, enabled: true }],
    });
    await value("/chats/" + chat.id + "/send", "POST", {
      content: "继续当前情节",
      debugPlugins: true,
    });
    type S = { pluginState: PluginState; pluginJob: unknown; chat: Chat };
    const wait = async () => {
      for (let n = 0; n < 160; n++) {
        const s = await value<S>("/chats/" + chat.id);
        if (!s.pluginJob && s.pluginState.runs.at(-1)?.status === "waiting")
          return s;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw Error("repeat timeout");
    };
    let s = await wait(),
      first = s.pluginState.runs.at(-1)!;
    await value("/chats/" + chat.id + "/draft", "PUT", { draft: "主草稿保留" });
    controls.mode = "normal"; // The model repeats the same question; the server must suppress it without another model call.
    await value(endpoint, "POST", {
      action: "answer",
      runId: first.id,
      selections: {},
      content: "我的自由回答",
    });
    s = await wait();
    const last = s.pluginState.runs.at(-1)!;
    expect(last.id).not.toBe(first.id);
    expect(JSON.parse(last.output).questions).toEqual([]);
    expect(s.pluginState.flows[0]!.status).toBe("waiting");
    expect(s.chat.draft).toBe("主草稿保留");
    const snapshot = await value<{
      messages: { role: string; content: string }[];
    }>(endpoint, "POST", { action: "request", runId: last.id });
    expect(
      snapshot.messages.some(
        (m) =>
          m.role === "tool" &&
          m.content.includes("本题跳过，不再追问") &&
          m.content.includes("我的自由回答"),
      ),
    ).toBe(true);
    await value(endpoint, "POST", {
      action: "finish-clarify",
      runId: last.id,
      content: "最后补充",
    });
    s = await value<S>("/chats/" + chat.id);
    expect(s.pluginState.flows[0]!.status).toBe("debug");
    await value(endpoint, "POST", { action: "cancel" });
    controls.mode = "normal";
  });
  it("runs ordered independent plugins, awaits clarification once, injects tool results and generates suggestions", async () => {
    controls.mode = "normal";
    controls.delay = 0;
    const list = defaultPlugins().map((p) => ({
      ...p,
      stream: !["analysis", "clarify"].includes(p.kind),
      prompt: `[PLUGIN_TEST_${p.kind}]\n${p.prompt}`,
      ...(p.kind === "analysis"
        ? {
            schema:
              '{"type":"object","required":["ABC"],"properties":{"ABC":{"type":"string"}}}',
          }
        : {}),
    }));
    await value("/settings", "PUT", { ...settings, plugins: list });
    const chat = await value<Chat>("/chats", "POST", {});
    await value("/chats/" + chat.id, "PATCH", {
      title: "Plugin integration fixture",
    });
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "configure",
      plugins: list.map((p) => ({ id: p.id, enabled: true })),
    });
    type Snapshot = {
      chat: Chat;
      pluginState: PluginState;
      pluginJob: PluginJobView | null;
      job: { id: string } | null;
    };
    const wait = async (predicate: (s: Snapshot) => boolean) => {
      for (let i = 0; i < 160; i++) {
        const s = await value<Snapshot>("/chats/" + chat.id);
        if (predicate(s)) return s;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw Error("plugin transition timeout");
    };
    const before = upstreamCalls.length;
    await value("/chats/" + chat.id + "/send", "POST", {
      content: "写一篇短故事",
    });
    let s = await wait((s) => s.chat.pluginPending === "waiting");
    expect(Object.values(s.chat.messages)).toHaveLength(1);
    expect(s.pluginState.runs.map((r) => r.status)).toEqual(["waiting"]);
    expect(upstreamCalls.length - before).toBe(1);
    expect(upstreamCalls.at(-1)?.stream).toBe(false);
    expect(s.pluginState.runs[0]?.usage?.cache_hit_rate).toBe("80%");
    const question = s.pluginState.runs[0]!;
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "answer",
      runId: question.id,
      content: "轻松幽默",
    });
    s = await wait(
      (s) =>
        !s.pluginJob &&
        s.pluginState.runs.some(
          (r) => r.plugin.kind === "analysis" && r.status === "waiting",
        ),
    );
    expect(upstreamCalls.at(-1)?.stream).toBe(false);
    const firstAnalysis = s.pluginState.runs.find(
      (r) => r.plugin.kind === "analysis",
    )!;
    expect(s.chat.pluginPending).toBe("waiting");
    expect(Object.values(s.chat.messages)).toHaveLength(1);
    expect(upstreamCalls.length - before).toBe(2);
    await new Promise((r) => setTimeout(r, 100));
    expect(upstreamCalls.length - before).toBe(2);
    expect(
      (
        await request("/chats/" + chat.id + "/plugins", "POST", {
          action: "answer",
          runId: firstAnalysis.id,
          content: "bypass",
        })
      ).status,
    ).toBe(400);
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "regenerate-analysis",
      runId: firstAnalysis.id,
    });
    s = await wait(
      (s) =>
        !s.pluginJob &&
        s.pluginState.runs.some(
          (r) => r.plugin.kind === "analysis" && r.status === "waiting",
        ),
    );
    const replacement = s.pluginState.runs.findLast(
      (r) => r.plugin.kind === "analysis" && r.status === "candidate",
    )!;
    expect(replacement).toBeTruthy();
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "replace",
      runId: replacement.id,
    });
    s = await value<Snapshot>("/chats/" + chat.id);
    expect(upstreamCalls.length - before).toBe(3);
    expect(
      s.pluginState.runs.filter((r) => r.plugin.kind === "clarify"),
    ).toHaveLength(1);
    expect(
      (
        await request("/chats/" + chat.id + "/plugins", "POST", {
          action: "approve-analysis",
          runId: firstAnalysis.id,
        })
      ).status,
    ).toBe(409);
    const approved = s.pluginState.runs.findLast(
      (r) => r.plugin.kind === "analysis" && r.status === "waiting",
    )!;
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "approve-analysis",
      runId: approved.id,
    });
    s = await wait(
      (s) =>
        !s.job &&
        !s.pluginJob &&
        s.pluginState.runs.some(
          (r) => r.plugin.kind === "suggest" && r.status === "complete",
        ),
    );
    expect(Object.values(s.chat.messages).map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(upstreamCalls.length - before).toBe(5);
    const analysis = upstreamCalls[before + 1]!.messages as {
      role: string;
      content: string;
    }[];
    expect(analysis.filter((m) => m.role === "tool")).toHaveLength(1);
    expect(JSON.stringify(analysis)).toContain("轻松幽默");
    expect(
      analysis.some(
        (m) =>
          m.role === "tool" &&
          m.content.includes(JSON.stringify(question.output)),
      ),
    ).toBe(true);
    const main = upstreamCalls[before + 3]!.messages as {
      role: string;
      content: string;
    }[];
    expect(main.filter((m) => m.role === "tool")).toHaveLength(2);
    expect(JSON.stringify(main)).toContain("轻松幽默");
    expect(JSON.stringify(s.chat.messages)).not.toContain("analysis-result");
    const exp = await value("/chats/" + chat.id + "/export");
    expect(JSON.stringify(exp)).not.toMatch(
      /analysis-result|轻松幽默|pluginState/,
    );
    const snapshot = await value<{ messages: unknown[] }>(
      "/chats/" + chat.id + "/plugins",
      "POST",
      { action: "request", runId: s.pluginState.runs[0]!.id },
    );
    expect(snapshot.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /encryptedKey|synthetic-fixture-key/,
    );
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "rewrite",
      pluginId: "builtin-rewrite",
      content: "重新构思我的计划",
    });
    s = await wait(
      (s) =>
        !s.pluginJob &&
        s.pluginState.runs.some(
          (r) => r.plugin.kind === "rewrite" && r.status === "complete",
        ),
    );
    expect(Object.values(s.chat.messages)).toHaveLength(2);
    expect(JSON.parse(s.pluginState.runs.at(-1)!.output)).toEqual({
      prompt1: "重生后的用户要求",
      prompt2: "换个说法的要求",
      prompt3: "另一条用户要求",
    });
    const duplicate = await value<Chat>(
        "/chats/" + chat.id + "/duplicate",
        "POST",
        {},
      ),
      copy = await value<Snapshot>("/chats/" + duplicate.id);
    expect(copy.pluginState.runs).toHaveLength(s.pluginState.runs.length);
    expect(copy.pluginState.runs[0]?.id).not.toBe(s.pluginState.runs[0]?.id);
    expect(
      copy.pluginState.runs.every(
        (r) => !r.anchorId || !!copy.chat.messages[r.anchorId],
      ),
    ).toBe(true);
    await value("/settings", "PUT", settings);
  }, 30000);
  it("skips a reviewed analysis without injecting it or making an extra plugin call", async () => {
    const p = {
      ...pluginDefaults("analysis"),
      prompt: "[PLUGIN_TEST_analysis]",
      schema: '{"type":"object","required":["ABC"]}',
    };
    await value("/settings", "PUT", { ...settings, plugins: [p] });
    const chat = await value<Chat>("/chats", "POST", {});
    await value("/chats/" + chat.id, "PATCH", { title: "Review skip fixture" });
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "configure",
      plugins: [{ id: p.id, enabled: true }],
    });
    const before = upstreamCalls.length;
    await value("/chats/" + chat.id + "/send", "POST", {
      content: "Skip this analysis",
    });
    let snapshot: {
      chat: Chat;
      pluginState: PluginState;
      pluginJob: PluginJobView | null;
    };
    for (let i = 0; i < 100; i++) {
      snapshot = await value("/chats/" + chat.id);
      if (snapshot.chat.pluginPending === "waiting" && !snapshot.pluginJob)
        break;
      await new Promise((r) => setTimeout(r, 40));
    }
    expect(snapshot!.chat.pluginPending).toBe("waiting");
    expect(Object.values(snapshot!.chat.messages)).toHaveLength(1);
    expect(upstreamCalls.length - before).toBe(1);
    const runId = snapshot!.pluginState.runs.at(-1)!.id;
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "skip",
      runId,
    });
    const done = await finished(chat.id);
    expect(Object.values(done.messages)).toHaveLength(2);
    expect(upstreamCalls.length - before).toBe(2);
    expect(JSON.stringify(upstreamCalls.at(-1))).not.toContain(
      "analysis-result",
    );
    expect(
      (upstreamCalls.at(-1)!.messages as { role: string }[]).some(
        (m) => m.role === "tool",
      ),
    ).toBe(false);
    expect(
      (
        await request("/chats/" + chat.id + "/plugins", "POST", {
          action: "approve-analysis",
          runId,
        })
      ).status,
    ).toBe(409);
    await value("/settings", "PUT", settings);
  });
  it("pauses invalid JSON, repairs without repeating the call, and keeps debug results out of main history", async () => {
    const list = defaultPlugins().map((p) => ({
      ...p,
      prompt: `[PLUGIN_TEST_${p.kind}]\n${p.prompt}`,
      ...(p.kind === "analysis"
        ? { schema: '{"type":"object","required":["ABC"]}' }
        : {}),
    }));
    await value("/settings", "PUT", { ...settings, plugins: list });
    const chat = await value<Chat>("/chats", "POST", {});
    await value("/chats/" + chat.id, "PATCH", {
      title: "Plugin debug fixture",
    });
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "configure",
      plugins: [{ id: "builtin-analysis", enabled: true }],
    });
    controls.mode = "plugin-invalid";
    const before = upstreamCalls.length;
    await value("/chats/" + chat.id + "/send", "POST", {
      content: "调试需求",
      debugPlugins: true,
    });
    type S = {
      chat: Chat;
      pluginState: PluginState;
      pluginJob: PluginJobView | null;
      job: unknown;
    };
    let s: S;
    for (let i = 0; i < 100; i++) {
      s = await value<S>("/chats/" + chat.id);
      if (s.chat.pluginPending === "error") break;
      await new Promise((r) => setTimeout(r, 40));
    }
    expect(s!.pluginState.runs[0]?.status).toBe("error");
    expect(upstreamCalls.length - before).toBe(1);
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "edit",
      runId: s!.pluginState.runs[0]!.id,
      content: '{"ABC":"repaired"}',
    });
    s = await value<S>("/chats/" + chat.id);
    expect(s.chat.pluginPending).toBe("waiting");
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "approve-analysis",
      runId: s.pluginState.runs[0]!.id,
    });
    s = await value<S>("/chats/" + chat.id);
    expect(s.chat.pluginPending).toBe("debug");
    expect(Object.values(s.chat.messages)).toHaveLength(1);
    expect(upstreamCalls.length - before).toBe(1);
    expect(s.pluginState.runs[0]?.originalOutput).toBe("invalid JSON");
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "configure",
      plugins: [
        {
          id: "builtin-analysis",
          enabled: true,
          overrides: { prompt: "[PLUGIN_TEST_analysis] updated task" },
        },
      ],
    });
    expect(
      (
        await request("/chats/" + chat.id + "/plugins", "POST", {
          action: "use",
        })
      ).status,
    ).toBe(409);
    controls.mode = "normal";
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "debug-rerun",
    });
    for (let i = 0; i < 100; i++) {
      s = await value<S>("/chats/" + chat.id);
      if (s.chat.pluginPending === "waiting") break;
      await new Promise((r) => setTimeout(r, 40));
    }
    expect(s.chat.pluginPending).toBe("waiting");
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "approve-analysis",
      runId: s.pluginState.runs.findLast(
        (r) => r.plugin.kind === "analysis" && r.status === "waiting",
      )!.id,
    });
    s = await value<S>("/chats/" + chat.id);
    expect(s.chat.pluginPending).toBe("debug");
    expect(upstreamCalls.length - before).toBe(2);
    await value("/chats/" + chat.id + "/plugins", "POST", { action: "use" });
    const result = await finished(chat.id);
    expect(Object.values(result.messages)).toHaveLength(3);
    expect(upstreamCalls.length - before).toBe(3);
    await value("/settings", "PUT", settings);
  }, 15000);
  it("rewrites an earlier user in isolation and splices deleted messages with their plugin records atomically", async () => {
    controls.mode = "normal";
    controls.delay = 0;
    await value("/settings", "PUT", { ...settings, plugins: defaultPlugins() });
    const chat = await value<Chat>("/chats", "POST", {});
    await value("/chats/" + chat.id, "PATCH", {
      title: "Historical rewrite fixture",
    });
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "configure",
      plugins: [{ id: "builtin-rewrite", enabled: true }],
    });
    await value("/chats/" + chat.id + "/send", "POST", {
      content: "first question",
    });
    const first = await finished(chat.id),
      firstUser = Object.values(first.messages).find((m) => m.role === "user")!,
      firstReply = first.currentId!;
    await value("/chats/" + chat.id + "/send", "POST", {
      content: "later unrelated question",
    });
    const before = await finished(chat.id),
      lastReply = before.currentId!;
    await value("/chats/" + chat.id + "/draft", "PUT", {
      draft: "composer untouched",
    });
    for (const messageId of [firstReply, "constructor", "missing"]) {
      expect(
        (
          await request("/chats/" + chat.id + "/plugins", "POST", {
            action: "rewrite",
            pluginId: "builtin-rewrite",
            messageId,
            content: "first request",
          })
        ).status,
      ).toBe(400);
    }
    const start = await request(
      "/chats/" + chat.id + "/plugins",
      "POST",
      {
        action: "rewrite",
        pluginId: "builtin-rewrite",
        messageId: firstUser.id,
        content: "first request",
      },
      true,
      "https://chat.test",
      true,
    );
    expect(start.status).toBe(200);
    type Snapshot = {
      chat: Chat;
      pluginState: PluginState;
      pluginJob: PluginJobView | null;
    };
    let snapshot = await value<Snapshot>("/chats/" + chat.id);
    expect(
      snapshot.pluginJob!.direct!.request.messages.map((m) => m.role),
    ).toEqual(["user"]);
    expect(
      snapshot.pluginJob!.direct!.request.messages.at(-1)?.content,
    ).toContain("first request");
    expect(
      JSON.stringify(snapshot.pluginJob!.direct!.request.messages),
    ).not.toContain("later unrelated");
    expect(
      (
        await request("/chats/" + chat.id + "/delete-message", "POST", {
          messageId: firstUser.id,
        })
      ).status,
    ).toBe(409);
    await request(
      "/plugins/jobs/" + snapshot.pluginJob!.id + "/finish",
      "POST",
      {
        sequence: 1,
        status: "complete",
        content:
          '{"prompt1":"new request","prompt2":"another request","prompt3":"third request"}',
      },
      true,
      "https://chat.test",
      true,
    );
    snapshot = await value<Snapshot>("/chats/" + chat.id);
    expect(snapshot.chat.currentId).toBe(lastReply);
    expect(snapshot.chat.messages).toEqual(before.messages);
    expect(snapshot.chat.draft).toBe("composer untouched");
    expect(snapshot.pluginState.runs.at(-1)).toMatchObject({
      rewriteMessageId: firstUser.id,
      anchorId: firstUser.id,
      contextAnchorId: null,
      status: "complete",
    });
    const deleted = await value<Chat>(
      "/chats/" + chat.id + "/delete-message",
      "POST",
      { messageId: firstUser.id },
    );
    expect(Object.values(deleted.messages)).toHaveLength(2);
    expect(
      deleted.messages[deleted.messages[lastReply]!.parentId!]!.parentId,
    ).toBeNull();
    expect(deleted.currentId).toBe(lastReply);
    expect(deleted.draft).toBe("composer untouched");
    snapshot = await value<Snapshot>("/chats/" + chat.id);
    expect(snapshot.pluginState.runs).toHaveLength(0);
    const leaf = await value<Chat>(
      "/chats/" + chat.id + "/delete-message",
      "POST",
      { messageId: lastReply },
    );
    expect(leaf.currentId).toBe(deleted.messages[lastReply]!.parentId);
    const empty = await value<Chat>(
      "/chats/" + chat.id + "/delete-message",
      "POST",
      { messageId: leaf.currentId },
    );
    expect(empty.currentId).toBeNull();
    expect(Object.keys(empty.messages)).toHaveLength(0);
    await value("/settings", "PUT", settings);
  }, 20000);
  it("delivers each device plugin and chained main task only once", async () => {
    const chat = await value<Chat>("/chats", "POST", {});
    await value("/chats/" + chat.id, "PATCH", {
      title: "Plugin direct fixture",
    });
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "configure",
      plugins: [{ id: "builtin-analysis", enabled: true }],
    });
    const response = await request(
      "/chats/" + chat.id + "/send",
      "POST",
      { content: "direct requirement" },
      true,
      "https://chat.test",
      true,
    );
    expect(response.status).toBe(202);
    const first = await value<{ pluginJob: PluginJobView }>(
      "/chats/" + chat.id,
    );
    expect(first.pluginJob.direct?.request.messages.at(-1)?.content).toContain(
      "direct requirement",
    );
    expect(
      (await value<{ pluginJob: PluginJobView }>("/chats/" + chat.id)).pluginJob
        .direct,
    ).toBeUndefined();
    const saved = await request(
      "/plugins/jobs/" + first.pluginJob.id + "/finish",
      "POST",
      {
        sequence: 1,
        status: "complete",
        content:
          '{"character_thoughts":"none","scene_state":"none","action_state":"none","knowledge_boundaries":"none"}',
      },
      true,
      "https://chat.test",
      true,
    );
    expect(saved.status, await saved.text()).toBe(200);
    const reviewed = await value<{
      chat: Chat;
      pluginState: PluginState;
      job: unknown;
    }>("/chats/" + chat.id);
    expect(reviewed.chat.pluginPending).toBe("waiting");
    expect(reviewed.job).toBeNull();
    await request(
      "/chats/" + chat.id + "/plugins",
      "POST",
      {
        action: "approve-analysis",
        runId: reviewed.pluginState.runs.at(-1)!.id,
      },
      true,
      "https://chat.test",
      true,
    );
    const next = await value<{
      generation: { direct?: { request: { messages: { role: string }[] } } };
      job: { id: string };
    }>("/chats/" + chat.id);
    expect(
      next.generation.direct?.request.messages.some((m) => m.role === "tool"),
    ).toBe(true);
    expect(
      (await value<{ generation: { direct?: unknown } }>("/chats/" + chat.id))
        .generation.direct,
    ).toBeUndefined();
    await request(
      "/device/jobs/" + next.job.id + "/finish",
      "POST",
      { sequence: 1, status: "complete", content: "direct main result" },
      true,
      "https://chat.test",
      true,
    );
  }, 15000);
  it("preserves clarification answers across new-send regeneration, edits and forks, migrating user injection to tools", async () => {
    controls.mode = "normal";
    controls.delay = 0;
    const list = defaultPlugins()
      .filter((p) => p.kind === "analysis" || p.kind === "clarify")
      .map((p) => ({
        ...p,
        prompt: `[PLUGIN_TEST_${p.kind}]\n${p.prompt}`,
        injection: "user",
        ...(p.kind === "analysis"
          ? { schema: '{"type":"object","required":["ABC"]}' }
          : {}),
      }));
    await value("/settings", "PUT", { ...settings, plugins: list });
    const chat = await value<Chat>("/chats", "POST", {});
    await value("/chats/" + chat.id, "PATCH", {
      title: "Plugin branch fixture",
    });
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "configure",
      plugins: list.map((p) => ({ id: p.id, enabled: true })),
    });
    type S = {
      chat: Chat;
      pluginState: PluginState;
      pluginJob: PluginJobView | null;
      job: unknown;
    };
    const wait = async (predicate: (s: S) => boolean) => {
      for (let i = 0; i < 160; i++) {
        const s = await value<S>("/chats/" + chat.id);
        if (predicate(s)) return s;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw Error("plugin branch timeout");
    };
    await value("/chats/" + chat.id + "/send", "POST", {
      content: "原始故事要求",
    });
    let s = await wait((s) => s.chat.pluginPending === "waiting");
    const originalRun = s.pluginState.runs.find((r) => r.status === "waiting")!;
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "answer",
      runId: originalRun.id,
      content: "旧偏好",
    });
    s = await wait(
      (s) =>
        !s.pluginJob &&
        s.pluginState.runs.some(
          (r) => r.plugin.kind === "analysis" && r.status === "waiting",
        ),
    );
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "approve-analysis",
      runId: s.pluginState.runs.findLast(
        (r) => r.plugin.kind === "analysis" && r.status === "waiting",
      )!.id,
    });
    s = await wait(
      (s) =>
        !s.job && !s.pluginJob && Object.values(s.chat.messages).length === 2,
    );
    const originalAssistant = s.chat.currentId!;
    const analysisRun = s.pluginState.runs.find(
      (r) => r.plugin.kind === "analysis" && r.status === "complete",
    )!;
    const analysisRequest = await value<{
      messages: { role: string; content: string }[];
    }>("/chats/" + chat.id + "/plugins", "POST", {
      action: "request",
      runId: analysisRun.id,
    });
    expect(analysisRequest.messages.some((m) => m.role === "tool")).toBe(true);
    expect(JSON.stringify(analysisRequest.messages)).toContain("旧偏好");
    expect(
      analysisRequest.messages.some(
        (m) =>
          m.role === "tool" &&
          m.content.includes(JSON.stringify(originalRun.output)),
      ),
    ).toBe(true);
    expect(JSON.stringify(upstreamCalls.at(-1)?.messages)).toContain("旧偏好");
    expect(
      (upstreamCalls.at(-1)?.messages as { role: string }[]).some(
        (m) => m.role === "tool",
      ),
    ).toBe(true);
    const count = upstreamCalls.length;
    await value("/chats/" + chat.id + "/draft", "PUT", {
      draft: "保留在输入框的新草稿",
    });
    await value("/chats/" + chat.id + "/regenerate", "POST", {
      messageId: originalAssistant,
    });
    s = await wait(
      (s) =>
        !s.pluginJob &&
        s.pluginState.runs.some(
          (r) => r.plugin.kind === "analysis" && r.status === "waiting",
        ),
    );
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "approve-analysis",
      runId: s.pluginState.runs.findLast(
        (r) => r.plugin.kind === "analysis" && r.status === "waiting",
      )!.id,
    });
    s = await wait(
      (s) =>
        !s.job && !s.pluginJob && Object.values(s.chat.messages).length === 4,
    );
    expect(upstreamCalls.length - count).toBe(2);
    expect(s.chat.draft).toBe("保留在输入框的新草稿");
    expect(
      s.pluginState.runs.filter((r) => r.status === "answered"),
    ).toHaveLength(2);
    expect(
      s.pluginState.runs
        .filter((r) => r.status === "answered")
        .every((r) => !!s.chat.messages[r.anchorId!]),
    ).toBe(true);
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "regenerate-main",
      runId: originalRun.id,
      answer: "新的偏好",
    });
    s = await wait(
      (s) =>
        !s.pluginJob &&
        s.pluginState.runs.some(
          (r) => r.plugin.kind === "analysis" && r.status === "waiting",
        ),
    );
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "approve-analysis",
      runId: s.pluginState.runs.findLast(
        (r) => r.plugin.kind === "analysis" && r.status === "waiting",
      )!.id,
    });
    s = await wait(
      (s) =>
        !s.job && !s.pluginJob && Object.values(s.chat.messages).length === 6,
    );
    expect(
      s.pluginState.runs.find((r) => r.id === originalRun.id)?.answer,
    ).toContain("旧偏好");
    expect(
      s.pluginState.runs.findLast((r) => r.status === "answered")?.answer,
    ).toBe("新的偏好");
    const fork = await value<Chat>("/chats/" + chat.id + "/fork", "POST", {
        messageId: originalAssistant,
      }),
      forked = await value<S>("/chats/" + fork.id);
    expect(Object.values(forked.chat.messages)).toHaveLength(2);
    expect(
      forked.pluginState.runs.filter((r) => r.status === "answered"),
    ).toHaveLength(1);
    expect(
      forked.pluginState.runs.every(
        (r) => !r.anchorId || !!forked.chat.messages[r.anchorId],
      ),
    ).toBe(true);
    await value("/settings", "PUT", settings);
  }, 20000);
  it("does not retry failed plugins automatically, stops partial output and survives beyond 30 seconds without a page", async () => {
    const p = {
      ...defaultPlugins().find((p) => p.kind === "analysis")!,
      prompt: "[PLUGIN_TEST_analysis]\nReturn JSON",
      schema: '{"type":"object","required":["ABC"]}',
    };
    await value("/settings", "PUT", { ...settings, plugins: [p] });
    const chat = await value<Chat>("/chats", "POST", {});
    await value("/chats/" + chat.id, "PATCH", {
      title: "Long background plugin fixture",
    });
    await value("/chats/" + chat.id + "/plugins", "POST", {
      action: "configure",
      plugins: [{ id: p.id, enabled: true }],
    });
    type S = {
      chat: Chat;
      pluginState: PluginState;
      pluginJob: PluginJobView | null;
      job: unknown;
    };
    const wait = async (predicate: (s: S) => boolean, timeout = 10000) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const s = await value<S>("/chats/" + chat.id);
        if (predicate(s)) return s;
        await new Promise((r) => setTimeout(r, 60));
      }
      throw Error("plugin transition timed out");
    };
    controls.mode = "plugin-http-error";
    const before = upstreamCalls.length;
    await value("/chats/" + chat.id + "/send", "POST", {
      content: "失败只调用一次",
      debugPlugins: true,
    });
    let s = await wait((s) => s.chat.pluginPending === "error");
    await new Promise((r) => setTimeout(r, 150));
    expect(upstreamCalls.length - before).toBe(1);
    expect(s.pluginState.runs[0]?.error).toContain("400");
    controls.mode = "plugin-slow";
    controls.delay = 33000;
    await value("/chats/" + chat.id + "/plugins", "POST", { action: "retry" });
    await new Promise((r) => setTimeout(r, 31000));
    s = await value<S>("/chats/" + chat.id);
    expect(s.pluginJob).not.toBeNull();
    expect(Object.values(s.chat.messages)).toHaveLength(1);
    s = await wait((s) => s.chat.pluginPending === "waiting");
    expect(s.pluginState.runs.at(-1)?.status).toBe("waiting");
    expect(s.pluginState.runs.at(-1)?.output).toContain("analysis-result");
    expect(upstreamCalls.length - before).toBe(2);
    await value("/chats/" + chat.id + "/plugins", "POST", { action: "cancel" });
    controls.delay = 1000;
    await value("/chats/" + chat.id + "/send", "POST", {
      content: "停止插件不生成正文",
    });
    await wait((s) => !!s.pluginJob);
    await value("/chats/" + chat.id + "/plugins", "POST", { action: "cancel" });
    s = await value<S>("/chats/" + chat.id);
    expect(s.pluginState.runs.at(-1)?.status).toBe("cancelled");
    expect(
      Object.values(s.chat.messages).filter((m) => m.role === "assistant"),
    ).toHaveLength(0);
    controls.mode = "normal";
    controls.delay = 0;
    await value("/settings", "PUT", settings);
  }, 45000);
  it("retains built-ins when settings omit them and prevents changing their kinds", async () => {
    const before = await value<Settings>("/settings");
    const next = await value<Settings>("/settings", "PUT", {
      ...before,
      plugins: [],
    });
    expect(next.plugins?.map((p) => p.id)).toEqual([
      "builtin-clarify",
      "builtin-analysis",
      "builtin-suggest",
      "builtin-rewrite",
    ]);
    expect(
      (
        await request("/settings", "PUT", {
          ...next,
          plugins: [{ ...next.plugins![0], kind: "rewrite" }],
        })
      ).status,
    ).toBe(400);
    await value("/settings", "PUT", before);
  });
  it("runs summaries and suggestions in parallel, confirms the next send, and keeps older jobs attached to their source", async () => {
    controls.mode = "plugin-slow";
    controls.delay = 1000;
    summaryControls.delay = 1000;
    summaryControls.output = "";
    const suggest = {
      ...pluginDefaults("suggest"),
      prompt: "[PLUGIN_TEST_suggest]",
    };
    await value("/settings", "PUT", { ...settings, plugins: [suggest] });
    const c = await value<Chat>("/chats", "POST", {});
    await value("/chats/" + c.id, "PATCH", {
      title: "Parallel summary fixture",
    });
    await value("/chats/" + c.id + "/plugins", "POST", {
      action: "configure",
      plugins: [{ id: suggest.id, enabled: true }],
    });
    const before = summaryCalls.length;
    await value("/chats/" + c.id + "/send", "POST", { content: "first turn" });
    const first = await waitSummary(
      c.id,
      (s) => !s.job && s.postJobs.length === 2,
    );
    const oldId = first.chat.currentId!;
    expect(first.pluginJob).toBeNull();
    expect(first.postJobs.map((j) => j.kind).sort()).toEqual([
      "suggest",
      "summary",
    ]);
    const denied = await request("/chats/" + c.id + "/send", "POST", {
      content: "next turn",
    });
    expect(denied.status).toBe(409);
    expect(
      Object.keys(
        (await value<{ chat: Chat }>("/chats/" + c.id)).chat.messages,
      ),
    ).toHaveLength(2);
    await value("/chats/" + c.id + "/send", "POST", {
      content: "next turn",
      confirmPost: true,
    });
    const done = await waitSummary(
      c.id,
      (s) =>
        Object.keys(s.chat.messages).length === 4 &&
        !s.job &&
        !s.postJobs.length,
    );
    expect(summaryCalls.length - before).toBe(2);
    expect(done.summaryState.runs.every((r) => r.status === "complete")).toBe(
      true,
    );
    expect(
      done.pluginState.runs.filter(
        (r) => r.plugin.kind === "suggest" && r.status === "complete",
      ),
    ).toHaveLength(2);
    expect(summaryFor(done.chat, done.summaryState, oldId)).toBeDefined();
    expect(done.pluginState.runs.some((r) => r.anchorId === oldId)).toBe(true);
    const exported = await value("/chats/" + c.id + "/export");
    expect(JSON.stringify(exported)).not.toMatch(
      /summaryState|user_excerpt|你与同行者确认|用户下一句/,
    );
    controls.mode = "normal";
    controls.delay = 0;
    summaryControls.delay = 0;
    await value("/settings", "PUT", settings);
  });
  it("validates summaries, keeps accepted text until explicit replacement, rejects stale candidates, and never replays on reconnect", async () => {
    controls.mode = "normal";
    controls.delay = 0;
    summaryControls.delay = 0;
    const c = await value<Chat>("/chats", "POST", {});
    await value("/chats/" + c.id, "PATCH", {
      title: "Summary replace fixture",
    });
    await value("/chats/" + c.id + "/send", "POST", { content: "one" });
    let s = await waitSummary(
      c.id,
      (s) =>
        s.summaryState.runs.some((r) => r.status === "complete") &&
        !s.postJobs.length,
    );
    const messageId = s.chat.currentId!,
      old = summaryFor(s.chat, s.summaryState, messageId)!;
    expect(old.usage?.cache_hit_rate).toBe("85.8%");
    expect(old.config.effort).toBe("inherit");
    summaryControls.output = '{"summary":"替换候选"}';
    await value("/chats/" + c.id + "/summaries", "POST", {
      action: "regenerate",
      messageId,
    });
    s = await waitSummary(c.id, (s) =>
      s.summaryState.runs.some((r) => r.status === "candidate"),
    );
    const candidate = s.summaryState.runs.at(-1)!;
    expect(candidate.warning).toContain("未自动截断");
    expect(summaryFor(s.chat, s.summaryState, messageId)?.id).toBe(old.id);
    await value("/chats/" + c.id + "/summaries", "POST", {
      action: "discard-candidates",
      runIds: [candidate.id, old.id, "not-a-real-run"],
    });
    expect(
      (
        await request("/chats/" + c.id + "/summaries", "POST", {
          action: "accept",
          runId: candidate.id,
        })
      ).status,
    ).toBe(404);
    expect(
      await value("/chats/" + c.id + "/summaries", "POST", {
        action: "discard-candidates",
        runIds: [candidate.id],
      }),
    ).toEqual({ ok: true });
    s = await value("/chats/" + c.id);
    expect(summaryFor(s.chat, s.summaryState, messageId)?.id).toBe(old.id);
    summaryControls.output = '{"summary":"确认后的摘要"}';
    await value("/chats/" + c.id + "/summaries", "POST", {
      action: "regenerate",
      messageId,
    });
    s = await waitSummary(c.id, (s) =>
      s.summaryState.runs.some((r) => r.status === "candidate"),
    );
    const acceptedId = s.summaryState.runs.at(-1)!.id;
    await value("/chats/" + c.id + "/summaries", "POST", {
      action: "accept",
      runId: acceptedId,
    });
    s = await value("/chats/" + c.id);
    expect(summaryFor(s.chat, s.summaryState, messageId)?.summary).toBe(
      "确认后的摘要",
    );
    summaryControls.output = '{"summary":"","extra":true}';
    await value("/chats/" + c.id + "/summaries", "POST", {
      action: "regenerate",
      messageId,
    });
    s = await waitSummary(
      c.id,
      (s) => s.summaryState.runs.at(-1)?.status === "error",
    );
    expect(summaryFor(s.chat, s.summaryState, messageId)?.id).toBe(acceptedId);
    const calls = summaryCalls.length;
    await value("/chats/" + c.id);
    await value("/chats/" + c.id);
    expect(summaryCalls.length).toBe(calls);
    summaryControls.output = '{"summary":"stale candidate"}';
    await value("/chats/" + c.id + "/summaries", "POST", {
      action: "regenerate",
      messageId,
    });
    s = await waitSummary(
      c.id,
      (s) => s.summaryState.runs.at(-1)?.status === "candidate",
    );
    const stale = s.summaryState.runs.at(-1)!;
    await value("/chats/" + c.id + "/edit", "POST", {
      messageId,
      content: "edited source",
    });
    expect(
      (
        await request("/chats/" + c.id + "/summaries", "POST", {
          action: "accept",
          runId: stale.id,
        })
      ).status,
    ).toBe(409);
    s = await value("/chats/" + c.id);
    expect(summaryFor(s.chat, s.summaryState, messageId)).toBeUndefined();
    summaryControls.output = "";
  });
  it("serially backfills imported history and preserves accepted summaries across copies and forks", async () => {
    summaryControls.delay = 100;
    summaryControls.maxActive = 0;
    controls.mode = "normal";
    controls.delay = 0;
    const imported = await value<{ ids: string[] }>("/import", "POST", {
      data: {
        title: "Backfill fixture",
        messages: [
          { id: "u1", role: "user", content: "one" },
          { id: "a1", role: "assistant", content: "first reply" },
          { id: "u2", role: "user", content: "two" },
          { id: "a2", role: "assistant", content: "second reply" },
        ],
      },
    });
    const id = imported.ids[0]!;
    let s = await value<SummarySnapshot>("/chats/" + id);
    expect(s.summaryState.runs).toHaveLength(0);
    const before = summaryCalls.length;
    await value("/chats/" + id + "/summaries", "POST", { action: "backfill" });
    await value("/chats/" + id + "/summaries", "POST", { action: "backfill" });
    s = await waitSummary(
      id,
      (s) =>
        s.summaryState.runs.filter((r) => r.status === "complete").length ===
          2 && !s.postJobs.length,
    );
    expect(summaryControls.maxActive).toBe(1);
    expect(summaryCalls.length - before).toBe(2);
    const second = summaryCalls.at(-1)!.messages as { content: string }[];
    expect(JSON.stringify(second)).toContain("previous_example");
    const copy = await value<Chat>("/chats/" + id + "/duplicate", "POST", {}),
      fork = await value<Chat>("/chats/" + id + "/fork", "POST", {
        messageId: "a1",
      });
    const cs = await value<SummarySnapshot>("/chats/" + copy.id),
      fs = await value<SummarySnapshot>("/chats/" + fork.id);
    expect(cs.summaryState.runs).toHaveLength(2);
    expect(fs.summaryState.runs).toHaveLength(1);
    expect(
      summaryFor(cs.chat, cs.summaryState, cs.chat.currentId!),
    ).toBeDefined();
    expect(
      summaryFor(fs.chat, fs.summaryState, fs.chat.currentId!),
    ).toBeDefined();
    await value("/chats/" + id + "/delete-message", "POST", {
      messageId: "a1",
    });
    s = await value("/chats/" + id);
    expect(s.summaryState.runs.some((r) => r.messageId === "a1")).toBe(false);
    expect(summaryFor(s.chat, s.summaryState, "a2")).toBeUndefined();
    summaryControls.delay = 0;
  });
  it("summarizes device replies on the server, labels manual partials and rejects stale results without blocking the next turn", async () => {
    controls.mode = "normal";
    controls.delay = 0;
    summaryControls.delay = 500;
    const c = await value<Chat>("/chats", "POST", {});
    await value("/chats/" + c.id, "PATCH", { title: "Device summary fixture" });
    const start = await request(
      "/chats/" + c.id + "/send",
      "POST",
      { content: "device source" },
      true,
      "https://chat.test",
      true,
    );
    const { jobId } = (await start.json()) as { jobId: string };
    await request(
      "/device/jobs/" + jobId + "/finish",
      "POST",
      { sequence: 1, status: "complete", content: "device full reply" },
      true,
      "https://chat.test",
      true,
    );
    let s = await waitSummary(c.id, (s) =>
      s.postJobs.some((j) => j.kind === "summary"),
    );
    const source = s.chat.currentId!;
    expect(s.postJobs[0]?.transport).toBeUndefined();
    expect(s.job).toBeNull();
    await value("/chats/" + c.id + "/edit", "POST", {
      messageId: source,
      content: "new source version",
    });
    s = await waitSummary(
      c.id,
      (s) => s.summaryState.runs.at(-1)?.status === "stale",
    );
    expect(summaryFor(s.chat, s.summaryState, source)).toBeUndefined();
    const next = await request(
      "/chats/" + c.id + "/send",
      "POST",
      { content: "partial" },
      true,
      "https://chat.test",
      true,
    );
    const nextId = ((await next.json()) as { jobId: string }).jobId;
    await request(
      "/device/jobs/" + nextId + "/finish",
      "POST",
      { sequence: 1, status: "stopped", content: "partial reply" },
      true,
      "https://chat.test",
      true,
    );
    s = await value("/chats/" + c.id);
    const partial = s.chat.currentId!;
    expect(s.summaryState.runs.some((r) => r.messageId === partial)).toBe(
      false,
    );
    await value("/chats/" + c.id + "/summaries", "POST", {
      action: "regenerate",
      messageId: partial,
    });
    s = await waitSummary(c.id, (s) =>
      s.summaryState.runs.some(
        (r) => r.messageId === partial && r.status === "complete",
      ),
    );
    expect(s.summaryState.runs.at(-1)?.sourceIncomplete).toBe(true);
    summaryControls.delay = 0;
  });
  it("finishes a summary after more than 30 seconds without a page and never reissues the upstream request", async () => {
    controls.mode = "normal";
    controls.delay = 0;
    summaryControls.delay = 32000;
    const c = await value<Chat>("/chats", "POST", {});
    await value("/chats/" + c.id, "PATCH", { title: "Long summary fixture" });
    const before = summaryCalls.length;
    await value("/chats/" + c.id + "/send", "POST", {
      content: "background summary",
    });
    const start = await waitSummary(
      c.id,
      (s) => !s.job && s.postJobs.some((j) => j.kind === "summary"),
    );
    expect(start.summaryState.runs.at(-1)?.status).toBe("running");
    await new Promise((r) => setTimeout(r, 32500));
    const done = await waitSummary(
      c.id,
      (s) =>
        !s.postJobs.length && s.summaryState.runs.at(-1)?.status === "complete",
    );
    expect(summaryCalls.length - before).toBe(1);
    expect(done.summaryState.runs.at(-1)?.elapsedMs).toBeGreaterThan(30000);
    await value("/chats/" + c.id);
    expect(summaryCalls.length - before).toBe(1);
    summaryControls.delay = 0;
  }, 45000);
  it("bans five consecutive login failures per IP, reports timestamps only after login and expires the ban", async () => {
    const db = await mf.getD1Database("DB");
    await db.batch([
      db.prepare("DELETE FROM login_guards"),
      db.prepare("DELETE FROM login_notice"),
    ]);
    const attempt = (ip: string, password: string, recovery = false) =>
      mf.dispatchFetch(
        "https://chat.test/api/auth/" + (recovery ? "recover" : "login"),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://chat.test",
            "CF-Connecting-IP": ip,
          },
          body: JSON.stringify({ password }),
        },
      );
    const started = Date.now();
    for (let i = 0; i < 4; i++)
      expect((await attempt("192.0.2.1", "incorrect")).status).toBe(401);
    const banned = await attempt("192.0.2.1", "incorrect");
    expect(banned.status).toBe(429);
    expect(Number(banned.headers.get("Retry-After"))).toBeGreaterThan(890);
    const body = (await banned.json()) as {
      retryAt: number;
      failedAttempts?: unknown;
    };
    expect(body.retryAt).toBeGreaterThan(Date.now() + 890000);
    expect(body.failedAttempts).toBeUndefined();
    expect((await attempt("192.0.2.1", fixturePassword)).status).toBe(429);
    const blocked = await db
      .prepare("SELECT failures,blocked_until FROM login_guards")
      .first<{ failures: number; blocked_until: number }>();
    expect(blocked).toEqual({ failures: 5, blocked_until: body.retryAt });
    const valid = await attempt("192.0.2.2", fixturePassword);
    expect(valid.status).toBe(200);
    const notice = (
      (await valid.json()) as {
        failedAttempts: { count: number; firstAt: number; lastAt: number };
      }
    ).failedAttempts;
    expect(notice.count).toBe(5);
    expect(notice.firstAt).toBeGreaterThanOrEqual(started);
    expect(notice.lastAt).toBeGreaterThanOrEqual(notice.firstAt);
    expect(
      (
        (await (await attempt("192.0.2.2", fixturePassword)).json()) as {
          failedAttempts?: unknown;
        }
      ).failedAttempts,
    ).toBeUndefined();
    // Advance only persisted expiry; no real 15-minute sleep or production writes.
    await db
      .prepare("UPDATE login_guards SET blocked_until=?,updated_at=?")
      .bind(Date.now() - 1, Date.now() - 900001)
      .run();
    expect((await attempt("192.0.2.1", "incorrect")).status).toBe(401);
    expect(
      (
        await db
          .prepare("SELECT failures FROM login_guards")
          .first<{ failures: number }>()
      )?.failures,
    ).toBe(1);
    expect((await attempt("192.0.2.1", fixturePassword)).status).toBe(200);
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM login_guards")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    for (let i = 0; i < 4; i++)
      expect((await attempt("192.0.2.3", "incorrect", i === 0)).status).toBe(
        401,
      );
    expect((await attempt("192.0.2.3", fixturePassword)).status).toBe(200);
    expect((await attempt("192.0.2.3", "incorrect")).status).toBe(401);
    expect(
      (
        await db
          .prepare("SELECT failures FROM login_guards")
          .first<{ failures: number }>()
      )?.failures,
    ).toBe(1);
    await db.batch([
      db.prepare("DELETE FROM login_guards"),
      db.prepare("DELETE FROM login_notice"),
    ]);
    const burst = await Promise.all(
      Array.from({ length: 8 }, () => attempt("192.0.2.4", "incorrect")),
    );
    expect(burst.filter((r) => r.status === 401)).toHaveLength(4);
    expect(burst.filter((r) => r.status === 429)).toHaveLength(4);
    expect(
      (
        await db
          .prepare("SELECT count FROM login_notice")
          .first<{ count: number }>()
      )?.count,
    ).toBe(5);
    await db.batch([
      db.prepare("DELETE FROM login_guards"),
      db.prepare("DELETE FROM login_notice"),
    ]);
  });
  it("changes password and revokes every prior session", async () => {
    const response = await value<{ recoveryCode: string }>(
      "/auth/password",
      "POST",
      { password: fixturePassword, newPassword: "synthetic-new-password-123" },
    );
    expect(response.recoveryCode.length).toBeGreaterThan(50);
    expect((await request("/chats")).status).toBe(401);
  });
  it("consumes a recovery code once under concurrent resets and returns a replacement", async () => {
    const login = await request(
      "/auth/login",
      "POST",
      { password: "synthetic-new-password-123" },
      false,
    );
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const code = await value<{ recoveryCode: string }>(
      "/auth/recovery-code",
      "POST",
      { password: "synthetic-new-password-123" },
    );
    const responses = await Promise.all(
      ["recovered-fixture-one-123", "recovered-fixture-two-123"].map(
        (newPassword) =>
          request(
            "/auth/recover",
            "POST",
            { password: code.recoveryCode, newPassword },
            false,
          ),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
    const good = responses.find((r) => r.status === 200)!;
    const result = (await good.json()) as { recoveryCode: string };
    expect(result.recoveryCode).not.toBe(code.recoveryCode);
    expect(result.recoveryCode.length).toBeGreaterThan(50);
    expect((await request("/chats")).status).toBe(401);
    expect(
      (
        await request(
          "/auth/recover",
          "POST",
          {
            password: code.recoveryCode,
            newPassword: "must-not-reuse-fixture",
          },
          false,
        )
      ).status,
    ).toBe(401);
  });
});
