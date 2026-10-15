import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Miniflare, Response as MFResponse } from "miniflare";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
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
const upstreamCalls: Record<string, unknown>[] = [],
  controls = { mode: "normal", delay: 0 };
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  useCookie = true,
  origin = "https://chat.test",
) {
  return mf.dispatchFetch("https://chat.test/api" + path, {
    method,
    headers: {
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
    const result = await value<{ chat: Chat; job: unknown }>("/chats/" + id);
    if (!result.job) return result.chat;
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
  for (const sql of (await readFile("migrations/0001.sql", "utf8"))
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
  it("finishes a single background call, retains request identity, branches retries and extends continuation versions", async () => {
    const chat = await value<Chat>("/chats", "POST", {}),
      count = upstreamCalls.length;
    await value("/chats/" + chat.id + "/send", "POST", { content: "hello" });
    const done = await finished(chat.id);
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
  it("rejects stale revisions even after old versions are garbage collected, and stores text beyond D1's row limit", async () => {
    const chat = await value<Chat>("/chats", "POST", {}),
      large = "🙂".repeat(600000);
    await value("/chats/" + chat.id + "/draft", "PUT", { draft: large });
    const result = await value<{ chat: Chat }>("/chats/" + chat.id);
    expect(result.chat.draft).toBe(large);
    const db = await mf.getD1Database("DB");
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
});
