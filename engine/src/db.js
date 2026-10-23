import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './config.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,            -- provider:account:session_key
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  session_key TEXT NOT NULL,
  project TEXT,
  title TEXT,
  cwd TEXT,
  model TEXT,
  state TEXT DEFAULT 'idle',      -- active | idle
  started_at INTEGER,
  last_at INTEGER,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  source_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_time ON sessions(last_at);

CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segments_time ON segments(started_at, ended_at);
CREATE INDEX IF NOT EXISTS idx_segments_session ON segments(session_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  provider TEXT,
  account TEXT,
  session_id TEXT,
  data TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS external_jobs (
  id TEXT PRIMARY KEY,            -- provider:account:job_id
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  name TEXT,
  kind TEXT,                      -- once | interval | cron
  detail TEXT,                    -- human schedule display
  next_run_at INTEGER,
  last_run_at INTEGER,
  state TEXT,                     -- scheduled | paused | completed | error
  enabled INTEGER DEFAULT 1,
  seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS prefs (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS file_state (
  path TEXT PRIMARY KEY,
  offset INTEGER NOT NULL,
  mtime INTEGER
);

CREATE TABLE IF NOT EXISTS limit_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  kind TEXT NOT NULL,             -- 5h | weekly | weekly:<model>
  used_percent REAL,
  resets_at INTEGER,              -- epoch ms, vendor-confirmed
  plan TEXT
);
CREATE INDEX IF NOT EXISTS idx_limits ON limit_snapshots(provider, account, kind, ts);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  events TEXT NOT NULL,           -- JSON array of event types, supports "*" and "session.*"
  secret TEXT,
  created_at INTEGER,
  last_status TEXT
);

CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,            -- one row per live agentcal process on this db
  pid INTEGER,
  port INTEGER,
  version TEXT,
  exe TEXT,                       -- entry script path: tells npx from launchd daemon builds
  started_at INTEGER,
  beat_at INTEGER
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT,
  when_type TEXT NOT NULL,        -- at | next_reset | daily | cron
  when_value TEXT,                -- ISO time | "provider" or "provider:account" | HH:MM | cron expr
  action_type TEXT NOT NULL,      -- command | webhook | claude
  action_value TEXT NOT NULL,
  status TEXT DEFAULT 'pending',  -- proposed | pending | running | done | error | cancelled | expired
  fire_at INTEGER,
  created_at INTEGER,
  fired_at INTEGER,
  result TEXT
);

-- HQ: standing agent roles ("employees"). A paused role's schedules don't
-- fire — that's the kill-switch. The playbook is the identity + duties +
-- success criteria; notes are the agent's own memory (16KB cap, reviewable).
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  agent TEXT DEFAULT 'claude',
  cwd TEXT,
  model TEXT,
  full_auto INTEGER DEFAULT 0,
  playbook TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  budget_week_usd REAL,           -- NULL = no cap; enforced at fire time
  auto_approve INTEGER DEFAULT 0, -- proposals inside the envelope skip the ask
  env_max_per_week INTEGER DEFAULT 5,
  env_horizon_days INTEGER DEFAULT 14,
  status TEXT DEFAULT 'active',   -- active | paused
  created_at INTEGER,
  updated_at INTEGER
);

-- HQ: the inbox. Agents write messages to the human; detail beyond an ask.
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  role_id TEXT,
  schedule_id TEXT,               -- the run that sent it
  kind TEXT DEFAULT 'info',       -- info | attention | report
  subject TEXT,
  body TEXT,
  created_at INTEGER,
  read_at INTEGER,
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(read_at, created_at);
`

// Columns added after a table shipped: SQLite has no IF NOT EXISTS for
// ALTER, so each is attempted and duplicate-column errors are swallowed.
// This is the whole migration mechanism — append, never modify.
const MIGRATIONS = [
  // HQ lineage + role linkage on schedules (proposals, delegation caps)
  "ALTER TABLE schedules ADD COLUMN role_id TEXT",
  "ALTER TABLE schedules ADD COLUMN parent_id TEXT",
  "ALTER TABLE schedules ADD COLUMN root_id TEXT",
  "ALTER TABLE schedules ADD COLUMN depth INTEGER DEFAULT 0",
  // Missions: a goal that groups roles + schedules ("ask your squad")
  `CREATE TABLE IF NOT EXISTS missions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    goal TEXT NOT NULL,
    summary TEXT DEFAULT '',
    metric TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    created_at INTEGER
  )`,
  "ALTER TABLE schedules ADD COLUMN mission_id TEXT",
  "ALTER TABLE roles ADD COLUMN mission_id TEXT",
]

export function openDb(path) {
  mkdirSync(DATA_DIR, { recursive: true })
  const db = new DatabaseSync(path || join(DATA_DIR, 'agentcal.db'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  for (const sql of MIGRATIONS) {
    try { db.exec(sql) } catch (e) {
      if (!/duplicate column/i.test(e.message)) throw e
    }
  }
  return db
}
