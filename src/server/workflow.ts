import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

export class Generation extends WorkflowEntrypoint<Env, { jobId: string }> {
  async run(event: WorkflowEvent<{ jobId: string }>, step: WorkflowStep) {
    // Model calls are not idempotent. Disable automatic retries, and persist an
    // attempted marker before fetching so replay cannot silently charge twice.
    return step.do(
      "generate-and-save",
      { retries: { limit: 0, delay: "1 second" }, timeout: "35 minutes" },
      async () =>
        this.env.PROGRESS.getByName(event.payload.jobId).run(
          event.payload.jobId,
        ),
    );
  }
}
