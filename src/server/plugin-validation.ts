import {
  pluginDefaults,
  type PluginDefinition,
  type PluginBinding,
} from "../shared/plugins";
import { obj, str, parameters, modelRef } from "./validation";
import { HttpError } from "./store";
export function validatedPlugins(value: unknown): PluginDefinition[] {
  if (!Array.isArray(value) || value.length > 32)
    throw new HttpError(400, "插件数量或格式无效");
  const ids = new Set<string>();
  return value.map((item) => {
    const v = obj(item),
      kind = v.kind;
    if (!["analysis", "clarify", "suggest", "rewrite"].includes(String(kind)))
      throw new HttpError(400, "插件类型无效");
    const id = str(v.id, 128);
    if (id.startsWith("builtin-") && id !== "builtin-" + kind)
      throw new HttpError(400, "内置插件类型不能修改");
    if (!id || ids.has(id)) throw new HttpError(400, "插件 ID 为空或重复");
    ids.add(id);
    const p = { ...pluginDefaults(kind as PluginDefinition["kind"], id), ...v };
    const num = (key: keyof PluginDefinition, min: number, max: number) => {
      const n = p[key];
      if (
        typeof n !== "number" ||
        !Number.isSafeInteger(n) ||
        n < min ||
        n > max
      )
        throw new HttpError(400, "插件数值无效：" + key);
      return n;
    };
    if (
      !["inherit", "none", "low", "medium", "high", "max"].includes(
        String(p.effort),
      )
    )
      throw new HttpError(400, "插件强度无效");
    if (
      !["tool", "user"].includes(String(p.injection)) ||
      !["sync", "rounds"].includes(String(p.contextMode))
    )
      throw new HttpError(400, "插件上下文或注入方式无效");
    const schema = str(p.schema, 100000);
    if (schema.trim())
      try {
        const data = JSON.parse(schema);
        if (
          typeof data !== "boolean" &&
          (!data || typeof data !== "object" || Array.isArray(data))
        )
          throw Error();
      } catch {
        throw new HttpError(400, "JSON Schema 必须是对象或布尔值");
      }
    const highWater = num("highWater", 0, 2000000),
      lowWater = num("lowWater", 0, 2000000);
    if (highWater > 0 && lowWater >= highWater)
      throw new HttpError(400, "低水位必须小于高水位");
    const initialUser = str(p.initialUser ?? "好的", 100000);
    if (["suggest", "rewrite"].includes(String(kind)) && !initialUser.trim())
      throw new HttpError(400, "开头 user 消息不能为空");
    return {
      id,
      kind: kind as PluginDefinition["kind"],
      name: str(p.name, 100),
      cardTitle: str(p.cardTitle, 100),
      model: modelRef(p.model),
      parameters: parameters(p.parameters),
      effort: p.effort as PluginDefinition["effort"],
      prompt: str(p.prompt, 100000),
      schema,
      example: str(p.example, 100000),
      injection: p.injection as "tool" | "user",
      injectionTemplate: str(p.injectionTemplate, 10000),
      contextMode: p.contextMode as "sync" | "rounds",
      historyRounds: num("historyRounds", 1, 1000),
      referenceCount: num("referenceCount", 0, 1000),
      userHistoryCount: num("userHistoryCount", 0, 100000),
      suggestions: num("suggestions", 1, 10),
      ...(["suggest", "rewrite"].includes(String(kind)) ? { initialUser } : {}),
      highWater,
      lowWater,
    };
  });
}
export function validatedBindings(
  value: unknown,
  definitions: PluginDefinition[],
): PluginBinding[] {
  if (!Array.isArray(value) || value.length > 32)
    throw new HttpError(400, "插件配置格式无效");
  const ids = new Set<string>();
  return value.map((item) => {
    const v = obj(item),
      id = str(v.id, 128),
      base = definitions.find((p) => p.id === id);
    if (!base || ids.has(id)) throw new HttpError(400, "插件不存在或重复");
    ids.add(id);
    if (typeof v.enabled !== "boolean")
      throw new HttpError(400, "插件开关无效");
    return {
      id,
      enabled: v.enabled,
      ...(v.overrides
        ? {
            overrides: validatedPlugins([
              { ...base, ...obj(v.overrides), id, kind: base.kind },
            ])[0],
          }
        : {}),
    };
  });
}
