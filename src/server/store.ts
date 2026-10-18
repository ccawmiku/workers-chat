export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const hasSeparateDraft = Symbol("separate-draft");
export type Document<T> = { value: T; revision: number };
export type DocumentHeader = {
  revision: number;
  kind: string;
  summary: string;
};
export function chunks(value: string, size = 524288): string[] {
  const result: string[] = [];
  for (let i = 0; i < value.length; ) {
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
  async get<T>(
    id: string,
    header?: DocumentHeader | null,
  ): Promise<Document<T> | null> {
    if (header === null) return null;
    // Read the current header and its immutable parts in one SQL snapshot.
    // A supplied header deliberately pins an earlier version (readChat also
    // selects its active job); never replace that with the current revision.
    const { results } = await (
      header === undefined
        ? this.db
            .prepare(
              "SELECT d.revision,d.kind,d.summary,p.value FROM documents d LEFT JOIN document_parts p ON p.id=d.id AND p.revision=d.revision WHERE d.id=? ORDER BY p.part",
            )
            .bind(id)
        : this.db
            .prepare(
              "SELECT value FROM document_parts WHERE id=? AND revision=? ORDER BY part",
            )
            .bind(id, header.revision)
    ).all<DocumentHeader & { value: string | null }>();
    const row = header ?? results[0];
    if (!row) return null;
    if (!results.length || results.some((p) => p.value === null))
      throw new HttpError(500, "存储版本不完整");
    const value = JSON.parse(results.map((p) => p.value).join("")) as T;
    if (row.kind === "chat") {
      Object.assign(value as object, {
        groupId: JSON.parse(row.summary).groupId ?? null,
      });
      const draft = await this.db
        .prepare(
          "SELECT p.value FROM chat_drafts h LEFT JOIN draft_parts p ON p.chat_id=h.chat_id AND p.version=h.version WHERE h.chat_id=? ORDER BY p.part",
        )
        .bind(id)
        .all<{ value: string | null }>();
      if (draft.results.length)
        Object.assign(value as object, {
          draft: draft.results.map((p) => p.value ?? "").join(""),
        });
      Object.defineProperty(value, hasSeparateDraft, {
        value: draft.results.length > 0,
      });
    }
    return {
      value,
      revision: row.revision,
    };
  }
  async all<T>(kind: string): Promise<(Document<T> & { id: string })[]> {
    const { results } = await this.db
      .prepare(
        "SELECT d.id,d.revision,p.value FROM documents d JOIN document_parts p ON p.id=d.id AND p.revision=d.revision WHERE d.kind=? ORDER BY d.id,p.part",
      )
      .bind(kind)
      .all<{ id: string; revision: number; value: string }>();
    const rows = new Map<
      string,
      { id: string; revision: number; parts: string[] }
    >();
    for (const row of results) {
      let group = rows.get(row.id);
      if (!group) {
        group = { id: row.id, revision: row.revision, parts: [] };
        rows.set(row.id, group);
      }
      group.parts.push(row.value);
    }
    return [...rows.values()].map((r) => ({
      id: r.id,
      revision: r.revision,
      value: JSON.parse(r.parts.join("")) as T,
    }));
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
  planSave<T>(
    id: string,
    kind: string,
    value: T,
    revision: number,
    summary: unknown = { id },
    extraStatements: D1PreparedStatement[] = [],
  ) {
    const chat =
      kind === "chat"
        ? (value as { draft?: string; [hasSeparateDraft]?: boolean })
        : null;
    const parts = chunks(
      JSON.stringify(chat ? Object.assign({}, value, { draft: "" }) : value),
    );
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
    if (chat?.draft && !chat[hasSeparateDraft])
      statements.push(...this.planDraft(id, chat.draft, true));
    statements.push(...extraStatements);
    // Retain a grace period for readers that already selected an older immutable version.
    statements.push(
      this.db
        .prepare(
          "DELETE FROM document_versions WHERE id=? AND revision<? AND created_at<?",
        )
        .bind(id, next, Date.now() - 60000),
    );
    return statements;
  }
  async save<T>(
    id: string,
    kind: string,
    value: T,
    revision: number,
    summary: unknown = { id },
    extraStatements: D1PreparedStatement[] = [],
  ) {
    await this.commit(
      this.planSave(id, kind, value, revision, summary, extraStatements),
    );
    return revision + 1;
  }
  async commit(statements: D1PreparedStatement[]) {
    // Keep room for authentication, configuration and job reads within Free's
    // 50-query invocation budget; large restores fail before any mutation.
    if (statements.length > 40)
      throw new HttpError(413, "本批数据过大，请分批恢复");
    try {
      await this.db.batch(statements);
    } catch (e) {
      if (/UNIQUE constraint|stale revision|group missing/.test(String(e)))
        throw new HttpError(409, "内容已在其他请求中更新，请重新打开聊天");
      throw e;
    }
  }
  planDraft(
    id: string,
    value: string,
    onlyIfAbsent = false,
  ): D1PreparedStatement[] {
    const pieces = chunks(value);
    if (pieces.length > 40) throw new HttpError(413, "草稿过大");
    const version = crypto.randomUUID(),
      statements = pieces.map((part, index) =>
        this.db
          .prepare(
            onlyIfAbsent
              ? "INSERT INTO draft_parts SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM chat_drafts WHERE chat_id=?)"
              : "INSERT INTO draft_parts VALUES(?,?,?,?)",
          )
          .bind(
            ...(onlyIfAbsent
              ? [id, version, index, part, id]
              : [id, version, index, part]),
          ),
      );
    statements.push(
      this.db
        .prepare(
          onlyIfAbsent
            ? "INSERT OR IGNORE INTO chat_drafts VALUES(?,?,?)"
            : "INSERT INTO chat_drafts VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET version=excluded.version,updated_at=excluded.updated_at",
        )
        .bind(id, version, Date.now()),
    );
    if (!onlyIfAbsent)
      statements.push(
        this.db
          .prepare("DELETE FROM draft_parts WHERE chat_id=? AND version!=?")
          .bind(id, version),
      );
    return statements;
  }
  async setDraft(id: string, value: string) {
    if (
      !(await this.db
        .prepare("SELECT id FROM documents WHERE id=? AND kind='chat'")
        .bind(id)
        .first())
    )
      throw new HttpError(404, "聊天不存在");
    await this.commit(this.planDraft(id, value));
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
    status:
      chat.pluginPending === "running"
        ? "running"
        : chat.pluginPending === "error"
          ? "error"
          : chat.currentId
            ? chat.messages[chat.currentId]?.status
            : undefined,
  };
}
