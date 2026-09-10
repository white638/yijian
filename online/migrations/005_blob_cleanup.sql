CREATE TABLE IF NOT EXISTS blob_delete_jobs (
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, object_key)
);
CREATE INDEX IF NOT EXISTS blob_delete_jobs_owner_created ON blob_delete_jobs(owner_id, created_at);
