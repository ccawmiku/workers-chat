import {
  type Chat,
  type Provider,
  type Settings,
  type ModelRef,
  route,
  defaultSettings,
  uuid,
} from "../shared/chat";
import { Store, HttpError, summary } from "./store";
import { decrypt, redactError } from "./security";
import { limitedText } from "./generation";
export type TitleJob = {
  id: string;
  chat_id: string;
  message_id: string;
  manual: number;
  status: string;
  attempted: number;
  created_at: number;
  updated_at: number;
  error: string | null;
  config: string;
};
type Candidate = {
  model: ModelRef;
  provider: Pick<Provider, "id" | "baseUrl" | "encryptedKey">;
  parameters: Chat["parameters"];
};
type TitleConfig = {
  titleRevision: string;
  prompt: string;
  scope: Chat["titleScope"];
  effort: Chat["effort"];
  candidates: Candidate[];
};
export async function titleStatus(env: Env, chatId: string) {
  const row = await env.DB.prepare(
    "SELECT id,status,error,created_at FROM title_jobs WHERE chat_id=? ORDER BY created_at DESC,id DESC LIMIT 1",
  )
    .bind(chatId)
    .first<{
      id: string;
      status: string;
      error: string | null;
      created_at: number;
    }>();
  if (!row) return null;
  if (
    ["pending", "running"].includes(row.status) &&
    Date.now() - row.created_at > 15000
  ) {
    try {
      const state = await (await env.TITLES.get(row.id)).status();
      if (
        ["errored", "terminated", "complete", "unknown"].includes(state.status)
      ) {
        const error = "标题任务中断，请手动重试；服务器不会自动重复请求";
        const changed = await env.DB.prepare(
          "UPDATE title_jobs SET status='error',error=?,config='{}',updated_at=? WHERE id=? AND status IN ('pending','running')",
        )
          .bind(error, Date.now(), row.id)
          .run();
        if (changed.meta.changes)
          Object.assign(row, { status: "error", error });
      }
    } catch {
      // A transient lookup failure cannot justify replaying a model request.
    }
  }
  return { id: row.id, status: row.status, error: row.error };
}
export async function queueTitle(env: Env, chatId: string, manual = false) {
  const store = new Store(env.DB),
    doc = await store.get<Chat>(chatId);
  if (!doc || doc.value.deleted) return null;
  const chat = doc.value;
  if (!manual && chat.titleManual) return null;
  const existing = await env.DB.prepare(
    "SELECT id FROM title_jobs WHERE chat_id=? AND (status IN ('pending','running') OR (?=0 AND manual=0)) LIMIT 1",
  )
    .bind(chatId, manual ? 1 : 0)
    .first<{ id: string }>();
  if (existing) {
    if (manual) throw new HttpError(409, "标题仍在生成，请稍后再试");
    return existing.id;
  }
  const selected = manual
    ? chat.currentId
    : Object.values(chat.messages)
        .filter(
          (m) =>
            m.role === "assistant" &&
            m.status === "complete" &&
            m.content &&
            !m.excluded,
        )
        .sort((a, b) => a.createdAt - b.createdAt)[0]?.id;
  if (
    !selected ||
    !route(chat, selected).some((m) => m.role === "assistant" && m.content)
  ) {
    if (manual) throw new HttpError(400, "请先完成一轮问答");
    return null;
  }
  const settings =
      (await store.get<Settings>("settings"))?.value ?? defaultSettings(),
    providers = (await store.all<Provider>("provider")).map((p) => p.value);
  const candidates: Candidate[] = [];
  for (const ref of [
    settings.titleModel ?? chat.model ?? settings.defaultModel,
    settings.defaultModel,
  ]) {
    if (
      !ref ||
      candidates.some(
        (c) =>
          c.model.providerId === ref.providerId &&
          c.model.modelId === ref.modelId,
      )
    )
      continue;
    const provider = providers.find((p) => p.id === ref.providerId),
      model = provider?.models.find((m) => m.id === ref.modelId);
    if (!provider || !model) continue;
    candidates.push({
      model: ref,
      provider: {
        id: provider.id,
        baseUrl: provider.baseUrl,
        encryptedKey: provider.encryptedKey,
      },
      parameters: { ...settings.parameters, ...model.parameters },
    });
  }
  const id = uuid(),
    config: TitleConfig = {
      titleRevision: chat.titleRevision ?? "",
      prompt: settings.titlePrompt,
      scope: manual ? chat.titleScope : "branch",
      effort: chat.effort,
      candidates,
    };
  try {
    await env.DB.prepare(
      "INSERT INTO title_jobs(id,chat_id,message_id,manual,status,created_at,updated_at,config) VALUES(?,?,?,?,'pending',?,?,?)",
    )
      .bind(
        id,
        chatId,
        selected,
        manual ? 1 : 0,
        Date.now(),
        Date.now(),
        JSON.stringify(config),
      )
      .run();
  } catch (e) {
    if (/UNIQUE constraint/.test(String(e))) {
      if (manual) throw new HttpError(409, "标题仍在生成，请稍后再试");
      return null;
    }
    throw e;
  }
  try {
    await env.TITLES.create({ id, params: { jobId: id } });
  } catch {
    await finishTitleJob(env, id, "error", "标题任务启动失败，请手动重试");
    if (manual) throw new HttpError(503, "标题任务启动失败");
  }
  return id;
}
export async function finishTitleJob(
  env: Env,
  id: string,
  status: string,
  error: string | null = null,
) {
  await env.DB.prepare(
    "UPDATE title_jobs SET status=?,error=?,updated_at=?,config='{}' WHERE id=?",
  )
    .bind(status, error, Date.now(), id)
    .run();
}
export function titleMaterial(
  chat: Chat,
  selection: string,
  scope: Chat["titleScope"],
) {
  let path = route(chat, selection).filter(
    (m) => !m.excluded && (m.role === "user" || m.role === "assistant"),
  );
  if (scope === "first") {
    const start = path.findIndex((m) => m.role === "user");
    const answer = path.findIndex(
      (m, i) => i > start && m.role === "assistant",
    );
    path =
      start < 0 ? [] : path.slice(start, answer < 0 ? start + 1 : answer + 1);
  }
  return path.map((m) => ({ role: m.role, content: m.content }));
}
export async function runTitle(env: Env, id: string): Promise<string> {
  const job = await env.DB.prepare(
    "UPDATE title_jobs SET attempted=1,status='running',updated_at=? WHERE id=? AND status='pending' AND attempted=0 RETURNING *",
  )
    .bind(Date.now(), id)
    .first<TitleJob>();
  if (!job) {
    await env.DB.prepare(
      "UPDATE title_jobs SET status='error',error='标题任务中断，请手动重试',config='{}' WHERE id=? AND status='running'",
    )
      .bind(id)
      .run();
    return "skipped";
  }
  try {
    const store = new Store(env.DB),
      doc = await store.get<Chat>(job.chat_id);
    if (!doc || doc.value.deleted) {
      await finishTitleJob(env, id, "superseded");
      return "superseded";
    }
    const config = JSON.parse(job.config) as TitleConfig;
    if (
      (doc.value.titleRevision ?? "") !== config.titleRevision ||
      (!job.manual && doc.value.titleManual)
    ) {
      await finishTitleJob(env, id, "superseded");
      return "superseded";
    }
    const material = titleMaterial(doc.value, job.message_id, config.scope);
    let title = "",
      error = "没有可用的标题模型或默认聊天模型";
    for (const candidate of config.candidates) {
      let key = "";
      try {
        key = candidate.provider.encryptedKey
          ? await decrypt(candidate.provider.encryptedKey, env.ENCRYPTION_KEY)
          : "";
        const response = await fetch(
          candidate.provider.baseUrl + "/chat/completions",
          {
            method: "POST",
            redirect: "manual",
            headers: {
              "Content-Type": "application/json",
              ...(key ? { Authorization: "Bearer " + key } : {}),
            },
            body: JSON.stringify({
              model: candidate.model.modelId,
              stream: false,
              ...candidate.parameters,
              ...(config.effort !== "inherit"
                ? { reasoning_effort: config.effort }
                : {}),
              messages: [
                { role: "system", content: config.prompt },
                { role: "user", content: JSON.stringify(material) },
              ],
            }),
            signal: AbortSignal.timeout(120000),
          },
        );
        const text = await limitedText(response, 65536);
        if (!response.ok)
          throw new Error(
            `标题上游 HTTP ${response.status}：${redactError(text, key)}`,
          );
        const data = JSON.parse(text) as {
          choices?: { message?: { content?: string } }[];
        };
        title = data.choices?.[0]?.message?.content?.trim() ?? "";
        if (!title || title.length > 500)
          throw new Error("标题为空或超过 500 个字符");
        break;
      } catch (e) {
        error = redactError(
          e instanceof Error ? e.message : "标题生成失败",
          key,
        );
        title = "";
      }
    }
    if (!title) throw new Error(error);
    for (let attempt = 0; attempt < 4; attempt++) {
      const latest = await store.get<Chat>(job.chat_id);
      if (
        !latest ||
        latest.value.deleted ||
        (latest.value.titleRevision ?? "") !== config.titleRevision ||
        (!job.manual && latest.value.titleManual)
      ) {
        await finishTitleJob(env, id, "superseded");
        return "superseded";
      }
      latest.value.title = title;
      latest.value.titleManual = !!job.manual;
      latest.value.titleRevision = uuid();
      if (job.manual) latest.value.updatedAt = Date.now();
      try {
        await store.save(
          job.chat_id,
          "chat",
          latest.value,
          latest.revision,
          summary(latest.value),
          [
            env.DB.prepare(
              "UPDATE title_jobs SET status='complete',config='{}',updated_at=? WHERE id=?",
            ).bind(Date.now(), id),
          ],
        );
        return "complete";
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 409) || attempt === 3)
          throw e;
      }
    }
  } catch (e) {
    await finishTitleJob(
      env,
      id,
      "error",
      e instanceof Error ? e.message : "标题生成失败",
    );
  }
  return "error";
}
