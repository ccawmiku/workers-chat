import { bindings, defineConfig, defineWorker, exports } from "cf/config";
import * as entrypoint from "./src/server/index.ts" with { type: "cf-worker" };
import { database } from "./database.config.ts";
const workerDefinition = defineWorker({
  name: "workers-chat",
  compatibilityDate: "2026-10-15",
  entrypoint,
  assets: {
    notFoundHandling: "single-page-application",
    runWorkerFirst: ["/api/*"],
  },
  exports: {
    TitleGeneration: exports.workflow({
      name: "workers-chat-titles",
      defaultRetention: { successRetention: "1 hour", errorRetention: "1 day" },
    }),
    Progress: exports.durableObject({ storage: "sqlite" }),
    Generation: exports.workflow({
      name: "workers-chat-generation",
      defaultRetention: { successRetention: "1 hour", errorRetention: "1 day" },
    }),
  },
  observability: {
    enabled: true,
    logs: { enabled: true },
    traces: { enabled: true, headSamplingRate: 0.01 },
  },
});
export default defineConfig({
  worker: {
    ...workerDefinition,
    env: {
      DB: bindings.d1(database),
      PROGRESS: bindings.durableObject({
        worker: workerDefinition,
        exportName: "Progress",
      }),
      TITLES: bindings.workflow({
        name: "workers-chat-titles",
        worker: workerDefinition,
        exportName: "TitleGeneration",
      }),
      GENERATION: bindings.workflow({
        name: "workers-chat-generation",
        worker: workerDefinition,
        exportName: "Generation",
      }),
      PASSWORD_HASH: bindings.secret(),
      RECOVERY_HASH: bindings.secret(),
      ENCRYPTION_KEY: bindings.secret(),
    },
  },
});
