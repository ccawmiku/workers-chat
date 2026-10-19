import type { Env } from "./env";

export interface WorkflowInstance {
  status(): Promise<{ status: "running" | "complete" | "errored" | "unknown" }>;
  terminate(): Promise<void>;
}

export class WorkflowManager {
  private activeJobs = new Map<
    string,
    {
      status: "running" | "complete" | "errored";
      promise: Promise<void>;
      abort?: () => void;
    }
  >();

  constructor(
    private kind: "generation" | "title",
    private env: Env,
  ) {}

  async create({ id, params }: { id: string; params: { jobId: string } }) {
    const jobId = params.jobId;
    const entry: {
      status: "running" | "complete" | "errored";
      promise: Promise<void>;
      abort?: () => void;
    } = {
      status: "running",
      promise: Promise.resolve(),
    };

    if (this.kind === "generation") {
      entry.promise = (async () => {
        try {
          const progress = this.env.PROGRESS.getByName(jobId);
          entry.abort = () => progress.cancel();
          const resultStr = await progress.run(jobId);
          const result = JSON.parse(resultStr);
          if (result.status === "complete") {
            await progress.scheduleTitle(jobId);
          }
          entry.status = "complete";
        } catch (err) {
          console.error(`Generation workflow error for job ${jobId}:`, err);
          entry.status = "errored";
        }
      })();
    } else {
      entry.promise = (async () => {
        try {
          const progress = this.env.PROGRESS.getByName("title-" + jobId);
          entry.abort = () => progress.cancel();
          await progress.runTitle(jobId);
          entry.status = "complete";
        } catch (err) {
          console.error(`Title workflow error for job ${jobId}:`, err);
          entry.status = "errored";
        }
      })();
    }

    this.activeJobs.set(id, entry);
    entry.promise.finally(() => {
      setTimeout(() => {
        this.activeJobs.delete(id);
      }, 300000);
    });
  }

  async get(id: string): Promise<WorkflowInstance> {
    const entry = this.activeJobs.get(id);
    return {
      status: async () => {
        if (!entry) return { status: "unknown" };
        return { status: entry.status };
      },
      terminate: async () => {
        if (entry) {
          entry.abort?.();
          entry.status = "complete";
          this.activeJobs.delete(id);
        }
      },
    };
  }
}

export class Generation {}
export class TitleGeneration {}
