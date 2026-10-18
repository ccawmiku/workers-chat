import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

async function login(page: Page) {
  const { password } = JSON.parse(
    await readFile(
      join(homedir(), ".config/workers-chat/local-login.json"),
      "utf8",
    ),
  );
  await page.goto("/");
  await page.getByLabel("访问密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.locator(".new-chat").waitFor();
  const response = await page.request.post("/api/chats", {
    headers: { Origin: "http://localhost:5173" },
    data: {},
  });
  const chat = await response.json();
  await page.evaluate((id) => localStorage.setItem("lastChat", id), chat.id);
  return chat;
}

test("one bootstrap, one idle request per minute, zero hidden requests and one parameter write", async ({
  page,
}) => {
  const chat = await login(page);
  await page.clock.install();
  const calls: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/"))
      calls.push(r.method() + " " + new URL(r.url()).pathname);
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "当前聊天设置", exact: true }),
  ).toBeVisible();
  expect(calls).toEqual(["GET /api/bootstrap"]);
  calls.length = 0;
  for (let i = 0; i < 5; i++) {
    const response = page.waitForResponse("**/api/navigation");
    await page.clock.fastForward(60000);
    await response;
    await page.waitForTimeout(10);
  }
  expect(calls).toHaveLength(5); // Previously 100 requests during the same five minutes.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  calls.length = 0;
  await page.clock.fastForward(300000);
  expect(calls).toEqual([]);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => calls.length).toBe(2);
  await page.getByRole("button", { name: "当前聊天设置", exact: true }).click();
  calls.length = 0;
  const input = page.getByLabel("温度", { exact: true });
  await input.fill("0.5");
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/chats/" + chat.id) &&
      r.request().method() === "PATCH",
  );
  await input.blur();
  await saved;
  expect(calls).toEqual(["PATCH /api/chats/" + chat.id]);
  await input.focus();
  await input.blur();
  expect(calls).toHaveLength(1);
});

test("generation pushes without polling and completion bypasses an older in-flight snapshot", async ({
  page,
}) => {
  const chat = await login(page),
    jobId = crypto.randomUUID();
  chat.titleManual = true;
  chat.currentId = "answer";
  chat.messages = {
    question: {
      id: "question",
      parentId: null,
      role: "user",
      content: "Synthetic streaming question",
      status: "complete",
      createdAt: Date.now(),
    },
    answer: {
      id: "answer",
      parentId: "question",
      role: "assistant",
      content: "",
      status: "running",
      createdAt: Date.now(),
    },
  };
  let socket: { send: (value: string) => void } | undefined,
    connections = 0;
  await page.route("**/api/bootstrap?*", async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    await route.fulfill({
      json: {
        ...data,
        current: {
          chat,
          job: { id: jobId, status: "running" },
          titleJob: null,
          revision: 1,
        },
      },
    });
  });
  let releaseSnapshot!: () => void,
    snapshots = 0;
  const snapshotGate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  await page.route("**/api/chats/" + chat.id, async (route) => {
    if (++snapshots === 1) {
      await snapshotGate;
      return route.fulfill({
        json: {
          chat,
          job: { id: jobId, status: "running" },
          titleJob: null,
          revision: 1,
        },
      });
    }
    return route.fulfill({
      json: {
        chat: {
          ...chat,
          messages: {
            ...chat.messages,
            answer: {
              ...chat.messages.answer,
              content: "First second",
              status: "complete",
            },
          },
        },
        revision: 2,
        job: null,
        titleJob: null,
      },
    });
  });
  await page.routeWebSocket("**/api/jobs/*/events", (ws) => {
    socket = ws;
    connections++;
  });
  let releaseNavigation!: () => void;
  const navigationGate = new Promise<void>((resolve) => {
    releaseNavigation = resolve;
  });
  await page.route("**/api/navigation", async (route) => {
    const response = await route.fetch();
    await navigationGate;
    await route.fulfill({ response });
  });
  await page.clock.install();
  const calls: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/"))
      calls.push(new URL(r.url()).pathname);
  });
  await page.reload();
  await expect.poll(() => connections).toBe(1);
  calls.length = 0;
  socket!.send(JSON.stringify({ type: "reset" }));
  socket!.send(
    JSON.stringify({ type: "delta", content: "First ", reasoning: "" }),
  );
  socket!.send(
    JSON.stringify({ type: "delta", content: "second", reasoning: "" }),
  );
  await expect(page.locator("#text-answer")).toHaveText("First second");
  await page.clock.fastForward(30000);
  expect(calls).toEqual([]); // Previously about 60 HTTP reads over 30 seconds.
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect.poll(() => snapshots).toBe(1);
  socket!.send(JSON.stringify({ type: "done" }));
  releaseSnapshot();
  await expect.poll(() => snapshots).toBe(2);
  await expect(
    page.getByRole("button", { name: "停止生成", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("#text-answer")).toHaveText("First second");
  // Both refreshes should share the still-pending navigation request.
  releaseNavigation();
  await expect.poll(() => calls.length).toBe(3);
  expect(calls.sort()).toEqual(
    [
      "/api/chats/" + chat.id,
      "/api/chats/" + chat.id,
      "/api/navigation",
    ].sort(),
  );
});
