import type { Chat, ModelRef, Settings, Provider } from "../shared/chat";
import { defaultSettings } from "../shared/chat";
import { HttpError } from "./store";
import { upstreamUrl } from "./security";
export type Obj = Record<string, unknown>;
export function obj(v: unknown): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new HttpError(400, "无效对象");
  return v as Obj;
}
export function str(v: unknown, max = 4 * 1024 * 1024): string {
  if (typeof v !== "string" || v.length > max)
    throw new HttpError(400, "文字格式或长度无效");
  return v;
}
export function parameters(v: unknown) {
  const data = obj(v),
    out: Chat["parameters"] = {};
  for (const key of ["temperature", "top_p", "top_k"] as const) {
    const n = data[key];
    if (n === undefined || n === null) continue;
    const max = key === "temperature" ? 2 : key === "top_p" ? 1 : 100000;
    if (
      typeof n !== "number" ||
      !Number.isFinite(n) ||
      n < 0 ||
      n > max ||
      (key === "top_k" && !Number.isInteger(n))
    )
      throw new HttpError(400, "生成参数无效");
    out[key] = n;
  }
  return out;
}
export function modelRef(v: unknown): ModelRef | null {
  if (v === null || v === undefined) return null;
  const r = obj(v);
  return { providerId: str(r.providerId, 128), modelId: str(r.modelId, 500) };
}
export function validatedSettings(v: unknown): Settings {
  const input = { ...defaultSettings(), ...obj(v) };
  if (!Array.isArray(input.templates) || input.templates.length > 100)
    throw new HttpError(400, "模板格式无效");
  return {
    defaultModel: modelRef(input.defaultModel),
    parameters: parameters(input.parameters),
    templates: input.templates.map((v) => {
      const t = obj(v);
      return {
        id: str(t.id, 128),
        name: str(t.name, 200),
        content: str(t.content),
      };
    }),
    titlePrompt: str(input.titlePrompt, 10000),
    titleModel: modelRef(input.titleModel),
  };
}
export function validatedProvider(
  v: unknown,
): Omit<Provider, "encryptedKey"> & { apiKey?: string } {
  const p = obj(v);
  if (!Array.isArray(p.models)) throw new HttpError(400, "模型列表格式无效");
  const ids = new Set<string>();
  const models = p.models.map((v) => {
    const m = obj(v),
      id = str(m.id, 500);
    if (!id || ids.has(id)) throw new HttpError(400, "模型 ID 为空或重复");
    ids.add(id);
    if (
      typeof m.enabled !== "boolean" ||
      typeof m.capacity !== "number" ||
      !Number.isSafeInteger(m.capacity) ||
      m.capacity < 1
    )
      throw new HttpError(400, "模型开关或容量无效");
    return {
      id,
      enabled: m.enabled,
      capacity: m.capacity,
      parameters: parameters(m.parameters ?? {}),
    };
  });
  return {
    id: str(p.id, 128),
    name: str(p.name, 100),
    baseUrl: upstreamUrl(str(p.baseUrl, 2000)),
    prefix: str(p.prefix ?? "", 100),
    models,
    ...(p.apiKey !== undefined ? { apiKey: str(p.apiKey, 8192) } : {}),
  };
}
