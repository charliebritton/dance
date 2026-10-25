CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- items is a JSON array: {k, type: 'fig'|'mark', fig, name, notes, bars, label}
CREATE TABLE IF NOT EXISTS routines (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  dance       TEXT NOT NULL,
  level       TEXT NOT NULL,
  brief       TEXT NOT NULL DEFAULT '',
  items       TEXT NOT NULL DEFAULT '[]',
  rev         INTEGER NOT NULL DEFAULT 1,
  example     INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id),
  updated_by  INTEGER REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- every version of a routine's figures, so a partner can see what changed since they signed off
CREATE TABLE IF NOT EXISTS routine_versions (
  routine_id  TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  rev         INTEGER NOT NULL,
  items       TEXT NOT NULL,
  level       TEXT NOT NULL,
  by_user     INTEGER REFERENCES users(id),
  at          INTEGER NOT NULL,
  PRIMARY KEY (routine_id, rev)
);

CREATE TABLE IF NOT EXISTS approvals (
  routine_id  TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  rev         INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  PRIMARY KEY (routine_id, user_id)
);

-- shared chart overrides (edited by you two or drafted by Claude); starter charts live in charts.json
CREATE TABLE IF NOT EXISTS charts (
  fig_id      TEXT PRIMARY KEY,
  data        TEXT NOT NULL,
  src         TEXT NOT NULL,          -- 'edited' | 'ai'
  updated_by  INTEGER REFERENCES users(id),
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  fig_id      TEXT PRIMARY KEY,
  text        TEXT NOT NULL,
  updated_by  INTEGER REFERENCES users(id),
  updated_at  INTEGER NOT NULL
);

-- ref is 'fig:<figure id>' or 'routine:<routine id>'; either url (a link) or file (an upload) is set
CREATE TABLE IF NOT EXISTS videos (
  id          TEXT PRIMARY KEY,
  ref         TEXT NOT NULL,
  url         TEXT,
  file        TEXT,
  mime        TEXT,
  size        INTEGER,
  title       TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES users(id),
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS videos_ref ON videos(ref);

-- the routine assistant conversation, shared by both partners
CREATE TABLE IF NOT EXISTS chat (
  id          INTEGER PRIMARY KEY,
  routine_id  TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,          -- 'user' | 'assistant'
  content     TEXT NOT NULL,
  proposal    TEXT,                   -- JSON or NULL
  user_id     INTEGER REFERENCES users(id),
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_routine ON chat(routine_id, id);

-- ── society accounts ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS groups (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_groups (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, group_id)
);

-- id is the credential id, base64url
CREATE TABLE IF NOT EXISTS passkeys (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key  BLOB NOT NULL,
  sign_count  INTEGER NOT NULL DEFAULT 0,
  transports  TEXT NOT NULL DEFAULT '[]',
  label       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  last_used   INTEGER
);

CREATE TABLE IF NOT EXISTS invites (
  token       TEXT PRIMARY KEY,
  label       TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT 'member',   -- role given to people who join with it
  max_uses    INTEGER,                          -- NULL = unlimited
  uses        INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER,                          -- NULL = never
  revoked     INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id          TEXT PRIMARY KEY,
  challenge   BLOB NOT NULL,
  purpose     TEXT NOT NULL,                    -- 'register' | 'login'
  user_id     INTEGER,
  data        TEXT NOT NULL DEFAULT '{}',       -- pending sign-up details
  expires_at  INTEGER NOT NULL
);

-- ── figures ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS figure_status (
  fig_id       TEXT PRIMARY KEY,
  verified_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS figure_comments (
  id          INTEGER PRIMARY KEY,
  fig_id      TEXT NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS figure_comments_fig ON figure_comments(fig_id, id);

CREATE TABLE IF NOT EXISTS user_notes (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fig_id      TEXT NOT NULL,
  text        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, fig_id)
);

-- ── lessons ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lessons (
  id          TEXT PRIMARY KEY,
  date        TEXT NOT NULL,                    -- YYYY-MM-DD
  group_id    INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  dance       TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  figures     TEXT NOT NULL DEFAULT '[]',       -- figure ids covered
  items       TEXT NOT NULL DEFAULT '[]',       -- the routine danced, same shape as routines.items
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lesson_comments (
  id          INTEGER PRIMARY KEY,
  lesson_id   TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lesson_comments_lesson ON lesson_comments(lesson_id, id);

-- a member's recording of a lesson (uploaded or recorded in the browser), transcribed on this server.
-- Seen only by the person who added it and the committee. file is NULL once the audio has been deleted.
CREATE TABLE IF NOT EXISTS lesson_recordings (
  id           TEXT PRIMARY KEY,
  lesson_id    TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file         TEXT,                            -- in upload_dir/recordings
  mime         TEXT NOT NULL DEFAULT '',
  size         INTEGER NOT NULL DEFAULT 0,
  keep_audio   INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'queued',  -- 'queued' | 'running' | 'done' | 'failed'
  progress     REAL NOT NULL DEFAULT 0,         -- 0–1 through the audio
  duration     REAL,                            -- seconds
  error        TEXT NOT NULL DEFAULT '',
  transcript   TEXT NOT NULL DEFAULT '',        -- one "[m:ss] text" line per segment
  notes        TEXT NOT NULL DEFAULT '',        -- notes drafted from it, edited by its owner
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER
);
CREATE INDEX IF NOT EXISTS lesson_recordings_lesson ON lesson_recordings(lesson_id, created_at);

-- ── competitions ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS competitions (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  host            TEXT NOT NULL DEFAULT '',
  start_date      TEXT,                         -- YYYY-MM-DD
  end_date        TEXT,
  venue           TEXT NOT NULL DEFAULT '',
  travel          TEXT NOT NULL DEFAULT 'tbc',  -- 'society' (travelling together) | 'own' | 'tbc'
  team_entry      INTEGER NOT NULL DEFAULT 0,
  entry_url       TEXT NOT NULL DEFAULT '',
  entry_deadline  TEXT,
  notes           TEXT NOT NULL DEFAULT '',
  confirmed       INTEGER NOT NULL DEFAULT 0,
  source          TEXT NOT NULL DEFAULT '',
  updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at      INTEGER NOT NULL
);

-- ── Claude ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_requests (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                    -- 'chart' | 'routine'
  target      TEXT NOT NULL,                    -- figure id or routine id
  note        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',     -- 'open' | 'done' | 'dismissed' | 'failed'
  created_at  INTEGER NOT NULL,
  handled_at  INTEGER,
  handled_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  purpose        TEXT NOT NULL,
  model          TEXT NOT NULL,
  input_tokens   INTEGER NOT NULL,
  output_tokens  INTEGER NOT NULL,
  cost_usd       REAL NOT NULL,
  at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_usage_user ON ai_usage(user_id, at);

-- pre-rendered 3D videos of each figure (renders.py); hash = the chart version, tempo and rig it was filmed from
CREATE TABLE IF NOT EXISTS renders (
  fig_id      TEXT PRIMARY KEY,
  hash        TEXT NOT NULL,
  file        TEXT NOT NULL,
  fps         REAL NOT NULL,
  bpm         REAL NOT NULL,
  lead        REAL NOT NULL,
  tail        REAL NOT NULL,
  size        INTEGER,
  created_at  INTEGER NOT NULL
);
