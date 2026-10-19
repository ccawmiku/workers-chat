import { lengthInjection } from "../shared/length-guidance";
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
  estimateTokens,
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
  injectPlugins,
} from "../shared/plugins";
import { type Document, Store, HttpError, summary } from "./store";
import { type Job, startGeneration } from "./generation";
import { readCompletion, type CompletionOutput } from "../shared/completion";
import { decrypt, redactError, digest } from "./security";
import { str } from "./validation";
import { validatedBindings } from "./plugin-validation";
import {
  analysisSections,
  sectionResult,
  mergeSection,
  questionView,
  clarifyAnswer,
  type AnalysisType,
} from "../shared/plugin-sections";
import { ANALYSIS_SCHEMA } from "../shared/analysis-defaults";
import {
  clarificationSubmission,
  legacyClarificationSubmission,
} from "../shared/clarification-transmission";
import { CONTINUE_CLARIFY_TASK } from "../shared/clarify-defaults";
import { fallbackRequest } from "./fallback-model";
import { compatibleMessages } from "../shared/upstream-compat";

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
async function frozenPreparation(
  env: Env,
  source: PluginRun,
  allowMissingProvider = false,
) {
  const saved = await new Store(env.DB).get<PluginTask>(
    taskId(source.fallbackOf ?? source.id),
  );
  if (!saved) throw new HttpError(409, "本轮请求快照不可用，请重新运行插件");
  const { providers } = await config(env),
    provider = providers.find((p) => p.id === saved.value.provider.id);
  if (!provider && !allowMissingProvider)
    throw new HttpError(409, "原服务商已移除");
  return {
    request: structuredClone(saved.value.request),
    metrics: {
      ...structuredClone(source.metrics),
      capacity:
        provider?.models.find((m) => m.id === saved.value.request.model)
          ?.capacity ?? source.metrics.capacity,
    },
    provider: provider ?? {
      ...saved.value.provider,
      name: "原服务商",
      prefix: "",
      models: [],
    },
    modelRef: source.fallbackOf
      ? {
          providerId: saved.value.provider.id,
          modelId: saved.value.request.model,
        }
      : (source.model ?? source.plugin.model!),
  };
}
const baselines = new WeakMap<Document<PluginState>, PluginState>();
async function frozenClarification(
  env: Env,
  source: PluginRun,
  state: PluginState,
  flow: PluginFlow,
) {
  const initial = state.runs.find(
    (r) => flow.results.includes(r.id) && r.plugin.kind === "clarify",
  );
  if (!initial) return undefined;
  let prepared;
  try {
    prepared = await frozenPreparation(env, initial);
  } catch (e) {
    // Legacy/copied questions may have no snapshot. Keep their existing rebuild path.
    if (
      e instanceof HttpError &&
      e.status === 409 &&
      e.message.includes("请求快照不可用")
    )
      return undefined;
    throw e;
  }
  const task = prepared.request.messages.pop();
  const answers = flowClarifications(state, flow, true);
  prepared.request.messages = injectPlugins(
    [...prepared.request.messages, { role: "user", content: source.input }],
    answers,
  );
  if (task)
    prepared.request.messages.push({
      ...task,
      content:
        (task.content ?? "") +
        "\n\n" +
        (source.plugin.clarifyFormat === "questions"
          ? CONTINUE_CLARIFY_TASK
          : "用户明确要求继续提问，请至少提出一个尚未问过、未回答或跳过的新问题，不得只回答无。保留原来的提问格式，不代写正文。"),
    });
  prepared.request.messages = compatibleMessages(
    prepared.request.model,
    prepared.request.messages,
  );
  prepared.metrics.total = estimateTokens(
    prepared.request.messages.map((m) => m.content ?? "").join("\n"),
  );
  prepared.metrics.sections.push({
    name: "本轮已提交澄清问答",
    tokens: estimateTokens(JSON.stringify(answers)),
  });
  return prepared;
}
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
      enabledPlugins(chat, settings)
        .filter((p) => p.kind === "analysis" || p.kind === "clarify")
        .map(({ analysisTypes, ...requestConfig }) => requestConfig),
    ]),
  );
}
async function markChat(env: Env, id: string, pending: Chat["pluginPending"]) {
  const store = new Store(env.DB);
  for (let i = 0; i < 4; i++) {
    const doc = await store.get<Chat>(id);
    if (!doc || doc.value.pluginPending === pending) return;
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
  const state =
    chat.plugins?.length || chat.lengthGuidance?.enabled || chat.pluginPending
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
  if (!source.plugins?.length && !source.lengthGuidance?.enabled) return;
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
      sectionEdit: r.sectionEdit
        ? {
            ...r.sectionEdit,
            sourceId:
              runIds.get(r.sectionEdit.sourceId) ?? r.sectionEdit.sourceId,
          }
        : undefined,
      sectionHistory: r.sectionHistory?.flatMap((id) => runIds.get(id) ?? []),
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
  const cloneStore = new Store(env.DB),
    statements = cloneStore.planSave(
      stateId(copy.id),
      "plugin-state",
      cloned,
      0,
      { id: stateId(copy.id), chatId: copy.id },
    );
  // A fork waiting for analysis confirmation needs the same frozen request too.
  const waiting = cloned.runs.find(
    (r) =>
      r.id === current?.results.at(-1) &&
      r.plugin.kind === "analysis" &&
      r.status === "waiting",
  );
  if (waiting) {
    const originalId = runs.find((r) => runIds.get(r.id) === waiting.id)?.id;
    const task = originalId
      ? await cloneStore.get<PluginTask>(taskId(originalId))
      : null;
    if (task) {
      task.value.runId = waiting.id;
      task.value.flowId = waiting.flowId;
      delete task.value.provider.encryptedKey;
      statements.push(
        ...cloneStore.planSave(
          taskId(waiting.id),
          "plugin-task",
          task.value,
          0,
          { id: taskId(waiting.id), chatId: copy.id },
        ),
      );
    }
  }
  await cloneStore.commit(statements);
}
export async function planPruneMessagePlugins(
  env: Env,
  chat: Chat,
  removed: string[],
) {
  if (!chat.plugins?.length && !chat.lengthGuidance?.enabled) return [];
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
  if (!chat.plugins?.length && !chat.lengthGuidance?.enabled) return;
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
  override?: ReturnType<typeof preparePlugin> & {
    sectionEdit?: PluginRun["sectionEdit"];
    fallbackOf?: string;
  },
) {
  const { settings, providers } = await config(env),
    prepared =
      override ??
      preparePlugin(
        chat,
        p,
        settings,
        providers,
        stateDoc.value,
        input,
        anchorId,
        flow
          ? flowClarifications(stateDoc.value, flow, p.kind === "clarify")
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
      ...(override?.fallbackOf ? { fallbackOf: override.fallbackOf } : {}),
      ...(replaces ? { replaces } : {}),
      ...(override?.sectionEdit ? { sectionEdit: override.sectionEdit } : {}),
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
  // A fixed local requirement needs no persisted waiting flow of its own.
  if (
    !selected.length &&
    (!chat.lengthGuidance?.enabled || chat.lengthGuidance.requirement.trim())
  )
    return false;
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
    ...(chat.lengthGuidance?.enabled
      ? {
          lengthEnabled: true,
          ...(chat.lengthGuidance.requirement.trim()
            ? { lengthRequirement: chat.lengthGuidance.requirement }
            : {}),
        }
      : {}),
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
        r.flowId === flow.id &&
        r.plugin.id === p.id &&
        r.status === "answered" &&
        !flow.results.includes(r.id),
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
  if (flow.lengthEnabled && flow.lengthRequirement === undefined) {
    flow.lengthWaiting = true;
    flow.status = "waiting";
    await saveState(env, chatId, state);
    await markChat(env, chatId, "waiting");
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
    [
      ...flowInjections(state.value, flow),
      ...(flow.lengthEnabled
        ? [
            lengthInjection(
              mainChat.value,
              flow.lengthRequirement ?? "",
              flow.id,
            ),
          ]
        : []),
    ],
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
      text = run.sectionEdit
        ? JSON.stringify(sectionResult(text))
        : normalizePluginOutput(run.plugin, text);
      if (
        run.plugin.kind === "clarify" &&
        run.plugin.clarifyFormat === "questions" &&
        run.flowId
      ) {
        const key = (s: string) => s.replace(/\s/g, "").trim();
        const asked = new Set(
          state.value.runs
            .filter(
              (r) =>
                r.id !== run.id &&
                r.flowId === run.flowId &&
                r.status === "answered",
            )
            .flatMap((r) =>
              (questionView(r.output) ?? []).map((q) => key(q.question)),
            ),
        );
        text = JSON.stringify(
          {
            questions: (questionView(text) ?? []).filter(
              (q) => !asked.has(key(q.question)),
            ),
          },
          null,
          2,
        );
        if (
          taskDoc?.value.request.messages
            .at(-1)
            ?.content?.includes(CONTINUE_CLARIFY_TASK) &&
          !questionView(text)?.length
        )
          throw Error(
            "模型没有生成新的追问，请重新生成或手动切换备用模型；已有回答已保留",
          );
      }
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
  if (action === "discard-sections") {
    if (
      !Array.isArray(body.runIds) ||
      body.runIds.length > 256 ||
      body.runIds.some((id) => typeof id !== "string")
    )
      throw new HttpError(400, "候选列表无效");
    const ids = new Set(body.runIds),
      remove = state.value.runs
        .filter(
          (r) =>
            r.sectionEdit &&
            ids.has(r.id) &&
            ["candidate", "error", "cancelled"].includes(r.status),
        )
        .map((r) => r.id);
    if (remove.length) {
      state.value.runs = state.value.runs.filter((r) => !remove.includes(r.id));
      // Do not rebase this deletion: a concurrent adoption must roll back both
      // the state removal and snapshot deletion together on the revision guard.
      await store.commit([
        ...store.planSave(
          stateId(chat.id),
          "plugin-state",
          state.value,
          state.revision,
          { id: stateId(chat.id), chatId: chat.id },
        ),
        env.DB.prepare(
          "DELETE FROM documents WHERE id IN (SELECT value FROM json_each(?))",
        ).bind(JSON.stringify(remove.map(taskId))),
      ]);
    }
    return { ok: true };
  }
  if (action === "checkpoint" || action === "finish")
    throw new HttpError(400, "请使用任务保存接口");
  if (action === "cancel") {
    const replacing =
      active && state.value.runs.find((r) => r.id === active.id)?.replaces;
    if (active?.kind === "plugin") {
      const output = await env.PROGRESS.getByName(active.id).cancel();
      await finishPlugin(env, active.id, output, "stopped");
      if (transport !== "device")
        try {
          await (await env.GENERATION.get(active.id)).terminate();
        } catch {}
    }
    if (replacing) return { ok: true };
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
  if (action === "length-answer") {
    if (!flow || flow.status !== "waiting" || !flow.lengthWaiting)
      throw new HttpError(409, "当前不在字数要求阶段");
    flow.lengthRequirement = str(body.content ?? "", 10000);
    delete flow.lengthWaiting;
    flow.status = "running";
    await saveState(env, chat.id, state);
    await advanceFlow(env, chat.id, flow.id);
    return { ok: true };
  }
  if (action === "fallback") {
    if (!run || run.status !== "error" || run.dismissed)
      throw new HttpError(409, "只有尚未处理的失败结果可以切换备用模型");
    if (
      run.flowId &&
      (!flow ||
        (run.replaces
          ? flow.status !== "waiting"
          : flow.status !== "error" || flow.results.at(-1) !== run.id))
    )
      throw new HttpError(409, "原插件阶段已变化，不能重新运行");
    if (
      run.sectionEdit &&
      (await digest(
        state.value.runs.find((r) => r.id === run.sectionEdit!.sourceId)
          ?.output ?? "",
      )) !== run.sectionEdit.expectedOutput
    )
      throw new HttpError(409, "分块内容已变化，请从当前块重新发起修改");
    const prepared = await frozenPreparation(env, run, true);
    const { settings, providers } = await config(env);
    const selected = fallbackRequest(
      settings,
      providers,
      body.model,
      prepared.request,
      run.plugin.parameters,
    );
    run.status = "superseded";
    if (flow && !run.replaces) flow.results.pop();
    return {
      jobId: await enqueue(
        env,
        chat,
        state,
        run.plugin,
        run.input,
        run.contextAnchorId ?? null,
        transport,
        run.flowId ? flow : undefined,
        run.replaces,
        run.rewriteMessageId,
        undefined,
        {
          ...prepared,
          ...selected,
          metrics: {
            ...prepared.metrics,
            capacity: selected.provider.models.find(
              (m) => m.id === selected.modelRef.modelId,
            )!.capacity,
          },
          sectionEdit: run.sectionEdit,
          fallbackOf: run.fallbackOf ?? run.id,
        },
      ),
    };
  }
  const requireAnalysis = () => {
    if (
      !run ||
      run.plugin.kind !== "analysis" ||
      run.status !== "waiting" ||
      !flow ||
      flow.status !== "waiting" ||
      flow.results.at(-1) !== run.id
    )
      throw new HttpError(409, "仅本轮待确认的写前分析可以修改");
    return run;
  };
  if (action === "section-generate") {
    const source = requireAnalysis(),
      targetId = body.targetId === null ? null : str(body.targetId, 128),
      instruction = str(body.content ?? "", 10000);
    const sections = analysisSections(source.output),
      target = sections.find((s) => s.id === targetId);
    if (targetId && !target) throw new HttpError(400, "分块不存在");
    if (!targetId && !instruction.trim())
      throw new HttpError(400, "请描述新增类型和要求");
    const prepared = await frozenPreparation(env, source);
    // Replace the full-output task contract; leave the original history prefix untouched.
    const originalTask = prepared.request.messages.pop();
    prepared.request.messages.push({
      role: "user",
      content: JSON.stringify({
        original_task: originalTask?.content?.split("\n\nJSON Schema：")[0],
        output_contract:
          '原任务只作为资料和内容规则参考，原任务中的完整字段/全量输出要求在本次无效。只输出 JSON {"type":"类型名称","content":"该块内容","instruction":"仅新增类型时填写可复用通用规则，不包含本轮人物/剧情方向"}；不要输出 id、其他块或完整分析。类型名称和内容不能为空。指定块的 type 必须保持原样。不得生成主角、玩家或“你”的第一人称想法。只涉及当前明确在场的角色；忽略不在场、已离场或位置不明的角色，不列缺席名单，不输出“某某不在场”的说明或占位。不编造已有状态。',
        output_schema: {
          type: "object",
          required: ["type", "content"],
          additionalProperties: false,
          properties: {
            type: { type: "string", minLength: 1 },
            content: { type: "string", minLength: 1 },
            instruction: { type: "string" },
          },
        },
        excluded_characters: source.plugin.excludedCharacters ?? "",
        current_sections: sections,
        task: targetId
          ? "只重新生成指定块；其他块只读，不要输出或改变它们。"
          : "按用户描述添加一种新类型；不改动现有块。",
        target: target ?? null,
        user_requirement: instruction,
      }),
    });
    prepared.request.response_format = { type: "json_object" };
    prepared.metrics.total = estimateTokens(
      prepared.request.messages.map((m) => m.content ?? "").join("\n"),
    );
    prepared.metrics.sections.push({
      name: "当前分块与局部任务",
      tokens: estimateTokens(prepared.request.messages.at(-1)?.content ?? ""),
    });
    return {
      jobId: await enqueue(
        env,
        chat,
        state,
        source.plugin,
        source.input,
        source.contextAnchorId ?? null,
        transport,
        flow,
        source.id,
        undefined,
        undefined,
        {
          ...prepared,
          sectionEdit: {
            sourceId: source.id,
            targetId,
            instruction,
            expectedOutput: await digest(source.output),
          },
        },
      ),
    };
  }
  if (action === "section-edit" || action === "section-remove") {
    const source = requireAnalysis(),
      targetId = str(body.targetId, 128),
      section = analysisSections(source.output).find((s) => s.id === targetId);
    if (!section) throw new HttpError(404, "分块不存在");
    const changed = mergeSection(
      source.output,
      targetId,
      {
        ...section,
        content: action === "section-remove" ? "none" : str(body.content),
      },
      action === "section-remove",
    );
    source.output = normalizePluginOutput(source.plugin, changed);
    const extra: D1PreparedStatement[] = [];
    if (action === "section-remove" && body.removeTemplate === true) {
      const settingsDoc = await store.get<Settings>("settings"),
        settings = settingsDoc?.value ?? defaultSettings(),
        base = definitions(settings).find((p) => p.id === source.plugin.id)!;
      if (body.scope === "global") {
        settings.plugins = definitions(settings).map((p) =>
          p.id === base.id
            ? {
                ...p,
                analysisTypes: (p.analysisTypes ?? []).filter(
                  (t) => t.id !== targetId,
                ),
              }
            : p,
        );
        extra.push(
          ...store.planSave(
            "settings",
            "settings",
            settings,
            settingsDoc?.revision ?? 0,
          ),
        );
      } else {
        chat.plugins = validatedBindings(
          (chat.plugins ?? []).map((p) =>
            p.id === base.id
              ? {
                  ...p,
                  overrides: {
                    ...p.overrides,
                    analysisTypes: (
                      p.overrides?.analysisTypes ??
                      base.analysisTypes ??
                      []
                    ).filter((t) => t.id !== targetId),
                  },
                }
              : p,
          ),
          definitions(settings),
        );
        extra.push(
          ...store.planSave(
            chat.id,
            "chat",
            chat,
            chatDoc.revision,
            summary(chat),
          ),
        );
      }
    }
    await saveState(env, chat.id, state, extra);
    return { ok: true };
  }
  if (action === "section-apply") {
    if (
      !run?.sectionEdit ||
      run.status !== "candidate" ||
      !flow ||
      flow.status !== "waiting"
    )
      throw new HttpError(409, "没有可采用的分块候选");
    const source = state.value.runs.find(
      (r) => r.id === run.sectionEdit!.sourceId,
    );
    if (
      !source ||
      source.status !== "waiting" ||
      flow.results.at(-1) !== source.id ||
      (await digest(source.output)) !== run.sectionEdit.expectedOutput
    )
      throw new HttpError(409, "原结果已变化，请重新生成此块");
    const section = {
      ...JSON.parse(run.output),
      id: run.sectionEdit.targetId ?? "extra:" + run.id,
    };
    if (!run.sectionEdit.targetId && source.plugin.schema.trim()) {
      const schema = JSON.parse(source.plugin.schema);
      if (schema && typeof schema === "object")
        source.plugin = {
          ...source.plugin,
          schema: JSON.stringify({
            ...schema,
            properties: {
              ...schema.properties,
              additional_sections:
                JSON.parse(ANALYSIS_SCHEMA).properties.additional_sections,
            },
          }),
        };
    }
    source.output = normalizePluginOutput(
      source.plugin,
      mergeSection(source.output, run.sectionEdit.targetId, section),
    );
    source.sectionHistory = [...(source.sectionHistory ?? []), run.id];
    run.status = "complete";
    run.sectionResultId = section.id;
    const extra: D1PreparedStatement[] = [];
    if (body.saveType === true && !run.sectionEdit.targetId) {
      const template: AnalysisType = {
        id: section.id,
        type: str(body.type ?? section.type, 100),
        instruction: str(body.instruction ?? section.instruction ?? "", 10000),
      };
      if (!template.type.trim()) throw new HttpError(400, "模板名称不能为空");
      const settingsDoc = await store.get<Settings>("settings"),
        settings = settingsDoc?.value ?? defaultSettings(),
        base = definitions(settings).find((p) => p.id === source.plugin.id)!;
      if (body.scope === "global") {
        settings.plugins = definitions(settings).map((p) =>
          p.id === base.id
            ? {
                ...p,
                analysisTypes: [
                  ...(p.analysisTypes ?? []).filter(
                    (t) => t.id !== template.id,
                  ),
                  template,
                ],
              }
            : p,
        );
        if (
          (settings.plugins.find((p) => p.id === base.id)?.analysisTypes
            ?.length ?? 0) > 64
        )
          throw new HttpError(400, "保存类型最多64个");
        extra.push(
          ...store.planSave(
            "settings",
            "settings",
            settings,
            settingsDoc?.revision ?? 0,
          ),
        );
      } else {
        const bindings = chat.plugins ?? [],
          binding = bindings.find((p) => p.id === base.id)!;
        const templates =
          binding.overrides?.analysisTypes ?? base.analysisTypes ?? [];
        chat.plugins = validatedBindings(
          bindings.map((p) =>
            p.id === base.id
              ? {
                  ...p,
                  overrides: {
                    ...p.overrides,
                    analysisTypes: [
                      ...templates.filter((t) => t.id !== template.id),
                      template,
                    ],
                  },
                }
              : p,
          ),
          definitions(settings),
        );
        extra.push(
          ...store.planSave(
            chat.id,
            "chat",
            chat,
            chatDoc.revision,
            summary(chat),
          ),
        );
      }
    }
    await saveState(env, chat.id, state, extra);
    return { ok: true };
  }
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
    if (
      run.sectionEdit ||
      (run.plugin.kind === "analysis" &&
        (!flow ||
          !["waiting", "error"].includes(flow.status) ||
          !["waiting", "error"].includes(run.status) ||
          flow.results.at(-1) !== run.id))
    )
      throw new HttpError(409, "历史分析仅供查看，请修改本轮待确认的结果");
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
    if (run?.sectionEdit) throw new HttpError(400, "请使用分块确认操作");
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
        undefined,
        undefined,
        await frozenPreparation(env, run),
      ),
    };
  }
  if (action === "answer" || action === "finish-clarify") {
    if (
      !run ||
      run.plugin.kind !== "clarify" ||
      run.status !== "waiting" ||
      !flow ||
      flow.status !== "waiting"
    )
      throw new HttpError(400, "当前没有等待回答的问题");
    const freeText = str(body.content ?? "");
    const structured = questionView(run.output);
    const answer = structured
      ? clarifyAnswer(run.output, body.selections, freeText)
      : freeText;
    if (!answer.trim() && action !== "finish-clarify" && structured === null)
      throw new HttpError(400, "请填写回答");
    run.answer = answer;
    run.submission = clarificationSubmission(
      run.output,
      body.selections,
      freeText,
    );
    run.status = "answered";
    for (const other of state.value.runs)
      if (
        other.flowId === flow.id &&
        other.replaces &&
        ["candidate", "error"].includes(other.status)
      )
        other.status = "superseded";
    const repeat = action !== "finish-clarify";
    if (!repeat) flow.index++;
    flow.status = "running";
    await saveState(env, chat.id, state);
    if (repeat)
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
          undefined,
          undefined,
          undefined,
          await frozenClarification(env, run, state.value, flow),
        ),
      };
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
          undefined,
          undefined,
          {
            ...(await frozenPreparation(env, run)),
            sectionEdit: run.sectionEdit,
          },
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
            ? {
                answer: body.answer,
                ...(old.plugin.kind === "clarify"
                  ? {
                      submission: legacyClarificationSubmission(
                        old.output,
                        body.answer,
                      ),
                    }
                  : {}),
              }
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
