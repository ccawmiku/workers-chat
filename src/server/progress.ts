import { DurableObject } from "cloudflare:workers";
import { chunks } from "./store";
import { runGeneration } from "./generation";
import { runTitle, queueTitle } from "./titles";

/** One SQLite-backed coordinator per generation, never a global singleton. */
export class Progress extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS pieces(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,value TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value INTEGER NOT NULL)",
    );
  }
  private state(key: string) {
    return (
      this.ctx.storage.sql
        .exec<{ value: number }>("SELECT value FROM state WHERE key=?", key)
        .toArray()[0]?.value ?? 0
    );
  }
  isCancelled() {
    return this.state("cancelled") === 1;
  }
  checkpoint(content: string, reasoning: string) {
    if (this.isCancelled()) return false;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO state VALUES('updatedAt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        Date.now(),
      );
      for (const [kind, value] of Object.entries({ content, reasoning })) {
        const previous = this.state(kind + "Length");
        if (value.length < previous) throw new Error("生成进度不能回退");
        for (const chunk of chunks(value.slice(previous)))
          this.ctx.storage.sql.exec(
            "INSERT INTO pieces(kind,value) VALUES(?,?)",
            kind,
            chunk,
          );
        this.ctx.storage.sql.exec(
          "INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          kind + "Length",
          value.length,
        );
      }
    });
    return true;
  }
  output() {
    const rows = this.ctx.storage.sql
      .exec<{
        kind: string;
        value: string;
      }>("SELECT kind,value FROM pieces ORDER BY seq")
      .toArray();
    return {
      content: rows
        .filter((r) => r.kind === "content")
        .map((r) => r.value)
        .join(""),
      reasoning: rows
        .filter((r) => r.kind === "reasoning")
        .map((r) => r.value)
        .join(""),
      hasData: rows.length > 0,
      updatedAt: this.state("updatedAt"),
    };
  }
  cancel() {
    this.ctx.storage.sql.exec(
      "INSERT INTO state VALUES('cancelled',1) ON CONFLICT(key) DO UPDATE SET value=1",
    );
    return this.output();
  }
  async run(jobId: string) {
    try {
      return JSON.stringify(await runGeneration(this.env, jobId, this));
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + 86400000);
    }
  }
  async scheduleTitle(jobId: string) {
    const job = await this.env.DB.prepare(
      "SELECT chat_id FROM jobs WHERE id=? AND status='complete'",
    )
      .bind(jobId)
      .first<{ chat_id: string }>();
    if (!job) return null;
    try {
      return await queueTitle(this.env, job.chat_id);
    } catch {
      return null;
    }
  }
  async runTitle(jobId: string) {
    try {
      return await runTitle(this.env, jobId);
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + 86400000);
    }
  }
  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
