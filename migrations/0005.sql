DROP INDEX jobs_one_active_chat;
CREATE UNIQUE INDEX jobs_one_active_chat ON jobs(chat_id) WHERE status IN ('pending','running') AND COALESCE(json_extract(config,'$.post'),0)=0;
CREATE INDEX jobs_active_post ON jobs(chat_id,created_at) WHERE status IN ('pending','running') AND json_extract(config,'$.post')=1;
