import type { SelenaDb } from "./db.js";

export const DAILY_AMOUNT = 100;
export const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

export interface Balance {
  points: number;
  xp: number;
  level: number;
}

export interface LeaderboardEntry {
  userId: string;
  points: number;
  xp: number;
  level: number;
}

function ensureUser(db: SelenaDb, guildId: string, userId: string): void {
  db.prepare("INSERT OR IGNORE INTO users (guild_id, user_id) VALUES (?, ?)").run(guildId, userId);
}

function readBalance(db: SelenaDb, guildId: string, userId: string): Balance {
  const row = db
    .prepare("SELECT points, xp, level FROM users WHERE guild_id = ? AND user_id = ?")
    .get(guildId, userId) as { points: number; xp: number; level: number } | undefined;
  return { points: row?.points ?? 0, xp: row?.xp ?? 0, level: row?.level ?? 0 };
}

function logLedger(db: SelenaDb, guildId: string, userId: string, delta: number, reason: string): void {
  db.prepare(
    "INSERT INTO point_ledger (guild_id, user_id, delta, reason, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(guildId, userId, delta, reason, Date.now());
}

/** Current points / XP / level for a user (creates the row if missing). */
export function getBalance(db: SelenaDb, guildId: string, userId: string): Balance {
  ensureUser(db, guildId, userId);
  return readBalance(db, guildId, userId);
}

/**
 * Add (or subtract) points, logging the change in point_ledger.
 * Returns the new balance. A negative delta that would drive the balance
 * below 0 is rejected atomically (throws Error) — points can never go negative.
 */
export function addPoints(db: SelenaDb, guildId: string, userId: string, delta: number, reason: string): number {
  if (!Number.isInteger(delta)) throw new Error("addPoints: delta must be an integer");
  ensureUser(db, guildId, userId);
  let result;
  if (delta < 0) {
    // Atomic guard: only apply if the balance stays >= 0.
    result = db
      .prepare("UPDATE users SET points = points + ? WHERE guild_id = ? AND user_id = ? AND points + ? >= 0")
      .run(delta, guildId, userId, delta);
    if (result.changes !== 1) throw new Error("Insufficient points");
  } else {
    result = db
      .prepare("UPDATE users SET points = points + ? WHERE guild_id = ? AND user_id = ?")
      .run(delta, guildId, userId);
    if (result.changes !== 1) throw new Error("User not found");
  }
  logLedger(db, guildId, userId, delta, reason);
  return readBalance(db, guildId, userId).points;
}

/**
 * Transfer points between two users in the same guild.
 * The debit is a single atomic UPDATE ... WHERE points >= amount, so a
 * concurrent / insufficient transfer can never drive the sender below 0.
 */
export function transferPoints(
  db: SelenaDb,
  guildId: string,
  fromId: string,
  toId: string,
  amount: number,
): { ok: boolean; error?: string } {
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, error: "Amount must be a positive whole number." };
  }
  if (fromId === toId) {
    return { ok: false, error: "You cannot give points to yourself." };
  }
  ensureUser(db, guildId, fromId);
  ensureUser(db, guildId, toId);
  const debit = db
    .prepare("UPDATE users SET points = points - ? WHERE guild_id = ? AND user_id = ? AND points >= ?")
    .run(amount, guildId, fromId, amount);
  if (debit.changes !== 1) {
    return { ok: false, error: "Insufficient points." };
  }
  db.prepare("UPDATE users SET points = points + ? WHERE guild_id = ? AND user_id = ?").run(amount, guildId, toId);
  logLedger(db, guildId, fromId, -amount, `give to ${toId}`);
  logLedger(db, guildId, toId, amount, `give from ${fromId}`);
  return { ok: true };
}

/** Claim the daily 100-point reward. 24h cooldown per user per guild. */
export function claimDaily(
  db: SelenaDb,
  guildId: string,
  userId: string,
  nowMs: number,
): { ok: boolean; amount?: number; nextAvailableAt?: number } {
  ensureUser(db, guildId, userId);
  const row = db
    .prepare("SELECT last_daily FROM users WHERE guild_id = ? AND user_id = ?")
    .get(guildId, userId) as { last_daily: number | null } | undefined;
  const last = row?.last_daily ?? null;
  if (last !== null && nowMs - last < DAILY_COOLDOWN_MS) {
    return { ok: false, nextAvailableAt: last + DAILY_COOLDOWN_MS };
  }
  db.prepare("UPDATE users SET last_daily = ? WHERE guild_id = ? AND user_id = ?").run(nowMs, guildId, userId);
  addPoints(db, guildId, userId, DAILY_AMOUNT, "daily");
  return { ok: true, amount: DAILY_AMOUNT, nextAvailableAt: nowMs + DAILY_COOLDOWN_MS };
}

/** Top point holders in a guild, highest first. */
export function getLeaderboard(db: SelenaDb, guildId: string, limit = 10): LeaderboardEntry[] {
  return db
    .prepare(
      "SELECT user_id, points, xp, level FROM users WHERE guild_id = ? ORDER BY points DESC, user_id ASC LIMIT ?",
    )
    .all(guildId, limit)
    .map((r) => ({
      userId: String(r.user_id),
      points: Number(r.points),
      xp: Number(r.xp),
      level: Number(r.level),
    }));
}
