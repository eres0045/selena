import { EmbedBuilder } from "discord.js";
import type { SelenaDb } from "./db.js";
import { addPoints } from "./economy.js";
import { SELENA_COLOR } from "./command.js";

// ---------------------------------------------------------------------------
// Daily GLOBAL quests (2026-11-07, Ronit's order).
//
// One quest set per UTC day, the SAME for every user on every server:
// the 3 quests are picked deterministically from QUEST_POOL, seeded by
// the date — no per-user roll, no reroll, no lock (a shared global set
// makes per-user reroll wrong). Each user tracks their OWN progress
// against the shared set. Rewards are gold + gems only — no new
// currency. Reset is midnight UTC, same as the shop refresh.
//
// Progress is recorded by the action handlers themselves (hunt catch,
// roll, battle win, casino win, explore discovery, bg purchase, daily
// claim, fuse, tower floor clear, about set) via recordQuestProgress —
// best-effort: callers wrap it in try/catch so a quest failure never
// breaks the action. Claims pay out once per quest per day, in one DB
// transaction, and re-claims refuse.
// ---------------------------------------------------------------------------

export type QuestKind =
  | "hunt"
  | "roll"
  | "catch"
  | "catch_rare"
  | "catch_legendary"
  | "battle_win"
  | "casino_win"
  | "coinflip_win"
  | "explore_discover"
  | "bg_buy"
  | "daily"
  | "fuse"
  | "tower_floor"
  | "about";

export interface QuestDef {
  id: string;
  kind: QuestKind;
  target: number;
  title: string;
  description: string;
  gold: number;
  gems: number;
}

/**
 * The quest pool. Every quest must be trackable from a real action
 * handler — no quest may name an event nothing records. Rewards scale
 * with difficulty: easy 500g, medium 1,000–2,000g, hard 2,500–5,000g
 * + gems. "Rare+" means Rare/Epic; "Legendary+" means Legendary/
 * Mythic/UwU.
 */
export const QUEST_POOL: readonly QuestDef[] = [
  { id: "hunt_3", kind: "hunt", target: 3, title: "Hunt 3 times", description: "Use `uwu hunt` 3 times.", gold: 800, gems: 0 },
  { id: "hunt_10", kind: "hunt", target: 10, title: "Hunt 10 times", description: "Use `uwu hunt` 10 times.", gold: 2000, gems: 0 },
  { id: "roll_3", kind: "roll", target: 3, title: "Roll 3 times", description: "Use `uwu roll` 3 times.", gold: 1000, gems: 0 },
  { id: "roll_10", kind: "roll", target: 10, title: "Roll 10 times", description: "Use `uwu roll` 10 times.", gold: 4000, gems: 3 },
  { id: "catch_5", kind: "catch", target: 5, title: "Catch 5 monsters", description: "Catch any 5 monsters (hunt or roll).", gold: 1500, gems: 0 },
  { id: "catch_rare", kind: "catch_rare", target: 1, title: "Catch a Rare+ monster", description: "Catch a Rare or better monster.", gold: 2500, gems: 2 },
  { id: "catch_legendary", kind: "catch_legendary", target: 1, title: "Catch a Legendary+ monster", description: "Catch a Legendary, Mythic or UwU monster.", gold: 5000, gems: 5 },
  { id: "battle_win_1", kind: "battle_win", target: 1, title: "Win a battle", description: "Win a 1v1 battle (`uwu battle @user`).", gold: 2000, gems: 1 },
  { id: "casino_win_3", kind: "casino_win", target: 3, title: "Win 3 casino games", description: "Win any 3 casino games (slots, blackjack, roulette, coinflip, highlow, mines).", gold: 1500, gems: 0 },
  { id: "coinflip_win_1", kind: "coinflip_win", target: 1, title: "Win a coinflip", description: "Win one `uwu coinflip` (or `uwu cf`).", gold: 500, gems: 0 },
  { id: "explore_1", kind: "explore_discover", target: 1, title: "Discover a tower", description: "Find a hidden tower with `uwu explore`.", gold: 2000, gems: 1 },
  { id: "bg_buy_1", kind: "bg_buy", target: 1, title: "Buy a profile background", description: "Buy any background with `uwu shop buy bg <name>`.", gold: 3000, gems: 2 },
  { id: "daily_1", kind: "daily", target: 1, title: "Claim your daily", description: "Claim your daily gold with `uwu daily`.", gold: 500, gems: 0 },
  { id: "fuse_1", kind: "fuse", target: 1, title: "Fuse a monster", description: "Fuse two of the same monster with `uwu fuse <monster>`.", gold: 2500, gems: 2 },
  { id: "tower_floor_2", kind: "tower_floor", target: 2, title: "Clear 2 tower floors", description: "Clear 2 tower floors (`uwu tower climb`).", gold: 3000, gems: 3 },
  { id: "about_1", kind: "about", target: 1, title: "Set your About Me", description: "Set your About Me with `uwu about <text>`.", gold: 500, gems: 0 },
];

/** How many quests are live each day. */
export const DAILY_QUEST_COUNT = 3;

/** UTC date key for a day ("YYYY-MM-DD"). The reset is midnight UTC. */
export function questDateKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** Milliseconds until the next UTC midnight (the quest reset). */
export function msUntilReset(now: Date = new Date()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() - now.getTime();
}

/** "Xh Ym" until the next reset, for the quest log footer. */
export function timeUntilReset(now: Date = new Date()): string {
  const ms = msUntilReset(now);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

// --- Deterministic daily pick ----------------------------------------------
// FNV-1a over the date string, then mulberry32 — a pure function of the
// date, so every process/server picks the same 3 quests for a day.

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The day's 3 quests, in pool order. Same date → same quests, everywhere. */
export function questsForDate(date: Date = new Date()): QuestDef[] {
  const rand = mulberry32(fnv1a(questDateKey(date)));
  const idx = QUEST_POOL.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx
    .slice(0, DAILY_QUEST_COUNT)
    .sort((a, b) => a - b)
    .map((i) => QUEST_POOL[i]!);
}

// --- Progress + claims -------------------------------------------------------

export interface QuestLogEntry {
  def: QuestDef;
  progress: number;
  claimed: boolean;
  get completed(): boolean;
}

function entry(def: QuestDef, progress: number, claimed: boolean): QuestLogEntry {
  return {
    def,
    progress,
    claimed,
    get completed() {
      return progress >= def.target;
    },
  };
}

/**
 * Record progress for today's quests whose kind is in `kinds`.
 * Progress is capped at the quest target. Best-effort by design:
 * callers wrap this in try/catch — a quest write must never break the
 * action that triggered it. (user_id is GLOBAL — quests follow you
 * across servers, like the profile and the world.)
 */
export async function recordQuestProgress(
  db: SelenaDb,
  userId: string,
  kinds: QuestKind[],
  n = 1,
  date: Date = new Date(),
): Promise<void> {
  if (kinds.length === 0 || n <= 0) return;
  const dateKey = questDateKey(date);
  const today = questsForDate(date).filter((q) => kinds.includes(q.kind));
  for (const q of today) {
    await db
      .prepare("INSERT OR IGNORE INTO user_quest_progress (user_id, date, quest_id, progress) VALUES (?, ?, ?, 0)")
      .run(userId, dateKey, q.id);
    await db
      .prepare(
        "UPDATE user_quest_progress SET progress = LEAST(progress + ?, ?) " +
          "WHERE user_id = ? AND date = ? AND quest_id = ?",
      )
      .run(n, q.target, userId, dateKey, q.id);
  }
}

/**
 * Backfill: did the user claim their daily gold during the UTC quest
 * day? The daily claim is recorded in `users.last_daily` (per guild)
 * even when the quest system did not exist yet, so a claim made before
 * the quests deployed still counts — the daily quest is otherwise
 * UNCOMPLETABLE that day (24h cooldown, no re-claim until tomorrow).
 * Quests are global, so the latest claim across ALL guilds is what
 * matters. Compute-on-read only: nothing is written here, so a
 * progress row recorded by the claim hook can never be double-counted.
 *
 * Daily is the only quest that gets this treatment: every other quest
 * action is repeatable today (hunt/roll/catch/battle/casino/explore/
 * bg buy/fuse/tower/about can all be done again), so a pre-deploy
 * action never blocks those quests. Only the 24h-gated daily claim
 * can strand a player with a 0/1 they cannot fix.
 */
export async function claimedDailyToday(
  db: SelenaDb,
  userId: string,
  date: Date = new Date(),
): Promise<boolean> {
  const row = (await db
    .prepare("SELECT MAX(last_daily) AS last_daily FROM users WHERE user_id = ?")
    .get(userId)) as { last_daily: number | null } | undefined;
  const last = row?.last_daily == null ? null : Number(row.last_daily);
  if (last === null || !Number.isFinite(last)) return false;
  return questDateKey(new Date(last)) === questDateKey(date);
}

/** Today's quest log for a user: the shared 3 quests + their progress + claimed flags. */
export async function getQuestLog(
  db: SelenaDb,
  userId: string,
  date: Date = new Date(),
): Promise<{ date: string; quests: QuestLogEntry[] }> {
  const dateKey = questDateKey(date);
  const defs = questsForDate(date);
  const progressRows = await db
    .prepare("SELECT quest_id, progress FROM user_quest_progress WHERE user_id = ? AND date = ?")
    .all(userId, dateKey);
  const claimedRows = await db
    .prepare("SELECT quest_id FROM user_quest_claims WHERE user_id = ? AND date = ?")
    .all(userId, dateKey);
  const progress = new Map(progressRows.map((r) => [String(r.quest_id), Number(r.progress)]));
  const claimed = new Set(claimedRows.map((r) => String(r.quest_id)));
  // Backfill (see claimedDailyToday): a daily claim from before the
  // quest system existed still completes today's daily quest. Only
  // fills the gap when no progress row covers it — a recorded row is
  // the source of truth and is never inflated.
  const dailyDef = defs.find((d) => d.kind === "daily");
  if (dailyDef && (progress.get(dailyDef.id) ?? 0) < dailyDef.target) {
    if (await claimedDailyToday(db, userId, date)) {
      progress.set(dailyDef.id, dailyDef.target);
    }
  }
  return {
    date: dateKey,
    quests: defs.map((d) => entry(d, progress.get(d.id) ?? 0, claimed.has(d.id))),
  };
}

/** Reward text for a quest, e.g. "2,000 gold + 1 gem" / "500 gold". */
export function rewardText(def: QuestDef): string {
  const gold = `${def.gold.toLocaleString("en-US")} gold`;
  return def.gems > 0 ? `${gold} + ${def.gems} gem${def.gems > 1 ? "s" : ""}` : gold;
}

/** Progress bar: ▓ filled, ░ empty. */
export function progressBar(progress: number, target: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((progress / target) * width)));
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

/**
 * Claim every completed-but-unclaimed quest for today, in ONE
 * transaction. The INSERT OR IGNORE into user_quest_claims is the
 * once-only guard: a second claim of the same quest inserts 0 rows
 * and pays nothing. Gold is paid in the claiming guild (gold is
 * guild-scoped); gems are global (user_wallet). Returns what was
 * actually paid.
 */
export async function claimQuests(
  db: SelenaDb,
  guildId: string,
  userId: string,
  date: Date = new Date(),
): Promise<{ claimed: QuestLogEntry[]; totalGold: number; totalGems: number }> {
  return db.transaction(async (tx) => {
    const log = await getQuestLog(tx, userId, date);
    const claimable = log.quests.filter((q) => q.completed && !q.claimed);
    let totalGold = 0;
    let totalGems = 0;
    const claimed: QuestLogEntry[] = [];
    for (const q of claimable) {
      const res = await tx
        .prepare(
          "INSERT OR IGNORE INTO user_quest_claims (user_id, date, quest_id, claimed_at) VALUES (?, ?, ?, ?)",
        )
        .run(userId, log.date, q.def.id, Date.now());
      if (res.changes === 0) continue; // already claimed (race) — pay nothing
      await addPoints(tx, guildId, userId, q.def.gold, `quest ${q.def.id}`);
      if (q.def.gems > 0) {
        await tx.prepare("INSERT OR IGNORE INTO user_wallet (user_id, gems) VALUES (?, 0)").run(userId);
        await tx.prepare("UPDATE user_wallet SET gems = gems + ? WHERE user_id = ?").run(q.def.gems, userId);
      }
      totalGold += q.def.gold;
      totalGems += q.def.gems;
      claimed.push(entry(q.def, q.progress, true));
    }
    return { claimed, totalGold, totalGems };
  });
}

/**
 * The quest log as a Discord embed (OwO Quest Log style): one field
 * per quest with its progress bar + count + rewards + status, and a
 * footer with the time to the next reset. Callers add the Claim
 * button themselves (buttons can't live in this pure builder).
 */
export function buildQuestLogEmbed(
  log: { date: string; quests: QuestLogEntry[] },
  displayName: string,
  now: Date = new Date(),
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(SELENA_COLOR)
    .setTitle(`📜 ${displayName}'s Quest Log`)
    .setDescription(
      "Complete quests to earn rewards!\n" +
        `Daily quests — the same for everyone, resetting at midnight UTC.\n` +
        `⏰ Next quests in ${timeUntilReset(now)}`,
    );
  for (const [i, q] of log.quests.entries()) {
    const status = q.claimed ? "✅ Claimed" : q.completed ? "🎉 Complete — claim it!" : "⏳ In progress";
    embed.addFields({
      name: `${i + 1}. ${q.def.title}`,
      value:
        `${progressBar(q.progress, q.def.target)} ${Math.min(q.progress, q.def.target)}/${q.def.target}\n` +
        `${q.def.description}\n` +
        `Completion rewards: ${rewardText(q.def)}\n${status}`,
      inline: false,
    });
  }
  return embed;
}

// --- Schema ------------------------------------------------------------------
// These tables live in SCHEMA in src/lib/db.ts (appended at merge).
// QUEST_SCHEMA is retained for standalone use (e.g. a DB built without
// the full schema). NOTE: do NOT exec it on a DB that already ran SCHEMA
// — pg-mem throws an unsupported-AST error when CREATE TABLE IF NOT
// EXISTS runs for a table that already exists.

export const QUEST_SCHEMA = `
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
