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
