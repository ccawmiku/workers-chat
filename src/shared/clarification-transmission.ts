import { questionView } from "./plugin-sections";
import type { APIMessage } from "./plugins";
export type ClarificationSubmission = {
  questions: {
    id: string;
    question: string;
    answers: { id: string; text: string }[];
  }[];
  free_text?: string;
};
/** Explicit selections, including terse typed replies such as 1A 2BC. No unchosen options. */
export function clarificationSubmission(
  output: string,
  selections: unknown,
  freeText: string,
): ClarificationSubmission {
  const questions = questionView(output) ?? [],
    selected = (
      selections && typeof selections === "object" && !Array.isArray(selections)
        ? selections
        : {}
    ) as Record<string, unknown>;
  const typed = new Map<number, string[]>();
  for (const match of freeText.matchAll(
    /(?:^|[\s,，;；])(\d+)\s*([A-Za-z]+)(?=$|[\s,，;；])/g,
  ))
    typed.set(Number(match[1]) - 1, [...match[2]!.toUpperCase()]);
  return {
    questions: questions.flatMap((q, i) => {
      const picked = Array.isArray(selected[q.id])
        ? (selected[q.id] as string[])
        : [];
      const raw = picked.length ? picked : (typed.get(i) ?? []);
      const ids = [...new Set(raw)].filter((id) =>
        q.options.some((o) => o.id === id),
      );
      if (!ids.length) return [];
      return [
        {
          id: q.id,
          question: q.question,
          answers: q.options
            .filter((o) => ids.includes(o.id))
            .map((o) => ({ id: o.id, text: o.text })),
        },
      ];
    }),
    ...(freeText.trim() ? { free_text: freeText } : {}),
  };
}
/** Older accepted records have a deterministic question/selected-answer transcript. */
export function legacyClarificationSubmission(
  output: string,
  answer = "",
): ClarificationSubmission {
  const questions = questionView(output);
  if (!questions)
    return { questions: [], ...(answer.trim() ? { free_text: answer } : {}) };
  const marker = "用户自由回答（原文）：\n",
    markerAt = answer.indexOf(marker);
  const free = markerAt >= 0 ? answer.slice(markerAt + marker.length) : "";
  if (!questions.some((q, i) => answer.includes(`${i + 1}. ${q.question}\n`)))
    return clarificationSubmission(output, {}, markerAt >= 0 ? free : answer);
  const selected: Record<string, string[]> = {};
  questions.forEach((q, i) => {
    const header = `${i + 1}. ${q.question}\n`,
      start = answer.indexOf(header);
    if (start < 0) return;
    const next =
      i + 1 < questions.length
        ? answer.indexOf(
            `${i + 2}. ${questions[i + 1]!.question}\n`,
            start + header.length,
          )
        : -1;
    const block = answer.slice(
      start + header.length,
      next >= 0 ? next : markerAt >= 0 ? markerAt : undefined,
    );
    selected[q.id] = q.options
      .filter((o) =>
        ("\n" + block.trim() + "\n").includes(
          "\n" + o.id + ". " + o.text + "\n",
        ),
      )
      .map((o) => o.id);
  });
  return clarificationSubmission(output, selected, free);
}
export const hasClarificationAnswers = (s: ClarificationSubmission) =>
  s.questions.length > 0 || !!s.free_text?.trim();
/** Old main tool snapshots must also stop leaking unchosen/entirely unanswered questions. */
export function cleanLegacyClarificationTools(
  messages: APIMessage[],
): APIMessage[] {
  const dropped = new Set<string>();
  const clean = messages.flatMap((m) => {
    if (m.role !== "tool" || !m.content) return [m];
    // The legacy wrapper was JSON.stringify({questions: output, answer}).
    // Locate this exact wrapper, even when a custom template has other braces.
    const start = m.content.indexOf('{"questions":"');
    if (start < 0) return [m];
    let end = start,
      depth = 0,
      quoted = false,
      escaped = false;
    for (; end < m.content.length; end++) {
      const c = m.content[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) break;
    }
    if (end >= m.content.length) return [m];
    try {
      const data = JSON.parse(m.content.slice(start, end + 1));
      if (typeof data.questions !== "string" || typeof data.answer !== "string")
        return [m];
      const submission = legacyClarificationSubmission(
        data.questions,
        data.answer,
      );
      if (!hasClarificationAnswers(submission)) {
        if (m.tool_call_id) dropped.add(m.tool_call_id);
        return [];
      }
      return [
        {
          ...m,
          content:
            m.content.slice(0, start) +
            JSON.stringify(submission) +
            m.content.slice(end + 1),
        },
      ];
    } catch {
      return [m];
    }
  });
  return clean.flatMap((m) => {
    if (m.role !== "assistant" || !m.tool_calls) return [m];
    const calls = m.tool_calls.filter((c) => !dropped.has(c.id));
    return calls.length
      ? [{ ...m, tool_calls: calls }]
      : m.content
        ? [{ ...m, tool_calls: undefined }]
        : [];
  });
}
