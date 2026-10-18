export type TokenBreakdown = {
  input: number;
  thinking: number;
  output: number;
  total: number;
};
const number = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
/** Output in OpenAI usage includes reasoning; split it rather than counting it twice. */
export function tokenBreakdown(value: unknown): TokenBreakdown | undefined {
  const u = object(value),
    details = object(u.completion_tokens_details ?? u.output_tokens_details);
  const rawInput = number(u.prompt_tokens ?? u.input_tokens),
    input =
      rawInput === undefined
        ? undefined
        : u.prompt_tokens === undefined &&
            u.cache_read_input_tokens !== undefined
          ? rawInput +
            (number(u.cache_read_input_tokens) ?? 0) +
            (number(u.cache_creation_input_tokens) ?? 0)
          : rawInput,
    out = number(u.completion_tokens ?? u.output_tokens),
    thought = number(
      details.reasoning_tokens ?? u.reasoning_tokens ?? u.thinking_tokens,
    );
  if (input === undefined && out === undefined && thought === undefined)
    return undefined;
  const separate =
    u.output_tokens_includes_reasoning === false ||
    (thought !== undefined &&
      thought > 0 &&
      input !== undefined &&
      out !== undefined &&
      number(u.total_tokens) === input + out + thought);
  const thinking =
    separate || out === undefined
      ? (thought ?? 0)
      : Math.min(thought ?? 0, out);
  const output = separate ? (out ?? 0) : Math.max(0, (out ?? 0) - thinking);
  const result = {
    input: input ?? 0,
    thinking,
    output,
    total: (input ?? 0) + thinking + output,
  };
  return result;
}
