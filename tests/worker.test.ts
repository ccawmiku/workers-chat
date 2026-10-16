import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Miniflare, Response as MFResponse } from "miniflare";
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes, pbkdf2Sync } from "node:crypto";
import type { Chat, Settings, Provider } from "../src/shared/chat";
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
    }>("/chats/" + id);
    if (
      !result.job &&
      !["pending", "running"].includes(result.titleJob?.status ?? "")
    )
      return result.chat;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("job did not complete");
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
              upstreamCalls.push(payload);
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
                  choices: [{ message: { content: "非流式回答" } }],
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
        await request("/chats/" + id + "/delete-message", "POST", {
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
      reasoning_effort: "max",
    });
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
