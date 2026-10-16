import type { Role } from "./chat";
export type DirectTask = {
  jobId: string;
  chatId: string;
  messageId: string;
  providerId: string;
  baseUrl: string;
  hasKey: boolean;
  seedContent: string;
  request: Record<string, unknown> & {
    messages: { role: Role; content: string }[];
  };
};
export type GenerationStart = { jobId: string; direct?: DirectTask };
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
