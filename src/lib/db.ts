import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Single SQLite database for all Selena state, backed by Node's built-in
 * node:sqlite (Node 24) — no native addon needed. better-sqlite3 cannot
 * build on this VM: its prebuilt binary is unavailable for Node 24.22.1
 * and node-gyp cannot download the Node headers through the egress proxy.
 *
 * SelenaDb exposes a small better-sqlite3-like surface (prepare/run/get/all,
 * exec, close) so feature code stays simple and readable.
 */
export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export class SelenaDb {
  private inner: DatabaseSync;

  constructor(path: string) {
    this.inner = new DatabaseSync(path);
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  prepare(sql: string): Statement {
    const st = this.inner.prepare(sql);
    return {
      run: (...params: unknown[]) => {
        const r = st.run(...(params as never[]));
        return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
      },
      get: (...params: unknown[]) => {
        const row = st.get(...(params as never[])) as Record<string, unknown> | undefined;
        return row ?? undefined;
      },
      all: (...params: unknown[]) => {
        return st.all(...(params as never[])) as Record<string, unknown>[];
      },
    };
  }

  close(): void {
    this.inner.close();
  }
}

let db: SelenaDb | null = null;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  modlog_channel_id TEXT,
  welcome_channel_id TEXT,
  starboard_channel_id TEXT,
  starboard_threshold INTEGER DEFAULT 3,
  ticket_category_id TEXT,
  staff_channel_id TEXT,
  log_channel_id TEXT
);

CREATE TABLE IF NOT EXISTS users (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 0,
  last_daily INTEGER,
  afk_reason TEXT,
  afk_since INTEGER,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS point_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mod_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS squads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  captain_id TEXT,
  kind TEXT NOT NULL DEFAULT 'squad',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS squad_members (
  squad_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (squad_id, user_id)
);

CREATE TABLE IF NOT EXISTS scrims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  opponent TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  reminded INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scrim_rsvps (
  scrim_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  attending INTEGER NOT NULL,
  PRIMARY KEY (scrim_id, user_id)
);

CREATE TABLE IF NOT EXISTS tryouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  ign TEXT NOT NULL,
  mlbb_id TEXT,
  role TEXT NOT NULL,
  rank_name TEXT NOT NULL,
  heroes TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  channel_id TEXT,
  message_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS brackets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bracket_entries (
  bracket_id INTEGER NOT NULL,
  seed INTEGER NOT NULL,
  team_name TEXT NOT NULL,
  PRIMARY KEY (bracket_id, seed)
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bracket_id INTEGER NOT NULL,
  round INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  team_a TEXT,
  team_b TEXT,
  winner TEXT,
  score_a INTEGER,
  score_b INTEGER,
  reported_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gacha_cards (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (guild_id, user_id, card_id)
);

CREATE TABLE IF NOT EXISTS gacha_state (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_roll INTEGER,
  pity INTEGER NOT NULL DEFAULT 0,
  total_rolls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS giveaways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  prize TEXT NOT NULL,
  ends_at INTEGER NOT NULL,
  winners_count INTEGER NOT NULL DEFAULT 1,
  ended INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS giveaway_entries (
  giveaway_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (giveaway_id, user_id)
);

CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  option_index INTEGER NOT NULL,
  PRIMARY KEY (poll_id, user_id)
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS reaction_roles (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  role_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, message_id, emoji)
);

CREATE TABLE IF NOT EXISTS starboard_posts (
  guild_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  starboard_message_id TEXT,
  stars INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, message_id)
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  text TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`;

export function getDb(dbPath?: string): SelenaDb {
  if (db) return db;
  const path = dbPath ?? process.env.DATABASE_PATH ?? resolve(process.cwd(), "selena.db");
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  db = new SelenaDb(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Reset the cached instance (tests use a fresh in-memory DB per file). */
export function resetDbForTests(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** In-memory DB with the full schema, for tests. */
export function getTestDb(): SelenaDb {
  resetDbForTests();
  db = new SelenaDb(":memory:");
  db.exec(SCHEMA);
  return db;
}
