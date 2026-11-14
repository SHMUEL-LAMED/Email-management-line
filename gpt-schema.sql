CREATE TABLE IF NOT EXISTS gpt_messages (
 id TEXT PRIMARY KEY,
 owner TEXT NOT NULL,
 conv TEXT NOT NULL,
 text TEXT NOT NULL,
 reply TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','answered')),
 created_at INTEGER NOT NULL,
 answered_at INTEGER,
 lease_id TEXT,
 lease_until INTEGER
);
CREATE INDEX IF NOT EXISTS gpt_messages_pending ON gpt_messages(owner,status,created_at);
CREATE INDEX IF NOT EXISTS gpt_messages_conv ON gpt_messages(owner,conv,created_at);
