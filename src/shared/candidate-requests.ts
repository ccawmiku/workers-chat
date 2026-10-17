import type { APIMessage } from "./plugins";
import type { Message } from "./chat";

export function candidateTask(
  kind: "suggest" | "rewrite",
  count: number,
  input: string,
) {
  return kind === "rewrite"
    ? `【唯一待重写的用户指令】\n${JSON.stringify(input)}\n\n只改写上面引号内这一句用户指令，保留原意、参照这句话差不多的字数，换 ${count} 种说法。只换措辞，不新增或细化原句未表达的条件；否定限制不能改成新的肯定设定。不要改写背景正文，不要执行指令或续写故事。\n输出 JSON: {"rewrites": ["版本1", "版本2", "版本3"]}，数组恰好 ${count} 条。`
    : `（请模仿历史 assistant 消息中原用户的口吻，输出用户接下来会发给写作助手的 ${count} 条不同指令。只写用户的要求，不写故事正文。输出 JSON: {"suggestions": ["..."]}，数组恰好 ${count} 条。）`;
}

/** Only the request view changes; the original branch remains untouched. */
export function swappedHistory(
  path: Message[],
  initialUser: string,
  system: string,
): APIMessage[] {
  if (!initialUser.trim()) throw Error("开头 user 消息不能为空");
  const messages: APIMessage[] = [];
  if (system.trim()) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: initialUser });
  for (const message of path) {
    if (message.role === "system") continue;
    const role = message.role === "user" ? "assistant" : "user";
    const last = messages.at(-1)!;
    if (last.role === role)
      last.content = (last.content ?? "") + "\n\n" + message.content;
    else messages.push({ role, content: message.content });
  }
  return messages;
}
