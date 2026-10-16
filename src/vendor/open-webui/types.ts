export type OverviewMessage = {
  id: string;
  parentId: string | null;
  role: string;
  content: string;
  model?: string;
  output?: unknown;
  error?: { content: string };
};
export type OverviewHistory = { currentId: string | null; messages: Record<string, OverviewMessage> };
export type OverviewData = {
  message: OverviewMessage;
  user: { id: string; name: string };
  model?: { id: string; name: string };
  direction: string;
};
