import type { D1DatabaseCompat } from "./sqlite-compat";
import type { Progress } from "./progress";
import type { WorkflowManager } from "./workflow";

export interface Env {
  DB: D1DatabaseCompat;
  PROGRESS: {
    getByName(name: string): Progress;
  };
  GENERATION: WorkflowManager;
  TITLES: WorkflowManager;
  PASSWORD_HASH: string;
  RECOVERY_HASH: string;
  ENCRYPTION_KEY: string;
  LOCAL_SESSION_TOKEN?: string;
  CF_ANALYTICS_TOKEN?: string;
  CF_ANALYTICS_ACCOUNT_ID?: string;
}
