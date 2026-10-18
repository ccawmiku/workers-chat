import { generationDeadline } from "./deadline";
import {
  type Chat,
  type Settings,
  type Provider,
  estimateTokens,
  route,
  sanitizeUsage,
  uuid,
} from "../shared/chat";
import {
  type SummaryState,
  type SummaryRun,
  type SummaryConfig,
  summarySourceKey,
  summaryFor,
  summaryIndex,
  prepareSummary,
  normalizeSummary,
  defaultSummaryConfig,
} from "../shared/summaries";
import type { PluginRequest } from "../shared/plugins";
import { Store, HttpError, type Document, summary as chatBrief } from "./store";
import { decrypt, redactError } from "./security";
import { readCompletion, type CompletionOutput } from "../shared/completion";
import { obj, str, parameters, modelRef } from "./validation";
import type { Job } from "./generation";
import { fallbackRequest } from "./fallback-model";
const stateId = (id: string) => "summary-state:" + id;
const taskId = (id: string) => "summary-task:" + id;
type SummaryTask = {
  chatId: string;
  messageId: string;
  sourceKey: string;
  provider: Pick<Provider, "id" | "baseUrl" | "encryptedKey">;
  request: PluginRequest;
};
export async function summaryState(
  env: Env,
  id: string,
): Promise<Document<SummaryState>> {
  return (
    (await new Store(env.DB).get<SummaryState>(stateId(id))) ?? {
      value: { runs: [] },
      revision: 0,
    }
  );
}
export function validatedSummaryConfig(value: unknown): SummaryConfig {
  const p = { ...defaultSummaryConfig(), ...obj(value) };
  if (
    !["inherit", "none", "low", "medium", "high", "max"].includes(
      String(p.effort),
    ) ||
    typeof p.stream !== "boolean"
  )
    throw new HttpError(400, "摘要生成设置无效");
  return {
    model: modelRef(p.model),
    parameters: parameters(p.parameters),
    effort: p.effort,
    stream: p.stream,
    system: str(p.system, 100000),
  };
}
async function updateState(
  env: Env,
  id: string,
  change: (state: SummaryState) => void,
  extra: () => D1PreparedStatement[] = () => [],
) {
  const store = new Store(env.DB);
  for (let attempt = 0; attempt < 4; attempt++) {
    const doc = await summaryState(env, id);
    change(doc.value);
    try {
      await store.commit([
        ...store.planSave(
          stateId(id),
          "summary-state",
          doc.value,
          doc.revision,
          { id: stateId(id), chatId: id },
        ),
        ...extra(),
      ]);
      return;
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 409) || attempt === 3)
        throw e;
    }
  }
}
export async function queueSummary(
  env: Env,
  chatId: string,
  messageId: string,
  manual = false,
  requestedId?: string,
  fallback?: unknown,
) {
  const store = new Store(env.DB),
    doc = await store.get<Chat>(chatId);
  const chat = doc?.value,
    message = chat?.messages[messageId];
  if (
    !chat ||
    chat.deleted ||
    !message ||
    message.role !== "assistant" ||
    message.status === "running" ||
    !message.content.trim() ||
    (!manual && message.status !== "complete")
  )
    return null;
  const key = summarySourceKey(chat, messageId),
    state = await summaryState(env, chatId);
  const related = state.value.runs.filter(
    (r) => r.messageId === messageId && r.sourceKey === key,
  );
  if (related.some((r) => r.status === "running"))
    return related.find((r) => r.status === "running")!.id;
  if (!manual && related.length) return null;
  const settings = (await store.get<Settings>("settings"))?.value ?? {
    defaultModel: null,
    parameters: {},
    templates: [],
    titlePrompt: "",
    titleModel: null,
  };
  const providers = (await store.all<Provider>("provider")).map((p) => p.value);
  let prepared: ReturnType<typeof prepareSummary>;
  try {
    prepared = prepareSummary(
      chat,
      messageId,
      state.value,
      settings,
      providers,
      fallback !== undefined ? (modelRef(fallback) ?? undefined) : undefined,
    );
    if (fallback !== undefined)
      prepared = {
        ...prepared,
        ...fallbackRequest(
          settings,
          providers,
          fallback,
          prepared.request,
          prepared.config.parameters,
        ),
      };
  } catch (e) {
    if (fallback !== undefined) throw e;
    const failed: SummaryRun = {
      id: uuid(),
      messageId,
      sourceKey: key,
      status: "error",
      output: "",
      error: e instanceof Error ? e.message : "摘要配置无效",
      createdAt: Date.now(),
      config: {
        ...defaultSummaryConfig(),
        ...settings.replySummary,
        ...chat.summaryOverrides,
      },
      inputTokens: 0,
    };
    await updateState(env, chatId, (s) => {
      if (!s.runs.some((r) => r.messageId === messageId && r.sourceKey === key))
        s.runs.push(failed);
    });
    return null;
  }
  const id =
    requestedId ??
    (manual ? uuid() : "sum-" + messageId + "-" + key.replace(":", "-"));
  const accepted = summaryFor(chat, state.value, messageId);
  const run: SummaryRun = {
    id,
    messageId,
    sourceKey: key,
    status: "running",
    sourceIncomplete: message.status !== "complete",
    output: "",
    createdAt: Date.now(),
    config: prepared.config,
    model: prepared.modelRef,
    inputTokens: estimateTokens(
      prepared.request.messages.map((m) => m.content ?? "").join("\n"),
    ),
    ...(accepted ? { replaces: accepted.id } : {}),
  };
  const task: SummaryTask = {
    chatId,
    messageId,
    sourceKey: key,
    provider: {
      id: prepared.provider.id,
      baseUrl: prepared.provider.baseUrl,
      encryptedKey: prepared.provider.encryptedKey,
    },
    request: prepared.request,
  };
  try {
    await updateState(
      env,
      chatId,
      (s) => {
        if (
          s.runs.some(
            (r) =>
              r.id === id ||
              (r.messageId === messageId &&
                r.sourceKey === key &&
                r.status === "running"),
          )
        )
          throw new HttpError(409, "摘要已在生成");
        s.runs.push(run);
      },
      () => [
        ...store.planSave(taskId(id), "summary-task", task, 0, {
          id: taskId(id),
          chatId,
        }),
        env.DB.prepare(
          "INSERT INTO jobs(id,chat_id,message_id,status,attempted,created_at,updated_at,config) VALUES(?,?,?,?,?,?,?,?)",
        ).bind(
          id,
          chatId,
          messageId,
          "pending",
          0,
          Date.now(),
          Date.now(),
          JSON.stringify({ kind: "summary", post: true, runId: id }),
        ),
      ],
    );
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) return null;
    throw e;
  }
  try {
    await env.GENERATION.create({ id, params: { jobId: id } });
  } catch (e) {
    await finishSummary(
      env,
      id,
      { content: "", reasoning: "" },
      "error",
      "摘要任务启动失败，请手动重新生成",
    );
  }
  return id;
}
export async function finishSummary(
  env: Env,
  id: string,
  output: CompletionOutput,
  status: "complete" | "error" | "stopped",
  failure?: string,
) {
  const store = new Store(env.DB),
    job = await env.DB.prepare("SELECT * FROM jobs WHERE id=?")
      .bind(id)
      .first<Job>();
  if (!job || !["pending", "running"].includes(job.status)) return;
  const chat = (await store.get<Chat>(job.chat_id))?.value;
  if (!chat) {
    await env.DB.prepare(
      "UPDATE jobs SET status='error',error='原聊天已删除',updated_at=? WHERE id=?",
    )
      .bind(Date.now(), id)
      .run();
    return;
  }
  let normalized: ReturnType<typeof normalizeSummary> | undefined;
  if (status === "complete")
    try {
      normalized = normalizeSummary(output.content);
    } catch (e) {
      status = "error";
      failure = e instanceof Error ? e.message : "摘要格式无效";
    }
  await updateState(
    env,
    job.chat_id,
    (s) => {
      const run = s.runs.find((r) => r.id === id);
      if (!run) return;
      const valid =
        chat?.messages[run.messageId] &&
        summarySourceKey(chat, run.messageId) === run.sourceKey;
      run.output = normalized?.output ?? output.content;
      run.summary = normalized?.summary;
      run.warning = normalized?.warning;
      run.usage = sanitizeUsage(output.usage);
      run.elapsedMs = Date.now() - job.created_at;
      run.error = failure;
      run.status = !valid
        ? "stale"
        : status === "complete"
          ? run.replaces
            ? "candidate"
            : "complete"
          : status === "stopped"
            ? "cancelled"
            : "error";
    },
    () => [
      env.DB.prepare(
        "UPDATE jobs SET status=?,error=?,updated_at=? WHERE id=? AND status IN ('pending','running')",
      ).bind(status, failure ?? null, Date.now(), id),
    ],
  );
  const task = await store.get<SummaryTask>(taskId(id));
  if (task?.value.provider.encryptedKey) {
    delete task.value.provider.encryptedKey;
    await store.save(taskId(id), "summary-task", task.value, task.revision, {
      id: taskId(id),
      chatId: job.chat_id,
    });
  }
}
export async function runSummary(
  env: Env,
  id: string,
  progress: import("./progress").Progress,
  controller: AbortController,
) {
  const job = await env.DB.prepare(
    "UPDATE jobs SET attempted=1,status='running',updated_at=? WHERE id=? AND attempted=0 AND status='pending' RETURNING *",
  )
    .bind(Date.now(), id)
    .first<Job>();
  if (!job) return { status: "summary-skipped" };
  const task = (await new Store(env.DB).get<SummaryTask>(taskId(id)))?.value;
  if (!task) {
    await finishSummary(
      env,
      id,
      { content: "", reasoning: "" },
      "error",
      "摘要请求快照不存在，请手动重新生成",
    );
    return { status: "summary-missing" };
  }
  const output: CompletionOutput = { content: "", reasoning: "" };
  let key = "",
    lastCheckpoint = 0;
  const disposeDeadline = generationDeadline(controller);
  try {
    key = task.provider.encryptedKey
      ? await decrypt(task.provider.encryptedKey, env.ENCRYPTION_KEY)
      : "";
    const signal = controller.signal;
    const response = await fetch(task.provider.baseUrl + "/chat/completions", {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: "Bearer " + key } : {}),
      },
      body: JSON.stringify(task.request),
      signal,
    });
    await readCompletion(response, task.request.stream, signal, output, () => {
      progress.publish(output.content, output.reasoning);
      if (Date.now() - lastCheckpoint > 2000) {
        progress.checkpoint(output.content, output.reasoning);
        lastCheckpoint = Date.now();
      }
    });
    progress.checkpoint(output.content, output.reasoning);
    await finishSummary(env, id, output, "complete");
  } catch (e) {
    await finishSummary(
      env,
      id,
      output,
      progress.isCancelled() ? "stopped" : "error",
      redactError(e instanceof Error ? e.message : "摘要生成失败", key),
    );
  } finally {
    disposeDeadline();
  }
  return { status: "summary-complete" };
}
export async function summaryEndpoint(
  env: Env,
  doc: Document<Chat>,
  body: Record<string, unknown>,
) {
  const chat = doc.value,
    action = body.action,
    store = new Store(env.DB);
  if (action === "configure") {
    chat.summaryOverrides =
      body.config === null ? undefined : validatedSummaryConfig(body.config);
    await store.save(chat.id, "chat", chat, doc.revision, chatBrief(chat));
    return { ok: true };
  }
  const state = await summaryState(env, chat.id);
  if (action === "discard-candidates") {
    if (
      !Array.isArray(body.runIds) ||
      body.runIds.length > 1000 ||
      body.runIds.some((id) => typeof id !== "string" || id.length > 128)
    )
      throw new HttpError(400, "摘要候选列表无效");
    const ids = new Set(body.runIds);
    const dropped = state.value.runs
      .filter((r) => r.status === "candidate" && ids.has(r.id))
      .map((r) => r.id);
    if (dropped.length) {
      const remove = new Set(dropped);
      let removed: string[] = [];
      await updateState(
        env,
        chat.id,
        (s) => {
          removed = s.runs
            .filter((r) => r.status === "candidate" && remove.has(r.id))
            .map((r) => r.id);
          const finalIds = new Set(removed);
          s.runs = s.runs.filter((r) => !finalIds.has(r.id));
        },
        () => [
          env.DB.prepare(
            "DELETE FROM documents WHERE id IN (SELECT value FROM json_each(?))",
          ).bind(JSON.stringify(removed.map(taskId))),
        ],
      );
    }
    return { ok: true };
  }
  const run =
    typeof body.runId === "string"
      ? state.value.runs.find((r) => r.id === body.runId)
      : undefined;
  if (action === "request")
    return run
      ? ((await store.get<SummaryTask>(taskId(run.id)))?.value.request ?? null)
      : null;
  if (action === "regenerate") {
    const messageId = str(body.messageId, 128);
    if (!chat.messages[messageId]) throw new HttpError(404, "回复不存在");
    return { jobId: await queueSummary(env, chat.id, messageId, true) };
  }
  if (action === "backfill") {
    // One persisted chain; each completion schedules at most the next missing item.
    const path = route(chat),
      accepted = summaryIndex(chat, state.value, path),
      ids = path
        .filter(
          (m) =>
            m.role === "assistant" &&
            m.status === "complete" &&
            !accepted.has(m.id),
        )
        .map((m) => m.id);
    const id = "summary-backfill:" + chat.id,
      old = await store.get<Backfill>(id);
    if (old?.value.activeId || old?.value.ids.length)
      return { jobId: await continueBackfill(env, chat.id) };
    await store.save(id, "summary-backfill", { ids }, old?.revision ?? 0, {
      id,
      chatId: chat.id,
    });
    return { jobId: await continueBackfill(env, chat.id) };
  }
  if (!run) throw new HttpError(404, "摘要记录不存在");
  if (action === "fallback") {
    if (
      run.status !== "error" ||
      summarySourceKey(chat, run.messageId) !== run.sourceKey
    )
      throw new HttpError(409, "该失败摘要已失效");
    if (
      state.value.runs.findLast(
        (r) => r.messageId === run.messageId && r.sourceKey === run.sourceKey,
      )?.id !== run.id
    )
      throw new HttpError(409, "此回复已有更新的摘要任务");
    return {
      jobId: await queueSummary(
        env,
        chat.id,
        run.messageId,
        true,
        undefined,
        body.model,
      ),
    };
  }
  if (action === "cancel") {
    const output = await env.PROGRESS.getByName(run.id).cancel();
    await finishSummary(env, run.id, output, "stopped");
    return { ok: true };
  }
  if (action === "dismiss") {
    await updateState(env, chat.id, (s) => {
      const r = s.runs.find((r) => r.id === run.id);
      if (r?.status === "candidate") r.status = "superseded";
    });
    return { ok: true };
  }
  if (action === "accept") {
    if (
      run.status !== "candidate" ||
      !chat.messages[run.messageId] ||
      summarySourceKey(chat, run.messageId) !== run.sourceKey
    )
      throw new HttpError(409, "该摘要候选已失效，请重新生成");
    await updateState(env, chat.id, (s) => {
      const r = s.runs.find((v) => v.id === run.id);
      if (r?.status !== "candidate") throw new HttpError(409, "该候选已处理");
      for (const old of s.runs)
        if (
          old.messageId === r.messageId &&
          old.sourceKey === r.sourceKey &&
          old.status === "complete"
        )
          old.status = "superseded";
      r.status = "complete";
    });
    return { ok: true };
  }
  throw new HttpError(400, "未知摘要操作");
}
type Backfill = { ids: string[]; activeId?: string; activeMessageId?: string };
export async function continueBackfill(env: Env, chatId: string) {
  const store = new Store(env.DB),
    id = "summary-backfill:" + chatId;
  // Persist a claim before enqueueing. Unrelated automatic completions cannot
  // advance a live chain; repeated requests resume an interrupted enqueue.
  for (let attempt = 0; attempt < 4; attempt++) {
    const batch = await store.get<Backfill>(id);
    if (!batch) return null;
    const b = batch.value;
    if (b.activeId) {
      const job = await env.DB.prepare("SELECT status FROM jobs WHERE id=?")
        .bind(b.activeId)
        .first<{ status: string }>();
      if (job && ["pending", "running"].includes(job.status)) return b.activeId;
      if (!job && b.activeMessageId) {
        const queued = await queueSummary(
          env,
          chatId,
          b.activeMessageId,
          true,
          b.activeId,
        );
        if (queued) return queued;
      }
      delete b.activeId;
      delete b.activeMessageId;
    }
    const next = b.ids.shift();
    if (next) {
      b.activeId = uuid();
      b.activeMessageId = next;
    }
    try {
      await store.save(id, "summary-backfill", b, batch.revision, {
        id,
        chatId,
      });
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) continue;
      throw e;
    }
    if (!next) return null;
    const queued = await queueSummary(env, chatId, next, true, b.activeId);
    if (queued && queued !== b.activeId) {
      const fresh = await store.get<Backfill>(id);
      if (fresh && fresh.value.activeId === b.activeId) {
        fresh.value.activeId = queued;
        await store.save(id, "summary-backfill", fresh.value, fresh.revision, {
          id,
          chatId,
        });
      }
    }
    if (queued) return queued;
    // Configuration errors are visible on their own reply. Continue the chain
    // on the next explicit resume instead of recursively exhausting an invocation.
    return null;
  }
  return null;
}
export async function cloneSummaries(
  env: Env,
  original: Chat,
  copy: Chat,
  forkId?: string,
) {
  const source = (await summaryState(env, original.id)).value;
  const old = forkId
      ? route(original, forkId)
      : Object.values(original.messages),
    fresh = Object.values(copy.messages);
  const mapping = new Map(old.map((m, index) => [m.id, fresh[index]?.id]));
  const runs: SummaryRun[] = [];
  for (const r of source.runs) {
    const target = mapping.get(r.messageId);
    if (
      !target ||
      !copy.messages[target] ||
      r.status !== "complete" ||
      summaryFor(original, source, r.messageId)?.id !== r.id
    )
      continue;
    runs.push({
      ...r,
      id: uuid(),
      messageId: target,
      sourceKey: summarySourceKey(copy, target),
    });
  }
  if (runs.length)
    await new Store(env.DB).save(
      stateId(copy.id),
      "summary-state",
      { runs },
      0,
      { id: stateId(copy.id), chatId: copy.id },
    );
}
export async function planPruneSummaries(
  env: Env,
  chatId: string,
  removed: string[],
) {
  const doc = await summaryState(env, chatId),
    ids = new Set(removed),
    dropped = doc.value.runs.filter((r) => ids.has(r.messageId));
  if (!dropped.length)
    return {
      statements: [] as D1PreparedStatement[],
      cancelIds: [] as string[],
    };
  doc.value.runs = doc.value.runs.filter((r) => !ids.has(r.messageId));
  const store = new Store(env.DB);
  return {
    statements: [
      ...store.planSave(
        stateId(chatId),
        "summary-state",
        doc.value,
        doc.revision,
        { id: stateId(chatId), chatId },
      ),
      env.DB.prepare(
        "DELETE FROM documents WHERE id IN (SELECT value FROM json_each(?))",
      ).bind(JSON.stringify(dropped.map((r) => taskId(r.id)))),
    ],
    cancelIds: dropped.filter((r) => r.status === "running").map((r) => r.id),
  };
}
