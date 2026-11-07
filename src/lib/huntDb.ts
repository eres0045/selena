import type { SelenaDb } from "./db.js";
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
 * per-guild supply caps. Returns the monster actually awarded and,
 * when a cap forced a downgrade, the tier it was downgraded from.
 * Throws (fail closed) when the cap count query fails — the caller
 * must refuse the award in that case.
 */
export async function awardMonster(
  db: SelenaDb,
  guildId: string,
  userId: string,
  tier: Tier,
  source: "hunt" | "roll",
  pick: (tier: Tier) => Monster,
  nowMs: number,
): Promise<{ monster: Monster; downgradedFrom: Tier | null }> {
  let current: Tier = tier;
  let downgradedFrom: Tier | null = null;
  // Walk down tiers while the current tier's chosen monster is capped.
  // (Only Mythic/UwU have caps; the loop terminates at Common, which
  // is never capped.)
  for (;;) {
    const monster = pick(current);
    const cap = TIERS[current].capPerGuild;
    if (cap === null) {
      await addMonster(db, guildId, userId, monster.id, source, nowMs);
      return { monster, downgradedFrom };
    }
    const owned = await countMonsterInGuild(db, guildId, monster.id);
    if (owned < cap) {
      await addMonster(db, guildId, userId, monster.id, source, nowMs);
      return { monster, downgradedFrom };
    }
    if (downgradedFrom === null) downgradedFrom = tier;
    current = tierDown(current);
  }
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
 * callers validate ownership first.
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
    return 0;
  }
  await db
    .prepare("UPDATE user_monsters SET count = count - 1 WHERE guild_id = ? AND user_id = ? AND monster_id = ?")
    .run(guildId, userId, monsterId);
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
