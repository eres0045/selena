import type { Monster, Tier } from "./hunt.js";

/**
 * Monster levels + fusion (Phase 2, design §6).
 *
 * Phase 1 roster stats are LEVEL-1 base stats. A monster's effective
 * stats scale +2% per level above 1 (multiplicative), and fusion adds
 * +10% per fuse step (+20% on the +5 step). Tier still dominates:
 * a max-level Common is roughly a level-1 Rare, never an Epic.
 */

export const MONSTER_LEVEL_CAP = 100;

/** XP a monster needs to go from `level` to `level + 1` (design §6.3). */
export function monsterXpForLevel(level: number): number {
  return 100 * level;
}

/** Fusion stat multiplier for a fuse level 0–6 (step 5 gives +20%). */
export function fuseMultiplier(fuseLevel: number): number {
  let mult = 1;
  for (let step = 1; step <= Math.max(0, Math.min(6, fuseLevel)); step++) {
    mult *= step === 5 ? 1.2 : 1.1;
  }
  return mult;
}

/** Effective HP/ATK/DEF of a monster at a level + fuse level. */
export function leveledStats(
  m: Monster,
  level: number,
  fuseLevel = 0,
): { hp: number; atk: number; def: number } {
  const lvl = Math.max(1, Math.min(MONSTER_LEVEL_CAP, Math.floor(level)));
  const scale = 1 + 0.02 * (lvl - 1);
  const fuse = fuseMultiplier(fuseLevel);
  return {
    hp: Math.max(1, Math.round(m.hp * scale * fuse)),
    atk: Math.max(1, Math.round(m.atk * scale * fuse)),
    def: Math.max(1, Math.round(m.def * scale * fuse)),
  };
}

/** Power budget (HP + 4×ATK + 3×DEF) of a leveled/fused monster. */
export function powerBudgetOf(m: Monster, level: number, fuseLevel = 0): number {
  const s = leveledStats(m, level, fuseLevel);
  return s.hp + 4 * s.atk + 3 * s.def;
}

/** Gold cost to fuse one step, by tier (design §6.4, working default). */
export const FUSION_COSTS: Record<Tier, number> = {
  Common: 100,
  Uncommon: 250,
  Rare: 500,
  Epic: 1000,
  Legendary: 2500,
  Mythic: 5000,
  UwU: 25000,
};

/** What each fuse step unlocks (design §6.4). */
export const FUSE_LADDER: readonly string[] = [
  "+1: unlocks one extra effect slot",
  "+2: signature move trigger chance +10pp",
  "+3: gains a second signature effect",
  "+4: signature move trigger chance +10pp again",
  "+5: +20% stats on this fuse step",
  "+6: gains a third signature effect",
];

/**
 * Hunt rewards (design §6.3): random, scaling with the caught
 * monster's level. XP = 10 + level×2 (±20%); coins = 5 + level×3 (±20%).
 * `rand` is injectable so tests can drive exact outcomes.
 */
export function huntReward(monsterLevel: number, rand: () => number = Math.random): { xp: number; coins: number } {
  const jitter = () => 0.8 + rand() * 0.4;
  return {
    xp: Math.max(1, Math.round((10 + monsterLevel * 2) * jitter())),
    coins: Math.max(1, Math.round((5 + monsterLevel * 3) * jitter())),
  };
}

/** Battle-win XP: 40 + average enemy team level × 2 (design §6.3). */
export function battleWinXp(avgEnemyLevel: number): number {
  return 40 + Math.round(avgEnemyLevel) * 2;
}

/** Tower floor-clear XP: 50 + floor × 5 (design §6.3). */
export function towerFloorXp(floor: number): number {
  return 50 + floor * 5;
}
