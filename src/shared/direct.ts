import type { APIMessage } from "./plugins";
export type DirectTask = {
  jobId: string;
  chatId: string;
  messageId: string;
  providerId: string;
  baseUrl: string;
  hasKey: boolean;
  seedContent: string;
  request: Record<string, unknown> & {
    messages: APIMessage[];
  };
};
export type GenerationStart = {
  jobId?: string;
  direct?: DirectTask;
  pluginFlow?: boolean;
};
export type DirectTitleTask = {
  jobId: string;
  chatId: string;
  candidates: {
    providerId: string;
    baseUrl: string;
    hasKey: boolean;
    request: Record<string, unknown>;
  }[];
};
