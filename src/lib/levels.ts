import type { SelenaDb } from "./db.js";

/**
 * Levels / XP curve.
 *
 * Cumulative XP required to REACH a level:
 *   xpForLevel(0) = 0
 *   xpForLevel(level) = 5*level^2 + 50*level + 100   (level >= 1)
 *
 * So the thresholds are: L1 = 155, L2 = 220, L3 = 295, L4 = 380, L5 = 475,
 * L10 = 1100, L20 = 3100, L50 = 15100. The gap between consecutive levels
 * grows linearly (65, 75, 85, ...), so levelling slows down gently instead
 * of exploding quadratically per-level. Level 0 is the starting level and
 * needs 0 XP (the formula itself would give 100 at level 0, which is the
 * cost of the first step, not a threshold — hence the explicit 0 case).
 */

/** Cumulative XP required to reach `level` (0 for level 0). */
export function xpForLevel(level: number): number {
  const l = Math.max(0, Math.floor(level));
  if (l === 0) return 0;
  return 5 * l * l + 50 * l + 100;
}

/** Highest level whose cumulative threshold is <= `xp`. */
export function levelFromXp(xp: number): number {
  const x = Math.max(0, Math.floor(xp));
  // Solve 5L^2 + 50L + 100 <= x  ->  L = (-50 + sqrt(500 + 20x)) / 10
  const level = Math.floor((-50 + Math.sqrt(500 + 20 * x)) / 10);
  return Math.max(0, level);
}

export interface RankCard {
  level: number;
  xp: number;
  /** Cumulative XP threshold for the next level. */
  xpForNext: number;
  /** XP already earned towards the next level. */
  xpIntoLevel: number;
  /** XP still needed to reach the next level. */
  xpNeeded: number;
  /** 0..1 progress towards the next level. */
  progress: number;
}

/** Rank-card data for the /rank embed. */
export function rankCard(xp: number): RankCard {
  const total = Math.max(0, Math.floor(xp));
  const level = levelFromXp(total);
  const floor = xpForLevel(level);
  const next = xpForLevel(level + 1);
  const xpIntoLevel = total - floor;
  const xpNeeded = next - total;
  const span = next - floor;
  return {
    level,
    xp: total,
    xpForNext: next,
    xpIntoLevel,
    xpNeeded,
    progress: span > 0 ? Math.min(1, Math.max(0, xpIntoLevel / span)) : 1,
  };
}

/** Text progress bar, e.g. `[██████░░░░] 60%`. */
export function progressBar(progress: number, width = 10): string {
  const filled = Math.round(Math.min(1, Math.max(0, progress)) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${Math.round(progress * 100)}%`;
}

// ---------------------------------------------------------------------------
// XP awarding (message XP). A 60s per-user cooldown is enforced by a
// module-level Map keyed `${guildId}:${userId}`; `nowMs` is injected so
// tests can control time. Call resetXpCooldowns() between tests.
// ---------------------------------------------------------------------------

const XP_COOLDOWN_MS = 60_000;
const lastAward = new Map<string, number>();

/** Clear all XP cooldowns (tests / restarts). */
export function resetXpCooldowns(): void {
  lastAward.clear();
}

export interface AwardXpResult {
  leveledUp: boolean;
  newLevel: number;
  /** Total XP after the award (unchanged when on cooldown). */
  xp: number;
  /** XP actually awarded (0 when on cooldown). */
  awarded: number;
}

function ensureUser(db: SelenaDb, guildId: string, userId: string): { xp: number; level: number } {
  db.prepare("INSERT OR IGNORE INTO users (guild_id, user_id) VALUES (?, ?)").run(guildId, userId);
  const row = db.prepare("SELECT xp, level FROM users WHERE guild_id = ? AND user_id = ?").get(guildId, userId) as
    | { xp: number; level: number }
    | undefined;
  return { xp: Number(row?.xp ?? 0), level: Number(row?.level ?? 0) };
}

/**
 * Award XP to a user. Returns whether they levelled up and their new level.
 * Awards are ignored while the user is inside their 60s cooldown window.
 */
export function awardXp(db: SelenaDb, guildId: string, userId: string, amount: number, nowMs: number): AwardXpResult {
  const current = ensureUser(db, guildId, userId);
  const key = `${guildId}:${userId}`;
  const last = lastAward.get(key);
  if (last !== undefined && nowMs - last < XP_COOLDOWN_MS) {
    return { leveledUp: false, newLevel: current.level, xp: current.xp, awarded: 0 };
  }
  const awarded = Math.max(0, Math.floor(amount));
  const xp = current.xp + awarded;
  const newLevel = levelFromXp(xp);
  lastAward.set(key, nowMs);
  db.prepare("UPDATE users SET xp = ?, level = ? WHERE guild_id = ? AND user_id = ?").run(xp, newLevel, guildId, userId);
  return { leveledUp: newLevel > current.level, newLevel, xp, awarded };
}

/** Read a user's stored XP/level (0/0 when they have no row yet). */
export function getUserXp(db: SelenaDb, guildId: string, userId: string): { xp: number; level: number } {
  const row = db
    .prepare("SELECT xp, level FROM users WHERE guild_id = ? AND user_id = ?")
    .get(guildId, userId) as { xp: number; level: number } | undefined;
  return { xp: Number(row?.xp ?? 0), level: Number(row?.level ?? 0) };
}
