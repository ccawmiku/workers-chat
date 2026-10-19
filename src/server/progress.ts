import { DatabaseSync } from "node:sqlite";
import { queueSummary, runSummary, continueBackfill } from "./summaries";
import { chunks } from "./store";
import { runGeneration } from "./generation";
import { runTitle, queueTitle } from "./titles";
import { runPlugin, queueSuggestions } from "./plugins";
import type { Env } from "./env";

export class Progress {
  private activeController?: AbortController;
  private liveContent = "";
  private liveReasoning = "";
  private lastPublish = 0;
  private sockets = new Set<any>();
  private sql: DatabaseSync;

  constructor(
    public readonly name: string,
    public readonly env: Env,
  ) {
    this.sql = new DatabaseSync(":memory:");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS pieces(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,value TEXT NOT NULL)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value INTEGER NOT NULL)",
    );
  }

  private send(socket: any, value: unknown) {
    try {
      if (socket.readyState === 1 /* OPEN */) {
        socket.send(JSON.stringify(value));
      }
    } catch {
      this.sockets.delete(socket);
      try {
        socket.close(1011, "Disconnected");
      } catch {}
    }
  }

  private broadcast(value: unknown) {
    for (const socket of this.sockets) this.send(socket, value);
  }

  publish(content: string, reasoning: string, force = false) {
    if (!force && Date.now() - this.lastPublish < 80) return;
    this.lastPublish = Date.now();
    const contentDelta = content.slice(this.liveContent.length),
      reasoningDelta = reasoning.slice(this.liveReasoning.length);
    this.liveContent = content;
    this.liveReasoning = reasoning;
    if (!this.sockets.size) return;
    const c = chunks(contentDelta, 8192),
      r = chunks(reasoningDelta, 8192);
    for (let i = 0; i < Math.max(c.length, r.length); i++)
      this.broadcast({
        type: "delta",
        content: c[i] ?? "",
        reasoning: r[i] ?? "",
      });
  }

  async attachWebSocket(socket: any, title: boolean, id: string) {
    this.sockets.add(socket);
    socket.on("close", () => {
      this.sockets.delete(socket);
    });
    socket.on("error", () => {
      this.sockets.delete(socket);
      try {
        socket.close(1011, "Disconnected");
      } catch {}
    });

    if (!title) {
      const output = this.output();
      this.send(socket, { type: "reset" });
      const content = this.activeController ? this.liveContent : output.content;
      const reasoning = this.activeController
        ? this.liveReasoning
        : output.reasoning;
      const c = chunks(content, 8192),
        r = chunks(reasoning, 8192);
      for (let i = 0; i < Math.max(c.length, r.length); i++)
        this.send(socket, {
          type: "delta",
          content: c[i] ?? "",
          reasoning: r[i] ?? "",
        });
    }

    const row = await this.env.DB.prepare(
      title
        ? "SELECT status FROM title_jobs WHERE id=?"
        : "SELECT status FROM jobs WHERE id=?",
    )
      .bind(id)
      .first<{ status: string }>();

    if (!row || !["pending", "running"].includes(row.status)) {
      this.send(socket, { type: "done" });
      try {
        socket.close(1000, "Complete");
      } catch {}
      this.sockets.delete(socket);
    }
  }

  private complete() {
    this.broadcast({ type: "done" });
    for (const socket of this.sockets) {
      try {
        socket.close(1000, "Complete");
      } catch {}
    }
    this.sockets.clear();
  }

  settled() {
    this.complete();
  }

  private state(key: string) {
    const row = this.sql
      .prepare("SELECT value FROM state WHERE key=?")
      .get(key) as { value: number } | undefined;
    return row?.value ?? 0;
  }

  isCancelled() {
    return this.state("cancelled") === 1;
  }

  isRunning() {
    return this.activeController !== undefined;
  }

  checkpoint(content: string, reasoning: string) {
    if (this.isCancelled()) return false;
    this.sql.exec("BEGIN");
    try {
      this.sql
        .prepare(
          "INSERT INTO state VALUES('updatedAt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(Date.now());
      for (const [kind, value] of Object.entries({ content, reasoning })) {
        const previous = this.state(kind + "Length");
        if (value.length < previous) throw new Error("生成进度不能回退");
        if (value.length === previous) continue;
        for (const chunk of chunks(value.slice(previous)))
          this.sql
            .prepare("INSERT INTO pieces(kind,value) VALUES(?,?)")
            .run(kind, chunk);
        this.sql
          .prepare(
            "INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(kind + "Length", value.length);
      }
      this.sql.exec("COMMIT");
    } catch (e) {
      try {
        this.sql.exec("ROLLBACK");
      } catch {}
      throw e;
    }
    this.publish(content, reasoning, true);
    return true;
  }

  async deviceCheckpoint(sequence: number, content: string, reasoning: string) {
    if (this.isCancelled()) return { accepted: false, cancelled: true };
    if (this.state("updatedAt") && sequence <= this.state("deviceSequence"))
      return { accepted: false, cancelled: false };
    this.checkpoint(content, reasoning);
    this.sql
      .prepare(
        "INSERT INTO state VALUES('deviceSequence',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(sequence);
    return { accepted: true, cancelled: false };
  }

  output() {
    const rows = this.sql
      .prepare("SELECT kind,value FROM pieces ORDER BY seq")
      .all() as { kind: string; value: string }[];
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
    this.sql
      .prepare(
        "INSERT INTO state VALUES('cancelled',1) ON CONFLICT(key) DO UPDATE SET value=1",
      )
      .run();
    this.activeController?.abort();
    return this.output();
  }

  async run(jobId: string) {
    if (this.activeController) return JSON.stringify({ skipped: true });
    const controller = new AbortController();
    this.activeController = controller;
    try {
      const job = await this.env.DB.prepare(
        "SELECT config FROM jobs WHERE id=?",
      )
        .bind(jobId)
        .first<{ config: string }>();
      if (job && JSON.parse(job.config).kind === "summary") {
        const result = await runSummary(this.env, jobId, this as any, controller);
        const saved = await this.env.DB.prepare(
          "SELECT chat_id FROM jobs WHERE id=?",
        )
          .bind(jobId)
          .first<{ chat_id: string }>();
        if (saved) await continueBackfill(this.env, saved.chat_id);
        return JSON.stringify(result);
      }
      if (job && JSON.parse(job.config).kind === "plugin")
        return JSON.stringify(
          await runPlugin(this.env, jobId, this as any, controller),
        );
      const result = await runGeneration(this.env, jobId, this as any, controller);
      if (result.status === "complete") {
        const saved = await this.env.DB.prepare(
          "SELECT chat_id,message_id FROM jobs WHERE id=?",
        )
          .bind(jobId)
          .first<{ chat_id: string; message_id: string }>();
        if (saved)
          try {
            await Promise.allSettled([
              this.env.PROGRESS.getByName("post-summary-" + jobId).schedulePost(
                jobId,
                "summary",
              ),
              this.env.PROGRESS.getByName("post-suggest-" + jobId).schedulePost(
                jobId,
                "suggest",
              ),
            ]);
          } catch {
            /* Main response remains saved if a post-plugin cannot start. */
          }
      }
      return JSON.stringify(result);
    } finally {
      this.activeController = undefined;
      this.complete();
    }
  }

  async scheduleTitle(jobId: string) {
    const job = await this.env.DB.prepare(
      "SELECT chat_id,message_id FROM jobs WHERE id=? AND status='complete'",
    )
      .bind(jobId)
      .first<{ chat_id: string; message_id: string }>();
    if (!job) return null;
    try {
      const title = await queueTitle(this.env, job.chat_id);
      return title;
    } catch {
      return null;
    }
  }

  async schedulePost(
    jobId: string,
    kind: "summary" | "suggest",
    transport?: "device",
  ) {
    const job = await this.env.DB.prepare(
      "SELECT chat_id,message_id FROM jobs WHERE id=? AND status='complete'",
    )
      .bind(jobId)
      .first<{ chat_id: string; message_id: string }>();
    if (!job) return null;
    return await (kind === "summary"
      ? queueSummary(this.env, job.chat_id, job.message_id)
      : queueSuggestions(this.env, job.chat_id, job.message_id, transport));
  }

  async runTitle(jobId: string) {
    try {
      return await runTitle(this.env, jobId);
    } finally {
      this.complete();
    }
  }
}
