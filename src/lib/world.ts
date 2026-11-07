import { AREAS, type Tier } from "./hunt.js";

/**
 * World map catalogue (Phase 2, design §2.1 + §6.1).
 *
 * One shared world across all of Discord. Region 1 is the Phase 1
 * world (the 4 areas from hunt.ts AREAS, reused verbatim — no duplicate
 * data). Regions 2–5 are the working defaults from the design doc.
 *
 * Each area has map coordinates in km; travel time is 5 minutes per km
 * (Ron's rule: 2 km = 10 min). Distances are Euclidean between
 * coordinates, rounded to 1 decimal; travel minutes are rounded, min 5.
 *
 * Encounter pools for Regions 2–5: the roster monsters are assigned
 * to Phase 1 area codes (M/W/P/H) only, so deeper regions draw from
 * the whole roster filtered by TIER (their `tiers` list), not by area
 * code. Mythic/UwU encounters stay in the deepest areas (Hollow +
 * Region 5), per the design rule.
 */

export interface WorldArea {
  id: string;
  name: string;
  regionId: string;
  unlockLevel: number;
  /** Tiers that can be encountered here. */
  tiers: readonly Tier[];
  /** Encounter weight per tier (renormalised over tiers present). */
  encounterWeights: Partial<Record<Tier, number>>;
  /** Wild monster level range (design §6.1). */
  wildLevels: readonly [number, number];
  /** Map position in km. */
  x: number;
  y: number;
  blurb: string;
}

export interface WorldRegion {
  id: string;
  name: string;
  levelRange: readonly [number, number];
  feel: string;
  areas: readonly WorldArea[];
}

const R1_WILD: Record<string, readonly [number, number]> = {
  meadow: [1, 5],
  woods: [5, 15],
  peaks: [10, 25],
  hollow: [15, 40],
};

const R1_COORDS: Record<string, readonly [number, number]> = {
  meadow: [0, 0],
  woods: [2, 1],
  peaks: [4, 0],
  hollow: [6, 2],
};

function region1Area(id: string): WorldArea {
  const a = AREAS.find((x) => x.id === id)!;
  const [x, y] = R1_COORDS[id]!;
  return {
    id: a.id,
    name: a.name,
    regionId: "starting-lands",
    unlockLevel: a.unlockLevel,
    tiers: a.tiers,
    encounterWeights: a.encounterWeights,
    wildLevels: R1_WILD[id]!,
    x,
    y,
    blurb: a.blurb,
  };
}

export const REGIONS: readonly WorldRegion[] = [
  {
    id: "starting-lands",
    name: "Starting Lands",
    levelRange: [1, 15],
    feel: "The Phase 1 world; every new player starts here",
    areas: ["meadow", "woods", "peaks", "hollow"].map(region1Area),
  },
  {
    id: "shifting-dunes",
    name: "The Shifting Dunes",
    levelRange: [15, 30],
    feel: "Desert; Fire + Earth monsters",
    areas: [
      { id: "sunken-oasis", name: "Sunken Oasis", regionId: "shifting-dunes", unlockLevel: 15, tiers: ["Uncommon", "Rare", "Epic"] as const, encounterWeights: { Uncommon: 30, Rare: 50, Epic: 20 }, wildLevels: [15, 22] as const, x: 9, y: 0, blurb: "A hidden spring in the sand" },
      { id: "glass-dunes", name: "Glass Dunes", regionId: "shifting-dunes", unlockLevel: 18, tiers: ["Rare", "Epic", "Legendary"] as const, encounterWeights: { Rare: 45, Epic: 40, Legendary: 15 }, wildLevels: [20, 26] as const, x: 11, y: 1, blurb: "Sand turned to glass by old heat" },
      { id: "mirage-town", name: "Mirage Town", regionId: "shifting-dunes", unlockLevel: 20, tiers: ["Rare", "Epic", "Legendary"] as const, encounterWeights: { Rare: 35, Epic: 45, Legendary: 20 }, wildLevels: [24, 30] as const, x: 13, y: 0, blurb: "A town that may not be there" },
    ],
  },
  {
    id: "frozen-reaches",
    name: "The Frozen Reaches",
    levelRange: [30, 45],
    feel: "Ice; Ice + Water monsters",
    areas: [
      { id: "frostbite-pass", name: "Frostbite Pass", regionId: "frozen-reaches", unlockLevel: 30, tiers: ["Rare", "Epic", "Legendary"] as const, encounterWeights: { Rare: 40, Epic: 45, Legendary: 15 }, wildLevels: [30, 36] as const, x: 9, y: 4, blurb: "A wind that bites through fur" },
      { id: "glacial-caverns", name: "Glacial Caverns", regionId: "frozen-reaches", unlockLevel: 33, tiers: ["Epic", "Legendary"] as const, encounterWeights: { Epic: 65, Legendary: 35 }, wildLevels: [34, 40] as const, x: 11, y: 5, blurb: "Blue ice, deep and old" },
      { id: "aurora-fields", name: "Aurora Fields", regionId: "frozen-reaches", unlockLevel: 35, tiers: ["Epic", "Legendary", "Mythic"] as const, encounterWeights: { Epic: 55, Legendary: 35, Mythic: 10 }, wildLevels: [38, 45] as const, x: 13, y: 4, blurb: "Lights dance over the snow" },
    ],
  },
  {
    id: "shadowlands",
    name: "The Shadowlands",
    levelRange: [45, 60],
    feel: "Dark; Shadow + Spirit monsters",
    areas: [
      { id: "gloomwood", name: "Gloomwood", regionId: "shadowlands", unlockLevel: 45, tiers: ["Epic", "Legendary"] as const, encounterWeights: { Epic: 60, Legendary: 40 }, wildLevels: [45, 51] as const, x: 4, y: 6, blurb: "Trees that whisper back" },
      { id: "weeping-marsh", name: "The Weeping Marsh", regionId: "shadowlands", unlockLevel: 48, tiers: ["Epic", "Legendary", "Mythic"] as const, encounterWeights: { Epic: 50, Legendary: 40, Mythic: 10 }, wildLevels: [49, 55] as const, x: 6, y: 7, blurb: "The water remembers everything" },
      { id: "nightfall-spire", name: "Nightfall Spire", regionId: "shadowlands", unlockLevel: 50, tiers: ["Legendary", "Mythic"] as const, encounterWeights: { Legendary: 75, Mythic: 25 }, wildLevels: [54, 60] as const, x: 8, y: 6, blurb: "A tower with no door, only dark" },
    ],
  },
  {
    id: "sky-isles",
    name: "The Sky Isles",
    levelRange: [60, 100],
    feel: "Endgame; highest-tier monsters",
    areas: [
      { id: "cloud-terraces", name: "Cloud Terraces", regionId: "sky-isles", unlockLevel: 60, tiers: ["Legendary", "Mythic"] as const, encounterWeights: { Legendary: 70, Mythic: 30 }, wildLevels: [60, 70] as const, x: 12, y: 8, blurb: "Fields floating on cloud" },
      { id: "storm-citadel", name: "Storm Citadel", regionId: "sky-isles", unlockLevel: 65, tiers: ["Legendary", "Mythic", "UwU"] as const, encounterWeights: { Legendary: 60, Mythic: 35, UwU: 5 }, wildLevels: [68, 85] as const, x: 14, y: 9, blurb: "Lightning never stops here" },
      { id: "void-rift", name: "The Void Rift", regionId: "sky-isles", unlockLevel: 70, tiers: ["Mythic", "UwU"] as const, encounterWeights: { Mythic: 90, UwU: 10 }, wildLevels: [80, 100] as const, x: 16, y: 8, blurb: "The end of the map — and the start of it" },
    ],
  },
];

export const WORLD_AREAS: readonly WorldArea[] = REGIONS.flatMap((r) => r.areas);

export function findWorldArea(input: string): WorldArea | undefined {
  const q = input.trim().toLowerCase();
  if (!q) return undefined;
  return (
    WORLD_AREAS.find((a) => a.id === q) ??
    WORLD_AREAS.find((a) => a.name.toLowerCase() === q) ??
    WORLD_AREAS.find((a) => a.name.toLowerCase().startsWith(q))
  );
}

/** Distance between two areas in km (Euclidean, 1 decimal). */
export function distanceKm(a: WorldArea, b: WorldArea): number {
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  return Math.round(d * 10) / 10;
}

/**
 * Travel time in minutes: 5 minutes per km (Ron's rule — 2 km = 10 min).
 * Minimum 5 minutes (even the shortest hop takes a little while).
 */
export function travelMinutes(a: WorldArea, b: WorldArea): number {
  return Math.max(5, Math.round(distanceKm(a, b) * 5));
}

/** A random wild level for an area (inclusive range). */
export function wildLevelForArea(area: WorldArea, rand: () => number = Math.random): number {
  const [lo, hi] = area.wildLevels;
  return lo + Math.floor(rand() * (hi - lo + 1));
}
