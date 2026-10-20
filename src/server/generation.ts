import { stripStyleMarkers } from "../shared/body-styles";
import { comparisonFork } from "../shared/comparison";
import { LENGTH_PLUGIN_ID, lengthInjection } from "../shared/length-guidance";
import { generationDeadline } from "./deadline";
import { compatibleMessages } from "../shared/upstream-compat";
import { readCompletion, type CompletionOutput } from "../shared/completion";
import type { DirectTask, GenerationStart } from "../shared/direct";
import {
  type Chat,
  type Provider,
  type Settings,
  requestPreview,
  contextMessages,
  addMessage,
} from "../shared/chat";
import { Store, HttpError, summary, type DocumentHeader } from "./store";
import { decrypt, redactError } from "./security";
import { injectPlugins, type PluginInjection } from "../shared/plugins";
export type JobConfig = {
  injections?: PluginInjection[];
  options: Record<string, unknown>;
  provider: Pick<Provider, "id" | "baseUrl" | "encryptedKey">;
  system: Chat["system"];
  rounds?: number;
  includeStopped: boolean;
  model: NonNullable<Chat["model"]>;
  seedId?: string;
  transport?: "device";
};
export type Job = {
  id: string;
  chat_id: string;
  message_id: string;
  status: string;
  attempted: number;
  created_at: number;
  updated_at: number;
  error: string | null;
  config: string;
};
export async function activeJob(env: Env, id: string) {
  return env.DB.prepare(
    "SELECT * FROM jobs WHERE chat_id=? AND status IN ('pending','running') AND COALESCE(json_extract(config,'$.post'),0)=0",
  )
    .bind(id)
    .first<Job>();
}
type ActiveJob = Pick<
  Job,
  "id" | "chat_id" | "message_id" | "status" | "created_at"
> & { transport?: "device"; kind?: "plugin" };
export async function readChat(env: Env, id: string) {
  // The immutable document version and its active job must come from one SQL
  // snapshot. Reading them separately can pair old text with a completed job.
  const row = await env.DB.prepare(
    "SELECT d.revision,d.kind,d.summary,(SELECT json_object('id',j.id,'chat_id',j.chat_id,'message_id',j.message_id,'status',j.status,'created_at',j.created_at,'transport',json_extract(j.config,'$.transport'),'kind',json_extract(j.config,'$.kind')) FROM jobs j WHERE j.chat_id=d.id AND j.status IN ('pending','running') AND COALESCE(json_extract(j.config,'$.post'),0)=0 LIMIT 1) AS active_job FROM documents d WHERE d.id=? AND d.kind='chat'",
  )
    .bind(id)
    .first<DocumentHeader & { active_job: string | null }>();
  return {
    doc: await new Store(env.DB).get<Chat>(id, row),
    job: row?.active_job ? (JSON.parse(row.active_job) as ActiveJob) : null,
  };
}
export async function jobOutput(env: Env, id: string) {
  return env.PROGRESS.getByName(id).output();
}
export function previewRequest(
  chat: Chat,
  settings: Settings,
  providers: Provider[],
  draft?: string,
) {
  try {
    return requestPreview(chat, settings, providers, draft);
  } catch (error) {
    throw new HttpError(
      400,
      error instanceof Error ? error.message : "请求配置无效",
    );
  }
}
export async function startGeneration(
  env: Env,
  chat: Chat,
  revision: number,
  settings: Settings,
  providers: Provider[],
  seedId?: string,
  clearDraft = false,
  transport?: "device",
  injections?: PluginInjection[],
) {
  if (
    !seedId &&
    chat.lengthGuidance?.enabled &&
    chat.lengthGuidance.requirement.trim() &&
    !injections?.some((i) => i.pluginId === LENGTH_PLUGIN_ID)
  )
    injections = [
      ...(injections ?? []),
      lengthInjection(
        chat,
        chat.lengthGuidance.requirement,
        crypto.randomUUID(),
      ),
    ];
  const { model, provider, request } = previewRequest(
    chat,
    settings,
    providers,
  );
  const { messages: _messages, ...options } = request;
  const seed = seedId ? chat.messages[seedId] : null;
  const compareConfig = chat.comparison?.enabled
    ? structuredClone(chat.comparison)
    : undefined;
  let fork: Chat | undefined;
  let forkSeedId: string | undefined;
  if (
    compareConfig &&
    chat.currentId &&
    chat.messages[chat.currentId]?.role === "user"
  ) {
    const titles = (
      await new Store(env.DB).list<{ title: string }>("chat")
    ).map((c) => c.title);
    fork = comparisonFork(chat, compareConfig, titles);
    if (seed) {
      forkSeedId = crypto.randomUUID();
      const copy = {
        ...structuredClone(seed),
        id: forkSeedId,
        parentId: fork.currentId,
      };
      if (copy.toolContext) copy.toolContext.parentId = fork.currentId!;
      if (compareConfig.mode === "plain") {
        delete copy.toolContext;
        delete copy.lengthRequirement;
        copy.content = stripStyleMarkers(copy.content);
        copy.styleTagged = false;
      }
      fork.messages[forkSeedId] = copy;
    }
  }
  const message = addMessage(chat, "assistant", seed?.content ?? "");
  const length = injections?.find((i) => i.pluginId === LENGTH_PLUGIN_ID);
  if (length) message.lengthRequirement = JSON.parse(length.content).本轮要求;
  else if (seed?.lengthRequirement !== undefined)
    message.lengthRequirement = seed.lengthRequirement;
  message.styleTagged = seed?.styleTagged ?? !!chat.bodyStyles?.enabled;
  message.status = "running";
  message.model = model;
  message.request = {
    parameters: {
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
      ...(request.top_p !== undefined ? { top_p: request.top_p } : {}),
      ...(request.top_k !== undefined ? { top_k: request.top_k } : {}),
    },
    effort: chat.effort,
    stream: chat.stream,
    ...(transport ? { transport } : {}),
  };
  const parent = message.parentId ? chat.messages[message.parentId] : undefined;
  if (injections?.length && parent?.role === "user")
    message.toolContext = {
      parentId: parent.id,
      stable: true,
      messages: injectPlugins(
        [{ role: "user", content: parent.content }],
        injections,
      ).slice(1),
    };
  else if (seed?.toolContext && parent?.id === seed.toolContext.parentId)
    message.toolContext = structuredClone(seed.toolContext);
  if (fork && parent)
    chat.comparisonRuns = [
      ...(chat.comparisonRuns ?? []),
      {
        chatId: fork.id,
        title: fork.title,
        userId: parent.id,
        mainMessageId: message.id,
        createdAt: Date.now(),
      },
    ];
  chat.unread = false;
  const config: JobConfig = {
    ...(injections?.length ? { injections } : {}),
    options,
    provider: {
      id: provider.id,
      baseUrl: provider.baseUrl,
      encryptedKey: provider.encryptedKey,
    },
    system: chat.system,
    rounds: chat.rounds,
    includeStopped: chat.includeStopped,
    model,
    seedId,
    transport,
  };
  const id = crypto.randomUUID();
  // The chat revision is the mutation lock; only one concurrent start can commit it.
  const store = new Store(env.DB);
  await store.save(chat.id, "chat", chat, revision, summary(chat), [
    ...(clearDraft ? store.planDraft(chat.id, "") : []),
    env.DB.prepare(
      "INSERT INTO jobs(id,chat_id,message_id,status,attempted,created_at,updated_at,config) VALUES(?,?,?,?,?,?,?,?)",
    ).bind(
      id,
      chat.id,
      message.id,
      transport === "device" ? "running" : "pending",
      transport === "device" ? 1 : 0,
      Date.now(),
      Date.now(),
      JSON.stringify(config),
    ),
  ]);
  if (fork && compareConfig) {
    try {
      await store.save(fork.id, "chat", fork, 0, summary(fork));
      if (
        compareConfig.model &&
        !providers.some(
          (p) =>
            p.id === compareConfig.model!.providerId &&
            p.models.some((m) => m.id === compareConfig.model!.modelId),
        )
      )
        throw new HttpError(400, "选定的对比模型已不存在，请重新选择");
      await startGeneration(
        env,
        fork,
        1,
        settings,
        providers,
        forkSeedId,
        false,
        transport,
        compareConfig.mode === "same" ? injections : [],
      );
    } catch (error) {
      // A failed secondary model never blocks or replays the main request.
      try {
        const fresh = await store.get<Chat>(fork.id);
        if (
          fresh &&
          fresh.value.messages[fresh.value.currentId ?? ""]?.role !==
            "assistant"
        ) {
          const failed = addMessage(fresh.value, "assistant", "");
          failed.status = "error";
          failed.error = redactError(
            error instanceof Error ? error.message : "对比启动失败",
          );
          await store.save(
            fork.id,
            "chat",
            fresh.value,
            fresh.revision,
            summary(fresh.value),
          );
        }
      } catch {
        console.error(JSON.stringify({ event: "comparison_start_failed" }));
      }
    }
  }
  if (transport === "device") {
    await env.PROGRESS.getByName(id).deviceCheckpoint(
      0,
      seed?.content ?? "",
      "",
    );
    return id;
  }
  try {
    await env.GENERATION.create({ id, params: { jobId: id } });
  } catch {
    await env.DB.prepare(
      "UPDATE jobs SET status='error',error='后台任务启动失败',config='{}' WHERE id=?",
    )
      .bind(id)
      .run();
    message.status = "error";
    message.error = "后台任务启动失败，请手动重试";
    const latest = await new Store(env.DB).get<Chat>(chat.id);
    if (latest) {
      latest.value.messages[message.id] = message;
      await new Store(env.DB).save(
        chat.id,
        "chat",
        latest.value,
        latest.revision,
        summary(latest.value),
      );
    }
    throw new HttpError(503, "后台任务启动失败，请手动重试");
  }
  return id;
}
export async function finalize(
  env: Env,
  job: Pick<Job, "id" | "chat_id" | "message_id" | "created_at">,
  status: "complete" | "stopped" | "error",
  content: string,
  reasoning: string,
  error?: string,
  usage?: Record<string, unknown>,
) {
  const store = new Store(env.DB);
  for (let attempt = 0; attempt < 4; attempt++) {
    const doc = await store.get<Chat>(job.chat_id);
    if (!doc) return;
    const message = doc.value.messages[job.message_id];
    if (!message) return;
    if (message.status !== "running") return;
    message.content = content;
    message.contentVersion = crypto.randomUUID();
    message.reasoning = reasoning;
    message.status = status;
    message.error = error;
    message.usage = usage;
    message.elapsedMs = Date.now() - job.created_at;
    doc.value.updatedAt = Date.now();
    doc.value.unread = status === "complete";
    try {
      await store.save(
        job.chat_id,
        "chat",
        doc.value,
        doc.revision,
        summary(doc.value),
        [
          env.DB.prepare(
            "UPDATE jobs SET status=?,error=?,updated_at=?,config='{}' WHERE id=?",
          ).bind(status, error ?? null, Date.now(), job.id),
        ],
      );
      break;
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 409) || attempt === 3)
        throw e;
    }
  }
}
export function requestForJob(
  chat: Chat,
  job: Pick<Job, "message_id">,
  config: JobConfig,
) {
  const target = chat.messages[job.message_id];
  if (!target) throw new HttpError(404, "回答不存在");
  const messages = injectPlugins(
    contextMessages(
      {
        ...chat,
        currentId: target.parentId,
        system: config.system,
        rounds: config.rounds,
        includeStopped: config.includeStopped,
      },
      undefined,
      /(^|\/)deepseek(?:[-/]|$)/i.test(config.model.modelId),
    ),
    config.injections ?? [],
  );
  const seed = config.seedId ? chat.messages[config.seedId] : null;
  if (seed) {
    messages.push({
      role: "assistant",
      content: seed.content,
      ...(/(^|\/)deepseek(?:[-/]|$)/i.test(config.model.modelId) &&
      seed.reasoning
        ? { reasoning_content: seed.reasoning }
        : {}),
    });
    messages.push({
      role: "user",
      content: "请继续上面的回答，不要重复已经写出的内容。",
    });
  }
  return {
    ...config.options,
    messages: compatibleMessages(config.model.modelId, messages),
  };
}
export async function generationStart(
  env: Env,
  jobId: string,
): Promise<GenerationStart> {
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id=?")
    .bind(jobId)
    .first<Job>();
  if (!job) throw new HttpError(404, "任务不存在");
  const config = JSON.parse(job.config) as JobConfig;
  if (config.transport !== "device") return { jobId };
  const delivery = await env.DB.prepare(
    "UPDATE jobs SET attempted=2 WHERE id=? AND attempted=1 AND status='running' RETURNING id",
  )
    .bind(jobId)
    .first();
  if (!delivery) return { jobId };
  const doc = await new Store(env.DB).get<Chat>(job.chat_id);
  if (!doc) throw new HttpError(404, "聊天不存在");
  const direct: DirectTask = {
    jobId,
    chatId: job.chat_id,
    messageId: job.message_id,
    providerId: config.model.providerId,
    baseUrl: config.provider.baseUrl,
    hasKey: !!config.provider.encryptedKey,
    seedContent: config.seedId
      ? (doc.value.messages[config.seedId]?.content ?? "")
      : "",
    request: requestForJob(doc.value, job, config),
  };
  return { jobId, direct };
}
export async function runGeneration(
  env: Env,
  id: string,
  progress: import("./progress").Progress,
  controller: AbortController,
) {
  const claimed = await env.DB.prepare(
    "UPDATE jobs SET attempted=1,status='running',updated_at=? WHERE id=? AND attempted=0 AND status='pending' RETURNING *",
  )
    .bind(Date.now(), id)
    .first<Job>();
  if (!claimed) return { skipped: true }; // Never replay a billable upstream request after a runtime restart.
  const config = JSON.parse(claimed.config) as JobConfig,
    store = new Store(env.DB);
  const output: CompletionOutput = { content: "", reasoning: "" };
  let key = "";
  let seedContent = "";
  const disposeDeadline = generationDeadline(controller);
  try {
    const doc = await store.get<Chat>(claimed.chat_id);
    if (!doc) throw new Error("聊天不存在");
    const target = doc.value.messages[claimed.message_id];
    if (!target) throw new Error("回答不存在");
    const seed = config.seedId ? doc.value.messages[config.seedId] : null;
    output.content = seed?.content ?? "";
    seedContent = output.content;
    if (!progress.checkpoint(output.content, output.reasoning)) {
      await finalize(env, claimed, "stopped", output.content, output.reasoning);
      return { stopped: true };
    }
    const request = requestForJob(doc.value, claimed, config);
    key = config.provider.encryptedKey
      ? await decrypt(config.provider.encryptedKey, env.ENCRYPTION_KEY)
      : "";
    const signal = controller.signal;
    const response = await fetch(
      config.provider.baseUrl + "/chat/completions",
      {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: "Bearer " + key } : {}),
        },
        body: JSON.stringify(request),
        signal,
      },
    );
    let lastCheckpoint = Date.now() - 2000;
    await readCompletion(
      response,
      Boolean(config.options.stream),
      signal,
      output,
      () => {
        progress.publish(output.content, output.reasoning);
        if (Date.now() - lastCheckpoint >= 2000) {
          if (!progress.checkpoint(output.content, output.reasoning)) {
            controller.abort();
            signal.throwIfAborted();
          }
          lastCheckpoint = Date.now();
        }
      },
      2000,
    );
  } catch (e) {
    if (progress.isCancelled()) {
      const output = progress.output();
      await finalize(
        env,
        claimed,
        "stopped",
        output.hasData ? output.content : seedContent,
        output.reasoning,
      );
      return { stopped: true };
    }
    const error = redactError(e instanceof Error ? e.message : "生成失败", key);
    await finalize(
      env,
      claimed,
      "error",
      output.content,
      output.reasoning,
      error,
      output.usage,
    );
    return { status: "error" };
  } finally {
    disposeDeadline();
  }
  progress.publish(output.content, output.reasoning, true);
  await finalize(
    env,
    claimed,
    "complete",
    output.content,
    output.reasoning,
    undefined,
    output.usage,
  );
  return { status: "complete" };
}
export async function limitedText(
  response: Response,
  max: number,
  signal?: AbortSignal,
) {
  if (!response.body) return "";
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  const abortRead = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abortRead, { once: true });
  let size = 0,
    result = "";
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > max) throw new HttpError(413, "响应超过安全上限");
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    signal?.removeEventListener("abort", abortRead);
    await reader.cancel().catch(() => {});
  }
}
