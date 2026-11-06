/**
 * MLBB hero dataset — STATIC SNAPSHOT.
 *
 * There is no official public MLBB API, so this file is a hand-written
 * snapshot of well-known heroes (name, role, lane, tier, community
 * matchup knowledge, and commonly suggested builds) from public
 * knowledge. It is NOT live data.
 *
 * HONESTY RULES followed here:
 * - Every hero carries `snapshot: true`.
 * - Win/pick/ban rates are OMITTED unless a figure is defensible from
 *   public knowledge. No rate in this file is invented: at the time of
 *   writing, none of the rates below met that bar, so every hero leaves
 *   winRate/pickRate/banRate undefined and embeds must render "—".
 * - Counters are plausible, well-known matchup knowledge (e.g.
 *   crowd-control heroes counter dash-heavy assassins), labelled in the
 *   UI as community knowledge, not official data.
 * - Builds list widely used item names, not a claim of a live meta.
 */

export interface Hero {
  id: string;
  name: string;
  role: "Tank" | "Fighter" | "Assassin" | "Mage" | "Marksman" | "Support";
  lane: string;
  /** Short skill/identity description, in our own words. */
  description: string;
  tier?: "S" | "A" | "B";
  /** Heroes this hero is strong against (community knowledge). */
  counters?: string[];
  /** Heroes that counter this hero (community knowledge). */
  counteredBy?: string[];
  /** Commonly suggested items (community knowledge, not a live meta). */
  build?: string[];
  /** Only set when a defensible public figure exists; otherwise omitted. */
  winRate?: number;
  pickRate?: number;
  banRate?: number;
  snapshot: true;
}

const h = (
  id: string,
  name: string,
  role: Hero["role"],
  lane: string,
  description: string,
  tier: Hero["tier"],
  counters: string[],
  counteredBy: string[],
  build: string[],
): Hero => ({
  id,
  name,
  role,
  lane,
  description,
  tier,
  counters,
  counteredBy,
  build,
  // winRate / pickRate / banRate deliberately omitted: no verified figures.
  snapshot: true,
});

export const HEROES: Hero[] = [
  // ---- Tanks (Roam) ----
  h(
    "tigreal",
    "Tigreal",
    "Tank",
    "Roam",
    "Stoic frontline knight who drags enemies together with his ultimate, then knocks them sky-high — the classic engage tank.",
    "B",
    ["Fanny", "Lancelot", "Ling"],
    ["Diggie", "Lunox"],
    ["Tough Boots", "Dominance Ice", "Athena's Shield", "Antique Cuirass", "Immortality"],
  ),
  h(
    "akai",
    "Akai",
    "Tank",
    "Roam",
    "Panda brawler who pins a target against a wall with his spinning ultimate, shutting down divers.",
    "A",
    ["Fanny", "Ling", "Hayabusa"],
    ["Diggie", "Kagura"],
    ["Tough Boots", "Dominance Ice", "Athena's Shield", "Blade Armor", "Immortality"],
  ),
  h(
    "johnson",
    "Johnson",
    "Tank",
    "Roam",
    "Drives across the map as a car, crashing into enemies to stun them — the game's most famous gank taxi.",
    "B",
    ["Layla", "Miya", "Eudora"],
    ["Diggie", "Chou"],
    ["Tough Boots", "Dominance Ice", "Radiant Armor", "Athena's Shield", "Immortality"],
  ),
  h(
    "atlas",
    "Atlas",
    "Tank",
    "Roam",
    "Deep-sea mech that chains enemies in and yanks them together for a team-wiping engage.",
    "A",
    ["Claude", "Miya", "Layla"],
    ["Diggie", "Lunox"],
    ["Tough Boots", "Dominance Ice", "Athena's Shield", "Antique Cuirass", "Immortality"],
  ),
  h(
    "khufra",
    "Khufra",
    "Tank",
    "Roam",
    "Bouncing brawler whose ball form blocks every dash in the game — the hard counter to mobile assassins.",
    "S",
    ["Fanny", "Ling", "Hayabusa", "Lancelot"],
    ["Diggie", "Lunox"],
    ["Tough Boots", "Dominance Ice", "Athena's Shield", "Antique Cuirass", "Immortality"],
  ),

  // ---- Fighters (EXP Lane) ----
  h(
    "aldous",
    "Aldous",
    "Fighter",
    "EXP Lane",
    "Soul-collecting puncher whose single strikes scale all game; his ultimate lets him fly across the map to finish a target.",
    "A",
    ["Layla", "Miya", "Eudora"],
    ["Chou", "Khufra"],
    ["Warrior Boots", "Endless Battle", "Blade of Despair", "War Axe", "Immortality"],
  ),
  h(
    "chou",
    "Chou",
    "Fighter",
    "EXP Lane",
    "Kung-fu fighter who dashes in, kicks a key target out of position, and walks away — prized for pick-offs.",
    "A",
    ["Aldous", "Fanny", "Lunox"],
    ["Akai", "Khufra"],
    ["Warrior Boots", "War Axe", "Blade of Despair", "Hunter Strike", "Immortality"],
  ),
  h(
    "yu-zhong",
    "Yu Zhong",
    "Fighter",
    "EXP Lane",
    "Black dragon who dives into the backline in dragon form, draining life as he fights.",
    "S",
    ["Miya", "Layla", "Cecilion"],
    ["Lunox", "Dyrroth"],
    ["Warrior Boots", "War Axe", "Brute Force Breastplate", "Blade of Despair", "Immortality"],
  ),
  h(
    "lapu-lapu",
    "Lapu-Lapu",
    "Fighter",
    "EXP Lane",
    "Twin-blade warrior who switches stances mid-fight, trading heavy damage for crowd control.",
    "A",
    ["Granger", "Claude", "Miya"],
    ["Lunox", "Chou"],
    ["Warrior Boots", "War Axe", "Hunter Strike", "Blade of Despair", "Immortality"],
  ),
  h(
    "dyrroth",
    "Dyrroth",
    "Fighter",
    "EXP Lane",
    "Prince who shreds armor with every strike, dueling tanks down with ease.",
    "A",
    ["Tigreal", "Akai", "Yu Zhong"],
    ["Lunox", "Chou"],
    ["Warrior Boots", "War Axe", "Blade of Despair", "Hunter Strike", "Endless Battle"],
  ),

  // ---- Assassins (Jungle) ----
  h(
    "lancelot",
    "Lancelot",
    "Assassin",
    "Jungle",
    "Fencing assassin who weaves through enemies untouchable, bursting squishy targets in a blink.",
    "S",
    ["Eudora", "Layla", "Cecilion"],
    ["Khufra", "Tigreal"],
    ["Swift Boots", "Blade of Despair", "Endless Battle", "Hunter Strike", "Malefic Roar"],
  ),
  h(
    "hayabusa",
    "Hayabusa",
    "Assassin",
    "Jungle",
    "Shadow ninja who splits into phantoms and shreds a lone target with his ultimate.",
    "A",
    ["Layla", "Eudora", "Cecilion"],
    ["Khufra", "Akai"],
    ["Swift Boots", "Blade of the Heptaseas", "Hunter Strike", "Blade of Despair", "Malefic Roar"],
  ),
  h(
    "ling",
    "Ling",
    "Assassin",
    "Jungle",
    "Wall-running swordsman who rains down from above, untouchable while he rides the walls.",
    "S",
    ["Layla", "Miya", "Cecilion"],
    ["Khufra", "Tigreal"],
    ["Swift Boots", "Blade of Despair", "Endless Battle", "Hunter Strike", "Malefic Roar"],
  ),
  h(
    "gusion",
    "Gusion",
    "Assassin",
    "Jungle",
    "Dagger mage-assassin who recalls a storm of blades to burst a target before they can react.",
    "A",
    ["Miya", "Layla", "Eudora"],
    ["Khufra", "Chou"],
    ["Arcane Boots", "Lightning Truncheon", "Holy Crystal", "Genius Wand", "Divine Glaive"],
  ),
  h(
    "fanny",
    "Fanny",
    "Assassin",
    "Jungle",
    "Cable-swinging assassin with the highest skill ceiling in the game — unstoppable in the right hands, useless without energy control.",
    "A",
    ["Layla", "Miya", "Cecilion"],
    ["Khufra", "Tigreal"],
    ["Swift Boots", "Blade of Despair", "Hunter Strike", "Blade of the Heptaseas", "Immortality"],
  ),

  // ---- Mages (Mid Lane) ----
  h(
    "kagura",
    "Kagura",
    "Mage",
    "Mid Lane",
    "Umbrella master who controls space with her Seimei Umbrella, bursting and slowing from range.",
    "A",
    ["Chou", "Aldous", "Tigreal"],
    ["Hayabusa", "Lancelot"],
    ["Arcane Boots", "Lightning Truncheon", "Holy Crystal", "Genius Wand", "Divine Glaive"],
  ),
  h(
    "lunox",
    "Lunox",
    "Mage",
    "Mid Lane",
    "Twin-goddess mage who flips between light and dark, shredding tanks with percent-health damage.",
    "S",
    ["Tigreal", "Yu Zhong", "Akai"],
    ["Hayabusa", "Lancelot"],
    ["Arcane Boots", "Clock of Destiny", "Lightning Truncheon", "Holy Crystal", "Divine Glaive"],
  ),
  h(
    "cecilion",
    "Cecilion",
    "Mage",
    "Mid Lane",
    "Vampire mage whose bats stack damage all game, turning teamfights into a bloodbath late.",
    "A",
    ["Tigreal", "Akai", "Yu Zhong"],
    ["Hayabusa", "Lancelot"],
    ["Arcane Boots", "Clock of Destiny", "Lightning Truncheon", "Holy Crystal", "Divine Glaive"],
  ),
  h(
    "eudora",
    "Eudora",
    "Mage",
    "Mid Lane",
    "Lightning witch who deletes one target with a simple stun-and-burst combo — easy to learn, feared in low ranks.",
    "B",
    ["Fanny", "Lancelot", "Ling"],
    ["Chou", "Hayabusa"],
    ["Arcane Boots", "Lightning Truncheon", "Holy Crystal", "Genius Wand", "Divine Glaive"],
  ),
  h(
    "selena",
    "Selena",
    "Mage",
    "Mid Lane",
    "Abyssal elf who snipes with long-range stun arrows, then transforms to finish prey up close.",
    "A",
    ["Layla", "Miya", "Eudora"],
    ["Chou", "Khufra"],
    ["Arcane Boots", "Lightning Truncheon", "Holy Crystal", "Genius Wand", "Divine Glaive"],
  ),

  // ---- Marksmen (Gold Lane) ----
  h(
    "miya",
    "Miya",
    "Marksman",
    "Gold Lane",
    "Moonlit archer and the game's mascot; her ultimate turns her invisible for a quick escape or chase.",
    "B",
    ["Tigreal", "Akai"],
    ["Hayabusa", "Ling"],
    ["Swift Boots", "Demon Hunter Sword", "Corrosion Scythe", "Golden Staff", "Blade of Despair"],
  ),
  h(
    "layla",
    "Layla",
    "Marksman",
    "Gold Lane",
    "Long-range gunner whose shots reach further than any other marksman as the game goes on.",
    "B",
    ["Tigreal", "Akai"],
    ["Lancelot", "Hayabusa"],
    ["Swift Boots", "Demon Hunter Sword", "Corrosion Scythe", "Blade of Despair", "Malefic Roar"],
  ),
  h(
    "granger",
    "Granger",
    "Marksman",
    "Gold Lane",
    "Gunslinger who fires skill-shot bullets in rhythm, bursting enemies with his ultimate volley.",
    "A",
    ["Tigreal", "Akai", "Johnson"],
    ["Ling", "Hayabusa"],
    ["Swift Boots", "Blade of Despair", "Endless Battle", "Hunter Strike", "Malefic Roar"],
  ),
  h(
    "claude",
    "Claude",
    "Marksman",
    "Gold Lane",
    "Thief marksman who blinks in with his monkey partner, shredding teams with rapid-fire attacks.",
    "S",
    ["Tigreal", "Akai", "Atlas"],
    ["Khufra", "Chou"],
    ["Swift Boots", "Demon Hunter Sword", "Corrosion Scythe", "Golden Staff", "Wind of Nature"],
  ),
  h(
    "beatrix",
    "Beatrix",
    "Marksman",
    "Gold Lane",
    "Weapons master who swaps between four guns mid-fight, adapting to any range.",
    "S",
    ["Tigreal", "Akai", "Johnson"],
    ["Lancelot", "Ling"],
    ["Swift Boots", "Blade of Despair", "Hunter Strike", "Malefic Roar", "Endless Battle"],
  ),

  // ---- Supports (Roam) ----
  h(
    "angela",
    "Angela",
    "Support",
    "Roam",
    "Puppet healer who attaches to an ally, shielding and healing them while slowing enemies.",
    "A",
    ["Fanny", "Ling"],
    ["Chou", "Hayabusa"],
    ["Magic Shoes", "Fleeting Time", "Necklace of Durance", "Oracle", "Immortality"],
  ),
  h(
    "estes",
    "Estes",
    "Support",
    "Roam",
    "Elf king whose healing links keep the whole team alive through long fights.",
    "A",
    ["Aldous", "Yu Zhong", "Lapu-Lapu"],
    ["Lunox", "Hayabusa"],
    ["Magic Shoes", "Fleeting Time", "Enchanted Talisman", "Oracle", "Dominance Ice"],
  ),
  h(
    "diggie",
    "Diggie",
    "Support",
    "Roam",
    "Owl timekeeper whose ultimate cleanses the whole team — the direct answer to crowd-control engages.",
    "A",
    ["Tigreal", "Atlas", "Khufra", "Akai"],
    ["Hayabusa", "Lancelot"],
    ["Magic Shoes", "Fleeting Time", "Necklace of Durance", "Dominance Ice", "Immortality"],
  ),
  h(
    "rafaela",
    "Rafaela",
    "Support",
    "Roam",
    "Angel healer who speeds the team up and reveals hidden enemies with holy light.",
    "B",
    ["Aldous", "Yu Zhong"],
    ["Hayabusa", "Lancelot"],
    ["Magic Shoes", "Fleeting Time", "Enchanted Talisman", "Oracle", "Necklace of Durance"],
  ),
  h(
    "mathilda",
    "Mathilda",
    "Support",
    "Roam",
    "Swift guide who dashes allies to safety and dives in with butterfly wings.",
    "A",
    ["Fanny", "Ling"],
    ["Khufra", "Chou"],
    ["Magic Shoes", "Fleeting Time", "Necklace of Durance", "Dominance Ice", "Immortality"],
  ),
];

/** Normalise for matching: lowercase, strip spaces/punctuation. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Find a hero by name or id, case-insensitive, tolerating partial names.
 * Exact match wins, then prefix match, then substring match.
 */
export function findHero(query: string): Hero | undefined {
  const q = norm(query);
  if (!q) return undefined;
  const exact = HEROES.find((hero) => norm(hero.name) === q || norm(hero.id) === q);
  if (exact) return exact;
  const prefix = HEROES.find((hero) => norm(hero.name).startsWith(q) || norm(hero.id).startsWith(q));
  if (prefix) return prefix;
  return HEROES.find((hero) => norm(hero.name).includes(q) || norm(hero.id).includes(q));
}

// ---- Gacha cards (for the gacha worker to import) ----

export type GachaRarity = "Common" | "Rare" | "Epic" | "Legendary";

export interface GachaCard {
  id: string;
  heroId: string;
  name: string;
  rarity: GachaRarity;
  skin?: string;
}

/** Long-time free starter heroes — Common rarity. */
const STARTER_HERO_IDS = new Set(["miya", "layla", "tigreal", "eudora", "rafaela"]);

/** Skins included only where the skin name is well established. */
const SKINS: Record<string, string> = {
  johnson: "S.A.B.E.R. Automata",
  layla: "S.A.B.E.R. Enforcer",
};

/** Rarity is assigned from the hero's tier: S → Legendary, A → Epic, B → Rare (Common for starter heroes). */
function rarityFor(hero: Hero): GachaRarity {
  if (hero.tier === "S") return "Legendary";
  if (hero.tier === "A") return "Epic";
  if (STARTER_HERO_IDS.has(hero.id)) return "Common";
  return "Rare";
}

export const GACHA_CARDS: GachaCard[] = HEROES.map((hero) => ({
  id: `card-${hero.id}`,
  heroId: hero.id,
  name: hero.name,
  rarity: rarityFor(hero),
  ...(SKINS[hero.id] ? { skin: SKINS[hero.id] } : {}),
}));
