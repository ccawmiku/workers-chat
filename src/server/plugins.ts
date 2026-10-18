import { generationDeadline } from "./deadline";
import { summaryState } from "./summaries";
import {
  type Chat,
  type Settings,
  type Provider,
  addMessage,
  route,
  defaultSettings,
  sanitizeUsage,
} from "../shared/chat";
import {
  type PluginState,
  type PluginRun,
  type PluginFlow,
  type PluginDefinition,
  type PluginRequest,
  emptyPluginState,
  enabledPlugins,
  definitions,
  preparePlugin,
  normalizePluginOutput,
  flowInjections,
  flowClarifications,
} from "../shared/plugins";
import { type Document, Store, HttpError, summary } from "./store";
import { type Job, startGeneration } from "./generation";
import { readCompletion, type CompletionOutput } from "../shared/completion";
import { decrypt, redactError, digest } from "./security";
import { str } from "./validation";
import { validatedBindings } from "./plugin-validation";

export type PluginTask = {
  kind: "plugin";
  runId: string;
  flowId?: string;
  transport?: "device";
  provider: Pick<Provider, "id" | "baseUrl" | "encryptedKey">;
  request: PluginRequest;
};
const stateId = (id: string) => "plugin-state:" + id;
const taskId = (id: string) => "plugin-task:" + id;
const baselines = new WeakMap<Document<PluginState>, PluginState>();
export async function pluginState(env: Env, id: string) {
  const doc = (await new Store(env.DB).get<PluginState>(stateId(id))) ?? {
    value: emptyPluginState(),
    revision: 0,
  };
  baselines.set(doc, structuredClone(doc.value));
  return doc;
}
async function config(env: Env) {
  const store = new Store(env.DB);
  return {
    settings:
      (await store.get<Settings>("settings"))?.value ?? defaultSettings(),
    providers: (await store.all<Provider>("provider")).map((p) => p.value),
  };
}
async function saveState(
  env: Env,
  id: string,
  doc: Document<PluginState>,
  extra: D1PreparedStatement[] = [],
) {
  const store = new Store(env.DB),
    base = baselines.get(doc) ?? structuredClone(doc.value),
    wanted = structuredClone(doc.value);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await store.commit([
        ...store.planSave(
          stateId(id),
          "plugin-state",
          doc.value,
          doc.revision,
          { id: stateId(id), chatId: id },
        ),
        ...extra,
      ]);
      doc.revision++;
      baselines.set(doc, structuredClone(doc.value));
      return;
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 409) || attempt === 3)
        throw e;
      const fresh = await pluginState(env, id);
      // Rebase only fields this operation actually changed. Post-response jobs
      // may finish while a user confirms a different plugin in the next turn.
      for (const key of ["runs", "flows"] as const) {
        const rows = fresh.value[key] as {
          id: string;
          [key: string]: unknown;
        }[];
        for (const row of wanted[key]) {
          const before = base[key].find((r) => r.id === row.id) as
            Record<string, unknown> | undefined;
          const target = rows.find((r) => r.id === row.id);
          if (!before) {
            if (!target) rows.push(structuredClone(row));
            continue;
          }
          if (!target) throw new HttpError(409, "插件记录已被删除");
          for (const field of new Set([
            ...Object.keys(before),
            ...Object.keys(row),
          ])) {
            const value = (row as unknown as Record<string, unknown>)[field];
            if (JSON.stringify(value) === JSON.stringify(before[field]))
              continue;
            if (
              JSON.stringify(target[field]) !== JSON.stringify(before[field]) &&
              JSON.stringify(target[field]) !== JSON.stringify(value)
            )
              throw new HttpError(
                409,
                "此插件已在其他请求中更新，请刷新后重试",
              );
            if (value === undefined) delete target[field];
            else target[field] = structuredClone(value);
          }
        }
      }
      if (base.activeFlowId !== wanted.activeFlowId)
        fresh.value.activeFlowId = wanted.activeFlowId;
      doc.value = fresh.value;
      doc.revision = fresh.revision;
    }
  }
}
async function signature(chat: Chat, settings: Settings) {
  return digest(
    JSON.stringify([
      route(chat).map((m) => ({ role: m.role, content: m.content })),
      chat.system,
      chat.model ?? settings.defaultModel,
      chat.parameters,
      settings.parameters,
      chat.effort,
      chat.stream,
      chat.rounds,
      enabledPlugins(chat, settings).filter(
        (p) => p.kind === "analysis" || p.kind === "clarify",
      ),
    ]),
  );
}
async function markChat(env: Env, id: string, pending: Chat["pluginPending"]) {
  const store = new Store(env.DB);
  for (let i = 0; i < 4; i++) {
    const doc = await store.get<Chat>(id);
    if (!doc) return;
    doc.value.pluginPending = pending;
    try {
      await store.save(id, "chat", doc.value, doc.revision, summary(doc.value));
      return;
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 409) || i === 3) throw e;
    }
  }
}
export async function pluginView(
  env: Env,
  chat: Chat,
  active?: { id: string; kind?: string; transport?: string } | null,
) {
  const state = chat.plugins?.length
    ? (await pluginState(env, chat.id)).value
    : emptyPluginState();
  if (active?.kind !== "plugin") return { pluginState: state, pluginJob: null };
  const doc = await new Store(env.DB).get<PluginTask>(taskId(active.id));
  const delivery =
    doc?.value.transport === "device"
      ? await env.DB.prepare(
          "UPDATE jobs SET attempted=2 WHERE id=? AND attempted=1 AND status='running' RETURNING id",
        )
          .bind(active.id)
          .first()
      : null;
  return {
    pluginState: state,
    pluginJob: doc
      ? {
          id: active.id,
          runId: doc.value.runId,
          transport: doc.value.transport,
          ...(delivery
            ? {
                direct: {
                  providerId: doc.value.provider.id,
                  baseUrl: doc.value.provider.baseUrl,
                  hasKey: !!doc.value.provider.encryptedKey,
                  request: doc.value.request,
                },
              }
            : {}),
        }
      : null,
  };
}
export async function clonePlugins(
  env: Env,
  source: Chat,
  copy: Chat,
  forkId?: string,
) {
  delete copy.pluginPending;
  if (!source.plugins?.length) return;
  const original = (await pluginState(env, source.id)).value;
  const oldMessages = forkId
      ? route(source, forkId)
      : Object.values(source.messages),
    newMessages = Object.values(copy.messages);
  const messages = new Map(
    oldMessages.map((m, i) => [m.id, newMessages[i]?.id]),
  );
  const runs = original.runs.filter((r) =>
      r.anchorId ? messages.has(r.anchorId) : !forkId,
    ),
    runIds = new Map(runs.map((r) => [r.id, crypto.randomUUID()]));
  const flows = original.flows.filter((f) => messages.has(f.userId)),
    flowIds = new Map(flows.map((f) => [f.id, crypto.randomUUID()]));
  const cloned: PluginState = {
    runs: runs.map((r) => ({
      ...structuredClone(r),
      id: runIds.get(r.id)!,
      flowId: r.flowId ? flowIds.get(r.flowId) : undefined,
      anchorId: r.anchorId ? (messages.get(r.anchorId) ?? null) : null,
      contextAnchorId: r.contextAnchorId
        ? (messages.get(r.contextAnchorId) ?? null)
        : null,
      rewriteMessageId: r.rewriteMessageId
        ? messages.get(r.rewriteMessageId)
        : undefined,
      replaces: r.replaces ? runIds.get(r.replaces) : undefined,
      status: r.status === "running" ? "cancelled" : r.status,
    })),
    flows: flows.map((f) => ({
      ...structuredClone(f),
      id: flowIds.get(f.id)!,
      userId: messages.get(f.userId)!,
      mainMessageId: f.mainMessageId
        ? messages.get(f.mainMessageId)
        : undefined,
      results: f.results.flatMap((id) => runIds.get(id) ?? []),
      status: f.status === "running" ? "cancelled" : f.status,
    })),
  };
  const current = cloned.flows.findLast(
    (f) =>
      ["waiting", "error", "debug"].includes(f.status) &&
      route(copy).some((m) => m.id === f.userId),
  );
  if (current) {
    cloned.activeFlowId = current.id;
    copy.pluginPending = current.status as Chat["pluginPending"];
  }
  await new Store(env.DB).save(stateId(copy.id), "plugin-state", cloned, 0, {
    id: stateId(copy.id),
    chatId: copy.id,
  });
}
export async function planPruneMessagePlugins(
  env: Env,
  chat: Chat,
  removed: string[],
) {
  if (!chat.plugins?.length) return [];
  const store = new Store(env.DB),
    state = await pluginState(env, chat.id),
    ids = new Set(removed);
  const dropped = state.value.runs.filter(
      (r) =>
        (r.anchorId && ids.has(r.anchorId)) ||
        (r.rewriteMessageId && ids.has(r.rewriteMessageId)),
    ),
    runIds = new Set(dropped.map((r) => r.id));
  state.value.runs = state.value.runs.filter((r) => !runIds.has(r.id));
  state.value.flows = state.value.flows.filter(
    (f) => !ids.has(f.userId) && !(f.mainMessageId && ids.has(f.mainMessageId)),
  );
  for (const f of state.value.flows)
    f.results = f.results.filter((id) => !runIds.has(id));
  const currentIds = new Set(route(chat).map((m) => m.id)),
    flow = state.value.flows.findLast(
      (f) =>
        currentIds.has(f.userId) &&
        ["waiting", "running", "error", "debug"].includes(f.status),
    );
  state.value.activeFlowId = flow?.id;
  chat.pluginPending = flow?.status as Chat["pluginPending"];
  return [
    ...store.planSave(
      stateId(chat.id),
      "plugin-state",
      state.value,
      state.revision,
      { id: stateId(chat.id), chatId: chat.id },
    ),
    ...dropped.flatMap((r) => [
      env.DB.prepare("DELETE FROM documents WHERE id=?").bind(taskId(r.id)),
      env.DB.prepare("DELETE FROM jobs WHERE id=? AND chat_id=?").bind(
        r.id,
        chat.id,
      ),
    ]),
  ];
}
export async function removePlugins(env: Env, chatId: string) {
  await env.DB.prepare(
    "DELETE FROM documents WHERE kind IN ('plugin-state','plugin-task') AND json_extract(summary,'$.chatId')=?",
  )
    .bind(chatId)
    .run();
}
export async function selectPluginFlow(env: Env, chat: Chat) {
  if (!chat.plugins?.length) return;
  const state = await pluginState(env, chat.id),
    ids = new Set(route(chat).map((m) => m.id));
  const flow = state.value.flows.findLast(
    (f) =>
      ids.has(f.userId) && ["waiting", "error", "debug"].includes(f.status),
  );
  state.value.activeFlowId = flow?.id;
  chat.pluginPending = flow?.status as Chat["pluginPending"];
  await saveState(env, chat.id, state);
}
async function enqueue(
  env: Env,
  chat: Chat,
  stateDoc: Document<PluginState>,
  p: PluginDefinition,
  input: string,
  anchorId: string | null,
  transport?: "device",
  flow?: PluginFlow,
  replaces?: string,
  rewriteMessageId?: string,
  queuedId?: string,
) {
  const { settings, providers } = await config(env),
    prepared = preparePlugin(
      chat,
      p,
      settings,
      providers,
      stateDoc.value,
      input,
      anchorId,
      p.kind === "analysis" && flow
        ? flowClarifications(stateDoc.value, flow)
        : [],
      (await summaryState(env, chat.id)).value,
    );
  const id = queuedId ?? crypto.randomUUID(),
    run: PluginRun = {
      id,
      plugin: p,
      flowId: flow?.id,
      anchorId: rewriteMessageId ?? flow?.userId ?? anchorId,
      contextAnchorId: anchorId,
      ...(rewriteMessageId ? { rewriteMessageId } : {}),
      input,
      output: "",
      status: "running",
      createdAt: Date.now(),
      metrics: prepared.metrics,
      model: prepared.modelRef,
      ...(replaces ? { replaces } : {}),
    };
  const request = prepared.request;
  const task: PluginTask = {
    kind: "plugin",
    runId: id,
    flowId: flow?.id,
    transport,
    provider: {
      id: prepared.provider.id,
      baseUrl: prepared.provider.baseUrl,
      encryptedKey: prepared.provider.encryptedKey,
    },
    request,
  };
  stateDoc.value.runs.push(run);
  if (flow && !replaces) {
    flow.status = "running";
    flow.results.push(id);
  }
  const store = new Store(env.DB);
  await saveState(env, chat.id, stateDoc, [
    ...store.planSave(taskId(id), "plugin-task", task, 0, {
      id: taskId(id),
      chatId: chat.id,
    }),
    env.DB.prepare(
      "INSERT INTO jobs(id,chat_id,message_id,status,attempted,created_at,updated_at,config) VALUES(?,?,?,?,?,?,?,?)",
    ).bind(
      id,
      chat.id,
      id,
      transport ? "running" : "pending",
      transport ? 1 : 0,
      Date.now(),
      Date.now(),
      JSON.stringify({
        kind: "plugin",
        runId: id,
        transport,
        post: p.kind === "suggest",
      }),
    ),
  ]);
  if (transport) await env.PROGRESS.getByName(id).deviceCheckpoint(0, "", "");
  else
    try {
      await env.GENERATION.create({ id, params: { jobId: id } });
    } catch {
      await finishPlugin(
        env,
        id,
        { content: "", reasoning: "" },
        "error",
        "插件后台任务启动失败",
      );
    }
  return id;
}
export async function startPluginFlow(
  env: Env,
  chat: Chat,
  revision: number,
  settings: Settings,
  transport?: "device",
  debug = false,
  reuseMessageId?: string,
  clearDraft = false,
) {
  const selected = enabledPlugins(chat, settings).filter(
    (p) => p.kind === "analysis" || p.kind === "clarify",
  );
  if (!selected.length) return false;
  const state = await pluginState(env, chat.id),
    user = chat.messages[chat.currentId!]!;
  const flow: PluginFlow = {
    id: crypto.randomUUID(),
    userId: user.id,
    definitions: structuredClone(selected),
    index: 0,
    results: [],
    debug,
    transport,
    status: "running",
    signature: await signature(chat, settings),
  };
  if (reuseMessageId) {
    const old = state.value.flows.findLast(
      (f) =>
        f.mainMessageId === reuseMessageId ||
        f.userId === chat.messages[reuseMessageId]?.parentId,
    );
    if (old)
      for (const id of old.results) {
        const run = state.value.runs.find((r) => r.id === id);
        if (run && run.status === "answered")
          state.value.runs.push({
            ...structuredClone(run),
            id: crypto.randomUUID(),
            flowId: flow.id,
            anchorId: user.id,
            contextAnchorId: user.parentId,
            input: user.content,
          });
      }
  }
  state.value.flows.push(flow);
  state.value.activeFlowId = flow.id;
  chat.pluginPending = "running";
  if (clearDraft) chat.draft = "";
  const store = new Store(env.DB);
  await store.commit([
    ...store.planSave(
      chat.id,
      "chat",
      chat,
      revision,
      summary(chat),
      clearDraft ? store.planDraft(chat.id, "") : [],
    ),
    ...store.planSave(
      stateId(chat.id),
      "plugin-state",
      state.value,
      state.revision,
      { id: stateId(chat.id), chatId: chat.id },
    ),
  ]);
  await advanceFlow(env, chat.id, flow.id);
  return true;
}
export async function advanceFlow(env: Env, chatId: string, flowId: string) {
  try {
    await advance(env, chatId, flowId);
  } catch (error) {
    const state = await pluginState(env, chatId),
      flow = state.value.flows.find((f) => f.id === flowId);
    if (flow) {
      flow.status = "error";
      flow.error = error instanceof Error ? error.message : "插件流程无法继续";
      await saveState(env, chatId, state);
      await markChat(env, chatId, "error");
    }
  }
}
async function advance(env: Env, chatId: string, flowId: string) {
  const store = new Store(env.DB),
    state = await pluginState(env, chatId),
    flow = state.value.flows.find((f) => f.id === flowId),
    chatDoc = await store.get<Chat>(chatId);
  if (
    !flow ||
    !chatDoc ||
    flow.status === "cancelled" ||
    flow.status === "waiting" ||
    flow.status === "main" ||
    flow.status === "complete"
  )
    return;
  const chat = chatDoc.value,
    user = chat.messages[flow.userId];
  if (!user) return;
  while (flow.index < flow.definitions.length) {
    const p = flow.definitions[flow.index]!;
    const reused = state.value.runs.findLast(
      (r) =>
        r.flowId === flow.id && r.plugin.id === p.id && r.status === "answered",
    );
    if (reused) {
      if (!flow.results.includes(reused.id)) flow.results.push(reused.id);
      flow.index++;
      continue;
    }
    await markChat(env, chatId, "running");
    await enqueue(
      env,
      chat,
      state,
      p,
      user.content,
      user.parentId,
      flow.transport,
      flow,
    );
    return;
  }
  if (flow.debug) {
    flow.status = "debug";
    await saveState(env, chatId, state);
    await markChat(env, chatId, "debug");
    return;
  }
  const { settings, providers } = await config(env);
  const mainChat = await store.get<Chat>(chatId);
  if (!mainChat) return;
  mainChat.value.currentId = flow.userId;
  delete mainChat.value.pluginPending;
  const jobId = await startGeneration(
    env,
    mainChat.value,
    mainChat.revision,
    settings,
    providers,
    undefined,
    false,
    flow.transport,
    flowInjections(state.value, flow),
  );
  const job = await env.DB.prepare("SELECT message_id FROM jobs WHERE id=?")
    .bind(jobId)
    .first<{ message_id: string }>();
  flow.mainMessageId = job?.message_id;
  flow.status = "main";
  delete state.value.activeFlowId;
  await saveState(env, chatId, state);
}
export async function finishPlugin(
  env: Env,
  id: string,
  output: CompletionOutput,
  status: "complete" | "error" | "stopped",
  failure?: string,
) {
  for (let attempt = 0; attempt < 4; attempt++)
    try {
      return await finishPluginOnce(env, id, output, status, failure);
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 409) || attempt === 3)
        throw e;
    }
}
async function finishPluginOnce(
  env: Env,
  id: string,
  output: CompletionOutput,
  status: "complete" | "error" | "stopped",
  failure?: string,
) {
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id=?")
    .bind(id)
    .first<Job>();
  if (!job) return;
  if (!["pending", "running"].includes(job.status)) return;
  const state = await pluginState(env, job.chat_id),
    run = state.value.runs.find((r) => r.id === id);
  if (!run) return;
  const taskDoc = await new Store(env.DB).get<PluginTask>(taskId(id));
  let text = output.content;
  if (status === "complete")
    try {
      text = normalizePluginOutput(run.plugin, text);
    } catch (e) {
      status = "error";
      failure = e instanceof Error ? e.message : "插件结果格式错误";
    }
  run.output = text;
  if (run.plugin.kind === "analysis") run.originalOutput = output.content;
  run.usage = sanitizeUsage(output.usage);
  run.elapsedMs = Date.now() - job.created_at;
  run.status =
    status === "complete"
      ? run.replaces
        ? "candidate"
        : ["clarify", "analysis"].includes(run.plugin.kind)
          ? "waiting"
          : "complete"
      : status === "stopped"
        ? "cancelled"
        : "error";
  run.error = failure;
  if (run.plugin.kind === "rewrite" && status === "complete")
    for (const old of state.value.runs)
      if (
        old.id !== run.id &&
        old.plugin.id === run.plugin.id &&
        old.anchorId === run.anchorId &&
        old.rewriteMessageId === run.rewriteMessageId &&
        old.createdAt <= run.createdAt
      )
        old.dismissed = true;
  const flow = state.value.flows.find((f) => f.id === run.flowId);
  if (flow && !run.replaces) {
    if (status !== "complete")
      flow.status = status === "stopped" ? "cancelled" : "error";
    else if (["clarify", "analysis"].includes(run.plugin.kind))
      flow.status = "waiting";
    else flow.index++;
  }
  const store = new Store(env.DB),
    statements = store.planSave(
      stateId(job.chat_id),
      "plugin-state",
      state.value,
      state.revision,
      { id: stateId(job.chat_id), chatId: job.chat_id },
    );
  if (taskDoc) {
    delete taskDoc.value.provider.encryptedKey;
    statements.push(
      ...store.planSave(
        taskId(id),
        "plugin-task",
        taskDoc.value,
        taskDoc.revision,
        { id: taskId(id), chatId: job.chat_id },
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      "UPDATE jobs SET status=?,error=?,updated_at=?,config=? WHERE id=? AND status IN ('pending','running')",
    ).bind(
      status,
      failure ?? null,
      Date.now(),
      JSON.stringify({
        kind: "plugin",
        runId: id,
        transport: taskDoc?.value.transport,
        post: run.plugin.kind === "suggest",
      }),
      id,
    ),
  );
  await store.commit(statements);
  if (flow && !run.replaces) {
    await markChat(
      env,
      job.chat_id,
      flow.status === "waiting"
        ? "waiting"
        : flow.status === "error"
          ? "error"
          : flow.status === "cancelled"
            ? undefined
            : "running",
    );
    if (
      status === "complete" &&
      !["clarify", "analysis"].includes(run.plugin.kind)
    )
      await advanceFlow(env, job.chat_id, flow.id);
  }
  if (!flow && run.plugin.kind === "suggest")
    await queueSuggestions(
      env,
      job.chat_id,
      run.anchorId!,
      taskDoc?.value.transport,
    );
}
export async function runPlugin(
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
  if (!job) return { status: "plugin-skipped" };
  const doc = await new Store(env.DB).get<PluginTask>(taskId(id));
  if (!doc) return { status: "plugin-missing" };
  const task = doc.value,
    output: CompletionOutput = { content: "", reasoning: "" };
  let key = "",
    last = 0;
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
      if (Date.now() - last > 2000) {
        progress.checkpoint(output.content, output.reasoning);
        last = Date.now();
      }
    });
    progress.checkpoint(output.content, output.reasoning);
    await finishPlugin(env, id, output, "complete");
  } catch (error) {
    await finishPlugin(
      env,
      id,
      output,
      progress.isCancelled() ? "stopped" : "error",
      redactError(error instanceof Error ? error.message : "插件调用失败", key),
    );
  } finally {
    disposeDeadline();
  }
  return { status: "plugin-complete" };
}
export async function queueSuggestions(
  env: Env,
  chatId: string,
  messageId: string,
  transport?: "device",
) {
  const chat = (await new Store(env.DB).get<Chat>(chatId))?.value;
  if (!chat || chat.deleted || chat.messages[messageId]?.status !== "complete")
    return;
  const { settings } = await config(env),
    selected = enabledPlugins(chat, settings).filter(
      (p) => p.kind === "suggest",
    );
  if (!selected.length) return;
  const state = await pluginState(env, chatId);
  const next = selected.find(
    (p) =>
      !state.value.runs.some(
        (r) => r.anchorId === messageId && r.plugin.id === p.id,
      ),
  );
  if (!next) return;
  const id =
    "suggest-" +
    (await digest(JSON.stringify([chatId, messageId, next.id]))).slice(0, 64);
  try {
    await enqueue(
      env,
      chat,
      state,
      next,
      "",
      messageId,
      transport,
      undefined,
      undefined,
      undefined,
      id,
    );
  } catch (e) {
    if (!(e instanceof HttpError && e.status === 409)) throw e;
  }
}
export async function pluginEndpoint(
  env: Env,
  chatDoc: Document<Chat>,
  body: Record<string, unknown>,
  active: { id: string; kind?: string } | null | undefined,
  transport?: "device",
) {
  const chat = chatDoc.value,
    action = str(body.action, 80),
    store = new Store(env.DB),
    state = await pluginState(env, chat.id);
  const run =
      typeof body.runId === "string"
        ? state.value.runs.find((r) => r.id === body.runId)
        : undefined,
    flow = state.value.flows.find(
      (f) => f.id === (run?.flowId ?? state.value.activeFlowId),
    );
  if (action === "configure") {
    const { settings } = await config(env);
    chat.plugins = validatedBindings(body.plugins, definitions(settings));
    await store.save(chat.id, "chat", chat, chatDoc.revision, summary(chat));
    return { ok: true };
  }
  if (action === "request") {
    if (!run) throw new HttpError(404, "插件记录不存在");
    const snapshot = await store.get<PluginTask>(taskId(run.id));
    return snapshot?.value.request ?? null;
  }
  if (action === "checkpoint" || action === "finish")
    throw new HttpError(400, "请使用任务保存接口");
  if (action === "cancel") {
    if (active?.kind === "plugin") {
      const output = await env.PROGRESS.getByName(active.id).cancel();
      await finishPlugin(env, active.id, output, "stopped");
      if (transport !== "device")
        try {
          await (await env.GENERATION.get(active.id)).terminate();
        } catch {}
    }
    const latest = await pluginState(env, chat.id),
      current = latest.value.flows.find(
        (f) => f.id === latest.value.activeFlowId,
      );
    if (current) current.status = "cancelled";
    delete latest.value.activeFlowId;
    await saveState(env, chat.id, latest);
    await markChat(env, chat.id, undefined);
    return { ok: true };
  }
  if (active && action !== "dismiss")
    throw new HttpError(409, "请等待当前生成结束，或先停止");
  if (action === "rewrite" || action === "suggest") {
    const { settings } = await config(env),
      p = enabledPlugins(chat, settings).find(
        (p) =>
          p.id === body.pluginId &&
          p.kind === (action === "rewrite" ? "rewrite" : "suggest"),
      );
    if (!p) throw new HttpError(400, "请先启用对应插件");
    const input = action === "rewrite" ? str(body.content) : "";
    if (action === "rewrite" && !input.trim())
      throw new HttpError(400, "请先在输入框填写本轮要求");
    const target =
      body.messageId === undefined
        ? undefined
        : typeof body.messageId === "string" &&
            Object.hasOwn(chat.messages, body.messageId)
          ? chat.messages[body.messageId]
          : null;
    if (
      body.messageId !== undefined &&
      (action !== "rewrite" || !target || target.role !== "user")
    )
      throw new HttpError(400, "请选择要编辑的 user 消息");
    return {
      jobId: await enqueue(
        env,
        chat,
        state,
        p,
        input,
        target ? target.parentId : chat.currentId,
        transport,
        undefined,
        undefined,
        target?.id,
      ),
    };
  }
  if (action === "dismiss") {
    if (run) {
      run.dismissed = true;
      await saveState(env, chat.id, state);
    }
    return { ok: true };
  }
  if (action === "clear-reference") {
    if (typeof body.pluginId !== "string")
      throw new HttpError(400, "请选择插件");
    // Keep the audit record; a marker only excludes older references in this branch.
    for (const item of state.value.runs)
      if (
        item.plugin.id === body.pluginId &&
        route(chat).some((m) => m.id === item.anchorId)
      )
        item.referenceReset = true;
    await saveState(env, chat.id, state);
    return { ok: true };
  }
  if (action === "edit") {
    if (!run) throw new HttpError(404, "插件记录不存在");
    const output = normalizePluginOutput(run.plugin, str(body.content));
    run.originalOutput ??= run.output;
    run.output = output;
    delete run.error;
    if (run.status === "error" && run.plugin.kind === "analysis") {
      run.status = "waiting";
      if (flow) {
        flow.status = "waiting";
      }
    }
    await saveState(env, chat.id, state);
    if (flow?.status === "waiting") await markChat(env, chat.id, "waiting");
    if (flow?.status === "running") await advanceFlow(env, chat.id, flow.id);
    return { ok: true };
  }
  if (action === "replace") {
    if (!run || run.status !== "candidate" || !run.replaces || !flow)
      throw new HttpError(400, "没有可替换的问题");
    const old = state.value.runs.find((r) => r.id === run.replaces);
    if (!old) throw new HttpError(404, "原问题不存在");
    if (flow.status !== "waiting" || old.status !== "waiting")
      throw new HttpError(409, "本轮已经继续或取消，不能再替换问题");
    old.status = "superseded";
    run.status = "waiting";
    for (const other of state.value.runs)
      if (other.id !== run.id && other.replaces === old.id)
        other.status = "superseded";
    flow.results = flow.results.map((id) => (id === old.id ? run.id : id));
    flow.status = "waiting";
    await saveState(env, chat.id, state);
    return { ok: true };
  }
  if (action === "regenerate-question") {
    if (
      !run ||
      run.plugin.kind !== "clarify" ||
      run.status !== "waiting" ||
      !flow ||
      flow.status !== "waiting"
    )
      throw new HttpError(400, "当前没有等待回答的问题");
    return {
      jobId: await enqueue(
        env,
        chat,
        state,
        run.plugin,
        run.input,
        run.contextAnchorId ?? null,
        transport,
        flow,
        run.id,
      ),
    };
  }
  if (action === "approve-analysis" || action === "regenerate-analysis") {
    if (
      !run ||
      run.plugin.kind !== "analysis" ||
      run.status !== "waiting" ||
      !flow ||
      flow.status !== "waiting" ||
      flow.results.at(-1) !== run.id
    )
      throw new HttpError(409, "当前没有等待确认的 JSON 结果");
    if (action === "approve-analysis") {
      normalizePluginOutput(run.plugin, run.output);
      run.status = "complete";
      flow.index++;
      flow.status = "running";
      await saveState(env, chat.id, state);
      await advanceFlow(env, chat.id, flow.id);
      return { ok: true };
    }
    run.status = "superseded";
    flow.results = flow.results.filter((id) => id !== run.id);
    flow.status = "running";
    await saveState(env, chat.id, state);
    await markChat(env, chat.id, "running");
    return {
      jobId: await enqueue(
        env,
        chat,
        state,
        run.plugin,
        run.input,
        run.contextAnchorId ?? null,
        transport,
        flow,
      ),
    };
  }
  if (action === "answer") {
    if (
      !run ||
      run.plugin.kind !== "clarify" ||
      run.status !== "waiting" ||
      !flow ||
      flow.status !== "waiting"
    )
      throw new HttpError(400, "当前没有等待回答的问题");
    const answer = str(body.content);
    if (!answer.trim()) throw new HttpError(400, "请填写回答");
    run.answer = answer;
    run.status = "answered";
    for (const other of state.value.runs)
      if (
        other.flowId === flow.id &&
        other.replaces &&
        ["candidate", "error"].includes(other.status)
      )
        other.status = "superseded";
    flow.index++;
    flow.status = "running";
    await saveState(env, chat.id, state);
    await store.setDraft(chat.id, "");
    await advanceFlow(env, chat.id, flow.id);
    return { ok: true };
  }
  if (action === "skip") {
    if (!flow || !["waiting", "error"].includes(flow.status))
      throw new HttpError(400, "没有待继续的插件流程");
    const last = state.value.runs.find((r) => r.id === flow.results.at(-1));
    if (run && run.id !== last?.id)
      throw new HttpError(409, "插件阶段已变化，请刷新后重试");
    if (last) last.status = "skipped";
    for (const other of state.value.runs)
      if (
        other.flowId === flow.id &&
        other.replaces &&
        ["candidate", "error"].includes(other.status)
      )
        other.status = "superseded";
    flow.index++;
    flow.status = "running";
    await saveState(env, chat.id, state);
    await advanceFlow(env, chat.id, flow.id);
    return { ok: true };
  }
  if (action === "retry") {
    if (run?.replaces && run.status === "error" && flow?.status === "waiting") {
      run.status = "superseded";
      return {
        jobId: await enqueue(
          env,
          chat,
          state,
          run.plugin,
          run.input,
          run.contextAnchorId ?? null,
          transport,
          flow,
          run.replaces,
        ),
      };
    }
    if (!flow || flow.status !== "error")
      throw new HttpError(400, "没有可重试的流程");
    const last = state.value.runs.find((r) => r.id === flow.results.at(-1));
    if (last?.status === "error") {
      last.status = "superseded";
      flow.results.pop();
    }
    flow.status = "running";
    await saveState(env, chat.id, state);
    await advanceFlow(env, chat.id, flow.id);
    return { ok: true };
  }
  if (action === "use") {
    if (!flow || flow.status !== "debug")
      throw new HttpError(400, "没有完成的调试结果");
    const { settings } = await config(env);
    if (
      flow.signature &&
      flow.signature !==
        (await signature({ ...chat, currentId: flow.userId }, settings))
    )
      throw new HttpError(409, "上下文或插件配置已变化，请重新调试后使用结果");
    flow.debug = false;
    flow.status = "running";
    await saveState(env, chat.id, state);
    await advanceFlow(env, chat.id, flow.id);
    return { ok: true };
  }
  if (action === "debug-rerun") {
    if (!flow || !["debug", "error"].includes(flow.status))
      throw new HttpError(400, "没有可重新调试的流程");
    const original = chat.messages[flow.userId];
    if (!original) throw new HttpError(404, "原始问题不存在");
    addMessage(chat, "user", original.content, original.parentId);
    const { settings } = await config(env);
    if (
      !(await startPluginFlow(
        env,
        chat,
        chatDoc.revision,
        settings,
        transport,
        true,
      ))
    )
      throw new HttpError(400, "请先启用前置插件");
    return { ok: true };
  }
  if (action === "regenerate-main") {
    if (!run) throw new HttpError(404, "插件记录不存在");
    const source = state.value.flows.find((f) => f.id === run.flowId);
    if (!source) throw new HttpError(404, "原流程不存在");
    if (typeof body.answer === "string" && !body.answer.trim())
      throw new HttpError(400, "回答不能为空");
    const user = chat.messages[source.userId];
    if (!user) throw new HttpError(404, "原始问题不存在");
    const copy = addMessage(chat, "user", user.content, user.parentId);
    const next: PluginFlow = {
      ...structuredClone(source),
      id: crypto.randomUUID(),
      userId: copy.id,
      status: "running",
      debug: false,
      mainMessageId: undefined,
      transport,
      index: source.definitions.length,
    };
    next.results = [];
    const retained =
      run.plugin.kind === "clarify"
        ? source.results.slice(
            0,
            source.definitions.findIndex((p) => p.id === run.plugin.id) + 1,
          )
        : source.results;
    for (const id of retained) {
      const old = state.value.runs.find((r) => r.id === id);
      if (old) {
        const cloned = {
          ...structuredClone(old),
          id: crypto.randomUUID(),
          flowId: next.id,
          anchorId: copy.id,
          contextAnchorId: copy.parentId,
          ...(id === run.id && typeof body.answer === "string"
            ? { answer: body.answer }
            : {}),
        };
        state.value.runs.push(cloned);
        next.results.push(cloned.id);
      }
    }
    if (run.plugin.kind === "clarify") {
      const position = source.definitions.findIndex(
        (p) => p.id === run.plugin.id,
      );
      next.index = position + 1;
      next.results = next.results.slice(0, position + 1);
    }
    state.value.flows.push(next);
    state.value.activeFlowId = next.id;
    await store.save(chat.id, "chat", chat, chatDoc.revision, summary(chat));
    await saveState(env, chat.id, state);
    await advanceFlow(env, chat.id, next.id);
    return { ok: true };
  }
  throw new HttpError(400, "未知插件操作");
}
export async function devicePluginSave(
  env: Env,
  id: string,
  action: string,
  body: Record<string, unknown>,
) {
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id=?")
      .bind(id)
      .first<Job>(),
    doc = await new Store(env.DB).get<PluginTask>(taskId(id));
  if (!job || !doc || doc.value.transport !== "device")
    throw new HttpError(404, "设备插件任务不存在");
  if (!["pending", "running"].includes(job.status)) {
    if (action === "finish") return { ok: true };
    throw new HttpError(409, "任务已结束");
  }
  const output = {
    content: str(body.content),
    reasoning: str(body.reasoning ?? ""),
    usage: sanitizeUsage(body.usage),
  };
  if (!Number.isSafeInteger(body.sequence) || Number(body.sequence) < 1)
    throw new HttpError(400, "进度序号无效");
  const result = await env.PROGRESS.getByName(id).deviceCheckpoint(
    Number(body.sequence),
    output.content,
    output.reasoning,
  );
  if (!result.accepted) throw new HttpError(409, "任务已停止或进度已更新");
  if (action === "finish") {
    if (!["complete", "error", "stopped"].includes(String(body.status)))
      throw new HttpError(400, "结束状态无效");
    const key = doc.value.provider.encryptedKey
      ? await decrypt(doc.value.provider.encryptedKey, env.ENCRYPTION_KEY)
      : "";
    await finishPlugin(
      env,
      id,
      output,
      body.status as "complete" | "error" | "stopped",
      typeof body.error === "string" ? redactError(body.error, key) : undefined,
    );
    await env.PROGRESS.getByName(id).settled();
  }
  return { ok: true };
}
