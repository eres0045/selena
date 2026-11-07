import pg, { Pool, type PoolClient, types as pgTypes } from "pg";

/**
 * Selena's database — Supabase Postgres (via the `pg` Pool).
 *
 * History: the bot used to keep state in a local SQLite file (Node 24's
 * built-in node:sqlite). Render's free tier has no persistent disk, so
 * every restart / sleep-wake wiped the file and every user's points, XP,
 * gacha cards, squads and tickets reset to zero. This layer replaces it
 * with a single Supabase Postgres database, configured by exactly one env
 * var: DATABASE_URL (the Supabase transaction-pooler connection string).
 *
 * SelenaDb exposes the same small better-sqlite3-like surface the feature
 * code was written against (prepare/run/get/all, exec, close, transaction)
 * so the call sites stay readable — but everything is ASYNC now: there is
 * no synchronous Postgres client for Node, so every query returns a
 * Promise and every caller awaits it.
 *
 * Dialect translation (done in prepare(), so call sites keep their
 * SQLite-shaped SQL):
 * - `?` placeholders become `$1..$n` (a `?` inside a quoted literal is
 *   left alone).
 * - `INSERT OR IGNORE INTO ...` becomes `INSERT INTO ... ON CONFLICT
 *   DO NOTHING` (bare ON CONFLICT = any unique violation).
 * - `INSERT OR REPLACE INTO ...` is NOT translated — the three call sites
 *   that used it were rewritten as explicit Postgres upserts.
 * - `run()` on an INSERT into a table with a serial `id` appends
 *   `RETURNING id` and reports it as `lastInsertRowid` (0 when the
 *   insert was ignored by ON CONFLICT DO NOTHING).
 *
 * Types: Postgres BIGINT (int8) columns come back from `pg` as strings by
 * default. All of ours (epoch-ms timestamps, serial ids) are safely below
 * 2^53, so int8 is parsed to a JS number globally (see setTypeParser
 * below) and the rest of the code can keep using plain numbers.
 */

// int8 (BIGINT) -> JS number. All our BIGINT values (ids, epoch-ms
// timestamps) are far below Number.MAX_SAFE_INTEGER.
pgTypes.setTypeParser(20, (value: string) => Number.parseInt(value, 10));

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  run(...params: unknown[]): Promise<RunResult>;
  get(...params: unknown[]): Promise<Record<string, unknown> | undefined>;
  all(...params: unknown[]): Promise<Record<string, unknown>[]>;
}

/** Tables whose INSERTs carry a serial `id` (used for RETURNING id). */
const ID_TABLES = new Set([
  "point_ledger",
  "warnings",
  "mod_actions",
  "squads",
  "scrims",
  "tryouts",
  "brackets",
  "matches",
  "giveaways",
  "polls",
  "tickets",
  "reminders",
  "guilds",
  "user_monster_instances",
  "auctions",
  "auction_bids",
  "announcements",
  "rare_logs",
  "battle_challenges",
]);

/**
 * Translate one SQLite-shaped statement to Postgres:
 * `INSERT OR IGNORE` -> `ON CONFLICT DO NOTHING`, `?` -> `$n`, and
 * `RETURNING id` for INSERTs into id-tables.
 */
export function translateSql(sql: string): string {
  const isOrIgnore = /INSERT\s+OR\s+IGNORE\s+INTO/i.test(sql);
  let text = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, "INSERT INTO");
  // `?` -> `$n`, skipping `?` inside single-quoted literals ('' = escaped quote).
  let out = "";
  let n = 0;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'") {
      if (inStr && text[i + 1] === "'") {
        out += "''";
        i++;
        continue;
      }
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (ch === "?" && !inStr) {
      n++;
      out += `$${n}`;
      continue;
    }
    out += ch;
  }
  text = out;
  if (isOrIgnore) text = `${text.trimEnd()} ON CONFLICT DO NOTHING`;
  const insertInto = /^\s*INSERT\s+INTO\s+"?(\w+)"?/i.exec(text);
  if (insertInto && ID_TABLES.has(insertInto[1]!.toLowerCase())) {
    text = `${text.trimEnd()} RETURNING id`;
  }
  return text;
}

export class SelenaDb {
  private pool: Pool;
  private client: PoolClient | null;
  private schemaPromise: Promise<void> | null;

  constructor(pool: Pool, client: PoolClient | null = null, schemaPromise: Promise<void> | null = null) {
    this.pool = pool;
    this.client = client;
    this.schemaPromise = schemaPromise;
  }

  private target(): Pool | PoolClient {
    return this.client ?? this.pool;
  }

  /**
   * Create the schema if it hasn't been yet. Idempotent; runs lazily on
   * the first query so getDb()/getTestDb() stay synchronous, and awaited
   * explicitly at boot (src/index.ts) to fail fast when the DB is down.
   */
  async ensureSchema(): Promise<void> {
    if (!this.schemaPromise) {
      this.schemaPromise = this.exec(SCHEMA);
    }
    return this.schemaPromise;
  }

  /** Run raw SQL (schema creation, multi-statement strings allowed). */
  async exec(sql: string): Promise<void> {
    await this.target().query(sql);
  }

  prepare(sql: string): Statement {
    const text = translateSql(sql);
    const runQuery = async (params: unknown[]) => {
      await this.ensureSchema();
      return this.target().query(text, params as never[]);
    };
    return {
      run: async (...params: unknown[]) => {
        const res = await runQuery(params);
        const row = res.rows[0] as { id?: number | bigint } | undefined;
        return { changes: res.rowCount ?? 0, lastInsertRowid: row?.id ?? 0 };
      },
      get: async (...params: unknown[]) => {
        const res = await runQuery(params);
        return (res.rows[0] as Record<string, unknown> | undefined) ?? undefined;
      },
      all: async (...params: unknown[]) => {
        const res = await runQuery(params);
        return res.rows as Record<string, unknown>[];
      },
    };
  }

  /**
   * Run `fn` inside a single transaction on one pooled client: BEGIN,
   * fn(tx), COMMIT — or ROLLBACK when fn throws. The `tx` handle has the
   * same prepare/run/get/all surface, bound to that client.
   */
  async transaction<T>(fn: (tx: SelenaDb) => Promise<T>): Promise<T> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tx = new SelenaDb(this.pool, client, this.schemaPromise);
      const out = await fn(tx);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* already rolled back / connection lost */
      }
      throw e;
    } finally {
      client.release();
    }
  }

  /** End the pool (root instances only; transaction handles share it). */
  async close(): Promise<void> {
    if (this.client) return;
    await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// Schema — same tables/columns as the SQLite version, translated:
// INTEGER PRIMARY KEY AUTOINCREMENT -> BIGSERIAL PRIMARY KEY;
// epoch-ms timestamp columns -> BIGINT (ms since epoch is ~1.8e12, far
// past int4's 2.1e9 max); id-reference columns -> BIGINT to match;
// everything else keeps its SQLite type (INTEGER/TEXT).
// ---------------------------------------------------------------------------

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
  last_daily BIGINT,
  afk_reason TEXT,
  afk_since BIGINT,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS point_ledger (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS warnings (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS mod_actions (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS squads (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  captain_id TEXT,
  kind TEXT NOT NULL DEFAULT 'squad',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS squad_members (
  squad_id BIGINT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (squad_id, user_id)
);

CREATE TABLE IF NOT EXISTS scrims (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  opponent TEXT NOT NULL,
  scheduled_at BIGINT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  reminded INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS scrim_rsvps (
  scrim_id BIGINT NOT NULL,
  user_id TEXT NOT NULL,
  attending INTEGER NOT NULL,
  PRIMARY KEY (scrim_id, user_id)
);

CREATE TABLE IF NOT EXISTS tryouts (
  id BIGSERIAL PRIMARY KEY,
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
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS brackets (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS bracket_entries (
  bracket_id BIGINT NOT NULL,
  seed INTEGER NOT NULL,
  team_name TEXT NOT NULL,
  PRIMARY KEY (bracket_id, seed)
);

CREATE TABLE IF NOT EXISTS matches (
  id BIGSERIAL PRIMARY KEY,
  bracket_id BIGINT NOT NULL,
  round INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  team_a TEXT,
  team_b TEXT,
  winner TEXT,
  score_a INTEGER,
  score_b INTEGER,
  reported_by TEXT,
  created_at BIGINT NOT NULL
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
  last_roll BIGINT,
  pity INTEGER NOT NULL DEFAULT 0,
  total_rolls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS giveaways (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  prize TEXT NOT NULL,
  ends_at BIGINT NOT NULL,
  winners_count INTEGER NOT NULL DEFAULT 1,
  ended INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS giveaway_entries (
  giveaway_id BIGINT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (giveaway_id, user_id)
);

CREATE TABLE IF NOT EXISTS polls (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id BIGINT NOT NULL,
  user_id TEXT NOT NULL,
  option_index INTEGER NOT NULL,
  PRIMARY KEY (poll_id, user_id)
);

CREATE TABLE IF NOT EXISTS tickets (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at BIGINT NOT NULL,
  closed_at BIGINT
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
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  text TEXT NOT NULL,
  due_at BIGINT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);

-- Hunt world (Phase 1, 2026-11-07). Ownership rows carry guild_id so
-- per-Discord-server supply caps are enforced by counting rows per
-- (guild_id, monster_id) — see src/lib/huntDb.ts (fail closed).
CREATE TABLE IF NOT EXISTS user_monsters (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  monster_id INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'hunt',
  caught_at BIGINT NOT NULL,
  PRIMARY KEY (guild_id, user_id, monster_id)
);

CREATE TABLE IF NOT EXISTS user_weapons (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  weapon_id INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  equipped INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, weapon_id)
);

CREATE TABLE IF NOT EXISTS user_pets (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  pet_id INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, pet_id)
);

CREATE TABLE IF NOT EXISTS user_hunt (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_hunt_at BIGINT,
  current_area TEXT,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS user_roll (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rolls_since_epic INTEGER NOT NULL DEFAULT 0,
  rolls_today INTEGER NOT NULL DEFAULT 0,
  roll_day TEXT,
  PRIMARY KEY (guild_id, user_id)
);

-- Hunt world Phase 2 (2026-11-07). Global world state is keyed by
-- user_id alone (the world is shared across all of Discord); ownership
-- rows keep guild_id so per-server caps still count per (guild_id,
-- monster_id). All tables are created by the bot on startup, same
-- pattern as Phase 1. Spec: docs/hunt-world-phase2-design.md §10.
CREATE TABLE IF NOT EXISTS user_location (
  user_id TEXT PRIMARY KEY,
  current_area TEXT NOT NULL DEFAULT 'meadow',
  travelling_to TEXT,
  travel_ends_at BIGINT,
  travel_origin TEXT,
  travel_channel_id TEXT,
  travel_guild_id TEXT,
  travel_started_at BIGINT,
  last_autohunt_at BIGINT,
  auto_hunt INTEGER NOT NULL DEFAULT 0,
  auto_hunt_seconds INTEGER NOT NULL DEFAULT 0,
  auto_hunt_charged INTEGER NOT NULL DEFAULT 0,
  map_marks TEXT NOT NULL DEFAULT '[]',
  map_zoom TEXT NOT NULL DEFAULT 'world',
  last_location TEXT
);

CREATE TABLE IF NOT EXISTS towers (
  tower_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  region TEXT NOT NULL,
  area TEXT NOT NULL,
  floors INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  level_req INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tower_parties (
  party_id TEXT PRIMARY KEY,
  tower_id TEXT NOT NULL,
  leader_id TEXT NOT NULL,
  members TEXT NOT NULL DEFAULT '[]',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS tower_progress (
  user_id TEXT NOT NULL,
  tower_id TEXT NOT NULL,
  floor_reached INTEGER NOT NULL DEFAULT 0,
  checkpoint_at BIGINT,
  party_id TEXT,
  PRIMARY KEY (user_id, tower_id)
);

CREATE TABLE IF NOT EXISTS tower_cooldowns (
  tower_id TEXT PRIMARY KEY,
  cleared_at BIGINT NOT NULL,
  resets_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS spawn_cooldowns (
  monster_id INTEGER PRIMARY KEY,
  caught_at BIGINT NOT NULL,
  available_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS guilds (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  leader_id TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  xp INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS guild_members (
  guild_id BIGINT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at BIGINT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS user_monster_instances (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  monster_id INTEGER NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  xp INTEGER NOT NULL DEFAULT 0,
  fuse_level INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'hunt',
  caught_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_wallet (
  user_id TEXT PRIMARY KEY,
  gems INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS auctions (
  id BIGSERIAL PRIMARY KEY,
  seller_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  item_ref TEXT NOT NULL,
  start_price INTEGER NOT NULL,
  current_bid INTEGER,
  current_bidder TEXT,
  ends_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS auction_bids (
  id BIGSERIAL PRIMARY KEY,
  auction_id BIGINT NOT NULL,
  bidder_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  refunded INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS shop_stock (
  date TEXT NOT NULL,
  item_id TEXT NOT NULL,
  price INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'gold',
  qty_per_player INTEGER NOT NULL DEFAULT 3,
  PRIMARY KEY (date, item_id)
);

CREATE TABLE IF NOT EXISTS user_shop_buys (
  date TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, user_id, item_id)
);

CREATE TABLE IF NOT EXISTS user_crates (
  user_id TEXT NOT NULL,
  crate_tier TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, crate_tier)
);

CREATE TABLE IF NOT EXISTS user_materials (
  user_id TEXT NOT NULL,
  material TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, material)
);

CREATE TABLE IF NOT EXISTS user_items (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS user_badges (
  user_id TEXT NOT NULL,
  badge TEXT NOT NULL,
  awarded_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, badge)
);

CREATE TABLE IF NOT EXISTS announcements (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  posted_by TEXT NOT NULL,
  posted_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS rare_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  item_ref TEXT NOT NULL,
  tier TEXT NOT NULL,
  source TEXT NOT NULL,
  caught_at BIGINT NOT NULL,
  posted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS battle_challenges (
  id BIGSERIAL PRIMARY KEY,
  challenger_id TEXT NOT NULL,
  opponent_id TEXT NOT NULL,
  wager INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  channel_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_battle (
  user_id TEXT PRIMARY KEY,
  last_battle_at BIGINT
);

-- Battle win streaks (2026-11-07). Streaks are GLOBAL (keyed by
-- user_id alone, like user_location): a win is +1, a loss resets to 0,
-- a draw leaves both streaks unchanged.
CREATE TABLE IF NOT EXISTS user_battle_streaks (
  user_id TEXT PRIMARY KEY,
  streak INTEGER NOT NULL DEFAULT 0
);

-- Tower mystery discovery (2026-11-07). Discovery is per-user, no
-- guild_id — the world is shared across Discord, like user_location.
CREATE TABLE IF NOT EXISTS user_tower_discoveries (
  user_id TEXT NOT NULL,
  tower_id TEXT NOT NULL,
  discovered_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, tower_id)
);

CREATE TABLE IF NOT EXISTS user_explore (
  user_id TEXT PRIMARY KEY,
  last_explore_at BIGINT
);

-- Profiles (2026-11-07). Profile data is GLOBAL (keyed by user_id alone,
-- like user_location): your About Me and background follow you across
-- servers. Backgrounds are bought with guild-scoped gold (the guild the
-- purchase ran in), but ownership is global — a background bought in one
-- server is yours everywhere.
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,
  about TEXT NOT NULL DEFAULT '',
  equipped_bg TEXT NOT NULL DEFAULT 'default'
);

CREATE TABLE IF NOT EXISTS user_backgrounds (
  user_id TEXT NOT NULL,
  bg_id TEXT NOT NULL,
  purchased_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, bg_id)
);

-- Daily global quests (2026-11-07). Quest progress is GLOBAL
-- (keyed by user_id alone, like the profile and the world): the 3
-- quests are the same for everyone each UTC day; each user tracks
-- their own progress against them. Claims pay once per quest per day.
CREATE TABLE IF NOT EXISTS user_quest_progress (
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  quest_id TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date, quest_id)
);

CREATE TABLE IF NOT EXISTS user_quest_claims (
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  quest_id TEXT NOT NULL,
  claimed_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, date, quest_id)
);
`;

let db: SelenaDb | null = null;

/**
 * The shared bot database, from DATABASE_URL (Supabase transaction
 * pooler). Throws a clear error when the var is missing — the bot cannot
 * run on a local file anymore, and failing loudly at boot beats silently
 * losing data again. Pool is capped at 5 (Render free + Supabase pooler).
 */
export function getDb(): SelenaDb {
  if (db) return db;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "Selena: DATABASE_URL is not set — the bot needs a Postgres connection string (Supabase transaction pooler). Set DATABASE_URL on the service and restart.",
    );
  }
  const pool = new Pool({
    connectionString: url,
    max: 5,
    ssl: /sslmode=disable/i.test(url) ? undefined : { rejectUnauthorized: false },
  });
  pool.on("error", (e) => console.error("Selena: idle pool error:", e instanceof Error ? e.message : e));
  db = new SelenaDb(pool);
  return db;
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
  }
}

/** Reset the cached instance (tests use a fresh in-memory DB per file). */
export function resetDbForTests(): void {
  if (db) {
    void db.close();
    db = null;
  }
}

/** Install a test-built instance as the shared one (used by test/testDb.ts). */
export function setDbForTests(instance: SelenaDb): void {
  db = instance;
}


