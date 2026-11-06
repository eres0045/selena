/**
 * Selena's hero catalogue — names, roles and lanes ONLY.
 *
 * This file deliberately holds NO stats: no win/pick/ban rates, no tiers,
 * no counters, no builds, no "meta". Selena cannot verify any of that
 * (there is no official public MLBB API), so she does not pretend to.
 * The catalogue exists only for Selena's own games: gacha cards (rarity
 * is Selena's own game assignment, not a performance claim) and the
 * draft helper's hero-name list. /guesshero keeps its own clue list in
 * lib/games.ts; trivia keeps its own questions in lib/trivia.ts.
 */

export type GachaRarity = "Common" | "Rare" | "Epic" | "Legendary";

export interface GachaCard {
  id: string;
  heroId: string;
  name: string;
  rarity: GachaRarity;
  skin?: string;
}

export interface Hero {
  id: string;
  name: string;
  role: "Tank" | "Fighter" | "Assassin" | "Mage" | "Marksman" | "Support";
  lane: string;
  /** Selena's own gacha rarity — a game assignment, not a performance claim. */
  rarity: GachaRarity;
}

export const HEROES: Hero[] = [
  { id: "tigreal", name: "Tigreal", role: "Tank", lane: "Roam", rarity: "Common" },
  { id: "akai", name: "Akai", role: "Tank", lane: "Roam", rarity: "Epic" },
  { id: "johnson", name: "Johnson", role: "Tank", lane: "Roam", rarity: "Rare" },
  { id: "atlas", name: "Atlas", role: "Tank", lane: "Roam", rarity: "Epic" },
  { id: "khufra", name: "Khufra", role: "Tank", lane: "Roam", rarity: "Legendary" },
  { id: "aldous", name: "Aldous", role: "Fighter", lane: "EXP Lane", rarity: "Epic" },
  { id: "chou", name: "Chou", role: "Fighter", lane: "EXP Lane", rarity: "Epic" },
  { id: "yu-zhong", name: "Yu Zhong", role: "Fighter", lane: "EXP Lane", rarity: "Legendary" },
  { id: "lapu-lapu", name: "Lapu-Lapu", role: "Fighter", lane: "EXP Lane", rarity: "Epic" },
  { id: "dyrroth", name: "Dyrroth", role: "Fighter", lane: "EXP Lane", rarity: "Epic" },
  { id: "lancelot", name: "Lancelot", role: "Assassin", lane: "Jungle", rarity: "Legendary" },
  { id: "hayabusa", name: "Hayabusa", role: "Assassin", lane: "Jungle", rarity: "Epic" },
  { id: "ling", name: "Ling", role: "Assassin", lane: "Jungle", rarity: "Legendary" },
  { id: "gusion", name: "Gusion", role: "Assassin", lane: "Jungle", rarity: "Epic" },
  { id: "fanny", name: "Fanny", role: "Assassin", lane: "Jungle", rarity: "Epic" },
  { id: "kagura", name: "Kagura", role: "Mage", lane: "Mid Lane", rarity: "Epic" },
  { id: "lunox", name: "Lunox", role: "Mage", lane: "Mid Lane", rarity: "Legendary" },
  { id: "cecilion", name: "Cecilion", role: "Mage", lane: "Mid Lane", rarity: "Epic" },
  { id: "eudora", name: "Eudora", role: "Mage", lane: "Mid Lane", rarity: "Common" },
  { id: "selena", name: "Selena", role: "Mage", lane: "Mid Lane", rarity: "Epic" },
  { id: "miya", name: "Miya", role: "Marksman", lane: "Gold Lane", rarity: "Common" },
  { id: "layla", name: "Layla", role: "Marksman", lane: "Gold Lane", rarity: "Common" },
  { id: "granger", name: "Granger", role: "Marksman", lane: "Gold Lane", rarity: "Epic" },
  { id: "claude", name: "Claude", role: "Marksman", lane: "Gold Lane", rarity: "Legendary" },
  { id: "beatrix", name: "Beatrix", role: "Marksman", lane: "Gold Lane", rarity: "Legendary" },
  { id: "angela", name: "Angela", role: "Support", lane: "Roam", rarity: "Epic" },
  { id: "estes", name: "Estes", role: "Support", lane: "Roam", rarity: "Epic" },
  { id: "diggie", name: "Diggie", role: "Support", lane: "Roam", rarity: "Epic" },
  { id: "rafaela", name: "Rafaela", role: "Support", lane: "Roam", rarity: "Common" },
  { id: "mathilda", name: "Mathilda", role: "Support", lane: "Roam", rarity: "Epic" },
];

/** Skins included only where the skin name is well established. */
const SKINS: Record<string, string> = {
  johnson: "S.A.B.E.R. Automata",
  layla: "S.A.B.E.R. Enforcer",
};

export const GACHA_CARDS: GachaCard[] = HEROES.map((hero) => ({
  id: `card-${hero.id}`,
  heroId: hero.id,
  name: hero.name,
  rarity: hero.rarity,
  ...(SKINS[hero.id] ? { skin: SKINS[hero.id] } : {}),
}));
