import { DatabaseSync, type StatementSync } from "node:sqlite";

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: {
    changes?: number;
    last_row_id?: number;
    [key: string]: unknown;
  };
}

export interface D1Response {
  success: boolean;
  meta: {
    changes: number;
    last_row_id?: number;
    [key: string]: unknown;
  };
}

export class D1StatementCompat {
  private stmt: StatementSync;
  private params: unknown[] = [];

  constructor(
    private db: DatabaseSync,
    public readonly sql: string,
  ) {
    this.stmt = this.db.prepare(sql);
  }

  bind(...values: unknown[]): D1StatementCompat {
    const next = new D1StatementCompat(this.db, this.sql);
    next.params = values.map((v) => (v === undefined ? null : v));
    return next;
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const row = this.stmt.get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (colName) return (row[colName] as T) ?? null;
    return row as T;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const rows = this.stmt.all(...this.params) as T[];
    return {
      results: rows,
      success: true,
      meta: {},
    };
  }

  async run<T = unknown>(): Promise<D1Response> {
    const res = this.stmt.run(...this.params);
    return {
      success: true,
      meta: {
        changes: res.changes,
        last_row_id: Number(res.lastInsertRowid),
      },
    };
  }

  executeDirect(): D1Result<any> {
    const trimmed = this.sql.trim().toUpperCase();
    const isSelect =
      trimmed.startsWith("SELECT") ||
      trimmed.startsWith("PRAGMA") ||
      trimmed.startsWith("EXPLAIN");
    if (isSelect) {
      const rows = this.stmt.all(...this.params);
      return {
        results: rows,
        success: true,
        meta: { changes: 0 },
      };
    } else {
      const res = this.stmt.run(...this.params);
      return {
        results: [],
        success: true,
        meta: {
          changes: res.changes,
          last_row_id: Number(res.lastInsertRowid),
        },
      };
    }
  }
}

const EMBEDDED_MIGRATIONS = [
  {
    id: 1,
    name: "0001.sql",
    sql: `
CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, summary TEXT NOT NULL, revision INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS documents_kind ON documents(kind);
CREATE TABLE IF NOT EXISTS document_versions (id TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(id, revision), FOREIGN KEY(id) REFERENCES documents(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS document_parts (id TEXT NOT NULL, revision INTEGER NOT NULL, part INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(id,revision,part), FOREIGN KEY(id,revision) REFERENCES document_versions(id,revision) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, device TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS auth (id INTEGER PRIMARY KEY CHECK(id=1), password_hash TEXT NOT NULL, recovery_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, message_id TEXT NOT NULL, status TEXT NOT NULL, attempted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT, config TEXT NOT NULL, FOREIGN KEY(chat_id) REFERENCES documents(id) ON DELETE CASCADE);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_chat ON jobs(chat_id) WHERE status IN ('pending','running');
CREATE TRIGGER IF NOT EXISTS document_version_cas BEFORE INSERT ON document_versions WHEN NOT (   NEW.revision = (SELECT revision + 1 FROM documents WHERE id=NEW.id)   OR (NEW.revision=1 AND (SELECT revision FROM documents WHERE id=NEW.id)=1) ) BEGIN SELECT RAISE(ABORT, 'stale revision'); END;
    `,
  },
  {
    id: 2,
    name: "0002.sql",
    sql: `
CREATE TABLE IF NOT EXISTS title_jobs(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,message_id TEXT NOT NULL,manual INTEGER NOT NULL,status TEXT NOT NULL,attempted INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,error TEXT,config TEXT NOT NULL,FOREIGN KEY(chat_id) REFERENCES documents(id) ON DELETE CASCADE);
CREATE UNIQUE INDEX IF NOT EXISTS title_auto_once ON title_jobs(chat_id) WHERE manual=0;
CREATE UNIQUE INDEX IF NOT EXISTS title_one_active ON title_jobs(chat_id) WHERE status IN ('pending','running');
CREATE TRIGGER IF NOT EXISTS chat_group_insert BEFORE INSERT ON documents WHEN NEW.kind='chat' AND json_extract(NEW.summary,'$.groupId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM documents WHERE kind='group' AND id=json_extract(NEW.summary,'$.groupId')) BEGIN SELECT RAISE(ABORT,'group missing'); END;
CREATE TRIGGER IF NOT EXISTS chat_group_update BEFORE UPDATE ON documents WHEN NEW.kind='chat' AND json_extract(NEW.summary,'$.groupId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM documents WHERE kind='group' AND id=json_extract(NEW.summary,'$.groupId')) BEGIN SELECT RAISE(ABORT,'group missing'); END;
    `,
  },
  {
    id: 3,
    name: "0003.sql",
    sql: `
CREATE TABLE IF NOT EXISTS chat_drafts(chat_id TEXT PRIMARY KEY,version TEXT NOT NULL,updated_at INTEGER NOT NULL,FOREIGN KEY(chat_id) REFERENCES documents(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS draft_parts(chat_id TEXT NOT NULL,version TEXT NOT NULL,part INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(chat_id,version,part),FOREIGN KEY(chat_id) REFERENCES documents(id) ON DELETE CASCADE);
    `,
  },
  {
    id: 4,
    name: "0004.sql",
    sql: `
CREATE TABLE IF NOT EXISTS login_guards (key TEXT PRIMARY KEY, failures INTEGER NOT NULL, blocked_until INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS login_guards_updated ON login_guards(updated_at);
CREATE TABLE IF NOT EXISTS login_notice (id INTEGER PRIMARY KEY CHECK(id=1), count INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL);
    `,
  },
  {
    id: 5,
    name: "0005.sql",
    sql: `
DROP INDEX IF EXISTS jobs_one_active_chat;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_chat ON jobs(chat_id) WHERE status IN ('pending','running') AND COALESCE(json_extract(config,'$.post'),0)=0;
CREATE INDEX IF NOT EXISTS jobs_active_post ON jobs(chat_id,created_at) WHERE status IN ('pending','running') AND json_extract(config,'$.post')=1;
    `,
  },
  {
    id: 6,
    name: "0006.sql",
    sql: `
CREATE INDEX IF NOT EXISTS title_jobs_latest ON title_jobs(chat_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS jobs_chat ON jobs(chat_id);
CREATE INDEX IF NOT EXISTS documents_kind_chat ON documents(kind,json_extract(summary,'$.chatId'));
    `,
  },
];

export class D1DatabaseCompat {
  public readonly rawDb: DatabaseSync;

  constructor(dbPath: string) {
    this.rawDb = new DatabaseSync(dbPath);
    this.rawDb.exec("PRAGMA journal_mode = WAL;");
    this.rawDb.exec("PRAGMA foreign_keys = ON;");
    this.initMigrations();
  }

  prepare(sql: string): D1StatementCompat {
    return new D1StatementCompat(this.rawDb, sql);
  }

  async batch<T = unknown>(statements: D1StatementCompat[]): Promise<D1Result<T>[]> {
    this.rawDb.exec("BEGIN");
    try {
      const results: D1Result<T>[] = [];
      for (const statement of statements) {
        results.push(statement.executeDirect());
      }
      this.rawDb.exec("COMMIT");
      return results;
    } catch (err) {
      try {
        this.rawDb.exec("ROLLBACK");
      } catch {}
      throw err;
    }
  }

  async exec(sql: string): Promise<void> {
    this.rawDb.exec(sql);
  }

  private initMigrations() {
    this.rawDb.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);

    const appliedRows = this.rawDb
      .prepare("SELECT id FROM _migrations")
      .all() as { id: number }[];
    const appliedIds = new Set(appliedRows.map((r) => r.id));

    for (const m of EMBEDDED_MIGRATIONS) {
      if (!appliedIds.has(m.id)) {
        this.rawDb.exec("BEGIN");
        try {
          this.rawDb.exec(m.sql);
          this.rawDb
            .prepare(
              "INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)",
            )
            .run(m.id, m.name, Date.now());
          this.rawDb.exec("COMMIT");
        } catch (e) {
          try {
            this.rawDb.exec("ROLLBACK");
          } catch {}
          throw new Error(
            `Failed to apply migration ${m.name}: ${(e as Error).message}`,
          );
        }
      }
    }
  }
}
