export const REPLY_FALLBACK_CHAR_LIMIT = 300;

/** Request-only fallback. Never mutates the source or masquerades as a summary. */
export function replyFallback(content: string): string {
  let end = 0, count = 0;
  for (const char of content) {
    if (count++ === REPLY_FALLBACK_CHAR_LIMIT) break;
    end += char.length;
  }
  return content.slice(0, end);
}
