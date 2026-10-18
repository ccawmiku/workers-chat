import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { Store, HttpError, summary } from "../src/server/store";
import { newChat } from "../src/shared/chat";

let mf: Miniflare;
let db: D1Database;
let reads: string[] = [];
let store: Store;

beforeAll(async () => {
  mf = new Miniflare({
    workers: [
      {
        config: {
          name: "store-test",
          compatibilityDate: "2026-10-15",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents:
                  'export default { fetch() { return new Response("local"); } }',
              },
            },
          },
          env: { DB: { type: "d1", name: "store-db" } },
        },
      },
    ],
  });
  db = await mf.getD1Database("DB");
  for (const name of (await readdir("migrations"))
    .filter((n) => n.endsWith(".sql") && n < "0006.sql")
    .sort())
    for (const sql of (await readFile("migrations/" + name, "utf8"))
      .trim()
      .split("\n"))
      await db.prepare(sql).run();
  const observed = new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          reads.push(sql);
          return target.prepare(sql);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  store = new Store(observed);
});
afterAll(async () => {
  await mf?.dispose();
});

describe("immutable document reads", () => {
  it("reads a multipart current version in one query and preserves a pinned older version", async () => {
    const id = crypto.randomUUID(),
      value = { text: "🙂".repeat(300000) };
    await store.save(id, "fixture", value, 0);
    const old = await db
      .prepare("SELECT revision,kind,summary FROM documents WHERE id=?")
      .bind(id)
      .first<{ revision: number; kind: string; summary: string }>();
    await store.save(id, "fixture", { text: "new" }, 1);
    reads = [];
    expect((await store.get(id))?.value).toEqual({ text: "new" });
    expect(reads).toHaveLength(1);
    reads = [];
    expect((await store.get(id, old))?.value).toEqual(value);
    expect(reads).toHaveLength(1);
  });
  it("retains independent drafts and group removal overlays without writing on reads", async () => {
    const chat = newChat();
    await store.save(chat.id, "chat", chat, 0, summary(chat));
    await store.setDraft(chat.id, "independent draft");
    reads = [];
    const loaded = await store.get<typeof chat>(chat.id);
    expect(loaded?.value.draft).toBe("independent draft");
    expect(loaded?.value.groupId).toBeNull();
    expect(reads).toHaveLength(2);
    expect(reads.every((sql) => sql.startsWith("SELECT"))).toBe(true);
  });
  it("distinguishes absent documents from corrupted or expired immutable versions", async () => {
    expect(await store.get("absent")).toBeNull();
    reads = [];
    expect(await store.get("absent", null)).toBeNull();
    expect(reads).toEqual([]);
    const id = crypto.randomUUID();
    await db
      .prepare("INSERT INTO documents VALUES(?,'fixture','{}',1)")
      .bind(id)
      .run();
    await expect(store.get(id)).rejects.toMatchObject({ status: 500 });
    await expect(
      store.get(id, { revision: 8, kind: "fixture", summary: "{}" }),
    ).rejects.toBeInstanceOf(HttpError);
  });
});

it("uses scoped indexes for title history, task cleanup and foreign-key checks", async () => {
  const numbers =
    "WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<499) ";
  await db
    .prepare(
      numbers +
        "INSERT INTO documents SELECT 'bench-chat-'||i,'chat','{}',1 FROM n",
    )
    .run();
  await db
    .prepare(
      numbers +
        "INSERT INTO jobs(id,chat_id,message_id,status,created_at,updated_at,config) SELECT 'bench-job-'||i||'-'||j.value,'bench-chat-'||i,i||'-'||j.value,'complete',j.value,j.value,'{}' FROM n,json_each('[0,1,2,3]') j",
    )
    .run();
  await db
    .prepare(
      numbers +
        "INSERT INTO title_jobs(id,chat_id,message_id,manual,status,created_at,updated_at,config) SELECT 'bench-title-'||i||'-'||j.value,'bench-chat-'||i,i||'-'||j.value,1,'complete',j.value,j.value,'{}' FROM n,json_each('[0,1,2,3]') j",
    )
    .run();
  await db
    .prepare(
      numbers +
        "INSERT INTO documents SELECT 'bench-task-'||i||'-'||j.value,'summary-task',json_object('chatId','bench-chat-'||i),1 FROM n,json_each('[0,1,2,3]') j",
    )
    .run();
  const queries = {
    latestTitle:
      "SELECT id FROM title_jobs WHERE chat_id='bench-chat-42' ORDER BY created_at DESC,id DESC LIMIT 1",
    scopedTasks:
      "SELECT id FROM documents WHERE kind IN ('summary-state','summary-task','summary-backfill') AND json_extract(summary,'$.chatId')='bench-chat-42'",
    // Deleting any document checks referencing jobs, even a task with no children.
    deleteTask: "DELETE FROM documents WHERE id='bench-task-42-0'",
  };
  const measure = async () => {
    const result: Record<string, number> = {};
    for (const [name, sql] of Object.entries(queries))
      result[name] = (await db.prepare(sql).run()).meta.rows_read;
    await db
      .prepare(
        "INSERT INTO documents VALUES('bench-task-42-0','summary-task',?,1)",
      )
      .bind(JSON.stringify({ chatId: "bench-chat-42" }))
      .run();
    return result;
  };
  const before = await measure();
  for (const sql of (await readFile("migrations/0006.sql", "utf8"))
    .trim()
    .split("\n"))
    await db.prepare(sql).run();
  const after = await measure();
  for (const name of Object.keys(queries))
    expect(after[name]).toBeLessThan(before[name]! / 10);
  for (const [name, sql] of Object.entries(queries)) {
    const plan = (
      await db.prepare("EXPLAIN QUERY PLAN " + sql).all<{ detail: string }>()
    ).results
      .map((row) => row.detail)
      .join("\n");
    expect(plan, name).not.toMatch(/SCAN (?:jobs|title_jobs)/);
  }
  console.info("local D1 rows_read " + JSON.stringify({ before, after }));
});
