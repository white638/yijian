CREATE TABLE IF NOT EXISTS migration_previews (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES workspaces(owner_id) ON DELETE CASCADE,
  object_key TEXT,
  sha256 TEXT NOT NULL,
  target_revision INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready','imported')),
  result TEXT
);
CREATE INDEX IF NOT EXISTS migration_previews_owner ON migration_previews(owner_id,status,expires_at);
