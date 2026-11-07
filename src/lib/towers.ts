import { addPoints } from "./economy.js";
import { secureFloat, mulberry32 } from "./rng.js";
import { WORLD_AREAS, drawMonsterFromWorldArea, encounterMonsterInWorldArea, findWorldArea } from "./world.js";
import { TIER_INDEX, TIER_ORDER, drawMonsterOfTier, type Monster, type Tier } from "./hunt.js";
import { towerFloorXp } from "./monsterLevels.js";
import {
  awardBattleXp,
  getBattleTeam,
  getEquippedWeapon,
  grantMonsterXp,
  pickTeam,
  simulateBattle,
  type BattleResult,
  type TeamMemberInput,
} from "./battle.js";
import type { SelenaDb } from "./db.js";
import { recordQuestProgress } from "./quests.js";

/**
 * Towers (Phase 2, design docs/hunt-world-phase2-design.md §4 + §9).
 *
 * 30 towers stand across the world, placed RANDOMLY (Ron's rule,
 * §4.2): 18 small (10 floors), 11 big (20 floors), 1 hidden main
 * (50 floors). Placement is DETERMINISTIC — a seeded RNG
 * (TOWER_SEED) so the layout is identical on every boot/restart.
 * The Main tower's location is NEVER revealed in any reply: it is
 * hidden from lists and its area always renders as "???".
 *
 * Locked numbers (Ron's, §4.1/§4.5): party size is a RECOMMENDED
 * MINIMUM (Small 2, Big 4, Main 6) — solo is allowed but hard, and
 * larger parties are allowed too. Checkpoints on every floor: resume
 * anytime, change party between sessions. Tower-wide clear
 * cooldowns: small 6h, big 12h, main 7 days.
 *
 * WORKING DEFAULTS (design §12 items 13/15/18/20 — unconfirmed,
 * chosen here and documented so Ronit can tune them):
 * - Entry level requirements: Small = its area's unlock level,
 *   Big = area unlock + 5, Main = 60.
 * - Floor scaling: floor monsters fight at level
 *   (area unlock level + floor), capped at 100, and their base
 *   stats are pre-multiplied by 1 + 5% per floor above 1 — ON TOP
 *   of the +2%/level scaling the battle engine already applies
 *   (monsterLevels.ts). So a floor-10 monster is ~1.45x base stats
 *   before its level scaling. Mini-boss (every 5th floor): one
 *   monster, one tier above the area's top tier (cap UwU), HP x3,
 *   ATK/DEF x1.5 on top of the floor scale. Final boss: one monster
 *   of a fixed tier by tower size (Small Epic, Big Legendary, Main
 *   Mythic — design §4.4), HP x2 on top of the floor scale, ATK/DEF
 *   at the floor scale only (x1.0): in this engine one fighter acts
 *   per side per round, so a boss's ATK/DEF scale far harder than its
 *   HP — the boss's bulk is its HP, not one-shot damage. Bosses are
 *   NEVER catchable — fought for drops only
 *   (design §4.4, §12 item 13 working default).
 * - Party model: progress (checkpoint floor) is PER USER in
 *   tower_progress; tower_parties holds the active party. A climb
 *   fights with the COMBINED top-3 across all party members'
 *   rosters (pickTeam over everyone's teams) — so a bigger party
 *   brings a stronger combined team, and a solo player fights with
 *   their own top-3. The climber's floor advances on a win, and so
 *   does every party member who has already entered this tower
 *   (they were there for the fight). The leader's equipped weapon
 *   backs the party's active monster.
 * - Floor rewards: gold = Small 20 + floor*10, Big 30 + floor*15,
 *   Main 50 + floor*25 (final floor pays double gold); XP =
 *   towerFloorXp(floor) = 50 + floor*5 (design §6.3). Crates:
 *   mini-boss floors grant Golden (Small/Big) or Crystal (Main);
 *   the final floor grants Silver (Small), Crystal (Big) or Void
 *   (Main); normal floors have a 10% crate roll — Wooden (Small),
 *   Iron (Big), Silver (Main). The crates system owns opening;
 *   towers only GRANT crates into user_crates.
 * - Final-clear bonus (on top of the final floor's crate): gems
 *   Small 5 / Big 15 / Main 50 into user_wallet, materials
 *   (Small: 10 shards; Big: 25 shards + 5 crystals; Main: 50 shards
 *   + 10 crystals + 1 evolution stone) into user_materials, and a
 *   `tower-clear-<tower_id>` badge into user_badges.
 * - Discovery (MYSTERY rebuild, 2026-11-07 — Ronit's order): towers
 *   are mysterious — undiscovered towers show as ??? and are never
 *   listed by name. Discovery is PER USER (user_tower_discoveries;
 *   no guild_id — the world is shared across Discord, like
 *   user_location). A non-hidden tower is discovered by `uwu explore`
 *   in its area (40% per explore, 60s cooldown between explores;
 *   when an area has no undiscovered towers left, exploring finds
 *   5–15 consolation gold instead) or by a 25% roll when arriving
 *   in an area by travel (maybeDiscoverOnArrival). Floors reveal
 *   only as cleared: floor N+1 is revealed once floor N is cleared
 *   (floorReveal). The Main tower is NEVER discoverable —
 *   discoverTower returns false for it; it is entered only by exact
 *   tower name/id (word of mouth / exploration), never listed, never
 *   shown on any list/detail area, and `uwu tower` never hints it
 *   exists.
 *
 * All persistent state lives in Supabase (towers, tower_parties,
 * tower_progress, tower_cooldowns, user_crates, user_materials,
 * user_wallet, user_badges) — never in-memory. Rewards are
 * fail-closed: a DB error during the settle transaction aborts the
 * whole climb (no floor advance, no rewards, no cooldown).
 */

// ---------------------------------------------------------------------------
// Locked numbers
// ---------------------------------------------------------------------------

export const TOWER_SEED = 20261107;
export const TOWER_TOTAL = 30;
export const SMALL_TOWER_COUNT = 18;
export const BIG_TOWER_COUNT = 11;
export const MAIN_TOWER_COUNT = 1;
export const SMALL_FLOORS = 10;
export const BIG_FLOORS = 20;
export const MAIN_FLOORS = 50;
export const MINI_BOSS_EVERY = 5;

export const RECOMMENDED_PARTY: Record<TowerType, number> = { small: 2, big: 4, main: 6 };
export const CLEAR_COOLDOWN_MS: Record<TowerType, number> = {
  small: 6 * 60 * 60 * 1000,
  big: 12 * 60 * 60 * 1000,
  main: 7 * 24 * 60 * 60 * 1000,
};
export const MAIN_LEVEL_REQ = 60;

/** Extra stat multiplier per floor above 1 (on top of level scaling). */
export const FLOOR_SCALE_PER_FLOOR = 0.05;
/** Mini-boss multipliers (on top of the floor scale). */
export const MINI_BOSS_HP_MULT = 3;
export const MINI_BOSS_ATK_DEF_MULT = 1.5;
/** Final-boss multipliers (on top of the floor scale). */
export const FINAL_BOSS_HP_MULT = 2;
export const FINAL_BOSS_ATK_DEF_MULT = 1;
/** Crate roll chance on a normal (non-boss) floor clear. */
export const NORMAL_FLOOR_CRATE_CHANCE = 0.1;

export const FINAL_BOSS_TIER: Record<TowerType, Tier> = {
  small: "Epic",
  big: "Legendary",
  main: "Mythic",
};
export const MINI_BOSS_CRATE: Record<TowerType, string> = {
  small: "Golden",
  big: "Golden",
  main: "Crystal",
};
export const FINAL_CRATE: Record<TowerType, string> = {
  small: "Silver",
  big: "Crystal",
  main: "Void",
};
export const NORMAL_FLOOR_CRATE: Record<TowerType, string> = {
  small: "Wooden",
  big: "Iron",
  main: "Silver",
};
export const CLEAR_GEMS: Record<TowerType, number> = { small: 5, big: 15, main: 50 };
export const CLEAR_MATERIALS: Record<TowerType, readonly (readonly [string, number])[]> = {
  small: [["shard", 10]],
  big: [
    ["shard", 25],
    ["crystal", 5],
  ],
  main: [
    ["shard", 50],
    ["crystal", 10],
    ["evolution stone", 1],
  ],
};

export type TowerType = "small" | "big" | "main";

export interface TowerRow {
  towerId: string;
  name: string;
  type: TowerType;
  region: string;
  area: string;
  floors: number;
  hidden: boolean;
  levelReq: number;
}

function toTowerRow(r: Record<string, unknown>): TowerRow {
  return {
    towerId: String(r.tower_id),
    name: String(r.name),
    type: String(r.type) as TowerType,
    region: String(r.region),
    area: String(r.area),
    floors: Number(r.floors),
    hidden: Number(r.hidden) === 1,
    levelReq: Number(r.level_req),
  };
}

// ---------------------------------------------------------------------------
// Seeding — deterministic random placement (same seed = same map)
// ---------------------------------------------------------------------------

const TOWER_ADJECTIVES: readonly string[] = [
  "Ember",
  "Silent",
  "Crimson",
  "Golden",
  "Frost",
  "Shadow",
  "Storm",
  "Ancient",
  "Iron",
  "Misty",
  "Burning",
  "Crystal",
  "Thorn",
  "Howling",
  "Hollow",
  "Verdant",
];
const TOWER_NOUNS: readonly string[] = [
  "Spire",
  "Keep",
  "Citadel",
  "Monolith",
  "Sanctum",
  "Bastion",
  "Watchtower",
  "Tower",
];

/** The full deterministic layout, pure (no DB) — seeding just stores it. */
export function plannedTowers(seed: number = TOWER_SEED): TowerRow[] {
  const rand = mulberry32(seed);
  const combos: string[] = [];
  for (const a of TOWER_ADJECTIVES) for (const n of TOWER_NOUNS) combos.push(`${a} ${n}`);
  // Seeded Fisher–Yates shuffle of the name pool.
  for (let i = combos.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = combos[i]!;
    combos[i] = combos[j]!;
    combos[j] = tmp;
  }
  const areas = WORLD_AREAS;
  const pickArea = () => areas[Math.floor(rand() * areas.length)]!;
  const out: TowerRow[] = [];
  let nameIdx = 0;
  const nextName = () => combos[nameIdx++]!;
  const make = (type: TowerType, floors: number, id: string): TowerRow => {
    const area = pickArea();
    return {
      towerId: id,
      name: nextName(),
      type,
      region: area.regionId,
      area: area.id,
      floors,
      hidden: false,
      levelReq: type === "big" ? area.unlockLevel + 5 : area.unlockLevel,
    };
  };
  for (let i = 0; i < SMALL_TOWER_COUNT; i++) {
    out.push(make("small", SMALL_FLOORS, `tower-${String(i + 1).padStart(2, "0")}`));
  }
  for (let i = 0; i < BIG_TOWER_COUNT; i++) {
    out.push(make("big", BIG_FLOORS, `tower-${String(SMALL_TOWER_COUNT + i + 1).padStart(2, "0")}`));
  }
  const mainArea = pickArea();
  out.push({
    towerId: "tower-main",
    name: nextName(),
    type: "main",
    region: mainArea.regionId,
    area: mainArea.id,
    floors: MAIN_FLOORS,
    hidden: true,
    levelReq: MAIN_LEVEL_REQ,
  });
  return out;
}

/**
 * Seed the towers table on first boot. Idempotent: when the table
 * already has rows, nothing is inserted (a re-seed never moves a
 * tower or wipes progress/cooldowns).
 */
export async function seedTowers(db: SelenaDb, seed: number = TOWER_SEED): Promise<TowerRow[]> {
  const countRow = (await db
    .prepare("SELECT COUNT(*) AS n FROM towers")
    .get()) as { n: number } | undefined;
  if (Number(countRow?.n ?? 0) > 0) {
    return (await db.prepare("SELECT * FROM towers ORDER BY tower_id").all()).map(toTowerRow);
  }
  const planned = plannedTowers(seed);
  for (const t of planned) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO towers (tower_id, name, type, region, area, floors, hidden, level_req) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(t.towerId, t.name, t.type, t.region, t.area, t.floors, t.hidden ? 1 : 0, t.levelReq);
  }
  return planned;
}

/** Cheap lazy-seed guard for command entry points (idempotent). */
export async function ensureTowersSeeded(db: SelenaDb): Promise<void> {
  await seedTowers(db);
}

// ---------------------------------------------------------------------------
// Lookups — the Main tower is never listed and its area never shown
// ---------------------------------------------------------------------------

export async function listVisibleTowers(db: SelenaDb): Promise<TowerRow[]> {
  const rows = (await db
    .prepare("SELECT * FROM towers WHERE hidden = 0 ORDER BY region, name")
    .all()) as Record<string, unknown>[];
  return rows.map(toTowerRow);
}

/**
 * Find a tower by id, exact name, or (visible towers only) a name
 * prefix/substring. The hidden Main tower matches ONLY on its exact
 * id or exact name — a fuzzy guess never reveals it, and a miss never
 * hints it exists.
 */
export async function findTower(db: SelenaDb, query: string): Promise<TowerRow | null> {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const rows = (await db.prepare("SELECT * FROM towers").all()) as Record<string, unknown>[];
  const towers = rows.map(toTowerRow);
  const exact =
    towers.find((t) => t.towerId.toLowerCase() === q) ??
    towers.find((t) => t.name.toLowerCase() === q);
  if (exact) return exact;
  const visible = towers.filter((t) => !t.hidden);
  return (
    visible.find((t) => t.name.toLowerCase().startsWith(q)) ??
    visible.find((t) => t.name.toLowerCase().includes(q)) ??
    null
  );
}

export async function getTower(db: SelenaDb, towerId: string): Promise<TowerRow | null> {
  const row = (await db.prepare("SELECT * FROM towers WHERE tower_id = ?").get(towerId)) as
    | Record<string, unknown>
    | undefined;
  return row ? toTowerRow(row) : null;
}

/** Display area for a tower — the Main tower's area is always "???". */
export function towerAreaLabel(t: TowerRow): string {
  if (t.hidden) return "???";
  return findWorldArea(t.area)?.name ?? t.area;
}

export function towerSizeLabel(t: TowerRow): string {
  return t.type === "small" ? "Small" : t.type === "big" ? "Big" : "Main";
}

// ---------------------------------------------------------------------------
// Discovery — mystery rebuild (2026-11-07, Ronit's spec)
// ---------------------------------------------------------------------------

/**
 * WORKING DEFAULTS (Ron's spec + these numbers — recorded here so
 * Ronit can tune them):
 * - EXPLORE_DISCOVERY_CHANCE = 0.4 (40% per `uwu explore`).
 * - EXPLORE_COOLDOWN_MS = 60_000 (60s between explores).
 * - TRAVEL_ARRIVAL_DISCOVERY_CHANCE = 0.25 (25% on travel arrival).
 * - EXPLORE_CONSOLATION_GOLD_MIN/MAX = 5/15 (gold found when an area
 *   has no undiscovered towers left).
 * Discovery is PER USER (user_tower_discoveries, no guild_id — the
 * world is shared across Discord). The hidden Main tower is NEVER
 * discoverable: discoverTower returns false for it, and the
 * undiscovered-list helpers never include it.
 */
export const EXPLORE_DISCOVERY_CHANCE = 0.4;
export const EXPLORE_COOLDOWN_MS = 60_000;
export const TRAVEL_ARRIVAL_DISCOVERY_CHANCE = 0.25;
export const EXPLORE_CONSOLATION_GOLD_MIN = 5;
export const EXPLORE_CONSOLATION_GOLD_MAX = 15;

/** True if this user has discovered this tower. */
export async function isTowerDiscovered(db: SelenaDb, userId: string, towerId: string): Promise<boolean> {
  const row = (await db
    .prepare("SELECT 1 AS found FROM user_tower_discoveries WHERE user_id = ? AND tower_id = ?")
    .get(userId, towerId)) as { found: number } | undefined;
  return row !== undefined;
}

/** The set of tower ids this user has discovered. */
export async function getDiscoveredTowerIds(db: SelenaDb, userId: string): Promise<Set<string>> {
  const rows = (await db
    .prepare("SELECT tower_id FROM user_tower_discoveries WHERE user_id = ?")
    .all(userId)) as Record<string, unknown>[];
  return new Set(rows.map((r) => String(r.tower_id)));
}

/**
 * Record a discovery; returns true if newly discovered, false if
 * already known. NEVER discovers a hidden (Main) tower — returns
 * false for hidden towers (and for unknown tower ids). Throws on DB
 * error (fail-closed: the caller must not treat a failed insert as a
 * discovery).
 */
export async function discoverTower(
  db: SelenaDb,
  userId: string,
  towerId: string,
  nowMs: number,
): Promise<boolean> {
  const tower = await getTower(db, towerId);
  if (!tower || tower.hidden) return false;
  const res = await db
    .prepare("INSERT OR IGNORE INTO user_tower_discoveries (user_id, tower_id, discovered_at) VALUES (?, ?, ?)")
    .run(userId, towerId, nowMs);
  return res.changes > 0;
}

/**
 * Non-hidden towers in this area the user has NOT discovered
 * (ordered by tower_id). Hidden towers are excluded by the query and
 * can therefore never leak through this list.
 */
export async function listUndiscoveredTowersInArea(
  db: SelenaDb,
  userId: string,
  areaId: string,
): Promise<TowerRow[]> {
  const rows = (await db
    .prepare("SELECT * FROM towers WHERE hidden = 0 AND area = ? ORDER BY tower_id")
    .all(areaId)) as Record<string, unknown>[];
  const discovered = await getDiscoveredTowerIds(db, userId);
  return rows.map(toTowerRow).filter((t) => !discovered.has(t.towerId));
}

/** Ms until the user may explore again (0 = ready). */
export async function exploreCooldownRemainingMs(db: SelenaDb, userId: string, nowMs: number): Promise<number> {
  const row = (await db
    .prepare("SELECT last_explore_at FROM user_explore WHERE user_id = ?")
    .get(userId)) as { last_explore_at: number | null } | undefined;
  if (!row || row.last_explore_at === null) return 0;
  return Math.max(0, Number(row.last_explore_at) + EXPLORE_COOLDOWN_MS - nowMs);
}

/** Stamp the user's explore cooldown at nowMs. */
export async function setExploreCooldown(db: SelenaDb, userId: string, nowMs: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO user_explore (user_id, last_explore_at) VALUES (?, ?) " +
        "ON CONFLICT (user_id) DO UPDATE SET last_explore_at = EXCLUDED.last_explore_at",
    )
    .run(userId, nowMs);
}

/**
 * Travel-arrival discovery: 25% roll; on success pick a random
 * undiscovered non-hidden tower in areaId, record the discovery, and
 * return the full discovery announcement line. Returns null when the
 * roll fails, when no undiscovered tower exists in the area, or when
 * areaId is unknown. Throws on DB error (the caller treats a throw
 * as "no discovery" — arrival still proceeds).
 */
export async function maybeDiscoverOnArrival(
  db: SelenaDb,
  userId: string,
  areaId: string,
  nowMs: number,
  rand: () => number = secureFloat,
): Promise<string | null> {
  if (rand() >= TRAVEL_ARRIVAL_DISCOVERY_CHANCE) return null;
  const area = findWorldArea(areaId);
  if (!area) return null;
  const undiscovered = await listUndiscoveredTowersInArea(db, userId, areaId);
  if (undiscovered.length === 0) return null;
  const tower = undiscovered[Math.floor(rand() * undiscovered.length)]!;
  const discovered = await discoverTower(db, userId, tower.towerId, nowMs);
  if (!discovered) return null;
  return (
    `🔍 On the way in, you stumbled on a tower: 🗼 ${tower.name} — a ${towerSizeLabel(tower)} tower, ` +
    `${tower.floors} floors, in ${area.name} · enter at level ${tower.levelReq}+. ` +
    `See it with \`uwu tower ${tower.name}\`.`
  );
}

// ---------------------------------------------------------------------------
// Cooldowns (tower-wide, §4.5)
// ---------------------------------------------------------------------------

export interface TowerCooldown {
  towerId: string;
  clearedAt: number;
  resetsAt: number;
}

export async function getTowerCooldown(db: SelenaDb, towerId: string): Promise<TowerCooldown | null> {
  const row = (await db
    .prepare("SELECT * FROM tower_cooldowns WHERE tower_id = ?")
    .get(towerId)) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    towerId: String(row.tower_id),
    clearedAt: Number(row.cleared_at),
    resetsAt: Number(row.resets_at),
  };
}

/** Ms until a tower's clear cooldown ends (0 = ready). */
export async function towerCooldownRemainingMs(db: SelenaDb, towerId: string, nowMs: number): Promise<number> {
  const cd = await getTowerCooldown(db, towerId);
  if (!cd) return 0;
  return Math.max(0, cd.resetsAt - nowMs);
}

export async function setTowerClearCooldown(
  db: SelenaDb,
  towerId: string,
  type: TowerType,
  nowMs: number,
): Promise<TowerCooldown> {
  const cd: TowerCooldown = { towerId, clearedAt: nowMs, resetsAt: nowMs + CLEAR_COOLDOWN_MS[type] };
  await db
    .prepare(
      "INSERT INTO tower_cooldowns (tower_id, cleared_at, resets_at) VALUES (?, ?, ?) " +
        "ON CONFLICT (tower_id) DO UPDATE SET cleared_at = EXCLUDED.cleared_at, resets_at = EXCLUDED.resets_at",
    )
    .run(towerId, cd.clearedAt, cd.resetsAt);
  return cd;
}

export function formatCooldown(ms: number): string {
  const totalMin = Math.ceil(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ---------------------------------------------------------------------------
// Progress + parties
// ---------------------------------------------------------------------------

export interface TowerProgress {
  userId: string;
  towerId: string;
  floorReached: number;
  checkpointAt: number | null;
  partyId: string | null;
}

export async function getProgress(db: SelenaDb, userId: string, towerId: string): Promise<TowerProgress | null> {
  const row = (await db
    .prepare("SELECT * FROM tower_progress WHERE user_id = ? AND tower_id = ?")
    .get(userId, towerId)) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    userId: String(row.user_id),
    towerId: String(row.tower_id),
    floorReached: Number(row.floor_reached),
    checkpointAt: row.checkpoint_at === null ? null : Number(row.checkpoint_at),
    partyId: row.party_id === null ? null : String(row.party_id),
  };
}

export async function setProgress(
  db: SelenaDb,
  userId: string,
  towerId: string,
  floorReached: number,
  partyId: string | null,
  nowMs: number,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO tower_progress (user_id, tower_id, floor_reached, checkpoint_at, party_id) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT (user_id, tower_id) DO UPDATE SET floor_reached = EXCLUDED.floor_reached, " +
        "checkpoint_at = EXCLUDED.checkpoint_at, party_id = EXCLUDED.party_id",
    )
    .run(userId, towerId, floorReached, nowMs, partyId);
}

export interface TowerParty {
  partyId: string;
  towerId: string;
  leaderId: string;
  members: string[];
  createdAt: number;
}

function toPartyRow(r: Record<string, unknown>): TowerParty {
  let members: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(r.members ?? "[]"));
    if (Array.isArray(parsed)) members = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    members = [];
  }
  return {
    partyId: String(r.party_id),
    towerId: String(r.tower_id),
    leaderId: String(r.leader_id),
    members,
    createdAt: Number(r.created_at),
  };
}

export async function getParty(db: SelenaDb, partyId: string): Promise<TowerParty | null> {
  const row = (await db
    .prepare("SELECT * FROM tower_parties WHERE party_id = ?")
    .get(partyId)) as Record<string, unknown> | undefined;
  return row ? toPartyRow(row) : null;
}

/** The party a user belongs to for a tower (via their progress row). */
export async function getUserParty(db: SelenaDb, userId: string, towerId: string): Promise<TowerParty | null> {
  const progress = await getProgress(db, userId, towerId);
  if (!progress?.partyId) return null;
  const party = await getParty(db, progress.partyId);
  if (!party || party.towerId !== towerId) return null;
  return party;
}

/** Most recently created party for a tower that has not cleared it yet. */
export async function getActivePartyForTower(db: SelenaDb, towerId: string): Promise<TowerParty | null> {
  const tower = await getTower(db, towerId);
  if (!tower) return null;
  const rows = (await db
    .prepare("SELECT * FROM tower_parties WHERE tower_id = ? ORDER BY created_at DESC")
    .all(towerId)) as Record<string, unknown>[];
  for (const row of rows) {
    const party = toPartyRow(row);
    const floors = await Promise.all(
      party.members.map((m) => getProgress(db, m, towerId)),
    );
    const maxFloor = Math.max(0, ...floors.map((p) => p?.floorReached ?? 0));
    if (maxFloor < tower.floors) return party;
  }
  return null;
}

async function saveParty(db: SelenaDb, party: TowerParty): Promise<void> {
  await db
    .prepare(
      "INSERT INTO tower_parties (party_id, tower_id, leader_id, members, created_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT (party_id) DO UPDATE SET leader_id = EXCLUDED.leader_id, members = EXCLUDED.members",
    )
    .run(party.partyId, party.towerId, party.leaderId, JSON.stringify(party.members), party.createdAt);
}

/**
 * Enter (or resume) a tower. Party rules, in order: (1) if the user
 * already belongs to a party for this tower, they resume it; (2) else
 * if a run is already active on this tower they join the most recent
 * active party; (3) else they start a new party as its leader.
 * A fully-cleared tower whose cooldown has expired resets the
 * player's checkpoint to floor 0 for a fresh run.
 */
export async function enterTower(
  db: SelenaDb,
  input: { userId: string; tower: TowerRow; playerLevel: number; nowMs: number },
): Promise<{ party: TowerParty; floorReached: number; joinedExisting: boolean; isNewParty: boolean }> {
  const { userId, tower, playerLevel, nowMs } = input;
  if (playerLevel < tower.levelReq) {
    throw new Error(
      `You need to be level ${tower.levelReq} to enter ${tower.hidden ? "this tower" : tower.name} — you're level ${playerLevel}.`,
    );
  }
  const remaining = await towerCooldownRemainingMs(db, tower.towerId, nowMs);
  if (remaining > 0) {
    throw new Error(
      `${tower.hidden ? "This tower" : tower.name} was cleared recently — it resets in ${formatCooldown(remaining)}.`,
    );
  }
  let progress = await getProgress(db, userId, tower.towerId);
  let floorReached = progress?.floorReached ?? 0;
  if (floorReached >= tower.floors) {
    // Cleared it before and the cooldown has since expired: fresh run.
    floorReached = 0;
  }
  const ownParty = await getUserParty(db, userId, tower.towerId);
  if (ownParty) {
    const active = await getActivePartyForTower(db, tower.towerId);
    if (active && active.partyId === ownParty.partyId) {
      await setProgress(db, userId, tower.towerId, floorReached, ownParty.partyId, nowMs);
      return { party: ownParty, floorReached, joinedExisting: false, isNewParty: false };
    }
    // Own party already cleared (or went stale): fall through to join/start fresh.
  }
  const active = await getActivePartyForTower(db, tower.towerId);
  if (active && !active.members.includes(userId)) {
    active.members.push(userId);
    await saveParty(db, active);
    await setProgress(db, userId, tower.towerId, floorReached, active.partyId, nowMs);
    return { party: active, floorReached, joinedExisting: true, isNewParty: false };
  }
  if (active && active.members.includes(userId)) {
    await setProgress(db, userId, tower.towerId, floorReached, active.partyId, nowMs);
    return { party: active, floorReached, joinedExisting: false, isNewParty: false };
  }
  const party: TowerParty = {
    partyId: `party-${tower.towerId}-${userId}-${nowMs}`,
    towerId: tower.towerId,
    leaderId: userId,
    members: [userId],
    createdAt: nowMs,
  };
  await saveParty(db, party);
  await setProgress(db, userId, tower.towerId, floorReached, party.partyId, nowMs);
  return { party, floorReached, joinedExisting: false, isNewParty: true };
}

/** Leave a tower run: checkpoint stays saved, the player drops out of the party. */
export async function leaveTower(
  db: SelenaDb,
  input: { userId: string; towerId: string; nowMs: number },
): Promise<{ left: boolean; floorReached: number }> {
  const progress = await getProgress(db, input.userId, input.towerId);
  if (!progress) return { left: false, floorReached: 0 };
  const party = progress.partyId ? await getParty(db, progress.partyId) : null;
  if (party) {
    party.members = party.members.filter((m) => m !== input.userId);
    if (party.members.length === 0) {
      await db.prepare("DELETE FROM tower_parties WHERE party_id = ?").run(party.partyId);
    } else {
      if (party.leaderId === input.userId) party.leaderId = party.members[0]!;
      await saveParty(db, party);
    }
  }
  await setProgress(db, input.userId, input.towerId, progress.floorReached, null, input.nowMs);
  return { left: true, floorReached: progress.floorReached };
}

// ---------------------------------------------------------------------------
// Floors — pure scaling math + team construction
// ---------------------------------------------------------------------------

export function isMiniBossFloor(floor: number, floors: number): boolean {
  return floor % MINI_BOSS_EVERY === 0 && floor !== floors;
}

export function isFinalFloor(floor: number, floors: number): boolean {
  return floor === floors;
}

/** Stat multiplier for a normal floor's monsters (before boss mults). */
export function floorScale(floor: number): number {
  return 1 + FLOOR_SCALE_PER_FLOOR * Math.max(0, floor - 1);
}

/** Wild level of a tower floor's monsters (area unlock + floor, cap 100). */
export function floorMonsterLevel(tower: TowerRow, floor: number): number {
  const area = findWorldArea(tower.area);
  const base = area?.unlockLevel ?? 0;
  return Math.min(100, base + floor);
}

/** One tier above a tier (cap UwU) — mini-bosses are a tier up (§4.4). */
export function tierAbove(tier: Tier): Tier {
  const i = TIER_INDEX[tier];
  return TIER_ORDER[Math.min(TIER_ORDER.length - 1, i + 1)]!;
}

function scaleMonster(m: Monster, hpMult: number, atkDefMult: number): Monster {
  return {
    ...m,
    hp: Math.max(1, Math.round(m.hp * hpMult)),
    atk: Math.max(1, Math.round(m.atk * atkDefMult)),
    def: Math.max(1, Math.round(m.def * atkDefMult)),
  };
}

export interface FloorTeam {
  team: TeamMemberInput[];
  kind: "normal" | "mini-boss" | "final-boss";
  level: number;
  bossName: string | null;
}

/**
 * The monsters guarding a floor. Normal floors: 3 wild monsters from
 * the tower's area pool. Boss floors: a single boss monster (mini-boss
 * one tier above the area's top tier; final boss the fixed tier for
 * the tower size). Bosses are never catchable — the climb code never
 * awards them, only drops.
 */
export function floorTeam(tower: TowerRow, floor: number, rand: () => number = secureFloat): FloorTeam {
  const level = floorMonsterLevel(tower, floor);
  const scale = floorScale(floor);
  const area = findWorldArea(tower.area);
  if (isFinalFloor(floor, tower.floors)) {
    const boss = scaleMonster(
      drawMonsterOfTier(FINAL_BOSS_TIER[tower.type], rand),
      scale * FINAL_BOSS_HP_MULT,
      scale * FINAL_BOSS_ATK_DEF_MULT,
    );
    return { team: [{ monster: boss, level }], kind: "final-boss", level, bossName: boss.name };
  }
  if (isMiniBossFloor(floor, tower.floors) && area) {
    const topTier = area.tiers.reduce((a, b) => (TIER_INDEX[a] >= TIER_INDEX[b] ? a : b));
    const bossTier = tierAbove(topTier);
    const boss = scaleMonster(
      drawMonsterFromWorldArea(area, bossTier, rand),
      scale * MINI_BOSS_HP_MULT,
      scale * MINI_BOSS_ATK_DEF_MULT,
    );
    return { team: [{ monster: boss, level }], kind: "mini-boss", level, bossName: boss.name };
  }
  if (!area) {
    // Unknown area (shouldn't happen — seeded from WORLD_AREAS):
    // fall back to a plain roster draw so the floor is still fightable.
    const team = [0, 1, 2].map(() => ({
      monster: scaleMonster(drawMonsterOfTier("Common", rand), scale, scale),
      level,
    }));
    return { team, kind: "normal", level, bossName: null };
  }
  const team = [0, 1, 2].map(() => ({
    monster: scaleMonster(encounterMonsterInWorldArea(area, rand), scale, scale),
    level,
  }));
  return { team, kind: "normal", level, bossName: null };
}

// ---------------------------------------------------------------------------
// Rewards — pure amounts + DB grants (fail-closed by the caller)
// ---------------------------------------------------------------------------

export function floorGold(tower: TowerRow, floor: number): number {
  const base =
    tower.type === "small" ? 20 + floor * 10 : tower.type === "big" ? 30 + floor * 15 : 50 + floor * 25;
  return isFinalFloor(floor, tower.floors) ? base * 2 : base;
}

export function floorXp(floor: number): number {
  return towerFloorXp(floor);
}

/** Crate granted for clearing this floor (null = none this floor). */
export function crateForFloor(tower: TowerRow, floor: number, rand: () => number = secureFloat): string | null {
  if (isFinalFloor(floor, tower.floors)) return FINAL_CRATE[tower.type];
  if (isMiniBossFloor(floor, tower.floors)) return MINI_BOSS_CRATE[tower.type];
  return rand() < NORMAL_FLOOR_CRATE_CHANCE ? NORMAL_FLOOR_CRATE[tower.type] : null;
}

export interface FloorReveal {
  floor: number;
  revealed: boolean;
  kind: "normal" | "mini-boss" | "final-boss";
  gold: number;
  xp: number;
  crateTier: string | null;
  crateChance: boolean;
}

/**
 * Pure helper — which floors of a tower are revealed to a player who
 * has cleared up to floorReached. Floors 1..floorReached+1 are
 * revealed (kind/gold/xp/crate from the floorGold/floorXp/crate
 * logic — for normal floors crateTier is null and crateChance is
 * true, meaning "10% Wooden/Iron/Silver"; for boss floors crateTier
 * is the guaranteed crate and crateChance is false). Floors beyond
 * floorReached+1 have revealed=false — kind/gold/xp are still filled
 * in for convenience but MUST be treated as hidden by callers. The
 * final floor is therefore only revealed once floorReached =
 * floors-1.
 */
export function floorReveal(tower: TowerRow, floorReached: number): FloorReveal[] {
  const out: FloorReveal[] = [];
  for (let floor = 1; floor <= tower.floors; floor++) {
    const kind = isFinalFloor(floor, tower.floors)
      ? "final-boss"
      : isMiniBossFloor(floor, tower.floors)
        ? "mini-boss"
        : "normal";
    const crateTier =
      kind === "final-boss"
        ? FINAL_CRATE[tower.type]
        : kind === "mini-boss"
          ? MINI_BOSS_CRATE[tower.type]
          : null;
    out.push({
      floor,
      revealed: floor <= floorReached + 1,
      kind,
      gold: floorGold(tower, floor),
      xp: floorXp(floor),
      crateTier,
      crateChance: kind === "normal",
    });
  }
  return out;
}

export async function grantCrate(db: SelenaDb, userId: string, crateTier: string, qty = 1): Promise<void> {
  await db
    .prepare(
      "INSERT INTO user_crates (user_id, crate_tier, qty) VALUES (?, ?, ?) " +
        "ON CONFLICT (user_id, crate_tier) DO UPDATE SET qty = user_crates.qty + EXCLUDED.qty",
    )
    .run(userId, crateTier, qty);
}

export async function grantMaterial(db: SelenaDb, userId: string, material: string, qty: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO user_materials (user_id, material, qty) VALUES (?, ?, ?) " +
        "ON CONFLICT (user_id, material) DO UPDATE SET qty = user_materials.qty + EXCLUDED.qty",
    )
    .run(userId, material, qty);
}

export async function grantGems(db: SelenaDb, userId: string, amount: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO user_wallet (user_id, gems) VALUES (?, ?) " +
        "ON CONFLICT (user_id) DO UPDATE SET gems = user_wallet.gems + EXCLUDED.gems",
    )
    .run(userId, amount);
}

// ---------------------------------------------------------------------------
// Climb — one floor, fought through the battle engine
// ---------------------------------------------------------------------------

export interface ClimbResult {
  outcome: "win" | "loss" | "draw";
  tower: TowerRow;
  floor: number;
  kind: "normal" | "mini-boss" | "final-boss";
  bossName: string | null;
  battle: BattleResult;
  gold: number;
  xp: number;
  crateTier: string | null;
  cleared: boolean;
  cooldownUntilMs: number | null;
  monsterLevelUps: string[];
  text: string;
}

async function playerLevel(db: SelenaDb, guildId: string, userId: string): Promise<number> {
  const row = (await db
    .prepare("SELECT level FROM users WHERE guild_id = ? AND user_id = ?")
    .get(guildId, userId)) as { level: number } | undefined;
  return Number(row?.level ?? 0);
}

/**
 * Fight the next floor of a tower the user has entered. Returns the
 * full result (structured + plain-text `text` for the reply). Throws
 * a user-facing Error when the climb can't start (not entered, no
 * monsters, already cleared); a DB failure during settle throws too
 * — the caller replies with the error and NO progress is saved.
 */
export async function climbFloor(
  db: SelenaDb,
  input: {
    guildId: string;
    userId: string;
    username: string;
    towerId: string;
    nowMs: number;
    rand?: () => number;
  },
): Promise<ClimbResult> {
  const rand = input.rand ?? secureFloat;
  const tower = await getTower(db, input.towerId);
  if (!tower) throw new Error("That tower doesn't exist.");
  const party = await getUserParty(db, input.userId, input.towerId);
  if (!party) {
    throw new Error(`You're not inside ${tower.hidden ? "this tower" : tower.name} — enter it first with \`uwu tower enter ${tower.name}\`.`);
  }
  const progress = await getProgress(db, input.userId, input.towerId);
  const floor = (progress?.floorReached ?? 0) + 1;
  if (floor > tower.floors) {
    throw new Error(
      `You've already cleared ${tower.hidden ? "this tower" : tower.name} — enter it again once its cooldown ends for a fresh run.`,
    );
  }
  const remaining = await towerCooldownRemainingMs(db, tower.towerId, input.nowMs);
  if (remaining > 0) {
    throw new Error(
      `${tower.hidden ? "This tower" : tower.name} is on cooldown — it resets in ${formatCooldown(remaining)}.`,
    );
  }

  // Combined party team: everyone's top-3 pooled, strongest 3 fight.
  const memberTeams = await Promise.all(party.members.map((m) => getBattleTeam(db, input.guildId, m)));
  const combined = pickTeam(memberTeams.flat());
  if (combined.length === 0) {
    throw new Error("Nobody in your party has monsters — hunt or roll for some first, then climb!");
  }
  const weapon = await getEquippedWeapon(db, input.guildId, party.leaderId);
  const floorDef = floorTeam(tower, floor, rand);
  const result = simulateBattle(
    {
      ownerId: input.userId,
      ownerName: "Your party",
      team: combined,
      weaponAtk: weapon?.atk,
      weaponEffects: weapon?.effects,
    },
    {
      ownerId: "tower",
      ownerName: tower.hidden ? "The hidden tower" : tower.name,
      team: floorDef.team,
    },
    rand,
  );

  const kindLabel =
    floorDef.kind === "final-boss"
      ? `👑 FINAL BOSS — ${floorDef.bossName}`
      : floorDef.kind === "mini-boss"
        ? `💪 Mini-boss — ${floorDef.bossName}`
        : `Floor ${floor}`;
  const header = `🗼 ${tower.hidden ? "The hidden tower" : tower.name} — ${kindLabel} (Lv ${floorDef.level} monsters)`;

  if (result.winner !== "A") {
    const outcome = result.winner === "B" ? "loss" : "draw";
    return {
      outcome,
      tower,
      floor,
      kind: floorDef.kind,
      bossName: floorDef.bossName,
      battle: result,
      gold: 0,
      xp: 0,
      crateTier: null,
      cleared: false,
      cooldownUntilMs: null,
      monsterLevelUps: [],
      text:
        `${header}\n` +
        `💀 Your party was defeated on floor ${floor} after ${result.roundsFought} rounds. ` +
        `Your checkpoint is saved at floor ${floor - 1} — heal up, bring friends, and try again with \`uwu tower climb\`.`,
    };
  }

  // WIN — settle atomically: progress + gold + XP + monster XP +
  // crate + (final floor) clear bonus + tower-wide cooldown. Any DB
  // error rolls the whole settle back (fail closed).
  const gold = floorGold(tower, floor);
  const xp = floorXp(floor);
  const crateTier = crateForFloor(tower, floor, rand);
  const cleared = isFinalFloor(floor, tower.floors);
  const cooldownUntilMs = cleared ? input.nowMs + CLEAR_COOLDOWN_MS[tower.type] : null;

  const settled = await db.transaction(async (tx) => {
    const levelUps: string[] = [];
    // Advance the climber and every entered party member.
    await setProgress(tx, input.userId, tower.towerId, floor, party.partyId, input.nowMs);
    for (const memberId of party.members) {
      if (memberId === input.userId) continue;
      const p = await getProgress(tx, memberId, tower.towerId);
      if (p && p.floorReached < floor) {
        await setProgress(tx, memberId, tower.towerId, floor, party.partyId, input.nowMs);
      }
    }
    const awarded = await awardBattleXp(tx, input.guildId, input.userId, xp);
    for (const m of combined) {
      const res = await grantMonsterXp(tx, input.guildId, input.userId, m.monster.id, xp);
      if (res?.leveledUp) levelUps.push(`🌟 ${m.monster.name} reached Lv ${res.newLevel}!`);
    }
    await addPoints(tx, input.guildId, input.userId, gold, `tower floor ${floor}`);
    // Quest progress (best-effort — caught, so it never fails the settle).
    try {
      await recordQuestProgress(tx, input.userId, ["tower_floor"]);
    } catch (e) {
      console.error("uwu: quest progress failed:", e instanceof Error ? e.message : e);
    }
    if (crateTier) await grantCrate(tx, input.userId, crateTier);
    if (cleared) {
      for (const [material, qty] of CLEAR_MATERIALS[tower.type]) {
        await grantMaterial(tx, input.userId, material, qty);
      }
      await grantGems(tx, input.userId, CLEAR_GEMS[tower.type]);
      await tx
        .prepare("INSERT OR IGNORE INTO user_badges (user_id, badge, awarded_at) VALUES (?, ?, ?)")
        .run(input.userId, `tower-clear-${tower.towerId}`, input.nowMs);
      await setTowerClearCooldown(tx, tower.towerId, tower.type, input.nowMs);
    }
    return { leveledUp: awarded.leveledUp, levelUps };
  });

  const lines = [
    `${header}`,
    `🏆 Your party cleared floor ${floor} in ${result.roundsFought} rounds!` +
      (result.finalBlow ? ` ${result.finalBlow.attackerName} landed the final blow on ${result.finalBlow.targetName}.` : ""),
    `+${gold} gold · +${xp} XP${settled.leveledUp ? " · you leveled up!" : ""}`,
  ];
  if (crateTier) lines.push(`📦 You found a ${crateTier} Crate! Open it with \`uwu open ${crateTier}\`.`);
  if (settled.levelUps.length > 0) lines.push(...settled.levelUps);
  if (cleared) {
    const mats = CLEAR_MATERIALS[tower.type].map(([m, q]) => `${q} ${m}`).join(", ");
    lines.push(
      `🎉 TOWER CLEARED! ${tower.hidden ? "The hidden tower" : tower.name} is yours — ` +
        `+${CLEAR_GEMS[tower.type]} gems, materials (${mats}), and a tower badge. ` +
        `This tower is now on cooldown for everyone — it resets in ${formatCooldown(CLEAR_COOLDOWN_MS[tower.type])}.`,
    );
  } else {
    lines.push(`Checkpoint saved at floor ${floor} — climb on with \`uwu tower climb\` or rest with \`uwu tower leave\`.`);
  }
  return {
    outcome: "win",
    tower,
    floor,
    kind: floorDef.kind,
    bossName: floorDef.bossName,
    battle: result,
    gold,
    xp,
    crateTier,
    cleared,
    cooldownUntilMs,
    monsterLevelUps: settled.levelUps,
    text: lines.join("\n"),
  };
}

/** Player level helper for the command layer (enter-gate). */
export async function getPlayerLevel(db: SelenaDb, guildId: string, userId: string): Promise<number> {
  return playerLevel(db, guildId, userId);
}
