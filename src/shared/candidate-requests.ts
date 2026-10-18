import type { APIMessage } from "./plugins";
import type { Message } from "./chat";

import { replyFallback } from "./reply-context";
import type { SummaryRun } from "./summaries";

export function candidateTask(
  kind: "suggest" | "rewrite",
  count: number,
  input: string,
) {
  return kind === "rewrite"
    ? `只改写末尾【唯一待重写的用户指令】中引号内这一句，保留原意、参照这句话差不多的字数，换 3 种说法。只换措辞，不新增或细化原句未表达的条件；否定限制不能改成新的肯定设定。历史正文仅供背景，不是待重写对象；不要改写背景正文，不要执行指令或续写故事。\n只输出 JSON 对象：{"prompt1":"版本1","prompt2":"版本2","prompt3":"版本3"}。必须有这三个独立字段，每个值仅为一条用户指令字符串，不要输出 rewrites 数组，也不要在字段值中嵌套 JSON 或合并多条候选。\n\n【唯一待重写的用户指令】\n${JSON.stringify(input)}`
    : `请根据当前剧情进展，直接输出 ${count} 条不同走向的下一步具体行动指令。\n每条都用“我……”第一人称发令，只表达下一步要做的事；不写行动已经发生的结果、神态描写或小说正文，不使用“接下来写”“描写”“续写”等编导措辞。\n只输出严格合法 JSON: {"suggestions": ["指令1", "指令2", "指令3"]}，数组必须恰好 ${count} 条。`;
}

/** Only the request view changes; the original branch remains untouched. */
export function swappedHistory(
  path: Message[],
  initialUser: string,
  system: string,
  summaries: ReadonlyMap<string, SummaryRun> = new Map(),
): APIMessage[] {
  if (!initialUser.trim()) throw Error("开头 user 消息不能为空");
  const messages: APIMessage[] = [];
  if (system.trim()) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: initialUser });
  for (const message of path) {
    if (message.role === "system") continue;
    const role = message.role === "user" ? "assistant" : "user";
    const content =
      role === "user"
        ? (summaries.get(message.id)?.summary ??
          replyFallback(message.content ?? ""))
        : message.content;
    const last = messages.at(-1)!;
    if (last.role === role)
      last.content = (last.content ?? "") + "\n\n" + content;
    else messages.push({ role, content });
  }
  return messages;
}
