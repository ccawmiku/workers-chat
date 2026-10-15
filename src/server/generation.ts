import {
  type Chat,
  type Provider,
  type Settings,
  requestPreview,
  route,
  addMessage,
  sanitizeUsage,
} from "../shared/chat";
import { Store, HttpError, summary, chunks } from "./store";
import { decrypt, redactError } from "./security";
export type JobConfig = {
  options: Record<string, unknown>;
  provider: Pick<Provider, "id" | "baseUrl" | "encryptedKey">;
  system: Chat["system"];
  rounds?: number;
  includeStopped: boolean;
  model: NonNullable<Chat["model"]>;
  seedId?: string;
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
    "SELECT * FROM jobs WHERE chat_id=? AND status IN ('pending','running')",
  )
    .bind(id)
    .first<Job>();
}
export async function jobOutput(env: Env, id: string) {
  return env.PROGRESS.getByName(id).output();
}
export async function startGeneration(
  env: Env,
  chat: Chat,
  revision: number,
  settings: Settings,
  providers: Provider[],
  seedId?: string,
  clearDraft = false,
) {
  const { model, provider, request } = requestPreview(
    chat,
    settings,
    providers,
  );
  const { messages: _messages, ...options } = request;
  const seed = seedId ? chat.messages[seedId] : null;
  const message = addMessage(chat, "assistant", seed?.content ?? "");
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
  };
  chat.unread = false;
  const config: JobConfig = {
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
  };
  const id = crypto.randomUUID();
  // The chat revision is the mutation lock; only one concurrent start can commit it.
  const store = new Store(env.DB);
  await store.save(chat.id, "chat", chat, revision, summary(chat), [
    ...(clearDraft ? store.planDraft(chat.id, "") : []),
    env.DB.prepare(
      "INSERT INTO jobs(id,chat_id,message_id,status,created_at,updated_at,config) VALUES(?,?,?,'pending',?,?,?)",
    ).bind(
      id,
      chat.id,
      message.id,
      Date.now(),
      Date.now(),
      JSON.stringify(config),
    ),
  ]);
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
  job: Job,
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
export async function runGeneration(
  env: Env,
  id: string,
  progress: import("./progress").Progress,
) {
  const claimed = await env.DB.prepare(
    "UPDATE jobs SET attempted=1,status='running',updated_at=? WHERE id=? AND attempted=0 AND status='pending' RETURNING *",
  )
    .bind(Date.now(), id)
    .first<Job>();
  if (!claimed) return { skipped: true }; // Never replay a billable upstream request after a runtime restart.
  const config = JSON.parse(claimed.config) as JobConfig,
    store = new Store(env.DB);
  let content = "",
    reasoning = "",
    key = "",
    usage: Record<string, unknown> | undefined,
    complete = false;
  const controller = new AbortController();
  try {
    const doc = await store.get<Chat>(claimed.chat_id);
    if (!doc) throw new Error("聊天不存在");
    const target = doc.value.messages[claimed.message_id];
    if (!target) throw new Error("回答不存在");
    const seed = config.seedId ? doc.value.messages[config.seedId] : null;
    content = seed?.content ?? "";
    if (!progress.checkpoint(content, reasoning)) {
      await finalize(env, claimed, "stopped", content, reasoning);
      return { stopped: true };
    }
    let path = route(doc.value, target.parentId).filter(
      (m) => !m.excluded && (config.includeStopped || m.status !== "stopped"),
    );
    if (config.rounds && config.rounds > 0) {
      let rounds = 0,
        i = path.length;
      while (i > 0) {
        i--;
        if (path[i]!.role === "user" && ++rounds === config.rounds) break;
      }
      path = path.slice(i);
    }
    const messages = path.map((m) => ({ role: m.role, content: m.content }));
    const system = config.system
      .map((t) => t.content)
      .filter(Boolean)
      .join("\n\n");
    if (system) messages.unshift({ role: "system", content: system });
    if (seed) {
      messages.push({ role: "assistant", content: seed.content });
      messages.push({
        role: "user",
        content: "请继续上面的回答，不要重复已经写出的内容。",
      });
    }
    key = config.provider.encryptedKey
      ? await decrypt(config.provider.encryptedKey, env.ENCRYPTION_KEY)
      : "";
    const response = await fetch(
      config.provider.baseUrl + "/chat/completions",
      {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: "Bearer " + key } : {}),
        },
        body: JSON.stringify({ ...config.options, messages }),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(30 * 60 * 1000),
        ]),
      },
    );
    if (!response.ok)
      throw new Error(
        `上游 HTTP ${response.status}：${redactError(await limitedText(response, 8192), key)}`,
      );
    if (config.options.stream) {
      if (!response.body) throw new Error("上游没有返回响应流");
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "",
        lastFlush = Date.now() - 2000,
        finished = false;
      const consume = (block: string) => {
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) return;
        if (data === "[DONE]") {
          finished = true;
          return;
        }
        const event = JSON.parse(data) as {
          error?: { message?: string };
          choices?: {
            delta?: {
              content?: string;
              reasoning_content?: string;
              reasoning?: string;
            };
            finish_reason?: string;
          }[];
          usage?: Record<string, unknown>;
        };
        if (event.error)
          throw new Error(
            redactError(event.error.message ?? "上游流式错误", key),
          );
        const choice = event.choices?.[0];
        content += choice?.delta?.content ?? "";
        reasoning +=
          choice?.delta?.reasoning_content ?? choice?.delta?.reasoning ?? "";
        if (event.usage) usage = sanitizeUsage(event.usage);
        if (choice?.finish_reason) finished = true;
      };
      try {
        let pending = reader.read();
        while (true) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const part = await Promise.race([
            pending,
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), 2000);
            }),
          ]);
          if (timer !== undefined) clearTimeout(timer);
          if (part) {
            buffer += decoder
              .decode(part.value, { stream: !part.done })
              .replace(/\r\n/g, "\n");
            let split: number;
            while ((split = buffer.indexOf("\n\n")) >= 0) {
              consume(buffer.slice(0, split));
              buffer = buffer.slice(split + 2);
            }
            if (buffer.length > 1048576)
              throw new Error("上游 SSE 事件超过安全上限");
          }
          if (!part || Date.now() - lastFlush >= 2000 || part.done) {
            if (!progress.checkpoint(content, reasoning)) {
              controller.abort();
              return { stopped: true };
            }
            lastFlush = Date.now();
          }
          if (part?.done) break;
          if (part) pending = reader.read();
        }
        if (buffer.trim()) consume(buffer);
        if (!finished) throw new Error("上游连接提前结束，已保存收到的部分");
      } finally {
        await reader.cancel().catch(() => {});
      }
    } else {
      const result = JSON.parse(
        await limitedText(response, 8 * 1024 * 1024),
      ) as {
        choices?: {
          message?: { content?: string; reasoning_content?: string };
        }[];
        usage?: Record<string, unknown>;
      };
      const message = result.choices?.[0]?.message;
      if (!message) throw new Error("上游没有返回回答");
      content += message.content ?? "";
      reasoning = message.reasoning_content ?? "";
      usage = sanitizeUsage(result.usage);
    }
    complete = true;
  } catch (e) {
    const error = redactError(e instanceof Error ? e.message : "生成失败", key);
    await finalize(env, claimed, "error", content, reasoning, error, usage);
    return { status: "error" };
  } finally {
    controller.abort();
  }
  if (complete)
    await finalize(
      env,
      claimed,
      "complete",
      content,
      reasoning,
      undefined,
      usage,
    );
  return { status: "complete" };
}
export async function limitedText(response: Response, max: number) {
  if (!response.body) return "";
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let size = 0,
    result = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new HttpError(413, "响应超过安全上限");
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}
