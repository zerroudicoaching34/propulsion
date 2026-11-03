-- Smart & Strong Sales Copilot — schema v1
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Editable knowledge base: offers, questionnaires, consent text (JSON documents).
CREATE TABLE kb (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE prospects (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  objective TEXT NOT NULL DEFAULT '',
  current_situation TEXT NOT NULL DEFAULT '',
  previous_attempts TEXT NOT NULL DEFAULT '',
  obstacles TEXT NOT NULL DEFAULT '',
  constraints TEXT NOT NULL DEFAULT '',
  budget TEXT NOT NULL DEFAULT '',
  autonomy TEXT NOT NULL DEFAULT '',
  decision_criteria TEXT NOT NULL DEFAULT '',
  coach_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  prospect_id TEXT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('R1','R2')),
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','live','done')),
  consent_given INTEGER NOT NULL DEFAULT 0,
  consent_at TEXT,
  retain INTEGER NOT NULL DEFAULT 0,
  decision TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  -- Non-content metadata kept for real statistics after purge.
  objection_kinds TEXT NOT NULL DEFAULT '',
  coverage_covered INTEGER NOT NULL DEFAULT 0,
  coverage_total INTEGER NOT NULL DEFAULT 0,
  -- Content (purged according to the retention policy).
  analysis_json TEXT,
  debrief_json TEXT,
  content_purged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_meetings_prospect ON meetings(prospect_id);

CREATE TABLE segments (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  speaker TEXT NOT NULL CHECK (speaker IN ('coach','prospect','unknown')),
  text TEXT NOT NULL,
  confidence REAL,
  source TEXT NOT NULL CHECK (source IN ('whisper','manual')),
  edited INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_segments_meeting ON segments(meeting_id, start_ms);

-- Audit log of cloud transfers: metadata only (never the content).
CREATE TABLE cloud_transfers (
  id TEXT PRIMARY KEY,
  meeting_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE cloud_results (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  transfer_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
