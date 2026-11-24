-- Design amendment 5: resumable chunked R2 archive state machine

ALTER TABLE tournaments ADD COLUMN closed_at TEXT;

CREATE TABLE archive_jobs (
  slug TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  table_idx INTEGER NOT NULL DEFAULT 0,
  cursor TEXT,
  next_part INTEGER NOT NULL DEFAULT 1,
  max_submission_rowid INTEGER NOT NULL DEFAULT 0,
  deleted_day TEXT,
  deleted_today INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE archive_parts (
  slug TEXT NOT NULL,
  part INTEGER NOT NULL,
  tbl TEXT NOT NULL,
  rows INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (slug, part)
);
