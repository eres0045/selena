import type { SelenaDb } from "./db.js";
import { levelFromXp } from "./levels.js";
import {
  FUSION_COSTS,
  applyMonsterXp,
} from "./monsterLevels.js";
import {
  MONSTER_BY_ID,
  TIERS,
  tierDown,
  type Monster,
  type Tier,
} from "./hunt.js";

/**
 * Hunt persistence (Supabase, via the existing SelenaDb surface).
 *
 * Tables are created by the bot on startup (CREATE TABLE IF NOT EXISTS
 * in db.ts SCHEMA) — the same pattern as every other feature. Ownership
 * rows carry guild_id so per-Discord-server caps are enforced by
 * counting rows per (guild_id, monster_id).
 *
 * CAP RULE (fail closed, design §3.3 rule 10): before awarding a
 * Mythic/UwU monster, count how many copies of THAT monster already
 * exist in the guild. At cap, the award downgrades one tier (and
 * re-checks). If the count query itself errors, the award is REFUSED —
 * never granted on a failed check.
 */

export interface HuntState {
  lastHuntAt: number | null;
  currentArea: string | null;
}

export interface RollState {
  rollsSinceEpic: number;
  rollsToday: number;
  rollDay: string | null;
}

export interface OwnedMonster {
  monster: Monster;
  count: number;
  source: string;
}

/** UTC calendar day, "YYYY-MM-DD" — the daily roll cap resets on it. */
export function utcDayString(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export async function getHuntState(db: SelenaDb, guildId: string, userId: string): Promise<HuntState> {
  const row = (await db
    .prepare("SELECT last_hunt_at, current_area FROM user_hunt WHERE guild_id = ? AND user_id = ?")
    .get(guildId, userId)) as { last_hunt_at: number | null; current_area: string | null } | undefined;
  return { lastHuntAt: row?.last_hunt_at ?? null, currentArea: row?.current_area ?? null };
}

export async function setHuntState(
  db: SelenaDb,
  guildId: string,
  userId: string,
  lastHuntAt: number,
  currentArea: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO user_hunt (guild_id, user_id, last_hunt_at, current_area) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (guild_id, user_id) DO UPDATE SET last_hunt_at = EXCLUDED.last_hunt_at, current_area = EXCLUDED.current_area",
    )
    .run(guildId, userId, lastHuntAt, currentArea);
}

export async function getRollState(db: SelenaDb, guildId: string, userId: string): Promise<RollState> {
  const row = (await db
    .prepare("SELECT rolls_since_epic, rolls_today, roll_day FROM user_roll WHERE guild_id = ? AND user_id = ?")
    .get(guildId, userId)) as
    | { rolls_since_epic: number; rolls_today: number; roll_day: string | null }
    | undefined;
  return {
    rollsSinceEpic: Number(row?.rolls_since_epic ?? 0),
    rollsToday: Number(row?.rolls_today ?? 0),
    rollDay: row?.roll_day ?? null,
  };
}

/** How many copies of one monster exist in one guild (the cap count). */
export async function countMonsterInGuild(db: SelenaDb, guildId: string, monsterId: number): Promise<number> {
  const row = (await db
    .prepare("SELECT COALESCE(SUM(count), 0) AS total FROM user_monsters WHERE guild_id = ? AND monster_id = ?")
    .get(guildId, monsterId)) as { total: number } | undefined;
  return Number(row?.total ?? 0);
}

/** Add one copy of a monster to a user's zoo (upsert count + 1). */
export async function addMonster(
  db: SelenaDb,
  guildId: string,
  userId: string,
  monsterId: number,
  source: "hunt" | "roll",
  nowMs: number,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO user_monsters (guild_id, user_id, monster_id, count, source, caught_at) VALUES (?, ?, ?, 1, ?, ?) " +
        "ON CONFLICT (guild_id, user_id, monster_id) DO UPDATE SET count = user_monsters.count + 1, caught_at = EXCLUDED.caught_at",
    )
    .run(guildId, userId, monsterId, source, nowMs);
}

/**
 * Award a monster of the requested tier to a user, enforcing the
 * per-guild supply caps AND the global spawn cooldowns. Returns the
 * monster actually awarded and, when a downgrade happened, the tier it
 * was downgraded from and why. Throws (fail closed) when the cap count
 * or cooldown query fails — the caller must refuse the award then.
 *
 * `level` is the level the awarded instance spawns at: wild level for
 * hunts (Phase 2 §6.1, via wildLevelForArea), 1 for rolls.
 */
export interface AwardResult {
  monster: Monster;
  downgradedFrom: Tier | null;
  downgradedReason: "cap" | "cooldown" | null;
  /** When the downgrade was a cooldown, when the resting monster returns. */
  cooldownAvailableAt: number | null;
  /** The user_monster_instances row created for this award. */
  instanceId: number;
  level: number;
}

export async function awardMonster(
  db: SelenaDb,
  guildId: string,
  userId: string,
  tier: Tier,
  source: "hunt" | "roll",
  pick: (tier: Tier) => Monster,
  nowMs: number,
  level = 1,
): Promise<AwardResult> {
  let current: Tier = tier;
  let downgradedFrom: Tier | null = null;
  let downgradedReason: "cap" | "cooldown" | null = null;
  let cooldownAvailableAt: number | null = null;
  // Walk down tiers while the current tier's chosen monster is capped
  // or cooling down. (Only Legendary+ have caps/cooldowns; the loop
  // terminates at Common, which has neither.)
  for (;;) {
    const monster = pick(current);
    // Global spawn cooldown (Phase 2 §7.1): a Legendary/Mythic/UwU
    // that was caught anywhere is gone world-wide until its timer
    // ends. While active that monster cannot spawn — downgrade a tier.
    // A failed cooldown read fails closed (throws) — never grant on a
    // failed check. Note the cooldown is per MONSTER, not per tier: a
    // different Legendary that is not cooling down can still spawn.
    if (spawnCooldownMs(current) !== null) {
      const cd = await getSpawnCooldown(db, monster.id);
      if (cd && cd.availableAt > nowMs) {
        if (downgradedFrom === null) {
          downgradedFrom = tier;
          downgradedReason = "cooldown";
          cooldownAvailableAt = cd.availableAt;
        }
        current = tierDown(current);
        continue;
      }
    }
    const cap = TIERS[current].capPerGuild;
    if (cap === null) {
      return await grantAward(db, guildId, userId, monster, source, nowMs, level, {
        downgradedFrom,
        downgradedReason,
        cooldownAvailableAt,
      });
    }
    const owned = await countMonsterInGuild(db, guildId, monster.id);
    if (owned < cap) {
      return await grantAward(db, guildId, userId, monster, source, nowMs, level, {
        downgradedFrom,
        downgradedReason,
        cooldownAvailableAt,
      });
    }
    if (downgradedFrom === null) {
      downgradedFrom = tier;
      downgradedReason = "cap";
    }
    current = tierDown(current);
  }
}

async function grantAward(
  db: SelenaDb,
  guildId: string,
  userId: string,
  monster: Monster,
  source: "hunt" | "roll",
  nowMs: number,
  level: number,
  downgrade: { downgradedFrom: Tier | null; downgradedReason: "cap" | "cooldown" | null; cooldownAvailableAt: number | null },
): Promise<AwardResult> {
  await addMonster(db, guildId, userId, monster.id, source, nowMs);
  const instanceId = await createMonsterInstance(db, guildId, userId, monster.id, level, source, nowMs);
  // The awarded high-tier monster now rests world-wide (§7.1).
  if (spawnCooldownMs(monster.tier) !== null) {
    await setSpawnCooldown(db, monster.id, nowMs);
  }
  return { monster, instanceId, level, ...downgrade };
}

// ---------------------------------------------------------------------------
// Global spawn cooldowns (Phase 2 §7.1) — one row per monster, world-wide.
// ---------------------------------------------------------------------------

/** Spawn cooldown after a catch, by tier (Phase 2 §7.1). */
export const SPAWN_COOLDOWN_MS: Record<"Legendary" | "Mythic" | "UwU", number> = {
  Legendary: 12 * 60 * 60 * 1000,
  Mythic: 3 * 24 * 60 * 60 * 1000,
  UwU: 14 * 24 * 60 * 60 * 1000,
};

/** Cooldown for a tier in ms, or null when the tier has none (Common–Epic). */
export function spawnCooldownMs(tier: Tier): number | null {
  if (tier === "Legendary" || tier === "Mythic" || tier === "UwU") return SPAWN_COOLDOWN_MS[tier];
  return null;
}

export interface SpawnCooldown {
  monsterId: number;
  caughtAt: number;
  availableAt: number;
}

/**
 * Read a monster's spawn cooldown (null when never caught). Throws on a
 * query error — callers treat that as fail-closed, never as "no cooldown".
 */
export async function getSpawnCooldown(db: SelenaDb, monsterId: number): Promise<SpawnCooldown | null> {
  const row = (await db
    .prepare("SELECT monster_id, caught_at, available_at FROM spawn_cooldowns WHERE monster_id = ?")
    .get(monsterId)) as { monster_id: number; caught_at: number; available_at: number } | undefined;
  if (!row) return null;
  return {
    monsterId: Number(row.monster_id),
    caughtAt: Number(row.caught_at),
    availableAt: Number(row.available_at),
  };
}

/** True when the monster is on its global spawn cooldown right now. */
export async function isSpawnCoolingDown(db: SelenaDb, monsterId: number, nowMs: number): Promise<boolean> {
  const cd = await getSpawnCooldown(db, monsterId);
  return cd !== null && cd.availableAt > nowMs;
}

/**
 * Start (or restart) a monster's spawn cooldown at nowMs. Returns the
 * timestamp it becomes available again, or 0 when the tier has none.
 */
export async function setSpawnCooldown(db: SelenaDb, monsterId: number, nowMs: number): Promise<number> {
  const monster = MONSTER_BY_ID.get(monsterId);
  const ms = monster ? spawnCooldownMs(monster.tier) : null;
  if (ms === null) return 0;
  const availableAt = nowMs + ms;
  await db
    .prepare(
      "INSERT INTO spawn_cooldowns (monster_id, caught_at, available_at) VALUES (?, ?, ?) " +
        "ON CONFLICT (monster_id) DO UPDATE SET caught_at = EXCLUDED.caught_at, available_at = EXCLUDED.available_at",
    )
    .run(monsterId, nowMs, availableAt);
  return availableAt;
}

// ---------------------------------------------------------------------------
// Monster instances (Phase 2 §6) — one row per caught copy, level + XP +
// fuse level. user_monsters count rows stay the source for per-server
// caps and zoo counts; instances are kept in sync by awardMonster (one
// row per award) and removeOneMonster / applyFuse (one row per removal).
// ---------------------------------------------------------------------------

export interface MonsterInstance {
  id: number;
  guildId: string;
  userId: string;
  monsterId: number;
  level: number;
  xp: number;
  fuseLevel: number;
  source: string;
  caughtAt: number;
}

/** Create one instance row; returns its id. */
export async function createMonsterInstance(
  db: SelenaDb,
  guildId: string,
  userId: string,
  monsterId: number,
  level: number,
  source: "hunt" | "roll",
  nowMs: number,
): Promise<number> {
  const res = await db
    .prepare(
      "INSERT INTO user_monster_instances (guild_id, user_id, monster_id, level, xp, fuse_level, source, caught_at) " +
        "VALUES (?, ?, ?, ?, 0, 0, ?, ?)",
    )
    .run(guildId, userId, monsterId, Math.max(1, Math.min(100, Math.floor(level))), source, nowMs);
  return Number(res.lastInsertRowid);
}

function instanceFromRow(r: Record<string, unknown>): MonsterInstance {
  return {
    id: Number(r.id),
    guildId: String(r.guild_id),
    userId: String(r.user_id),
    monsterId: Number(r.monster_id),
    level: Number(r.level),
    xp: Number(r.xp),
    fuseLevel: Number(r.fuse_level),
    source: String(r.source),
    caughtAt: Number(r.caught_at),
  };
}

/** All instances a user owns (optionally of one monster), best first. */
export async function getUserInstances(
  db: SelenaDb,
  guildId: string,
  userId: string,
  monsterId?: number,
): Promise<MonsterInstance[]> {
  const rows =
    monsterId === undefined
      ? ((await db
          .prepare(
            "SELECT id, guild_id, user_id, monster_id, level, xp, fuse_level, source, caught_at " +
              "FROM user_monster_instances WHERE guild_id = ? AND user_id = ? ORDER BY fuse_level DESC, level DESC, id ASC",
          )
          .all(guildId, userId)) as Record<string, unknown>[])
      : ((await db
          .prepare(
            "SELECT id, guild_id, user_id, monster_id, level, xp, fuse_level, source, caught_at " +
              "FROM user_monster_instances WHERE guild_id = ? AND user_id = ? AND monster_id = ? ORDER BY fuse_level DESC, level DESC, id ASC",
          )
          .all(guildId, userId, monsterId)) as Record<string, unknown>[]);
  return rows.map(instanceFromRow);
}

/** One instance by id (undefined when it does not exist). */
export async function getMonsterInstance(db: SelenaDb, instanceId: number): Promise<MonsterInstance | undefined> {
  const row = (await db
    .prepare(
      "SELECT id, guild_id, user_id, monster_id, level, xp, fuse_level, source, caught_at " +
        "FROM user_monster_instances WHERE id = ?",
    )
    .get(instanceId)) as Record<string, unknown> | undefined;
  return row ? instanceFromRow(row) : undefined;
}

/**
 * Add XP to one instance, levelling it up while its XP crosses the
 * 100 × current-level threshold (design §6.3, cap level 100). Returns
 * the new level/XP and how many levels were gained.
 */
export async function addMonsterXp(
  db: SelenaDb,
  instanceId: number,
  gained: number,
): Promise<{ level: number; xp: number; levelsGained: number }> {
  const inst = await getMonsterInstance(db, instanceId);
  if (!inst) throw new Error(`addMonsterXp: no instance ${instanceId}`);
  const next = applyMonsterXp(inst.level, inst.xp, gained);
  await db
    .prepare("UPDATE user_monster_instances SET level = ?, xp = ? WHERE id = ?")
    .run(next.level, next.xp, instanceId);
  return next;
}

// ---------------------------------------------------------------------------
// Fusion (Phase 2 §6.4) — 2 copies of the same monster -> 1 stronger one.
// ---------------------------------------------------------------------------

export interface FusePlan {
  ok: boolean;
  /** Human-readable refusal reason when ok is false. */
  error?: string;
  monster?: Monster;
  /** Gold cost of this fuse step, by tier (design §6.4). */
  cost?: number;
  /** The copy that survives (highest fuse, then highest level). */
  survivor?: MonsterInstance;
  /** The copy that is consumed (weakest). */
  consumed?: MonsterInstance;
  newFuseLevel?: number;
  newLevel?: number;
}

/**
 * Read-only-ish fuse check. When the user owns more copies (count row)
 * than instances — count rows predate instances — the missing instances
 * are backfilled at level 1 so fusion can see every copy the user owns.
 * The backfill is the instance/count sync repair for legacy zoos.
 */
export async function getFusePlan(
  db: SelenaDb,
  guildId: string,
  userId: string,
  monsterId: number,
  nowMs: number,
): Promise<FusePlan> {
  const monster = MONSTER_BY_ID.get(monsterId);
  if (!monster) return { ok: false, error: "No monster with that id." };
  const owned = await getOwnedCount(db, guildId, userId, monsterId);
  if (owned < 2) {
    return { ok: false, error: `You need 2 copies of ${monster.name} to fuse — you have ${owned}.` };
  }
  let instances = await getUserInstances(db, guildId, userId, monsterId);
  if (instances.length < owned) {
    for (let i = instances.length; i < owned; i++) {
      await createMonsterInstance(db, guildId, userId, monsterId, 1, "hunt", nowMs);
    }
    instances = await getUserInstances(db, guildId, userId, monsterId);
  }
  // Fusion pairs EQUAL fuse levels (design §6.4: reaching +6 takes 64
  // base copies — 2 +5s make a +6, 2 +4s make a +5, and so on). The
  // highest fuse level with a pair is fused; the survivor keeps the
  // higher level of the two. Mixed levels never fuse: a +1 and a +0
  // are not a pair.
  const byFuse = new Map<number, MonsterInstance[]>();
  for (const inst of instances) {
    const list = byFuse.get(inst.fuseLevel) ?? [];
    list.push(inst);
    byFuse.set(inst.fuseLevel, list);
  }
  const fuseLevels = [...byFuse.keys()].sort((a, b) => b - a);
  let pair: MonsterInstance[] | undefined;
  for (const fl of fuseLevels) {
    const list = byFuse.get(fl)!;
    if (list.length >= 2) {
      pair = list;
      break;
    }
  }
  if (!pair) {
    return {
      ok: false,
      error: `You need 2 copies of ${monster.name} at the same fusion level to fuse — your copies are at different levels.`,
    };
  }
  // Within the pair: higher level survives (design §6.4), ties keep the older copy.
  const [first, second] = [...pair].sort((a, b) => b.level - a.level || a.id - b.id);
  const survivor = first!;
  const consumed = second!;
  if (survivor.fuseLevel >= 6) {
    return { ok: false, error: `${monster.name} is already +6 — the highest fusion. It can't fuse any further.` };
  }
  return {
    ok: true,
    monster,
    cost: FUSION_COSTS[monster.tier],
    survivor,
    consumed,
    newFuseLevel: survivor.fuseLevel + 1,
    newLevel: Math.max(survivor.level, consumed.level),
  };
}

/**
 * Execute a fusion: consume the weakest copy, bump the survivor's fuse
 * level by 1 (keeping the higher level), and drop the count row by 1.
 * Re-validates via getFusePlan first — throws on any invalid state, so
 * a caller inside a transaction rolls the whole fuse back. Gold is NOT
 * handled here; the caller deducts FUSION_COSTS[tier] in the same
 * transaction before calling this (fail-closed: insufficient gold
 * refuses before any copy is consumed).
 */
export async function applyFuse(
  db: SelenaDb,
  guildId: string,
  userId: string,
  monsterId: number,
  nowMs: number,
): Promise<{ survivor: MonsterInstance; consumedId: number; newFuseLevel: number; newLevel: number }> {
  const plan = await getFusePlan(db, guildId, userId, monsterId, nowMs);
  if (!plan.ok || !plan.survivor || !plan.consumed || plan.newFuseLevel === undefined || plan.newLevel === undefined) {
    throw new Error(plan.error ?? "Cannot fuse this monster.");
  }
  await db.prepare("DELETE FROM user_monster_instances WHERE id = ?").run(plan.consumed.id);
  await db
    .prepare("UPDATE user_monster_instances SET fuse_level = ?, level = ? WHERE id = ?")
    .run(plan.newFuseLevel, plan.newLevel, plan.survivor.id);
  await db
    .prepare("UPDATE user_monsters SET count = count - 1 WHERE guild_id = ? AND user_id = ? AND monster_id = ?")
    .run(guildId, userId, monsterId);
  return {
    survivor: { ...plan.survivor, fuseLevel: plan.newFuseLevel, level: plan.newLevel },
    consumedId: plan.consumed.id,
    newFuseLevel: plan.newFuseLevel,
    newLevel: plan.newLevel,
  };
}

// ---------------------------------------------------------------------------
// Player XP for hunt/roll rewards (Phase 2 §6.3). Unlike awardXp in
// levels.ts, this has NO 60s chat-XP cooldown — hunt/roll rewards are
// earned per catch/pull, not per message, and the cooldown would
// silently swallow them.
// ---------------------------------------------------------------------------

export async function grantPlayerXp(
  db: SelenaDb,
  guildId: string,
  userId: string,
  amount: number,
): Promise<{ xp: number; level: number; leveledUp: boolean }> {
  await db.prepare("INSERT OR IGNORE INTO users (guild_id, user_id) VALUES (?, ?)").run(guildId, userId);
  const row = (await db.prepare("SELECT xp, level FROM users WHERE guild_id = ? AND user_id = ?").get(guildId, userId)) as
    | { xp: number; level: number }
    | undefined;
  const prevLevel = Number(row?.level ?? 0);
  const xp = Number(row?.xp ?? 0) + Math.max(0, Math.floor(amount));
  const level = levelFromXp(xp);
  await db.prepare("UPDATE users SET xp = ?, level = ? WHERE guild_id = ? AND user_id = ?").run(xp, level, guildId, userId);
  return { xp, level, leveledUp: level > prevLevel };
}

/** All monsters a user owns in a guild, with counts. */
export async function getUserMonsters(db: SelenaDb, guildId: string, userId: string): Promise<OwnedMonster[]> {
  const rows = (await db
    .prepare("SELECT monster_id, count, source FROM user_monsters WHERE guild_id = ? AND user_id = ? ORDER BY monster_id")
    .all(guildId, userId)) as { monster_id: number; count: number; source: string }[];
  const out: OwnedMonster[] = [];
  for (const r of rows) {
    const monster = MONSTER_BY_ID.get(Number(r.monster_id));
    if (monster) out.push({ monster, count: Number(r.count), source: String(r.source) });
  }
  return out;
}

/** How many copies of one monster a user owns (0 when none). */
export async function getOwnedCount(db: SelenaDb, guildId: string, userId: string, monsterId: number): Promise<number> {
  const row = (await db
    .prepare("SELECT count FROM user_monsters WHERE guild_id = ? AND user_id = ? AND monster_id = ?")
    .get(guildId, userId, monsterId)) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

/**
 * Remove one copy of a monster from a user's zoo. Returns the remaining
 * count, or null when the user owned no copy. Throws nothing on its own;
 * callers validate ownership first. Keeps instances in sync: the weakest
 * instance copy (lowest fuse, then lowest level) is deleted too, so the
 * instance count never drifts from the count row.
 */
export async function removeOneMonster(
  db: SelenaDb,
  guildId: string,
  userId: string,
  monsterId: number,
): Promise<number | null> {
  const owned = await getOwnedCount(db, guildId, userId, monsterId);
  if (owned <= 0) return null;
  if (owned === 1) {
    await db
      .prepare("DELETE FROM user_monsters WHERE guild_id = ? AND user_id = ? AND monster_id = ?")
      .run(guildId, userId, monsterId);
  } else {
    await db
      .prepare("UPDATE user_monsters SET count = count - 1 WHERE guild_id = ? AND user_id = ? AND monster_id = ?")
      .run(guildId, userId, monsterId);
  }
  const instances = await getUserInstances(db, guildId, userId, monsterId);
  if (instances.length > 0) {
    const weakest = [...instances].sort(
      (a, b) => a.fuseLevel - b.fuseLevel || a.level - b.level || a.id - b.id,
    )[0]!;
    await db.prepare("DELETE FROM user_monster_instances WHERE id = ?").run(weakest.id);
  }
  return owned - 1;
}

export async function getUserWeapons(
  db: SelenaDb,
  guildId: string,
  userId: string,
): Promise<{ weaponId: number; count: number; equipped: boolean }[]> {
  const rows = (await db
    .prepare("SELECT weapon_id, count, equipped FROM user_weapons WHERE guild_id = ? AND user_id = ? ORDER BY weapon_id")
    .all(guildId, userId)) as { weapon_id: number; count: number; equipped: number }[];
  return rows.map((r) => ({ weaponId: Number(r.weapon_id), count: Number(r.count), equipped: Number(r.equipped) !== 0 }));
}

export async function getUserPets(
  db: SelenaDb,
  guildId: string,
  userId: string,
): Promise<{ petId: number; count: number; active: boolean }[]> {
  const rows = (await db
    .prepare("SELECT pet_id, count, active FROM user_pets WHERE guild_id = ? AND user_id = ? ORDER BY pet_id")
    .all(guildId, userId)) as { pet_id: number; count: number; active: number }[];
  return rows.map((r) => ({ petId: Number(r.pet_id), count: Number(r.count), active: Number(r.active) !== 0 }));
}
