import type { Settings, Provider, Parameters } from "../shared/chat";
import type { PluginRequest } from "../shared/plugins";
import { HttpError } from "./store";
import { modelRef } from "./validation";
import { compatibleMessages } from "../shared/upstream-compat";

/** Manual, one-attempt override. Never writes global or chat configuration. */
export function fallbackRequest(
  settings: Settings,
  providers: Provider[],
  value: unknown,
  request: PluginRequest,
  explicit: Parameters,
) {
  const ref = modelRef(value);
  if (
    !ref ||
    !settings.pluginFallbackModels?.some(
      (m) => m.providerId === ref.providerId && m.modelId === ref.modelId,
    )
  )
    throw new HttpError(400, "请选择共享备用列表中的模型");
  const provider = providers.find((p) => p.id === ref.providerId);
  const model = provider?.models.find((m) => m.id === ref.modelId && m.enabled);
  if (!provider || !model)
    throw new HttpError(400, "备用模型已关闭或移除，请更新列表");
  const { temperature, top_p, top_k, ...base } = request;
  const messages = request.messages.map(
    ({ reasoning_content, ...message }) => message,
  );
  return {
    provider,
    modelRef: ref,
    request: {
      ...base,
      ...settings.parameters,
      ...model.parameters,
      ...explicit,
      model: ref.modelId,
      messages: compatibleMessages(ref.modelId, messages),
    },
  };
}
