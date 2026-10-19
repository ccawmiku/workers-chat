import { stripStyleMarkers } from "./body-styles";
import {
  forkChat,
  type Chat,
  type ModelRef,
  type Parameters,
  type Effort,
} from "./chat";
export type ComparisonConfig = {
  enabled: boolean;
  model: ModelRef | null;
  parameters: Parameters;
  effort: Effort;
  mode: "same" | "plain";
};
export type ComparisonRun = {
  chatId: string;
  title?: string;
  userId: string;
  mainMessageId: string;
  createdAt: number;
  error?: string;
};
export const defaultComparison = (): ComparisonConfig => ({
  enabled: false,
  model: null,
  parameters: {},
  effort: "inherit",
  mode: "same",
});
/** Always fork the current main user, never the prior comparison branch. */
export function comparisonFork(
  chat: Chat,
  config: ComparisonConfig,
  titles: string[],
) {
  if (!chat.currentId || chat.messages[chat.currentId]?.role !== "user")
    throw Error("对比必须关联当前用户消息");
  const copy = forkChat(chat, chat.currentId, titles);
  copy.model = config.model ?? chat.model;
  copy.parameters = { ...chat.parameters, ...config.parameters };
  copy.effort = config.effort;
  copy.comparison = { ...config, enabled: false };
  copy.plugins = [];
  copy.lengthGuidance = { enabled: false, requirement: "" };
  delete copy.comparisonRuns;
  copy.comparisonSource = {
    chatId: chat.id,
    userId: chat.currentId,
    localUserId: copy.currentId!,
    mode: config.mode,
  };
  if (config.mode === "plain" && copy.bodyStyles) copy.bodyStyles.enabled = false;
  if (config.mode === "plain")
    for (const m of Object.values(copy.messages)) {
      delete m.toolContext;
      delete m.lengthRequirement;
      if (m.role === "assistant") { m.content = stripStyleMarkers(m.content); m.styleTagged = false; }
    }
  return copy;
}
