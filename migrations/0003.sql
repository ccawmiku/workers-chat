CREATE TABLE chat_drafts(chat_id TEXT PRIMARY KEY,version TEXT NOT NULL,updated_at INTEGER NOT NULL,FOREIGN KEY(chat_id) REFERENCES documents(id) ON DELETE CASCADE);
CREATE TABLE draft_parts(chat_id TEXT NOT NULL,version TEXT NOT NULL,part INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(chat_id,version,part),FOREIGN KEY(chat_id) REFERENCES documents(id) ON DELETE CASCADE);
