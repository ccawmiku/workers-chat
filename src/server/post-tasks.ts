import type { Chat } from "../shared/chat";
import type { PostJobView } from "../shared/summaries";
import type { PluginState } from "../shared/plugins";
import { pluginState, pluginView, finishPlugin } from "./plugins";
import { summaryState, finishSummary } from "./summaries";
import { jobOutput, type Job } from "./generation";
export async function postView(env: Env, chat: Chat, foreground?: PluginState) {
  const jobs = (
    await env.DB.prepare(
      "SELECT * FROM jobs WHERE chat_id=? AND status IN ('pending','running') AND json_extract(config,'$.post')=1 ORDER BY created_at DESC LIMIT 12",
    )
      .bind(chat.id)
      .all<Job>()
  ).results;
  const summaryDoc = await summaryState(env, chat.id),
    plugins = foreground
      ? { value: foreground }
      : await pluginState(env, chat.id);
  let changed = false;
  const postJobs: PostJobView[] = [];
  for (const job of jobs) {
    const c = JSON.parse(job.config),
      isSummary = c.kind === "summary";
    const output = await jobOutput(env, job.id);
    const age = Date.now() - (output.updatedAt || job.created_at);
    let interrupted = c.transport === "device" && age > 90000;
    if (c.transport !== "device" && age > 15000)
      try {
        interrupted = ["errored", "terminated", "complete", "unknown"].includes(
          (await (await env.GENERATION.get(job.id)).status()).status,
        );
      } catch {}
    if (interrupted) {
      const failure =
        "任务中断，已保留结果；请手动重新生成，不会自动重试模型请求";
      if (isSummary) await finishSummary(env, job.id, output, "error", failure);
      else await finishPlugin(env, job.id, output, "error", failure);
      changed = true;
      continue;
    }
    if (isSummary) {
      const run = summaryDoc.value.runs.find((r) => r.id === job.id);
      if (run && output.hasData) run.output = output.content;
      postJobs.push({
        id: job.id,
        kind: "summary",
        runId: job.id,
        messageId: job.message_id,
      });
    } else {
      const run = plugins.value.runs.find((r) => r.id === job.message_id);
      if (run && output.hasData) run.output = output.content;
      const delivery =
        c.transport === "device"
          ? await pluginView(env, chat, {
              ...job,
              kind: "plugin",
              transport: c.transport,
            })
          : { pluginJob: null };
      postJobs.push({
        id: job.id,
        kind: "suggest",
        runId: job.message_id,
        messageId: run?.anchorId ?? "",
        ...delivery.pluginJob,
      });
    }
  }
  // The foreground snapshot was read before the jobs query. A suggestion may
  // have finished in between: do not return "no jobs" with that stale running row.
  const finishedBetweenReads = !!foreground?.runs.some(
    (r) =>
      r.plugin.kind === "suggest" &&
      r.status === "running" &&
      !jobs.some((j) => j.message_id === r.id),
  );
  return {
    summaryState: changed
      ? (await summaryState(env, chat.id)).value
      : summaryDoc.value,
    postJobs,
    postPluginState:
      changed || finishedBetweenReads
        ? (await pluginState(env, chat.id)).value
        : plugins.value,
  };
}
