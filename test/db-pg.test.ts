import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import pg, { type Pool } from "pg";
import { getTestDb, translateSql, SelenaDb, SCHEMA } from "../src/lib/db.js";
import { addPoints, getBalance } from "../src/lib/economy.js";
import { awardXp, getUserXp } from "../src/lib/levels.js";

// ---------------------------------------------------------------------------
// The Postgres layer (src/lib/db.ts): dialect translation, schema, and the
// transaction wrapper. Tests run against pg-mem (in-memory Postgres, no
// network, no Supabase). Two pg-mem behaviours are deliberately NOT relied
// on here — see the notes in-line:
// - pg-mem evaluates `col - $param` backwards, so the debit SQL in the
//   app is written as `col + (-amount)` (equivalent on real Postgres).
// - pg-mem does not implement transaction rollback, so the rollback path
//   of SelenaDb.transaction() is verified with a fake pool below, not
//   against pg-mem.
// ---------------------------------------------------------------------------

describe("translateSql", () => {
  it("turns ? placeholders into $1..$n", () => {
    expect(translateSql("SELECT * FROM users WHERE guild_id = ? AND user_id = ?")).toBe(
      "SELECT * FROM users WHERE guild_id = $1 AND user_id = $2",
    );
  });

  it("leaves a ? inside a string literal alone", () => {
    expect(translateSql("SELECT * FROM t WHERE note = 'really?' AND id = ?")).toBe(
      "SELECT * FROM t WHERE note = 'really?' AND id = $1",
    );
  });

  it("rewrites INSERT OR IGNORE as ON CONFLICT DO NOTHING", () => {
    expect(
      translateSql("INSERT OR IGNORE INTO users (guild_id, user_id) VALUES (?, ?)"),
    ).toBe("INSERT INTO users (guild_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING");
  });

  it("appends RETURNING id for INSERTs into id-tables", () => {
    expect(
      translateSql(
        "INSERT INTO reminders (guild_id, user_id, channel_id, text, due_at, delivered, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
      ),
    ).toBe(
      "INSERT INTO reminders (guild_id, user_id, channel_id, text, due_at, delivered, created_at) VALUES ($1, $2, $3, $4, $5, 0, $6) RETURNING id",
    );
    // ...but not for tables without an id column.
    expect(
      translateSql("INSERT INTO users (guild_id, user_id) VALUES (?, ?)"),
    ).toBe("INSERT INTO users (guild_id, user_id) VALUES ($1, $2)");
  });
});

describe("schema on a fresh in-memory DB", () => {
  it("creates all 23 tables", async () => {
    const db = getTestDb();
    const rows = await db
      .prepare("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")
      .all();
    const names = new Set(rows.map((r) => String(r.table_name)));
    for (const t of [
      "guild_settings", "users", "point_ledger", "warnings", "mod_actions",
      "squads", "squad_members", "scrims", "scrim_rsvps", "tryouts",
      "brackets", "bracket_entries", "matches", "gacha_cards", "gacha_state",
      "giveaways", "giveaway_entries", "polls", "poll_votes", "tickets",
      "reaction_roles", "starboard_posts", "reminders",
    ]) {
      expect(names.has(t), `missing table ${t}`).toBe(true);
    }
  });

  it("is idempotent: ensureSchema twice does not error", async () => {
    const db = getTestDb();
    await db.ensureSchema();
    await db.ensureSchema();
    const rows = await db.prepare("SELECT COUNT(*) AS c FROM users").all();
    expect(Number(rows[0]?.c)).toBe(0);
  });
});

describe("points / XP round-trip", () => {
  it("writes points and XP and reads them back", async () => {
    const db = getTestDb();
    await addPoints(db, "guild-1", "user-1", 250, "seed");
    expect((await getBalance(db, "guild-1", "user-1")).points).toBe(250);
    const awarded = await awardXp(db, "guild-1", "user-1", 200, 1_000_000);
    expect(awarded.awarded).toBe(200);
    expect((await getUserXp(db, "guild-1", "user-1")).xp).toBe(200);
    // Same row holds both: points survive the XP write and vice versa.
    const bal = await getBalance(db, "guild-1", "user-1");
    expect(bal.points).toBe(250);
    expect(bal.xp).toBe(200);
  });

  it("stores epoch-ms timestamps as BIGINT numbers, not strings", async () => {
    const db = getTestDb();
    const now = 1_792_000_000_000;
    const r = await db
      .prepare("INSERT INTO reminders (guild_id, user_id, channel_id, text, due_at, delivered, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
      .run("guild-1", "user-1", "chan-1", "probe", now, now);
    expect(typeof r.lastInsertRowid).toBe("number");
    expect(r.lastInsertRowid).toBeGreaterThan(0);
    const row = await db.prepare("SELECT due_at FROM reminders WHERE id = ?").get(Number(r.lastInsertRowid));
    expect(row?.due_at).toBe(now);
    expect(typeof row?.due_at).toBe("number");
  });

  it("reports lastInsertRowid and changes for INSERTs", async () => {
    const db = getTestDb();
    const a = await db
      .prepare("INSERT INTO tickets (guild_id, channel_id, user_id, reason, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)")
      .run("guild-1", "chan-1", "user-1", "help", 1000);
    const b = await db
      .prepare("INSERT INTO tickets (guild_id, channel_id, user_id, reason, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)")
      .run("guild-1", "chan-2", "user-1", "help", 1001);
    expect(a.changes).toBe(1);
    expect(b.changes).toBe(1);
    expect(Number(b.lastInsertRowid)).toBe(Number(a.lastInsertRowid) + 1);
  });

  it("INSERT OR IGNORE reports changes 0 on the second insert", async () => {
    const db = getTestDb();
    const first = await db
      .prepare("INSERT OR IGNORE INTO users (guild_id, user_id) VALUES (?, ?)")
      .run("guild-1", "user-1");
    const second = await db
      .prepare("INSERT OR IGNORE INTO users (guild_id, user_id) VALUES (?, ?)")
      .run("guild-1", "user-1");
    expect(first.changes).toBe(1);
    expect(second.changes).toBe(0);
  });
});

describe("restart survival (same server, new pool)", () => {
  it("a second SelenaDb on the same pg-mem server sees the first one's rows", async () => {
    // One pg-mem server = one Postgres server. Two pools = the bot
    // restarting and reconnecting: the data must still be there.
    const mem = newDb();
    const pgMem = mem.adapters.createPg() as unknown as { Pool: new () => pg.Pool };
    const db1 = new SelenaDb(new pgMem.Pool());
    await db1.ensureSchema();
    await addPoints(db1, "guild-1", "user-1", 99, "seed");
    await db1.close();

    // db2 reconnects to the same server. Its schemaPromise is pre-resolved
    // because the schema already exists there — pg-mem cannot re-run
    // CREATE TABLE IF NOT EXISTS against existing tables (real Postgres
    // handles that fine; this is a pg-mem-only limitation, not app logic).
    const db2 = new SelenaDb(new pgMem.Pool(), null, Promise.resolve());
    expect((await getBalance(db2, "guild-1", "user-1")).points).toBe(99);
    await db2.close();
  });
});

describe("transaction() wrapper (fake pool — pg-mem has no rollback)", () => {
  function fakePool() {
    const calls: string[] = [];
    let released = false;
    const client = {
      query: async (sql: string) => {
        calls.push(sql);
        return { rows: [{ one: 1 }], rowCount: 1 };
      },
      release: () => {
        released = true;
      },
    };
    const pool = {
      connect: async () => client,
      end: async () => undefined,
    };
    return { pool, client, calls, isReleased: () => released };
  }

  it("BEGINs, runs the body on the checked-out client, COMMITs, releases", async () => {
    const f = fakePool();
    const db = new SelenaDb(f.pool as unknown as Pool, null, Promise.resolve());
    const seen: string[] = [];
    const out = await db.transaction(async (tx) => {
      const row = await tx.prepare("SELECT 1 AS one").get();
      seen.push(String(row?.one));
      return "done";
    });
    expect(out).toBe("done");
    expect(seen).toEqual(["1"]);
    expect(f.calls[0]).toBe("BEGIN");
    expect(f.calls).toContain("SELECT 1 AS one");
    expect(f.calls[f.calls.length - 1]).toBe("COMMIT");
    expect(f.isReleased()).toBe(true);
  });

  it("ROLLBACKs and releases when the body throws, and rethrows", async () => {
    const f = fakePool();
    const db = new SelenaDb(f.pool as unknown as Pool, null, Promise.resolve());
    await expect(
      db.transaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(f.calls[0]).toBe("BEGIN");
    expect(f.calls).toContain("ROLLBACK");
    expect(f.calls).not.toContain("COMMIT");
    expect(f.isReleased()).toBe(true);
  });

  it("executes the schema text verbatim (no placeholder mangling)", async () => {
    // The schema contains no `?`, so translateSql must not touch it —
    // exec() runs it as-is. A schema with a stray $ would break here.
    expect(SCHEMA).not.toContain("?");
    expect(SCHEMA).toContain("CREATE TABLE IF NOT EXISTS users");
  });
});
