CREATE TABLE login_guards (key TEXT PRIMARY KEY, failures INTEGER NOT NULL, blocked_until INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX login_guards_updated ON login_guards(updated_at);
CREATE TABLE login_notice (id INTEGER PRIMARY KEY CHECK(id=1), count INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL);
