export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Document<T> = { value: T; revision: number };
export function chunks(value: string, size = 131072): string[] {
  const result: string[] = [];
  for (let i = 0; i < value.length;) {
    let end = Math.min(i + size, value.length);
    const c = value.charCodeAt(end - 1);
    if (end < value.length && c >= 0xd800 && c <= 0xdbff) end--;
    result.push(value.slice(i, end));
    i = end;
  }
  return result;
}
export class Store {
  constructor(readonly db: D1Database) {}
  async get<T>(id: string): Promise<Document<T> | null> {
    const row = await this.db
      .prepare("SELECT revision FROM documents WHERE id=?")
      .bind(id)
      .first<{ revision: number }>();
    if (!row) return null;
    const { results } = await this.db
      .prepare(
        "SELECT value FROM document_parts WHERE id=? AND revision=? ORDER BY part",
      )
      .bind(id, row.revision)
      .all<{ value: string }>();
    if (!results.length) throw new HttpError(500, "存储版本不完整");
    return {
      value: JSON.parse(results.map((p) => p.value).join("")) as T,
      revision: row.revision,
    };
  }
  async list<T>(kind: string): Promise<T[]> {
    const { results } = await this.db
      .prepare(
        "SELECT summary FROM documents WHERE kind=? ORDER BY json_extract(summary,'$.updatedAt') DESC",
      )
      .bind(kind)
      .all<{ summary: string }>();
    return results.map((r) => JSON.parse(r.summary) as T);
  }
  async save<T>(
    id: string,
    kind: string,
    value: T,
    revision: number,
    summary: unknown = value,
    extraStatements: D1PreparedStatement[] = [],
  ) {
    const parts = chunks(JSON.stringify(value));
    if (parts.length > 40)
      throw new HttpError(413, "单项数据过大，请分批导入或拆分聊天");
    const next = revision + 1,
      statements: D1PreparedStatement[] = [];
    if (revision === 0)
      statements.push(
        this.db
          .prepare(
            "INSERT INTO documents(id,kind,summary,revision) VALUES(?,?,?,?)",
          )
          .bind(id, kind, JSON.stringify(summary), next),
      );
    statements.push(
      this.db
        .prepare(
          "INSERT INTO document_versions(id,revision,created_at) VALUES(?,?,?)",
        )
        .bind(id, next, Date.now()),
    );
    parts.forEach((part, i) =>
      statements.push(
        this.db
          .prepare("INSERT INTO document_parts VALUES(?,?,?,?)")
          .bind(id, next, i, part),
      ),
    );
    if (revision !== 0)
      statements.push(
        this.db
          .prepare(
            "UPDATE documents SET summary=?,revision=? WHERE id=? AND revision=?",
          )
          .bind(JSON.stringify(summary), next, id, revision),
      );
    statements.push(...extraStatements);
    // Retain a grace period for readers that already selected an older immutable version.
    statements.push(
      this.db
        .prepare(
          "DELETE FROM document_versions WHERE id=? AND revision<? AND created_at<?",
        )
        .bind(id, next, Date.now() - 60000),
    );
    try {
      await this.db.batch(statements);
    } catch (e) {
      if (/UNIQUE constraint|stale revision/.test(String(e)))
        throw new HttpError(409, "内容已在其他请求中更新，请重新打开聊天");
      throw e;
    }
    return next;
  }
  async remove(id: string) {
    await this.db.prepare("DELETE FROM documents WHERE id=?").bind(id).run();
  }
}
export function summary(chat: import("../shared/chat").Chat) {
  return {
    id: chat.id,
    title: chat.title,
    groupId: chat.groupId,
    updatedAt: chat.updatedAt,
    pinned: chat.pinned,
    archived: chat.archived,
    deleted: chat.deleted,
    unread: chat.unread,
    status: chat.currentId ? chat.messages[chat.currentId]?.status : undefined,
  };
}
