import { queueSummary, runSummary, continueBackfill } from "./summaries";
import { DurableObject } from "cloudflare:workers";
import { chunks } from "./store";
import { runGeneration } from "./generation";
import { runTitle, queueTitle } from "./titles";
import { runPlugin, queueSuggestions } from "./plugins";

/** One SQLite-backed coordinator per generation, never a global singleton. */
export class Progress extends DurableObject<Env> {
  private activeController?: AbortController;
  private liveContent = "";
  private liveReasoning = "";
  private lastPublish = 0;
  private send(socket: WebSocket, value: unknown) {
    try {
      socket.send(JSON.stringify(value));
    } catch {
      socket.close(1011, "Disconnected");
    }
  }
  private broadcast(value: unknown) {
    for (const socket of this.ctx.getWebSockets()) this.send(socket, value);
  }
  publish(content: string, reasoning: string, force = false) {
    if (!force && Date.now() - this.lastPublish < 80) return;
    this.lastPublish = Date.now();
    const contentDelta = content.slice(this.liveContent.length),
      reasoningDelta = reasoning.slice(this.liveReasoning.length);
    this.liveContent = content;
    this.liveReasoning = reasoning;
    if (!this.ctx.getWebSockets().length) return;
    const c = chunks(contentDelta, 8192),
      r = chunks(reasoningDelta, 8192);
    for (let i = 0; i < Math.max(c.length, r.length); i++)
      this.broadcast({
        type: "delta",
        content: c[i] ?? "",
        reasoning: r[i] ?? "",
      });
  }
  async fetch(request: Request) {
    const url = new URL(request.url),
      id = url.pathname.split("/")[3]!,
      title = url.searchParams.get("kind") === "title";
    const pair = new WebSocketPair(),
      client = pair[0],
      server = pair[1];
    this.ctx.acceptWebSocket(server);
    // Register before awaiting state so completion cannot be missed during attach.
    if (!title) {
      const output = this.output();
      this.send(server, { type: "reset" });
      const content = this.activeController ? this.liveContent : output.content;
      const reasoning = this.activeController
        ? this.liveReasoning
        : output.reasoning;
      const c = chunks(content, 8192),
        r = chunks(reasoning, 8192);
      for (let i = 0; i < Math.max(c.length, r.length); i++)
        this.send(server, {
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
      this.send(server, { type: "done" });
      server.close(1000, "Complete");
    }
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(socket: WebSocket) {
    socket.close(1008, "Read only");
  }
  webSocketClose(socket: WebSocket) {
    socket.close(1000, "Closed");
  }
  webSocketError(socket: WebSocket) {
    socket.close(1011, "Disconnected");
  }
  private complete() {
    this.broadcast({ type: "done" });
    for (const socket of this.ctx.getWebSockets())
      socket.close(1000, "Complete");
  }
  settled() {
    this.complete();
  }
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
  isRunning() {
    return this.activeController !== undefined;
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
        if (value.length === previous) continue;
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
    this.publish(content, reasoning, true);
    return true;
  }
  async deviceCheckpoint(sequence: number, content: string, reasoning: string) {
    if (this.isCancelled()) return { accepted: false, cancelled: true };
    if (this.state("updatedAt") && sequence <= this.state("deviceSequence"))
      return { accepted: false, cancelled: false };
    this.checkpoint(content, reasoning);
    this.ctx.storage.sql.exec(
      "INSERT INTO state VALUES('deviceSequence',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      sequence,
    );
    await this.ctx.storage.setAlarm(Date.now() + 86400000);
    return { accepted: true, cancelled: false };
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
        const result = await runSummary(this.env, jobId, this, controller);
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
          await runPlugin(this.env, jobId, this, controller),
        );
      const result = await runGeneration(this.env, jobId, this, controller);
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
      await this.ctx.storage.setAlarm(Date.now() + 86400000);
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
    // Each queue runs in a separate invocation to stay within D1 Free's query
    // budget, while the parent Workflow waits before notifying observers.
    return kind === "summary"
      ? queueSummary(this.env, job.chat_id, job.message_id)
      : queueSuggestions(this.env, job.chat_id, job.message_id, transport);
  }
  async runTitle(jobId: string) {
    try {
      return await runTitle(this.env, jobId);
    } finally {
      this.complete();
      await this.ctx.storage.setAlarm(Date.now() + 86400000);
    }
  }
  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
