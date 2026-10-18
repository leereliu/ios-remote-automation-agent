CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('operation','goal')),
  device_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','done','error')),
  payload TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(kind,device_id,status,created_at);
-- Run once during deployment, never on the request path.
CREATE INDEX IF NOT EXISTS jobs_expires ON jobs(expires_at,id);
-- Expired pending jobs must not be scanned on every idle queue check.
CREATE INDEX IF NOT EXISTS jobs_pending_expiry ON jobs(kind,device_id,expires_at,created_at,id) WHERE status='pending';
CREATE TABLE IF NOT EXISTS device_state (
  id TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL,
  metadata TEXT NOT NULL
);
