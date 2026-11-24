-- Service D1 schema (design Appendix D)
-- Note: host_rank is added to tournaments to support the Section 4 step 8
-- host-number + rank tie-breaking rule with zero extra D1 row writes.

CREATE TABLE tournaments (
  slug TEXT PRIMARY KEY,
  key_hash TEXT,
  host_number INTEGER NOT NULL DEFAULT 1,
  host_id TEXT,
  host_rank INTEGER,
  status TEXT NOT NULL,              -- pending|active|paused|revoked|closed|archived
  share_requests INTEGER NOT NULL,
  share_writes INTEGER NOT NULL,
  cdn_origin TEXT,
  acked_through INTEGER NOT NULL DEFAULT 0,
  reg_open TEXT,
  reg_close TEXT,
  reg_cap INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE key_requests (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  contact TEXT NOT NULL,
  note TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  decision TEXT
);

CREATE TABLE permits (
  slug TEXT NOT NULL,
  round_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  open INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (slug, round_id)
);

-- No (slug, rowid) index: the inbox reads `WHERE rowid > ?after ORDER BY rowid LIMIT 2000`
-- and filters by slug, saving one written index row per submission (design section 13).
CREATE TABLE submissions (
  rowid INTEGER PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL,
  round_id TEXT,
  lookup_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE heads (
  slug TEXT NOT NULL,
  seq INTEGER NOT NULL,
  head_hash TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (slug, seq)
);

CREATE TABLE usage (
  slug TEXT NOT NULL,
  day TEXT NOT NULL,
  requests INTEGER NOT NULL,
  writes INTEGER NOT NULL,
  reg_writes INTEGER NOT NULL,
  PRIMARY KEY (slug, day)
);

CREATE TABLE archives (
  slug TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  rows INTEGER NOT NULL,
  archived_at TEXT NOT NULL
);

CREATE TABLE admins (
  email TEXT PRIMARY KEY,
  added_at TEXT NOT NULL
);
