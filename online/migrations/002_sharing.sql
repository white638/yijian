CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','closed','revoked','imported')),
  token_hash TEXT UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  source_count INTEGER NOT NULL,
  imported INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS shares_owner ON shares(owner_id, created_at);

CREATE TABLE IF NOT EXISTS share_items (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  brand TEXT NOT NULL,
  image_id TEXT UNIQUE,
  object_key TEXT,
  position INTEGER NOT NULL,
  UNIQUE(share_id, item_id)
);
CREATE INDEX IF NOT EXISTS share_items_source ON share_items(item_id, share_id);

CREATE TABLE IF NOT EXISTS share_replies (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  nickname TEXT NOT NULL,
  text TEXT NOT NULL,
  snapshot_item_ids TEXT NOT NULL,
  item_ids TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(share_id, request_id)
);
CREATE INDEX IF NOT EXISTS share_replies_share ON share_replies(share_id, created_at);

CREATE TABLE IF NOT EXISTS share_rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
