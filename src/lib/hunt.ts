import { secureFloat, weightedPick } from "./rng.js";
import { HUNT_EMOJI_IDS } from "./hunt-emoji-ids.js";

/**
 * Hunt world — static data + pure math for Phase 1 (hunt + roll/gacha +
 * zoo/inventory + sell). Spec: docs/hunt-world-design.md.
 *
 * The rosters here ARE the design doc's §5/§6 tables, transcribed
 * verbatim (stats, tiers, areas, effects). Emoji are the animated
 * application emoji uploaded to the bot (see hunt-emoji-ids.ts),
 * with the Unicode placeholders as fallback when an ID is missing.
 */

export type Tier = "Common" | "Uncommon" | "Rare" | "Epic" | "Legendary" | "Mythic" | "UwU";

export const TIER_ORDER: readonly Tier[] = ["Common", "Uncommon", "Rare", "Epic", "Legendary", "Mythic", "UwU"];

export const TIER_INDEX: Record<Tier, number> = {
  Common: 0,
  Uncommon: 1,
  Rare: 2,
  Epic: 3,
  Legendary: 4,
  Mythic: 5,
  UwU: 6,
};

export type MonsterType =
  | "Fire"
  | "Water"
  | "Earth"
  | "Wind"
  | "Nature"
  | "Ice"
  | "Lightning"
  | "Shadow"
  | "Light"
  | "Spirit";

// ---------------------------------------------------------------------------
// Locked numbers (design §1)
// ---------------------------------------------------------------------------

export const ROLL_COST = 500;
export const ROLL10_COST = 4500;
export const ROLL10_COUNT = 10;
/** Daily roll cap per user (design §7.4 guard, approved by Ronit). */
export const DAILY_ROLL_CAP = 20;
/** Hunt cooldown (design §1.3). */
export const HUNT_COOLDOWN_MS = 30_000;
/** Pity: after this many rolls with no Epic+, the next roll is
 * guaranteed Epic minimum (design §1.2). */
export const PITY_THRESHOLD = 50;
/** Per-guild supply caps (design §1.4). */
export const MYTHIC_CAP_PER_GUILD = 3;
export const UWU_CAP_PER_GUILD = 1;

export interface TierInfo {
  /** Roll (gacha) drop rate in percent — sums to 100 across tiers. */
  rollRate: number;
  /** Catch rate on a hunt encounter, in percent. */
  catchRate: number;
  /** Gold when sold (§2.4). */
  sellPrice: number;
  /** Gems when sacrificed (§2.4). */
  gemYield: number;
  /** Max copies of ONE monster of this tier per Discord server, or null. */
  capPerGuild: number | null;
  color: string;
}

export const TIERS: Record<Tier, TierInfo> = {
  Common: { rollRate: 60, catchRate: 90, sellPrice: 25, gemYield: 1, capPerGuild: null, color: "Gray" },
  Uncommon: { rollRate: 25, catchRate: 75, sellPrice: 60, gemYield: 2, capPerGuild: null, color: "Green" },
  Rare: { rollRate: 10, catchRate: 60, sellPrice: 150, gemYield: 5, capPerGuild: null, color: "Blue" },
  Epic: { rollRate: 4, catchRate: 45, sellPrice: 400, gemYield: 12, capPerGuild: null, color: "Purple" },
  Legendary: { rollRate: 0.9, catchRate: 30, sellPrice: 1500, gemYield: 40, capPerGuild: null, color: "Gold" },
  Mythic: { rollRate: 0.09, catchRate: 15, sellPrice: 5000, gemYield: 150, capPerGuild: MYTHIC_CAP_PER_GUILD, color: "Red/Pink" },
  UwU: { rollRate: 0.01, catchRate: 10, sellPrice: 25000, gemYield: 500, capPerGuild: UWU_CAP_PER_GUILD, color: "Rainbow" },
};

/** Announcement level for a tier (§1.1): none / server-wide plain text /
 * server-wide + special embed / server-wide + bot-wide. */
export function tierAnnouncement(tier: Tier): "none" | "server" | "server-embed" | "bot-wide" {
  if (tier === "UwU") return "bot-wide";
  if (tier === "Mythic") return "server-embed";
  if (tier === "Legendary") return "server";
  return "none";
}

// ---------------------------------------------------------------------------
// Areas (design §2.1). Encounter weights are working defaults (design
// §10 item 5 — exact per-area tables were TBD): the weights only apply
// to tiers that actually have monsters in the area, and are renormalised.
// Meadow unlocks at level 0, not 1 — level 0 IS the starting level, so
// an unlock of 1 would lock brand-new players out of hunting entirely.
//
// DEVIATION from the doc's §2.1 tier lists, made so no roster monster
// is stranded: the doc lists Woods as Uncommon+Rare and Peaks as
// Rare+Epic, but the roster (§5) assigns 14 Commons to Woods and 10
// Uncommons to Peaks. Under the doc's lists those 24 monsters could
// never be encountered anywhere (rolls only). Each area's tier list
// below is widened to cover the tiers its roster monsters actually
// have, with small weights for the spill-over tiers.
export interface Area {
  id: string;
  name: string;
  unlockLevel: number;
  tiers: readonly Tier[];
  /** Encounter weight per tier (only tiers with monsters here matter). */
  encounterWeights: Partial<Record<Tier, number>>;
  blurb: string;
}

export const AREAS: readonly Area[] = [
  {
    id: "meadow",
    name: "Meadow of Beginnings",
    unlockLevel: 0,
    tiers: ["Common", "Uncommon"],
    encounterWeights: { Common: 80, Uncommon: 20 },
    blurb: "Safe, grassy, starter monsters",
  },
  {
    id: "woods",
    name: "Whispering Woods",
    unlockLevel: 5,
    tiers: ["Common", "Uncommon", "Rare"],
    encounterWeights: { Common: 20, Uncommon: 55, Rare: 25 },
    blurb: "Dark forest, trickier monsters",
  },
  {
    id: "peaks",
    name: "Ember Peaks",
    unlockLevel: 10,
    tiers: ["Uncommon", "Rare", "Epic"],
    encounterWeights: { Uncommon: 20, Rare: 55, Epic: 25 },
    blurb: "Volcanic, strong monsters",
  },
  {
    id: "hollow",
    name: "The Hollow Deep",
    unlockLevel: 15,
    tiers: ["Rare", "Epic", "Legendary", "Mythic", "UwU"],
    encounterWeights: { Rare: 5, Epic: 65, Legendary: 25, Mythic: 4.5, UwU: 0.5 },
    blurb: "Endgame — the only place Mythic and UwU can be encountered",
  },
];

export function findArea(input: string): Area | undefined {
  const q = input.trim().toLowerCase();
  if (!q) return undefined;
  return (
    AREAS.find((a) => a.id === q) ??
    AREAS.find((a) => a.name.toLowerCase() === q) ??
    AREAS.find((a) => a.name.toLowerCase().startsWith(q))
  );
}

// ---------------------------------------------------------------------------
// Unicode emoji placeholders (design: real art is a later step).
// Keyword match on the name first, then the type's emoji.
// ---------------------------------------------------------------------------

export const TYPE_EMOJI: Record<MonsterType, string> = {
  Fire: "🔥",
  Water: "💧",
  Earth: "🪨",
  Wind: "🌬️",
  Nature: "🌿",
  Ice: "❄️",
  Lightning: "⚡",
  Shadow: "🌑",
  Light: "✨",
  Spirit: "👻",
};

const NAME_EMOJI: readonly (readonly [string, string])[] = [
  ["dragon", "🐉"],
  ["phoenix", "🔥"],
  ["wolf", "🐺"],
  ["fox", "🦊"],
  ["cat", "🐱"],
  ["kitten", "🐱"],
  ["owl", "🦉"],
  ["hawk", "🦅"],
  ["falcon", "🦅"],
  ["eagle", "🦅"],
  ["crow", "🐦‍⬛"],
  ["raven", "🐦‍⬛"],
  ["snake", "🐍"],
  ["serpent", "🐍"],
  ["frog", "🐸"],
  ["turtle", "🐢"],
  ["bear", "🐻"],
  ["boar", "🐗"],
  ["shark", "🦈"],
  ["spider", "🕷️"],
  ["bat", "🦇"],
  ["stag", "🦌"],
  ["crab", "🦀"],
  ["slime", "🟢"],
  ["golem", "🗿"],
  ["moth", "🦋"],
  ["mouse", "🐭"],
  ["rat", "🐭"],
  ["duck", "🦆"],
  ["sheep", "🐑"],
  ["piglet", "🐷"],
  ["pig", "🐷"],
  ["squirrel", "🐿️"],
  ["hare", "🐰"],
  ["bunny", "🐰"],
  ["beetle", "🪲"],
  ["ant", "🐜"],
  ["chick", "🐥"],
  ["lizard", "🦎"],
  ["eel", "🐍"],
  ["salamander", "🦎"],
  ["tiger", "🐯"],
  ["panther", "🐆"],
  ["lion", "🦁"],
  ["leopard", "🐆"],
  ["lynx", "🐱"],
  ["hound", "🐶"],
  ["pup", "🐶"],
  ["kraken", "🐙"],
  ["leviathan", "🐋"],
  ["titan", "🗿"],
  ["demon", "😈"],
  ["reaper", "💀"],
  ["ghost", "👻"],
  ["wisp", "👻"],
  ["sprite", "🧚"],
  ["queen", "👸"],
  ["king", "🤴"],
  ["emperor", "👑"],
  ["monarch", "👑"],
  ["seraph", "😇"],
  ["colossus", "🗿"],
  ["wyrm", "🐉"],
  ["roc", "🦅"],
  ["basilisk", "🐍"],
  ["otter", "🦦"],
  ["imp", "😈"],
  ["sprout", "🌱"],
  ["shroom", "🍄"],
  ["dewdrop", "💧"],
  ["dew", "💧"],
  ["sovereign", "👑"],
];

export function nameEmoji(name: string): string | null {
  const lower = name.toLowerCase();
  for (const [keyword, emoji] of NAME_EMOJI) {
    if (lower.includes(keyword)) return emoji;
  }
  return null;
}

/**
 * Slug of a roster name, exactly as scripts/upload_application_emoji.py
 * slugs it when uploading (lowercase, runs of non-alphanumerics become
 * one "_", trimmed). "Storm King's Axe" -> "storm_king_s_axe".
 */
export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Animated application-emoji markup for a roster item (`<a:slug:id>`),
 * or the supplied Unicode `fallback` when the item has no uploaded ID.
 * Fail-soft by design: a missing ID never crashes a command, it just
 * shows the old Unicode placeholder.
 */
export function huntEmoji(name: string, fallback: string): string {
  const id = HUNT_EMOJI_IDS[slugifyName(name)];
  if (id) return `<a:${slugifyName(name)}:${id}>`;
  return fallback;
}

// ---------------------------------------------------------------------------
// Monster roster (design §5) — [id, name, type, tier, hp, atk, def,
// move, effects, area]. Area codes: M = Meadow, W = Woods, P = Peaks,
// H = Hollow.
// ---------------------------------------------------------------------------

export interface Monster {
  id: number;
  name: string;
  type: MonsterType;
  tier: Tier;
  hp: number;
  atk: number;
  def: number;
  move: string;
  effects: readonly string[];
  area: string;
}

type MonsterRow = readonly [
  number,
  string,
  MonsterType,
  Tier,
  number,
  number,
  number,
  string,
  readonly string[],
  string,
];

const MONSTER_ROWS: readonly MonsterRow[] = [
  // Common — 40
  [1, "Pebble Pup", "Earth", "Common", 55, 10, 6, "Tackle", [], "M"],
  [2, "Sproutling", "Nature", "Common", 50, 9, 7, "Vine Slap", [], "M"],
  [3, "Cinder Mouse", "Fire", "Common", 45, 11, 5, "Ember Nip", ["Burn"], "M"],
  [4, "Bubble Frog", "Water", "Common", 60, 8, 8, "Splash", [], "M"],
  [5, "Dust Bunny", "Earth", "Common", 48, 9, 6, "Hop Kick", [], "M"],
  [6, "Glow Moth", "Light", "Common", 42, 10, 5, "Dazzle", [], "M"],
  [7, "Thorn Rat", "Nature", "Common", 52, 11, 6, "Gnaw", [], "M"],
  [8, "Pebble Crab", "Water", "Common", 65, 9, 8, "Pinch", [], "M"],
  [9, "Ash Sparrow", "Wind", "Common", 44, 12, 5, "Peck", [], "M"],
  [10, "Moss Turtle", "Earth", "Common", 70, 8, 8, "Shell Bump", [], "M"],
  [11, "Dewdrop Slime", "Water", "Common", 58, 9, 6, "Goo Slap", [], "M"],
  [12, "Ember Ant", "Fire", "Common", 46, 10, 5, "Bite", ["Burn"], "M"],
  [13, "Cloud Sheep", "Wind", "Common", 62, 8, 7, "Fluff Ram", [], "M"],
  [14, "Root Mole", "Earth", "Common", 56, 10, 7, "Dig", [], "M"],
  [15, "Firefly Sprite", "Light", "Common", 40, 12, 4, "Flash", [], "M"],
  [16, "Mud Piglet", "Earth", "Common", 66, 9, 7, "Mud Toss", [], "M"],
  [17, "Berry Fox", "Nature", "Common", 50, 11, 6, "Berry Bite", [], "M"],
  [18, "Frost Minnow", "Ice", "Common", 54, 9, 6, "Cold Splash", [], "M"],
  [19, "Spark Beetle", "Lightning", "Common", 48, 11, 5, "Zap", [], "M"],
  [20, "Shadow Wisp", "Shadow", "Common", 44, 12, 5, "Shade Touch", [], "M"],
  [21, "Acorn Squirrel", "Nature", "Common", 50, 10, 6, "Nut Throw", [], "M"],
  [22, "Pebble Snake", "Earth", "Common", 58, 10, 6, "Coil", [], "M"],
  [23, "Drizzle Duck", "Water", "Common", 60, 9, 7, "Wing Slap", [], "M"],
  [24, "Cinder Cat", "Fire", "Common", 47, 12, 5, "Scratch", ["Burn"], "M"],
  [25, "Gust Hare", "Wind", "Common", 46, 12, 5, "Quick Kick", [], "M"],
  [26, "Stone Beetle", "Earth", "Common", 68, 8, 8, "Horn Push", [], "M"],
  [27, "Glowcap Shroom", "Nature", "Common", 55, 9, 7, "Spore Puff", ["Poison"], "W"],
  [28, "Mist Bat", "Shadow", "Common", 45, 11, 5, "Wing Buffet", [], "W"],
  [29, "Bark Beetle", "Nature", "Common", 64, 9, 7, "Bark Bite", [], "W"],
  [30, "Ember Lizard", "Fire", "Common", 52, 11, 6, "Tail Whip", ["Burn"], "W"],
  [31, "Frost Hare", "Ice", "Common", 50, 10, 6, "Ice Kick", [], "W"],
  [32, "Static Eel", "Lightning", "Common", 48, 12, 5, "Shock", [], "W"],
  [33, "Dusk Moth", "Shadow", "Common", 46, 11, 5, "Dust Wing", [], "W"],
  [34, "River Otter", "Water", "Common", 62, 9, 7, "Slide Tackle", [], "W"],
  [35, "Spike Puffer", "Water", "Common", 60, 10, 7, "Spike Roll", [], "W"],
  [36, "Cinder Imp", "Fire", "Common", 45, 12, 5, "Impish Jab", ["Burn"], "W"],
  [37, "Gale Chick", "Wind", "Common", 43, 12, 5, "Gust Peck", [], "W"],
  [38, "Pebble Golemlet", "Earth", "Common", 70, 9, 8, "Rock Toss", [], "W"],
  [39, "Wisp Cat", "Spirit", "Common", 48, 11, 6, "Spirit Paw", [], "W"],
  [40, "Dew Beetle", "Water", "Common", 57, 9, 6, "Bubble Pop", [], "W"],
  // Uncommon — 25
  [41, "Thorn Wolf", "Nature", "Uncommon", 85, 16, 9, "Fang Bite", ["Bleed"], "W"],
  [42, "Ember Fox", "Fire", "Uncommon", 78, 18, 8, "Flame Dash", ["Burn"], "W"],
  [43, "Frost Wolf", "Ice", "Uncommon", 90, 15, 10, "Ice Fang", [], "W"],
  [44, "Storm Hawk", "Lightning", "Uncommon", 76, 19, 8, "Dive Strike", [], "W"],
  [45, "Moss Golem", "Earth", "Uncommon", 105, 14, 12, "Slam", [], "W"],
  [46, "Shadow Panther", "Shadow", "Uncommon", 80, 18, 9, "Shadow Pounce", [], "W"],
  [47, "Tide Serpent", "Water", "Uncommon", 95, 15, 10, "Coil Crush", [], "W"],
  [48, "Gale Gryphon", "Wind", "Uncommon", 82, 17, 9, "Talon Rake", [], "W"],
  [49, "Cinder Boar", "Fire", "Uncommon", 100, 16, 11, "Charge", ["Burn"], "W"],
  [50, "Spirit Owl", "Spirit", "Uncommon", 75, 18, 8, "Hex Gaze", ["Attack Down"], "W"],
  [51, "Thorn Stag", "Nature", "Uncommon", 92, 16, 10, "Antler Charge", ["Bleed"], "W"],
  [52, "Frost Bear", "Ice", "Uncommon", 108, 15, 12, "Ice Slam", [], "W"],
  [53, "Spark Lynx", "Lightning", "Uncommon", 78, 19, 8, "Volt Claw", [], "W"],
  [54, "Dusk Raven", "Shadow", "Uncommon", 80, 17, 9, "Dark Feather", [], "W"],
  [55, "Boulder Crab", "Earth", "Uncommon", 110, 14, 12, "Claw Crush", [], "W"],
  [56, "Flame Salamander", "Fire", "Uncommon", 84, 17, 9, "Fire Tongue", ["Burn"], "P"],
  [57, "Wave Shark", "Water", "Uncommon", 98, 16, 10, "Jaw Snap", [], "P"],
  [58, "Storm Crow", "Wind", "Uncommon", 79, 18, 8, "Storm Dive", [], "P"],
  [59, "Iron Rhino", "Earth", "Uncommon", 106, 15, 12, "Horn Charge", [], "P"],
  [60, "Ghost Hound", "Spirit", "Uncommon", 82, 18, 9, "Wail", ["Attack Down"], "P"],
  [61, "Frost Falcon", "Ice", "Uncommon", 84, 17, 9, "Frost Dive", [], "P"],
  [62, "Venom Spider", "Nature", "Uncommon", 86, 17, 9, "Venom Bite", ["Poison"], "P"],
  [63, "Ember Eagle", "Fire", "Uncommon", 81, 18, 8, "Swoop", ["Burn"], "P"],
  [64, "Mist Stag", "Spirit", "Uncommon", 88, 16, 10, "Mist Charge", [], "P"],
  [65, "Thunder Ram", "Lightning", "Uncommon", 96, 16, 11, "Thunder Ram", [], "P"],
  // Rare — 15
  [66, "Crystal Wolf", "Ice", "Rare", 130, 24, 14, "Crystal Fang", ["Freeze"], "P"],
  [67, "Inferno Tiger", "Fire", "Rare", 125, 26, 13, "Inferno Claw", ["Burn"], "P"],
  [68, "Abyss Serpent", "Water", "Rare", 145, 23, 16, "Abyss Coil", [], "P"],
  [69, "Storm Dragonet", "Lightning", "Rare", 120, 27, 13, "Storm Breath", ["Paralyze"], "P"],
  [70, "Stone Titan", "Earth", "Rare", 155, 22, 17, "Titan Slam", ["Stun"], "P"],
  [71, "Shadow Reaper", "Shadow", "Rare", 118, 27, 14, "Reap", ["Bleed"], "P"],
  [72, "Frost Phoenix", "Ice", "Rare", 122, 25, 14, "Frost Wing", ["Freeze"], "P"],
  [73, "Thorn Behemoth", "Nature", "Rare", 150, 23, 16, "Thorn Crush", ["Poison"], "P"],
  [74, "Gale Dragon", "Wind", "Rare", 128, 25, 14, "Gale Burst", [], "P"],
  [75, "Spirit Guardian", "Spirit", "Rare", 135, 24, 15, "Guardian Light", ["Shield"], "P"],
  [76, "Ember Golem", "Fire", "Rare", 152, 23, 16, "Magma Fist", ["Burn"], "P"],
  [77, "Moonlight Panther", "Light", "Rare", 124, 26, 13, "Moon Claw", [], "H"],
  [78, "Thunder Roc", "Lightning", "Rare", 132, 25, 14, "Thunder Dive", ["Paralyze"], "H"],
  [79, "Venom Basilisk", "Nature", "Rare", 138, 24, 15, "Petrify Gaze", ["Stun"], "H"],
  [80, "Frost Leviathan", "Water", "Rare", 148, 23, 16, "Tidal Slam", ["Freeze"], "H"],
  // Epic — 10
  [81, "Inferno Phoenix", "Fire", "Epic", 195, 34, 20, "Rebirth Flame", ["Burn", "Regen"], "H"],
  [82, "Storm Leviathan", "Water", "Epic", 215, 32, 22, "Storm Surge", ["Paralyze"], "H"],
  [83, "Shadow Dragon", "Shadow", "Epic", 200, 35, 21, "Shadow Breath", ["Confuse"], "H"],
  [84, "Crystal Titan", "Earth", "Epic", 225, 30, 24, "Crystal Crush", ["Stun"], "H"],
  [85, "Frost Queen", "Ice", "Epic", 185, 34, 20, "Blizzard", ["Freeze", "Attack Down"], "H"],
  [86, "Thunder Godbird", "Lightning", "Epic", 190, 36, 19, "God Strike", ["Paralyze", "Crit Up"], "H"],
  [87, "Nature Warden", "Nature", "Epic", 210, 31, 23, "Warden's Grasp", ["Poison", "Lifesteal"], "H"],
  [88, "Light Seraph", "Light", "Epic", 180, 35, 20, "Holy Light", ["Shield", "Regen"], "H"],
  [89, "Abyss Kraken", "Water", "Epic", 220, 33, 22, "Abyssal Pull", ["Defense Down"], "H"],
  [90, "Ember Demon", "Fire", "Epic", 198, 36, 21, "Demon Fire", ["Burn", "Bleed"], "H"],
  // Legendary — 6
  [91, "Solar Dragon", "Fire", "Legendary", 290, 46, 28, "Solar Flare", ["Burn", "Crit Up"], "H"],
  [92, "Lunar Wolf", "Light", "Legendary", 260, 48, 26, "Moon Howl", ["Sleep"], "H"],
  [93, "Storm Emperor", "Lightning", "Legendary", 280, 47, 29, "Emperor's Wrath", ["Paralyze", "Attack Down"], "H"],
  [94, "Frost Wyrm", "Ice", "Legendary", 300, 44, 31, "Eternal Frost", ["Freeze", "Regen"], "H"],
  [95, "Shadow Monarch", "Shadow", "Legendary", 270, 49, 27, "Monarch's Grasp", ["Confuse", "Lifesteal"], "H"],
  [96, "Earth Colossus", "Earth", "Legendary", 315, 43, 32, "Colossal Slam", ["Stun", "Defense Down"], "H"],
  // Mythic — 3
  [97, "Void Dragon", "Shadow", "Mythic", 420, 60, 38, "Void Breath", ["Confuse", "Bleed"], "H"],
  [98, "Celestial Phoenix", "Light", "Mythic", 380, 62, 36, "Celestial Flame", ["Burn", "Regen"], "H"],
  [99, "Titan of the Deep", "Water", "Mythic", 445, 55, 42, "Deep Slam", ["Freeze", "Shield"], "H"],
  // UwU-tier — 1
  [100, "The UwU Sovereign", "Spirit", "UwU", 500, 72, 46, "Sovereign's Decree", ["Sleep", "Lifesteal"], "H"],
];

export const MONSTERS: readonly Monster[] = MONSTER_ROWS.map(
  ([id, name, type, tier, hp, atk, def, move, effects, area]) => ({
    id,
    name,
    type,
    tier,
    hp,
    atk,
    def,
    move,
    effects,
    area,
  }),
);

export const MONSTER_BY_ID = new Map<number, Monster>(MONSTERS.map((m) => [m.id, m]));

export function monsterEmoji(m: Monster): string {
  return huntEmoji(m.name, nameEmoji(m.name) ?? TYPE_EMOJI[m.type]);
}

export function monstersOfTier(tier: Tier): Monster[] {
  return MONSTERS.filter((m) => m.tier === tier);
}

export function monstersInArea(areaId: string): Monster[] {
  const area = AREAS.find((a) => a.id === areaId);
  if (!area) return [];
  const code = { meadow: "M", woods: "W", peaks: "P", hollow: "H" }[areaId] ?? "";
  return MONSTERS.filter((m) => m.area === code && area.tiers.includes(m.tier));
}

/** Power budget = HP + 4×ATK + 3×DEF (design §3.1). */
export function powerBudget(m: Monster): number {
  return m.hp + 4 * m.atk + 3 * m.def;
}

export function findMonsterByName(name: string): Monster | undefined {
  const q = name.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return undefined;
  return MONSTERS.find((m) => m.name.toLowerCase() === q);
}

// ---------------------------------------------------------------------------
// Weapon roster (design §6.1–6.7) — [id, name, kind, tier, atk, effects]
// ---------------------------------------------------------------------------

export interface Weapon {
  id: number;
  name: string;
  kind: string;
  tier: Tier;
  atk: number;
  effects: readonly string[];
}

type WeaponRow = readonly [number, string, string, Tier, number, readonly string[]];

const WEAPON_ROWS: readonly WeaponRow[] = [
  // Common — 20
  [1, "Wooden Sword", "Sword", "Common", 2, []],
  [2, "Rusty Dagger", "Dagger", "Common", 3, []],
  [3, "Training Bow", "Bow", "Common", 3, []],
  [4, "Pebble Hammer", "Hammer", "Common", 4, []],
  [5, "Stick Wand", "Wand", "Common", 2, []],
  [6, "Blunt Axe", "Axe", "Common", 4, []],
  [7, "Leather Whip", "Whip", "Common", 3, []],
  [8, "Stone Spear", "Spear", "Common", 4, []],
  [9, "Twig Staff", "Staff", "Common", 2, []],
  [10, "Iron Knife", "Dagger", "Common", 5, []],
  [11, "Wooden Club", "Club", "Common", 4, []],
  [12, "Slingshot", "Bow", "Common", 3, []],
  [13, "Bone Dagger", "Dagger", "Common", 4, []],
  [14, "Copper Sword", "Sword", "Common", 5, []],
  [15, "Reed Bow", "Bow", "Common", 3, []],
  [16, "Clay Hammer", "Hammer", "Common", 4, []],
  [17, "Thorn Whip", "Whip", "Common", 3, []],
  [18, "Flint Axe", "Axe", "Common", 5, []],
  [19, "Wooden Spear", "Spear", "Common", 4, []],
  [20, "Practice Blade", "Sword", "Common", 2, []],
  // Uncommon — 12
  [21, "Iron Sword", "Sword", "Uncommon", 6, []],
  [22, "Hunter's Bow", "Bow", "Uncommon", 7, []],
  [23, "Oak Staff", "Staff", "Uncommon", 6, []],
  [24, "Steel Dagger", "Dagger", "Uncommon", 8, []],
  [25, "Battle Axe", "Axe", "Uncommon", 7, []],
  [26, "Ember Wand", "Wand", "Uncommon", 8, ["Burn"]],
  [27, "Frost Dagger", "Dagger", "Uncommon", 7, []],
  [28, "War Hammer", "Hammer", "Uncommon", 9, []],
  [29, "Long Spear", "Spear", "Uncommon", 7, []],
  [30, "Shadow Blade", "Sword", "Uncommon", 8, []],
  [31, "Storm Bow", "Bow", "Uncommon", 8, []],
  [32, "Coral Trident", "Spear", "Uncommon", 9, []],
  // Rare — 8
  [33, "Knight's Sword", "Sword", "Rare", 11, []],
  [34, "Eagle Bow", "Bow", "Rare", 12, []],
  [35, "Crystal Staff", "Staff", "Rare", 11, ["Freeze"]],
  [36, "Titan Axe", "Axe", "Rare", 12, ["Stun"]],
  [37, "Inferno Blade", "Sword", "Rare", 13, ["Burn"]],
  [38, "Thunder Hammer", "Hammer", "Rare", 14, ["Paralyze"]],
  [39, "Venom Fang", "Dagger", "Rare", 12, ["Poison"]],
  [40, "Moon Wand", "Wand", "Rare", 11, ["Shield"]],
  // Epic — 5
  [41, "Dragon Slayer", "Sword", "Epic", 18, ["Bleed"]],
  [42, "Phoenix Bow", "Bow", "Epic", 17, ["Burn"]],
  [43, "Stormcaller Staff", "Staff", "Epic", 19, ["Paralyze"]],
  [44, "Void Dagger", "Dagger", "Epic", 18, ["Confuse"]],
  [45, "Frostbrand", "Sword", "Epic", 16, ["Freeze"]],
  // Legendary — 3
  [46, "Solar Blade", "Sword", "Legendary", 26, ["Burn", "Crit Up"]],
  [47, "Moonfang", "Dagger", "Legendary", 24, ["Sleep"]],
  [48, "Storm King's Axe", "Axe", "Legendary", 27, ["Paralyze"]],
  // Mythic — 1
  [49, "Voidreaver", "Sword", "Mythic", 35, ["Confuse", "Bleed"]],
  // UwU-tier — 1
  [50, "The UwU Blade", "Sword", "UwU", 48, ["Sleep", "Lifesteal"]],
];

export const WEAPONS: readonly Weapon[] = WEAPON_ROWS.map(([id, name, kind, tier, atk, effects]) => ({
  id,
  name,
  kind,
  tier,
  atk,
  effects,
}));

export const WEAPON_BY_ID = new Map<number, Weapon>(WEAPONS.map((w) => [w.id, w]));

const WEAPON_EMOJI: Record<string, string> = {
  Sword: "⚔️",
  Dagger: "🗡️",
  Bow: "🏹",
  Hammer: "🔨",
  Wand: "🪄",
  Axe: "🪓",
  Whip: "🪢",
  Spear: "🔱",
  Staff: "🪄",
  Club: "🦴",
};

export function weaponEmoji(w: Weapon): string {
  return huntEmoji(w.name, WEAPON_EMOJI[w.kind] ?? "⚔️");
}

// ---------------------------------------------------------------------------
// Pet roster (design §6.8) — [id, name, tier, buffType, buffValue]
// ---------------------------------------------------------------------------

export type PetBuffType = "gold-sells" | "catch" | "gold-hunts" | "xp";

export interface Pet {
  id: number;
  name: string;
  tier: Tier;
  buffType: PetBuffType;
  buffValue: number;
}

type PetRow = readonly [number, string, Tier, PetBuffType, number];

const PET_ROWS: readonly PetRow[] = [
  [1, "Pocket Slime", "Common", "gold-sells", 3],
  [2, "Mini Moth", "Common", "catch", 3],
  [3, "Pebble Crablet", "Common", "gold-hunts", 3],
  [4, "Sprout Buddy", "Common", "xp", 3],
  [5, "Dewdrop", "Common", "gold-sells", 3],
  [6, "Ember Mouse", "Common", "catch", 3],
  [7, "Flame Fox Pup", "Uncommon", "catch", 5],
  [8, "Frost Bunny", "Uncommon", "gold-sells", 5],
  [9, "Storm Chick", "Uncommon", "xp", 5],
  [10, "Shadow Kitten", "Uncommon", "catch", 5],
  [11, "Tide Turtle", "Uncommon", "gold-hunts", 5],
  [12, "Crystal Fox", "Rare", "catch", 8],
  [13, "Ember Phoenix Chick", "Rare", "gold-sells", 8],
  [14, "Moon Moth", "Rare", "xp", 8],
  [15, "Thunder Pup", "Rare", "catch", 8],
  [16, "Mini Dragon", "Epic", "catch", 12],
  [17, "Star Sprite", "Epic", "gold-hunts", 12],
  [18, "Solar Pup", "Legendary", "catch", 18],
  [19, "Lunar Cat", "Legendary", "gold-hunts", 18],
  [20, "Void Wisp", "Mythic", "catch", 25],
];

export const PETS: readonly Pet[] = PET_ROWS.map(([id, name, tier, buffType, buffValue]) => ({
  id,
  name,
  tier,
  buffType,
  buffValue,
}));

export const PET_BY_ID = new Map<number, Pet>(PETS.map((p) => [p.id, p]));

export function petEmoji(p: Pet): string {
  return huntEmoji(p.name, nameEmoji(p.name) ?? "🐾");
}

export function petBuffText(p: Pet): string {
  const what =
    p.buffType === "catch"
      ? "catch chance"
      : p.buffType === "gold-sells"
        ? "gold from sells"
        : p.buffType === "gold-hunts"
          ? "gold from hunts"
          : "XP";
  return `+${p.buffValue}% ${what}`;
}

// ---------------------------------------------------------------------------
// Pure draw math (design §1–§3). `rand` is injectable so tests can drive
// exact outcomes with mulberry32; production uses crypto-backed floats.
// ---------------------------------------------------------------------------

/** Draw a tier from the roll (gacha) rates. */
export function rollTier(rand: () => number = secureFloat): Tier {
  return weightedPick(
    TIER_ORDER.map((t) => [t, TIERS[t].rollRate] as const),
    rand,
  );
}

/** Pity draw: Epic minimum — weighted only over Epic+ by their roll rates. */
export function pityTier(rand: () => number = secureFloat): Tier {
  const epicPlus: readonly Tier[] = ["Epic", "Legendary", "Mythic", "UwU"];
  return weightedPick(
    epicPlus.map((t) => [t, TIERS[t].rollRate] as const),
    rand,
  );
}

/** True when the pity rule fires for this pull. */
export function shouldUsePity(rollsSinceEpic: number): boolean {
  return rollsSinceEpic >= PITY_THRESHOLD;
}

/** A random monster of the given tier. */
export function drawMonsterOfTier(tier: Tier, rand: () => number = secureFloat): Monster {
  const pool = monstersOfTier(tier);
  if (pool.length === 0) throw new Error(`drawMonsterOfTier: no monsters of tier ${tier}`);
  return pool[Math.floor(rand() * pool.length)]!;
}

/** Encounter tier inside an area: weighted over the tiers that actually
 * have monsters there (renormalised). */
export function encounterTier(area: Area, rand: () => number = secureFloat): Tier {
  const pool = monstersInArea(area.id);
  const present = new Set(pool.map((m) => m.tier));
  const entries = area.tiers
    .filter((t) => present.has(t))
    .map((t) => [t, area.encounterWeights[t] ?? 1] as const);
  if (entries.length === 0) throw new Error(`encounterTier: no monsters in area ${area.id}`);
  return weightedPick(entries, rand);
}

/** A random monster encountered in the area (tier first, then a monster
 * of that tier in the area's pool). */
export function encounterMonster(area: Area, rand: () => number = secureFloat): Monster {
  const tier = encounterTier(area, rand);
  const pool = monstersInArea(area.id).filter((m) => m.tier === tier);
  return pool[Math.floor(rand() * pool.length)]!;
}

/** Catch chance for a tier, in percent (design §1.3). */
export function catchRate(tier: Tier): number {
  return TIERS[tier].catchRate;
}

/** Attempt a catch: true when the random roll beats the tier's rate.
 * `bonus` adds flat percentage points (guild catch bonus, pet buffs);
 * the caller caps the combined bonus at +30pp (design §1.3). */
export function attemptCatch(
  tier: Tier,
  rand: () => number = secureFloat,
  bonus: number = 0,
): boolean {
  return rand() * 100 < TIERS[tier].catchRate + bonus;
}

/** Gold for selling one copy of a monster of this tier (design §2.4). */
export function sellPriceFor(tier: Tier): number {
  return TIERS[tier].sellPrice;
}

/** One tier down (for cap downgrades); Common downgrades to itself. */
export function tierDown(tier: Tier): Tier {
  const i = TIER_INDEX[tier];
  return i <= 0 ? tier : TIER_ORDER[i - 1]!;
}
