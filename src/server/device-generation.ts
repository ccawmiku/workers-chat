import { type Job, type JobConfig, finalize } from "./generation";
import { HttpError, Store } from "./store";
import { str } from "./validation";
import { decrypt, redactError } from "./security";
import { type Chat, sanitizeUsage } from "../shared/chat";
import { queueTitle } from "./titles";
import { queueSuggestions } from "./plugins";

export async function deviceGeneration(
  env: Env,
  id: string,
  action: string,
  body: Record<string, unknown>,
) {
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id=?")
    .bind(id)
    .first<Job>();
  if (!job) throw new HttpError(404, "任务不存在");
  if (!["pending", "running"].includes(job.status)) {
    const doc = await new Store(env.DB).get<Chat>(job.chat_id);
    if (
      action === "finish" &&
      body.status === job.status &&
      doc?.value.messages[job.message_id]?.request?.transport === "device"
    )
      return Response.json({
        ok: true,
        titleJobId:
          job.status === "complete" ? await queueTitle(env, job.chat_id) : null,
      });
    throw new HttpError(409, "任务已结束");
  }
  const config = JSON.parse(job.config) as JobConfig;
  if (config.transport !== "device")
    throw new HttpError(400, "不是设备直连任务");
  const status = body.status;
  if (
    action === "finish" &&
    status !== "complete" &&
    status !== "error" &&
    status !== "stopped"
  )
    throw new HttpError(400, "结束状态无效");
  if (body.content === undefined) throw new HttpError(400, "缺少回答进度");
  const error = body.error === undefined ? undefined : str(body.error, 4000);
  const progress = env.PROGRESS.getByName(id);
  if (body.content !== undefined) {
    if (!Number.isSafeInteger(body.sequence) || Number(body.sequence) < 1)
      throw new HttpError(400, "进度序号无效");
    const result = await progress.deviceCheckpoint(
      Number(body.sequence),
      str(body.content),
      str(body.reasoning ?? ""),
    );
    if (result.cancelled) throw new HttpError(409, "任务已停止");
    if (!result.accepted) throw new HttpError(409, "进度已更新，不能回退");
  }
  if (action === "checkpoint") return Response.json({ ok: true });
  if (status !== "complete" && status !== "error" && status !== "stopped")
    throw new HttpError(400, "结束状态无效");
  if (status === "complete" && body.content === undefined)
    throw new HttpError(400, "缺少完整回答");
  const output = await progress.cancel();
  const key = config.provider.encryptedKey
    ? await decrypt(config.provider.encryptedKey, env.ENCRYPTION_KEY)
    : "";
  await finalize(
    env,
    job,
    status,
    output.content,
    output.reasoning,
    error === undefined ? undefined : redactError(error, key),
    sanitizeUsage(body.usage),
  );
  let titleJobId: string | null = null;
  if (status === "complete") titleJobId = await queueTitle(env, job.chat_id);
  if (status === "complete")
    await queueSuggestions(env, job.chat_id, job.message_id, "device");
  return Response.json({ ok: true, titleJobId });
}
