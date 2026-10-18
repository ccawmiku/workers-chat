CREATE INDEX title_jobs_latest ON title_jobs(chat_id,created_at DESC,id DESC);
CREATE INDEX jobs_chat ON jobs(chat_id);
CREATE INDEX documents_kind_chat ON documents(kind,json_extract(summary,'$.chatId'));
