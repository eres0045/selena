import type { SelenaDb } from "./db.js";
import { recordQuestProgress } from "./quests.js";

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

async function ensureUser(db: SelenaDb, guildId: string, userId: string): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO users (guild_id, user_id) VALUES (?, ?)").run(guildId, userId);
}

async function readBalance(db: SelenaDb, guildId: string, userId: string): Promise<Balance> {
  const row = await db
    .prepare("SELECT points, xp, level FROM users WHERE guild_id = ? AND user_id = ?")
    .get(guildId, userId) as { points: number; xp: number; level: number } | undefined;
  return { points: row?.points ?? 0, xp: row?.xp ?? 0, level: row?.level ?? 0 };
}

async function logLedger(db: SelenaDb, guildId: string, userId: string, delta: number, reason: string): Promise<void> {
  await db.prepare(
    "INSERT INTO point_ledger (guild_id, user_id, delta, reason, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(guildId, userId, delta, reason, Date.now());
}

/** Current points / XP / level for a user (creates the row if missing). */
export async function getBalance(db: SelenaDb, guildId: string, userId: string): Promise<Balance> {
  await ensureUser(db, guildId, userId);
  return await readBalance(db, guildId, userId);
}

/**
 * Add (or subtract) points, logging the change in point_ledger.
 * Returns the new balance. A negative delta that would drive the balance
 * below 0 is rejected atomically (throws Error) — points can never go negative.
 */
export async function addPoints(db: SelenaDb, guildId: string, userId: string, delta: number, reason: string): Promise<number> {
  if (!Number.isInteger(delta)) throw new Error("addPoints: delta must be an integer");
  await ensureUser(db, guildId, userId);
  let result;
  if (delta < 0) {
    // Atomic guard: only apply if the balance stays >= 0.
    result = await db
      .prepare("UPDATE users SET points = points + ? WHERE guild_id = ? AND user_id = ? AND points + ? >= 0")
      .run(delta, guildId, userId, delta);
    if (result.changes !== 1) throw new Error("Insufficient gold");
  } else {
    result = await db
      .prepare("UPDATE users SET points = points + ? WHERE guild_id = ? AND user_id = ?")
      .run(delta, guildId, userId);
    if (result.changes !== 1) throw new Error("User not found");
  }
  await logLedger(db, guildId, userId, delta, reason);
  return (await readBalance(db, guildId, userId)).points;
}

/**
 * Transfer points between two users in the same guild.
 * The debit is a single atomic UPDATE ... WHERE points >= amount, so a
 * concurrent / insufficient transfer can never drive the sender below 0.
 */
export async function transferPoints(
  db: SelenaDb,
  guildId: string,
  fromId: string,
  toId: string,
  amount: number,
): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, error: "Amount must be a positive whole number." };
  }
  if (fromId === toId) {
    return { ok: false, error: "You cannot give gold to yourself." };
  }
  await ensureUser(db, guildId, fromId);
  await ensureUser(db, guildId, toId);
  // NOTE: written as points + (-amount) rather than points - amount:
  // pg-mem (the test double) evaluates `col - $param` backwards
  // ($param - col); the two forms are identical on real Postgres.
  const debit = await db
    .prepare("UPDATE users SET points = points + ? WHERE guild_id = ? AND user_id = ? AND points >= ?")
    .run(-amount, guildId, fromId, amount);
  if (debit.changes !== 1) {
    return { ok: false, error: "Insufficient gold." };
  }
  await db.prepare("UPDATE users SET points = points + ? WHERE guild_id = ? AND user_id = ?").run(amount, guildId, toId);
  await logLedger(db, guildId, fromId, -amount, `give to ${toId}`);
  await logLedger(db, guildId, toId, amount, `give from ${fromId}`);
  return { ok: true };
}

/** Claim the daily 100-point reward. 24h cooldown per user per guild. */
export async function claimDaily(
  db: SelenaDb,
  guildId: string,
  userId: string,
  nowMs: number,
): Promise<{ ok: boolean; amount?: number; nextAvailableAt?: number }> {
  await ensureUser(db, guildId, userId);
  const row = await db
    .prepare("SELECT last_daily FROM users WHERE guild_id = ? AND user_id = ?")
    .get(guildId, userId) as { last_daily: number | null } | undefined;
  const last = row?.last_daily ?? null;
  if (last !== null && nowMs - last < DAILY_COOLDOWN_MS) {
    return { ok: false, nextAvailableAt: last + DAILY_COOLDOWN_MS };
  }
  await db.prepare("UPDATE users SET last_daily = ? WHERE guild_id = ? AND user_id = ?").run(nowMs, guildId, userId);
  await addPoints(db, guildId, userId, DAILY_AMOUNT, "daily");
  // Quest progress (best-effort — a quest failure never fails the claim).
  try {
    await recordQuestProgress(db, userId, ["daily"]);
  } catch (e) {
    console.error("uwu: quest progress failed:", e instanceof Error ? e.message : e);
  }
  return { ok: true, amount: DAILY_AMOUNT, nextAvailableAt: nowMs + DAILY_COOLDOWN_MS };
}

/** Top point holders in a guild, highest first. */
export async function getLeaderboard(db: SelenaDb, guildId: string, limit = 10): Promise<LeaderboardEntry[]> {
  return (
    await db
      .prepare(
        "SELECT user_id, points, xp, level FROM users WHERE guild_id = ? ORDER BY points DESC, user_id ASC LIMIT ?",
      )
      .all(guildId, limit)
  ).map((r) => ({
      userId: String(r.user_id),
      points: Number(r.points),
      xp: Number(r.xp),
      level: Number(r.level),
    }));
}
