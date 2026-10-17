import { Validator, type Schema } from "@cfworker/json-schema";
export function readPluginJSON(text: string, schemaText?: string) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1")
    .trim();
  let value: unknown;
  try {
    value = JSON.parse(cleaned);
  } catch {
    throw Error("插件返回的内容不是合法 JSON，可编辑修复或重新生成。");
  }
  if (schemaText?.trim()) {
    let schema: Schema;
    try {
      schema = JSON.parse(schemaText) as Schema;
    } catch {
      throw Error("JSON Schema 格式无效");
    }
    const result = new Validator(schema, "2020-12").validate(value);
    if (!result.valid)
      throw Error(
        "JSON 不符合结构规则：" +
          result.errors
            .slice(0, 3)
            .map((e) => e.instanceLocation + " " + e.error)
            .join("；"),
      );
  }
  return value;
}
