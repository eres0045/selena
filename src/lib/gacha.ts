import type { SelenaDb } from "./db.js";
import { secureFloat, weightedPick } from "./rng.js";

/**
 * Gacha (hero/skin card rolls) — pure lib.
 *
 * Rarity weights (documented in /roll help): Common 60 / Rare 25 / Epic 11 /
 * Legendary 4. Rolls are free but cooldown-gated (1 hour per user). Pity:
 * guaranteed Epic or better after 10 rolls without Epic or better.
 *
 * Card data lives in src/data/heroes.ts (owned by another worker) and is
 * loaded lazily by loadGachaCards() in the command layer. This lib only
 * ever works with plain GachaCard values passed in, so it is fully testable
 * without that file.
 */

export type Rarity = "Common" | "Rare" | "Epic" | "Legendary";

export interface GachaCard {
  id: string;
  heroId: string;
  name: string;
  rarity: Rarity;
  skin?: string;
}

export const RARITIES: Rarity[] = ["Common", "Rare", "Epic", "Legendary"];

/** Rarity weights for /roll. Sums to 100. */
export const RARITY_WEIGHTS: ReadonlyArray<readonly [Rarity, number]> = [
  ["Common", 60],
  ["Rare", 25],
  ["Epic", 11],
  ["Legendary", 4],
] as const;

export const ROLL_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
export const PITY_THRESHOLD = 10; // rolls without Epic+ before a guaranteed Epic+
export const PITY_RARITIES: Rarity[] = ["Epic", "Legendary"];

export interface GachaState {
  last_roll: number | null;
  pity: number;
  total_rolls: number;
}

export function defaultGachaState(): GachaState {
  return { last_roll: null, pity: 0, total_rolls: 0 };
}

export function isEpicOrBetter(rarity: Rarity): boolean {
  return rarity === "Epic" || rarity === "Legendary";
}

/**
 * Roll one card. Pity: when state.pity >= PITY_THRESHOLD the rarity is
 * forced to Epic/Legendary (weighted 11:4). Otherwise rarity follows
 * RARITY_WEIGHTS, then a uniform card is picked within that rarity.
 * `rand` is injectable for tests (defaults to crypto-backed secureFloat).
 */
export function rollCard(
  cards: readonly GachaCard[],
  state: GachaState | null | undefined,
  rand: () => number = secureFloat,
): { card: GachaCard; rarity: Rarity; newPity: number } {
  if (cards.length === 0) throw new Error("No gacha cards available");
  const pity = state?.pity ?? 0;
  const present = new Set(cards.map((c) => c.rarity));
  const entries: Array<readonly [Rarity, number]> = (
    pity >= PITY_THRESHOLD
      ? RARITY_WEIGHTS.filter(([r]) => PITY_RARITIES.includes(r))
      : RARITY_WEIGHTS
  ).filter(([r]) => present.has(r));
  if (entries.length === 0) throw new Error("No gacha cards available");
  const rarity = weightedPick(entries, rand);
  const pool = cards.filter((c) => c.rarity === rarity);
  const card = pool[Math.floor(rand() * pool.length)] as GachaCard;
  return { card, rarity, newPity: isEpicOrBetter(rarity) ? 0 : pity + 1 };
}

/** Cooldown check. Returns remaining ms (0 when allowed). */
export function canRoll(
  state: GachaState | null | undefined,
  nowMs: number,
): { allowed: boolean; remainingMs: number } {
  const last = state?.last_roll ?? null;
  if (last === null || last === undefined) return { allowed: true, remainingMs: 0 };
  const remainingMs = last + ROLL_COOLDOWN_MS - nowMs;
  if (remainingMs <= 0) return { allowed: true, remainingMs: 0 };
  return { allowed: false, remainingMs };
}

export async function getGachaState(db: SelenaDb, guildId: string, userId: string): Promise<GachaState> {
  const row = await db
    .prepare("SELECT last_roll, pity, total_rolls FROM gacha_state WHERE guild_id = ? AND user_id = ?")
    .get(guildId, userId);
  if (!row) return defaultGachaState();
  return {
    last_roll: row.last_roll === null || row.last_roll === undefined ? null : Number(row.last_roll),
    pity: Number(row.pity ?? 0),
    total_rolls: Number(row.total_rolls ?? 0),
  };
}

export type RollResult =
  | { ok: true; card: GachaCard; rarity: Rarity; pity: number; totalRolls: number }
  | { ok: false; error: string; remainingMs?: number };

/** Full roll: cooldown check, roll, persist card + state. Nothing is deducted. */
export async function doRoll(
  db: SelenaDb,
  guildId: string,
  userId: string,
  cards: readonly GachaCard[],
  nowMs: number = Date.now(),
  rand: () => number = secureFloat,
): Promise<RollResult> {
  if (cards.length === 0) {
    return { ok: false, error: "Gacha cards aren't configured yet — no hero cards are loaded." };
  }
  const state = await getGachaState(db, guildId, userId);
  const check = canRoll(state, nowMs);
  if (!check.allowed) {
    return {
      ok: false,
      error: `You're on cooldown — you can roll again in ${Math.ceil(check.remainingMs / 60000)} minute(s).`,
      remainingMs: check.remainingMs,
    };
  }
  let rolled;
  try {
    rolled = rollCard(cards, state, rand);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Roll failed." };
  }
  await db.prepare(
    `INSERT INTO gacha_cards (guild_id, user_id, card_id, count) VALUES (?, ?, ?, 1)
     ON CONFLICT(guild_id, user_id, card_id) DO UPDATE SET count = gacha_cards.count + 1`,
  ).run(guildId, userId, rolled.card.id);
  const totalRolls = state.total_rolls + 1;
  await db.prepare(
    `INSERT INTO gacha_state (guild_id, user_id, last_roll, pity, total_rolls) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET last_roll = excluded.last_roll, pity = excluded.pity, total_rolls = excluded.total_rolls`,
  ).run(guildId, userId, nowMs, rolled.newPity, totalRolls);
  return { ok: true, card: rolled.card, rarity: rolled.rarity, pity: rolled.newPity, totalRolls };
}

export interface CollectionEntry {
  cardId: string;
  name: string;
  rarity: Rarity | "Unknown";
  count: number;
}

export interface CollectionSummary {
  byRarity: Record<string, CollectionEntry[]>;
  totalDistinct: number;
  totalCards: number;
}

/**
 * Owned cards grouped by rarity. Pass the card catalogue (from
 * loadGachaCards) for names/rarities; without it, cards group under
 * "Unknown" with the card id as the name.
 */
export async function collectionSummary(
  db: SelenaDb,
  guildId: string,
  userId: string,
  cards?: readonly GachaCard[],
): Promise<CollectionSummary> {
  const rows = await db
    .prepare("SELECT card_id, count FROM gacha_cards WHERE guild_id = ? AND user_id = ? ORDER BY card_id")
    .all(guildId, userId);
  const byId = new Map((cards ?? []).map((c) => [c.id, c]));
  const byRarity: Record<string, CollectionEntry[]> = {};
  let totalCards = 0;
  for (const row of rows) {
    const cardId = String(row.card_id);
    const count = Number(row.count);
    totalCards += count;
    const meta = byId.get(cardId);
    const entry: CollectionEntry = {
      cardId,
      name: meta?.name ?? cardId,
      rarity: meta?.rarity ?? "Unknown",
      count,
    };
    const key = entry.rarity;
    if (!byRarity[key]) byRarity[key] = [];
    byRarity[key]!.push(entry);
  }
  return { byRarity, totalDistinct: rows.length, totalCards };
}

export type SwapResult = { ok: true } | { ok: false; error: string };

/**
 * Atomic two-way card swap. Both users must own the card they offer.
 * On any failure nothing changes (single transaction).
 */
export async function swapCards(
  db: SelenaDb,
  guildId: string,
  userA: string,
  cardA: string,
  userB: string,
  cardB: string,
): Promise<SwapResult> {
  if (userA === userB) return { ok: false, error: "You can't trade with yourself." };
  if (!cardA || !cardB) return { ok: false, error: "Both cards must be specified." };
  const owns = async (tx: SelenaDb, userId: string, cardId: string): Promise<boolean> => {
    const row = await tx
      .prepare("SELECT count FROM gacha_cards WHERE guild_id = ? AND user_id = ? AND card_id = ?")
      .get(guildId, userId, cardId);
    return !!row && Number(row.count) > 0;
  };
  if (!(await owns(db, userA, cardA))) return { ok: false, error: `<@${userA}> no longer owns \`${cardA}\`.` };
  if (!(await owns(db, userB, cardB))) return { ok: false, error: `<@${userB}> no longer owns \`${cardB}\`.` };

  const take = async (tx: SelenaDb, userId: string, cardId: string): Promise<void> => {
    const row = await tx
      .prepare("SELECT count FROM gacha_cards WHERE guild_id = ? AND user_id = ? AND card_id = ?")
      .get(guildId, userId, cardId);
    if (!row) throw new Error("swap: missing card row");
    if (Number(row.count) <= 1) {
      await tx.prepare("DELETE FROM gacha_cards WHERE guild_id = ? AND user_id = ? AND card_id = ?").run(guildId, userId, cardId);
    } else {
      await tx.prepare("UPDATE gacha_cards SET count = count - 1 WHERE guild_id = ? AND user_id = ? AND card_id = ?").run(guildId, userId, cardId);
    }
  };
  const give = async (tx: SelenaDb, userId: string, cardId: string): Promise<void> => {
    await tx.prepare(
      `INSERT INTO gacha_cards (guild_id, user_id, card_id, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(guild_id, user_id, card_id) DO UPDATE SET count = gacha_cards.count + 1`,
    ).run(guildId, userId, cardId);
  };

  try {
    await db.transaction(async (tx) => {
      await take(tx, userA, cardA);
      await take(tx, userB, cardB);
      await give(tx, userA, cardB);
      await give(tx, userB, cardA);
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Trade failed." };
  }
  return { ok: true };
}

export interface LeaderboardEntry {
  userId: string;
  distinctCards: number;
  totalCards: number;
}

/** Top collectors by distinct cards, then total cards. */
export async function gachaLeaderboard(db: SelenaDb, guildId: string, limit = 10): Promise<LeaderboardEntry[]> {
  const rows = await db
    .prepare(
      `SELECT user_id, COUNT(*) AS distinct_cards, SUM(count) AS total_cards
       FROM gacha_cards WHERE guild_id = ? GROUP BY user_id
       ORDER BY distinct_cards DESC, total_cards DESC, user_id ASC LIMIT ?`,
    )
    .all(guildId, limit);
  return rows.map((r) => ({
    userId: String(r.user_id),
    distinctCards: Number(r.distinct_cards),
    totalCards: Number(r.total_cards),
  }));
}

export async function ownsCard(db: SelenaDb, guildId: string, userId: string, cardId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT count FROM gacha_cards WHERE guild_id = ? AND user_id = ? AND card_id = ?")
    .get(guildId, userId, cardId);
  return !!row && Number(row.count) > 0;
}

// ---------------------------------------------------------------------------
// Card catalogue loading (src/data/heroes.ts, owned by another worker).
// The import uses a non-literal specifier so this module still typechecks
// and runs when heroes.ts does not exist yet — it then resolves to [].
// ---------------------------------------------------------------------------

let cachedCards: GachaCard[] | null = null;

/** Clear the in-memory catalogue cache (tests / catalogue reloads). */
export function resetGachaCardCache(): void {
  cachedCards = null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function normalizeCard(v: unknown): GachaCard | null {
  if (!isRecord(v)) return null;
  const id = typeof v.id === "string" ? v.id : "";
  const name = typeof v.name === "string" ? v.name : "";
  const heroId = typeof v.heroId === "string" ? v.heroId : id;
  const rarity = typeof v.rarity === "string" ? v.rarity : "";
  if (!id || !name || !RARITIES.includes(rarity as Rarity)) return null;
  const card: GachaCard = { id, heroId, name, rarity: rarity as Rarity };
  if (typeof v.skin === "string" && v.skin) card.skin = v.skin;
  return card;
}

/**
 * Load GACHA_CARDS from ../data/heroes.js. Returns [] (no throw) when the
 * file is missing or exports nothing usable. Non-empty results are cached;
 * empty results are retried on the next call so a file created later is
 * picked up without a restart.
 */
export async function loadGachaCards(): Promise<GachaCard[]> {
  if (cachedCards) return cachedCards;
  try {
    const specifier = "../data/heroes.js";
    const mod = (await import(specifier)) as Record<string, unknown>;
    const raw = Array.isArray(mod.GACHA_CARDS) ? mod.GACHA_CARDS : [];
    const cards = raw.map(normalizeCard).filter((c): c is GachaCard => c !== null);
    if (cards.length > 0) cachedCards = cards;
    return cards;
  } catch {
    return [];
  }
}

/** Hero names for draft validation, de-duplicated by heroId. */
export async function loadHeroNames(): Promise<string[]> {
  try {
    const specifier = "../data/heroes.js";
    const mod = (await import(specifier)) as Record<string, unknown>;
    const names: string[] = [];
    const seen = new Set<string>();
    const pushName = (n: unknown): void => {
      if (typeof n === "string" && n.trim() && !seen.has(n.trim().toLowerCase())) {
        seen.add(n.trim().toLowerCase());
        names.push(n.trim());
      }
    };
    if (Array.isArray(mod.GACHA_CARDS)) {
      const byHero = new Map<string, string>();
      for (const raw of mod.GACHA_CARDS) {
        if (!isRecord(raw)) continue;
        if (typeof raw.name === "string") {
          const key = typeof raw.heroId === "string" ? raw.heroId : raw.name;
          if (!byHero.has(key)) byHero.set(key, raw.name);
        }
      }
      for (const n of byHero.values()) pushName(n);
    }
    if (Array.isArray(mod.HEROES)) {
      for (const h of mod.HEROES) {
        if (typeof h === "string") pushName(h);
        else if (isRecord(h) && typeof h.name === "string") pushName(h.name);
      }
    }
    return names;
  } catch {
    return [];
  }
}
