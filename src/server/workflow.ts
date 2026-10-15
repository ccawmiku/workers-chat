import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

export class Generation extends WorkflowEntrypoint<Env, { jobId: string }> {
  async run(event: WorkflowEvent<{ jobId: string }>, step: WorkflowStep) {
    // Model calls are not idempotent. Disable automatic retries, and persist an
    // attempted marker before fetching so replay cannot silently charge twice.
    const result = await step.do(
      "generate-and-save",
      { retries: { limit: 0, delay: "1 second" }, timeout: "35 minutes" },
      async () =>
        this.env.PROGRESS.getByName(event.payload.jobId).run(
          event.payload.jobId,
        ),
    );
    if (JSON.parse(result).status === "complete")
      await step.do(
        "schedule-title",
        { retries: { limit: 0, delay: "1 second" } },
        async () =>
          this.env.PROGRESS.getByName(event.payload.jobId).scheduleTitle(
            event.payload.jobId,
          ),
      );
    return result;
  }
}

export class TitleGeneration extends WorkflowEntrypoint<
  Env,
  { jobId: string }
> {
  async run(event: WorkflowEvent<{ jobId: string }>, step: WorkflowStep) {
    return step.do(
      "title-and-save",
      { retries: { limit: 0, delay: "1 second" }, timeout: "5 minutes" },
      async () =>
        this.env.PROGRESS.getByName("title-" + event.payload.jobId).runTitle(
          event.payload.jobId,
        ),
    );
  }
}
