import type { SelenaDb } from "./db.js";
import { addPoints } from "./economy.js";
import {
  MONSTER_BY_ID,
  PETS,
  PET_BY_ID,
  WEAPONS,
  WEAPON_BY_ID,
  drawMonsterOfTier,
  findMonsterByName,
  type Monster,
  type Pet,
  type Tier,
  type Weapon,
} from "./hunt.js";
import { getOwnedCount, getUserInstances, utcDayString } from "./huntDb.js";
import { mulberry32, secureFloat, weightedPick } from "./rng.js";

/**
 * Market — auction house + daily shop + crates + gem wallet
 * (Phase 2, design docs/hunt-world-phase2-design.md §8–§9).
 *
 * Locked numbers (Ron's, do not re-decide): auction is GLOBAL across
 * Discord, fixed 24h duration, 5% seller fee, unsold items return to
 * the seller, anything can be auctioned; shop refreshes daily at
 * midnight UTC with the SAME stock for everyone and a per-player qty
 * limit; crates are named "Crate" (Wooden/Iron/Silver/Golden/Crystal/
 * Void) and drop from towers/hunts/bosses.
 *
 * Everything below is database-backed (Supabase via SelenaDb) — no
 * in-memory state. All money moves are fail-closed: a failed escrow
 * debit/refund refuses the bid, never grants the item.
 *
 * Tables used (all already in db.ts SCHEMA): auctions, auction_bids,
 * shop_stock, user_shop_buys, user_crates, user_materials, user_items,
 * user_wallet, user_monsters, user_monster_instances, user_weapons,
 * user_pets, users, user_hunt.
 */

// ---------------------------------------------------------------------------
// Auctions — constants
// ---------------------------------------------------------------------------

/** Fixed auction duration: 24 hours (locked). */
export const AUCTION_DURATION_MS = 24 * 60 * 60 * 1000;
/** Minimum starting price in gold (working default, design §8.1). */
export const AUCTION_MIN_START_PRICE = 100;
/** Seller fee in percent of the winning bid (locked at 5%). */
export const AUCTION_FEE_PERCENT = 5;
/** Minimum raise over the current bid, in percent (working default). */
export const AUCTION_MIN_INCREMENT_PERCENT = 10;

export type AuctionItemType = "monster" | "weapon" | "pet" | "item" | "crate";

export type AuctionStatus = "open" | "sold" | "expired" | "cancelled";

export interface Auction {
  id: number;
  sellerId: string;
  itemType: AuctionItemType;
  itemRef: string;
  startPrice: number;
  currentBid: number | null;
  currentBidder: string | null;
  endsAt: number;
  status: AuctionStatus;
  createdAt: number;
}

function auctionFromRow(r: Record<string, unknown>): Auction {
  return {
    id: Number(r.id),
    sellerId: String(r.seller_id),
    itemType: String(r.item_type) as AuctionItemType,
    itemRef: String(r.item_ref),
    startPrice: Number(r.start_price),
    currentBid: r.current_bid == null ? null : Number(r.current_bid),
    currentBidder: r.current_bidder == null ? null : String(r.current_bidder),
    endsAt: Number(r.ends_at),
    status: String(r.status) as AuctionStatus,
    createdAt: Number(r.created_at),
  };
}

/** Fee on a winning bid, in gold (floor — the seller never pays more than 5%). */
export function auctionFee(bid: number): number {
  return Math.floor((bid * AUCTION_FEE_PERCENT) / 100);
}

/** What the seller receives from a winning bid (bid minus the 5% fee). */
export function sellerProceeds(bid: number): number {
  return bid - auctionFee(bid);
}

/** Minimum next bid: the start price when there are no bids, else +10% over the current bid. */
export function minNextBid(a: Auction): number {
  if (a.currentBid === null) return a.startPrice;
  return Math.ceil((a.currentBid * (100 + AUCTION_MIN_INCREMENT_PERCENT)) / 100);
}

// ---------------------------------------------------------------------------
// Crate tiers (declared early — the shop catalogue below builds crate
// entries from them, so they must exist before it runs)
// ---------------------------------------------------------------------------

export type CrateTierSlug = "wooden" | "iron" | "silver" | "golden" | "crystal" | "void";

export interface CrateTier {
  slug: CrateTierSlug;
  name: string;
  tier: Tier;
}

export const CRATE_TIERS: readonly CrateTier[] = [
  { slug: "wooden", name: "Wooden Crate", tier: "Common" },
  { slug: "iron", name: "Iron Crate", tier: "Uncommon" },
  { slug: "silver", name: "Silver Crate", tier: "Rare" },
  { slug: "golden", name: "Golden Crate", tier: "Epic" },
  { slug: "crystal", name: "Crystal Crate", tier: "Legendary" },
  { slug: "void", name: "Void Crate", tier: "Mythic" },
];

export const CRATE_TIER_BY_SLUG: Record<string, CrateTier> = Object.fromEntries(
  CRATE_TIERS.map((c) => [c.slug, c]),
);

export const CRATE_MATERIALS: readonly string[] = ["shards", "scales", "fangs", "feathers", "crystals", "ores"];

// ---------------------------------------------------------------------------
// Item refs
// ---------------------------------------------------------------------------
//
// item_ref encoding (auctions.item_ref is TEXT):
//   monster -> "<monsterId>" or "<monsterId>:<level>:<fuseLevel>"
//              (level/fuse are preserved so a listed +6 Lv 40 monster
//              comes back exactly as it was — for the winner, or for
//              the seller when it goes unsold)
//   weapon  -> "<weaponId>"
//   pet     -> "<petId>"
//   item    -> "<itemId>" (shop catalogue id, e.g. "heal-potion")
//   crate   -> "<tier slug>" (e.g. "wooden")
//
// ---------------------------------------------------------------------------

export interface ResolvedItem {
  type: AuctionItemType;
  ref: string;
  /** Plain-text display, e.g. "Stone Beetle · Lv 12 +2 · Common". */
  display: string;
}

function parseMonsterRef(ref: string): { id: number; level: number; fuseLevel: number } {
  const [id, level, fuse] = ref.split(":");
  return {
    id: Number(id ?? 0),
    level: Number(level ?? 1) || 1,
    fuseLevel: Number(fuse ?? 0) || 0,
  };
}

/** Human-readable display for an auctioned item (roster lookups only, no DB). */
export function describeAuctionItem(itemType: AuctionItemType, itemRef: string): string {
  if (itemType === "monster") {
    const { id, level, fuseLevel } = parseMonsterRef(itemRef);
    const m = MONSTER_BY_ID.get(id);
    if (!m) return `Unknown monster #${id}`;
    const fuse = fuseLevel > 0 ? ` +${fuseLevel}` : "";
    return `${m.name} · Lv ${level}${fuse} · ${m.tier}`;
  }
  if (itemType === "weapon") {
    const w = WEAPON_BY_ID.get(Number(itemRef));
    return w ? `${w.name} · ${w.tier} (+${w.atk} ATK)` : `Unknown weapon #${itemRef}`;
  }
  if (itemType === "pet") {
    const p = PET_BY_ID.get(Number(itemRef));
    return p ? `${p.name} · ${p.tier}` : `Unknown pet #${itemRef}`;
  }
  if (itemType === "crate") {
    const tier = CRATE_TIERS.find((c) => c.slug === itemRef);
    return tier ? tier.name : `Unknown crate "${itemRef}"`;
  }
  const item = SHOP_ITEM_BY_ID[itemRef];
  return item ? item.name : itemRef;
}

/** Resolve a free-text name ("Stone Beetle", "Wooden Crate", "Heal Potion") to a listable item. */
export function resolveListableItem(name: string): ResolvedItem | undefined {
  const q = name.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return undefined;
  const monster = findMonsterByName(q);
  if (monster) {
    return { type: "monster", ref: String(monster.id), display: `${monster.name} · ${monster.tier}` };
  }
  const weapon = WEAPONS.find((w) => w.name.toLowerCase() === q);
  if (weapon) {
    return { type: "weapon", ref: String(weapon.id), display: `${weapon.name} · ${weapon.tier}` };
  }
  const pet = PETS.find((p) => p.name.toLowerCase() === q);
  if (pet) {
    return { type: "pet", ref: String(pet.id), display: `${pet.name} · ${pet.tier}` };
  }
  const crate = CRATE_TIERS.find((c) => c.slug === q || c.name.toLowerCase() === q || `crate ${c.slug}` === q);
  if (crate) {
    return { type: "crate", ref: crate.slug, display: crate.name };
  }
  const item =
    SHOP_ITEM_BY_ID[q] ??
    Object.values(SHOP_ITEM_BY_ID).find((i) => i.name.toLowerCase() === q);
  if (item) {
    return { type: "item", ref: item.id, display: item.name };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Guild resolution (auctions are global — the tables carry no guild_id)
// ---------------------------------------------------------------------------
//
// user_monsters / user_weapons / user_pets / users are keyed by
// (guild_id, user_id), but auctions/auction_bids carry only user ids
// (the market is global across Discord). When gold or an item has to
// move for a user at close time, the guild is resolved in this order:
// the guild where the user already owns monsters/weapons/pets, else
// their hunt guild, else any guild where they have a users row. A
// user who listed or bid always has a users row in the guild they
// used (every command ensures it), so this resolves in practice; when
// it cannot resolve, the close is left open to retry next sweep
// rather than losing the item or the gold.
// ---------------------------------------------------------------------------

export async function resolveGuildForUser(db: SelenaDb, userId: string): Promise<string | null> {
  const queries: string[] = [
    "SELECT guild_id FROM user_monsters WHERE user_id = ? LIMIT 1",
    "SELECT guild_id FROM user_weapons WHERE user_id = ? LIMIT 1",
    "SELECT guild_id FROM user_pets WHERE user_id = ? LIMIT 1",
    "SELECT guild_id FROM user_hunt WHERE user_id = ? LIMIT 1",
    "SELECT guild_id FROM users WHERE user_id = ? LIMIT 1",
  ];
  for (const sql of queries) {
    try {
      const row = (await db.prepare(sql).get(userId)) as { guild_id: unknown } | undefined;
      if (row?.guild_id != null) return String(row.guild_id);
    } catch {
      /* try the next source — a failed lookup never blocks settlement */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Take / grant one copy of an item (guild-scoped ownership tables)
// ---------------------------------------------------------------------------

/**
 * Remove one copy of an item from a user's inventory. Returns the
 * monster level/fuse when the item was a monster (so the listing can
 * preserve it), or null when the user does not own the item.
 * The WEAKEST monster copy is listed (lowest fuse, then lowest level)
 * — same choice removeOneMonster makes.
 */
export async function takeItem(
  db: SelenaDb,
  guildId: string,
  userId: string,
  itemType: AuctionItemType,
  itemRef: string,
): Promise<{ level: number; fuseLevel: number } | null> {
  if (itemType === "monster") {
    const { id } = parseMonsterRef(itemRef);
    const owned = await getOwnedCount(db, guildId, userId, id);
    if (owned <= 0) return null;
    const instances = await getUserInstances(db, guildId, userId, id);
    const weakest = [...instances].sort(
      (a, b) => a.fuseLevel - b.fuseLevel || a.level - b.level || a.id - b.id,
    )[0];
    if (owned === 1) {
      await db
        .prepare("DELETE FROM user_monsters WHERE guild_id = ? AND user_id = ? AND monster_id = ?")
        .run(guildId, userId, id);
    } else {
      await db
        .prepare("UPDATE user_monsters SET count = count - 1 WHERE guild_id = ? AND user_id = ? AND monster_id = ?")
        .run(guildId, userId, id);
    }
    if (weakest) {
      await db.prepare("DELETE FROM user_monster_instances WHERE id = ?").run(weakest.id);
      return { level: weakest.level, fuseLevel: weakest.fuseLevel };
    }
    return { level: 1, fuseLevel: 0 };
  }
  if (itemType === "weapon" || itemType === "pet") {
    const table = itemType === "weapon" ? "user_weapons" : "user_pets";
    const idCol = itemType === "weapon" ? "weapon_id" : "pet_id";
    const flagCol = itemType === "weapon" ? "equipped" : "active";
    const row = (await db
      .prepare(`SELECT count FROM ${table} WHERE guild_id = ? AND user_id = ? AND ${idCol} = ?`)
      .get(guildId, userId, Number(itemRef))) as { count: number } | undefined;
    const count = Number(row?.count ?? 0);
    if (count <= 0) return null;
    if (count === 1) {
      await db
        .prepare(`DELETE FROM ${table} WHERE guild_id = ? AND user_id = ? AND ${idCol} = ?`)
        .run(guildId, userId, Number(itemRef));
    } else {
      // A listed copy is unequipped/deactivated — it is not worn while it is on sale.
      await db
        .prepare(
          `UPDATE ${table} SET count = count - 1, ${flagCol} = 0 WHERE guild_id = ? AND user_id = ? AND ${idCol} = ?`,
        )
        .run(guildId, userId, Number(itemRef));
    }
    return { level: 1, fuseLevel: 0 };
  }
  if (itemType === "item") {
    const row = (await db
      .prepare("SELECT qty FROM user_items WHERE user_id = ? AND item_id = ?")
      .get(userId, itemRef)) as { qty: number } | undefined;
    const qty = Number(row?.qty ?? 0);
    if (qty <= 0) return null;
    if (qty === 1) {
      await db.prepare("DELETE FROM user_items WHERE user_id = ? AND item_id = ?").run(userId, itemRef);
    } else {
      await db.prepare("UPDATE user_items SET qty = qty - 1 WHERE user_id = ? AND item_id = ?").run(userId, itemRef);
    }
    return { level: 1, fuseLevel: 0 };
  }
  // crate
  const row = (await db
    .prepare("SELECT qty FROM user_crates WHERE user_id = ? AND crate_tier = ?")
    .get(userId, itemRef)) as { qty: number } | undefined;
  const qty = Number(row?.qty ?? 0);
  if (qty <= 0) return null;
  if (qty === 1) {
    await db.prepare("DELETE FROM user_crates WHERE user_id = ? AND crate_tier = ?").run(userId, itemRef);
  } else {
    await db.prepare("UPDATE user_crates SET qty = qty - 1 WHERE user_id = ? AND crate_tier = ?").run(userId, itemRef);
  }
  return { level: 1, fuseLevel: 0 };
}

/**
 * Give one copy of an item to a user. Monsters are created at the
 * given level/fuse (preserved from the listing); everything else is a
 * plain count upsert. `source` is recorded on monster rows
 * ('auction' / 'crate' / 'shop') — these are OWNED, not caught or
 * rolled, so the per-server catch/roll caps never apply here
 * (design §7.2: no cap on buying/owning).
 */
export async function grantItem(
  db: SelenaDb,
  guildId: string,
  userId: string,
  itemType: AuctionItemType,
  itemRef: string,
  nowMs: number,
  opts: { level?: number; fuseLevel?: number; source?: string } = {},
): Promise<void> {
  const source = opts.source ?? "auction";
  if (itemType === "monster") {
    const { id } = parseMonsterRef(itemRef);
    const parsed = parseMonsterRef(itemRef);
    const level = Math.max(1, Math.min(100, Math.floor(opts.level ?? parsed.level ?? 1)));
    const fuseLevel = Math.max(0, Math.min(6, Math.floor(opts.fuseLevel ?? parsed.fuseLevel ?? 0)));
    await db
      .prepare(
        "INSERT INTO user_monsters (guild_id, user_id, monster_id, count, source, caught_at) VALUES (?, ?, ?, 1, ?, ?) " +
          "ON CONFLICT (guild_id, user_id, monster_id) DO UPDATE SET count = user_monsters.count + 1, caught_at = EXCLUDED.caught_at",
      )
      .run(guildId, userId, id, source, nowMs);
    await db
      .prepare(
        "INSERT INTO user_monster_instances (guild_id, user_id, monster_id, level, xp, fuse_level, source, caught_at) " +
          "VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
      )
      .run(guildId, userId, id, level, fuseLevel, source, nowMs);
    return;
  }
  if (itemType === "weapon" || itemType === "pet") {
    const table = itemType === "weapon" ? "user_weapons" : "user_pets";
    const idCol = itemType === "weapon" ? "weapon_id" : "pet_id";
    const flagCol = itemType === "weapon" ? "equipped" : "active";
    await db
      .prepare(
        `INSERT INTO ${table} (guild_id, user_id, ${idCol}, count, ${flagCol}) VALUES (?, ?, ?, 1, 0) ` +
          `ON CONFLICT (guild_id, user_id, ${idCol}) DO UPDATE SET count = ${table}.count + 1`,
      )
      .run(guildId, userId, Number(itemRef));
    return;
  }
  if (itemType === "item") {
    await db
      .prepare(
        "INSERT INTO user_items (user_id, item_id, qty) VALUES (?, ?, 1) " +
          "ON CONFLICT (user_id, item_id) DO UPDATE SET qty = user_items.qty + 1",
      )
      .run(userId, itemRef);
    return;
  }
  await db
    .prepare(
      "INSERT INTO user_crates (user_id, crate_tier, qty) VALUES (?, ?, 1) " +
        "ON CONFLICT (user_id, crate_tier) DO UPDATE SET qty = user_crates.qty + 1",
    )
    .run(userId, itemRef);
}

// ---------------------------------------------------------------------------
// Auctions — list / bid / cancel / read
// ---------------------------------------------------------------------------

export async function getAuction(db: SelenaDb, auctionId: number): Promise<Auction | undefined> {
  const row = (await db
    .prepare("SELECT id, seller_id, item_type, item_ref, start_price, current_bid, current_bidder, ends_at, status, created_at FROM auctions WHERE id = ?")
    .get(auctionId)) as Record<string, unknown> | undefined;
  return row ? auctionFromRow(row) : undefined;
}

/** Live auctions across Discord, soonest-ending first. */
export async function listAuctions(db: SelenaDb, nowMs: number, limit = 20): Promise<Auction[]> {
  const rows = (await db
    .prepare(
      "SELECT id, seller_id, item_type, item_ref, start_price, current_bid, current_bidder, ends_at, status, created_at " +
        "FROM auctions WHERE status = 'open' AND ends_at > ? ORDER BY ends_at ASC LIMIT ?",
    )
    .all(nowMs, limit)) as Record<string, unknown>[];
  return rows.map(auctionFromRow);
}

/** A seller's own open auctions. */
export async function listMyAuctions(db: SelenaDb, sellerId: string, nowMs: number): Promise<Auction[]> {
  const rows = (await db
    .prepare(
      "SELECT id, seller_id, item_type, item_ref, start_price, current_bid, current_bidder, ends_at, status, created_at " +
        "FROM auctions WHERE status = 'open' AND seller_id = ? ORDER BY ends_at ASC",
    )
    .all(sellerId)) as Record<string, unknown>[];
  return rows.map(auctionFromRow).filter((a) => a.endsAt > nowMs);
}

/** Bid history for one auction, most recent first. */
export async function getAuctionBids(
  db: SelenaDb,
  auctionId: number,
  limit = 10,
): Promise<{ bidderId: string; amount: number; refunded: boolean; createdAt: number }[]> {
  const rows = (await db
    .prepare("SELECT bidder_id, amount, refunded, created_at FROM auction_bids WHERE auction_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(auctionId, limit)) as Record<string, unknown>[];
  return rows.map((r) => ({
    bidderId: String(r.bidder_id),
    amount: Number(r.amount),
    refunded: Number(r.refunded ?? 0) !== 0,
    createdAt: Number(r.created_at),
  }));
}

/**
 * Make sure a (guild, user) row exists — every command caller has
 * one in practice (getBalance ensures it), but list/bid can also be
 * reached from lib callers. The row is what lets closeDueAuctions
 * resolve a guild for the seller/winner later (see
 * resolveGuildForUser): without it, a seller who listed their only
 * monster would have no guild on record at close time.
 */
async function ensureUserRow(db: SelenaDb, guildId: string, userId: string): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO users (guild_id, user_id) VALUES (?, ?)").run(guildId, userId);
}

/**
 * List an item for 24h. The item leaves the seller's inventory at
 * listing time and is held by the auction. Fail-closed: an unowned
 * item or a bad price refuses before anything moves.
 */
export async function listAuction(
  db: SelenaDb,
  guildId: string,
  sellerId: string,
  item: ResolvedItem,
  startPrice: number,
  nowMs: number,
): Promise<{ ok: boolean; error?: string; auction?: Auction }> {
  if (!Number.isInteger(startPrice) || startPrice < AUCTION_MIN_START_PRICE) {
    return { ok: false, error: `Starting price must be at least ${AUCTION_MIN_START_PRICE} gold.` };
  }
  try {
    const auction = await db.transaction(async (tx) => {
      await ensureUserRow(tx, guildId, sellerId);
      const taken = await takeItem(tx, guildId, sellerId, item.type, item.ref);
      if (!taken) throw new Error(`You don't own ${item.display}.`);
      // Preserve a monster's level/fuse in the ref so the winner (or
      // the seller, on an unsold return) gets the same copy back.
      const ref =
        item.type === "monster"
          ? `${item.ref}:${taken.level}:${taken.fuseLevel}`
          : item.ref;
      const res = await tx
        .prepare(
          "INSERT INTO auctions (seller_id, item_type, item_ref, start_price, current_bid, current_bidder, ends_at, status, created_at) " +
            "VALUES (?, ?, ?, ?, NULL, NULL, ?, 'open', ?)",
        )
        .run(sellerId, item.type, ref, startPrice, nowMs + AUCTION_DURATION_MS, nowMs);
      const created = await getAuction(tx, Number(res.lastInsertRowid));
      if (!created) throw new Error("Auction row was not created.");
      return created;
    });
    return { ok: true, auction };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't list that item." };
  }
}

/**
 * Place a binding bid. Gold is escrowed immediately (deducted from
 * the bidder); the previous bidder is auto-refunded at once. Every
 * failure — unknown/closed auction, self-bid, too-low bid,
 * insufficient gold, a failed refund — refuses the bid and moves no
 * gold. Runs in one transaction so a mid-bid failure rolls the
 * escrow back on real Postgres.
 */
export async function placeBid(
  db: SelenaDb,
  guildId: string,
  auctionId: number,
  bidderId: string,
  amount: number,
  nowMs: number,
): Promise<{ ok: boolean; error?: string; auction?: Auction; refundedBidder?: string; refundedAmount?: number }> {
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, error: "Bid must be a positive whole number of gold." };
  }
  try {
    const out = await db.transaction(async (tx) => {
      await ensureUserRow(tx, guildId, bidderId);
      const auction = await getAuction(tx, auctionId);
      if (!auction) throw new Error(`No auction #${auctionId}.`);
      if (auction.status !== "open" || auction.endsAt <= nowMs) {
        throw new Error(`Auction #${auctionId} is closed.`);
      }
      if (auction.sellerId === bidderId) throw new Error("You can't bid on your own listing.");
      const minimum = minNextBid(auction);
      if (amount < minimum) {
        throw new Error(
          auction.currentBid === null
            ? `The starting price is ${minimum} gold — bid at least that.`
            : `You need to bid at least ${minimum} gold (10% over the current ${auction.currentBid}).`,
        );
      }
      // Escrow the new bid FIRST — addPoints throws on insufficient
      // gold, which aborts the transaction before anything else moves.
      await addPoints(tx, guildId, bidderId, -amount, `auction bid #${auctionId}`);
      // Refund the outbid bidder at once (their gold was escrowed).
      let refundedBidder: string | undefined;
      let refundedAmount: number | undefined;
      if (auction.currentBidder !== null && auction.currentBid !== null) {
        const prevBidder = auction.currentBidder;
        const prevAmount = auction.currentBid;
        const prevGuild = await resolveGuildForUser(tx, prevBidder);
        if (prevGuild === null) throw new Error("Couldn't refund the previous bidder — bid refused.");
        await addPoints(tx, prevGuild, prevBidder, prevAmount, `auction outbid refund #${auctionId}`);
        await tx
          .prepare("UPDATE auction_bids SET refunded = 1 WHERE auction_id = ? AND bidder_id = ? AND refunded = 0")
          .run(auctionId, prevBidder);
        refundedBidder = prevBidder;
        refundedAmount = prevAmount;
      }
      await tx
        .prepare("UPDATE auctions SET current_bid = ?, current_bidder = ? WHERE id = ? AND status = 'open'")
        .run(amount, bidderId, auctionId);
      await tx
        .prepare("INSERT INTO auction_bids (auction_id, bidder_id, amount, created_at, refunded) VALUES (?, ?, ?, ?, 0)")
        .run(auctionId, bidderId, amount, nowMs);
      const updated = await getAuction(tx, auctionId);
      if (!updated) throw new Error("Auction vanished mid-bid.");
      return { auction: updated, refundedBidder, refundedAmount };
    });
    return { ok: true, ...out };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't place that bid." };
  }
}

/**
 * Cancel a listing — only the seller, only while it has NO bids
 * (design §8.2). The item returns to the seller immediately.
 */
export async function cancelAuction(
  db: SelenaDb,
  guildId: string,
  auctionId: number,
  sellerId: string,
  nowMs: number,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await db.transaction(async (tx) => {
      const auction = await getAuction(tx, auctionId);
      if (!auction) throw new Error(`No auction #${auctionId}.`);
      if (auction.sellerId !== sellerId) throw new Error("Only the seller can cancel this listing.");
      if (auction.status !== "open" || auction.endsAt <= nowMs) throw new Error(`Auction #${auctionId} is closed.`);
      if (auction.currentBid !== null) throw new Error("This listing already has bids — it runs to the end now.");
      const parsed = parseMonsterRef(auction.itemRef);
      await grantItem(tx, guildId, sellerId, auction.itemType, auction.itemRef, nowMs, {
        source: "auction",
        level: parsed.level,
        fuseLevel: parsed.fuseLevel,
      });
      await tx.prepare("UPDATE auctions SET status = 'cancelled' WHERE id = ?").run(auctionId);
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't cancel that listing." };
  }
}

// ---------------------------------------------------------------------------
// Auction close sweep
// ---------------------------------------------------------------------------

/** Minimal client surface the close sweep needs (a real discord.js Client fits). */
export interface MarketClient {
  users?: { fetch: (id: string) => Promise<{ send: (msg: unknown) => Promise<unknown> }> };
}

async function dmUser(client: MarketClient | null, userId: string, content: string): Promise<void> {
  if (!client?.users) return;
  try {
    const user = await client.users.fetch(userId);
    await user.send({ content });
  } catch {
    /* a closed DM / left user never breaks the sweep */
  }
}

export interface CloseSummary {
  due: number;
  sold: number;
  expired: number;
  failed: number;
}

/**
 * Settle every auction whose 24h is up. Highest bidder gets the
 * item, seller gets the bid minus the 5% fee; with no bids the item
 * returns to the seller. NEVER throws — a failed settlement is
 * counted, logged, and left open to retry on the next sweep (never
 * half-settled: each auction settles inside one transaction, and the
 * status flip is the last step). When a client is provided, the
 * winner and seller are DM'd their result; with a null client the
 * sweep settles silently. Double-close is a no-op: only rows still
 * 'open' are picked up, and the in-transaction re-read refuses rows
 * that already closed.
 */
export async function closeDueAuctions(
  db: SelenaDb,
  client: MarketClient | null,
  nowMs: number,
): Promise<CloseSummary> {
  const summary: CloseSummary = { due: 0, sold: 0, expired: 0, failed: 0 };
  let due: Auction[];
  try {
    const rows = (await db
      .prepare(
        "SELECT id, seller_id, item_type, item_ref, start_price, current_bid, current_bidder, ends_at, status, created_at " +
          "FROM auctions WHERE status = 'open' AND ends_at <= ? ORDER BY ends_at ASC",
      )
      .all(nowMs)) as Record<string, unknown>[];
    due = rows.map(auctionFromRow);
  } catch (e) {
    console.error("uwu: auction close sweep query failed:", e instanceof Error ? e.message : e);
    return summary;
  }
  summary.due = due.length;
  for (const a of due) {
    try {
      const outcome = await db.transaction(async (tx) => {
        const fresh = await getAuction(tx, a.id);
        if (!fresh || fresh.status !== "open" || fresh.endsAt > nowMs) return null; // already closed / not due
        const sellerGuild = await resolveGuildForUser(tx, fresh.sellerId);
        if (sellerGuild === null) throw new Error(`no guild resolvable for seller ${fresh.sellerId}`);
        const parsed = parseMonsterRef(fresh.itemRef);
        if (fresh.currentBidder !== null && fresh.currentBid !== null) {
          const winnerGuild = await resolveGuildForUser(tx, fresh.currentBidder);
          if (winnerGuild === null) throw new Error(`no guild resolvable for winner ${fresh.currentBidder}`);
          await grantItem(tx, winnerGuild, fresh.currentBidder, fresh.itemType, fresh.itemRef, nowMs, {
            source: "auction",
            level: parsed.level,
            fuseLevel: parsed.fuseLevel,
          });
          const proceeds = sellerProceeds(fresh.currentBid);
          await addPoints(tx, sellerGuild, fresh.sellerId, proceeds, `auction sale #${fresh.id}`);
          await tx.prepare("UPDATE auctions SET status = 'sold' WHERE id = ? AND status = 'open'").run(fresh.id);
          return { kind: "sold" as const, auction: fresh, proceeds };
        }
        await grantItem(tx, sellerGuild, fresh.sellerId, fresh.itemType, fresh.itemRef, nowMs, {
          source: "auction",
          level: parsed.level,
          fuseLevel: parsed.fuseLevel,
        });
        await tx.prepare("UPDATE auctions SET status = 'expired' WHERE id = ? AND status = 'open'").run(fresh.id);
        return { kind: "expired" as const, auction: fresh, proceeds: 0 };
      });
      if (outcome === null) continue; // raced with another closer — already settled
      if (outcome.kind === "sold") {
        summary.sold += 1;
        const item = describeAuctionItem(outcome.auction.itemType, outcome.auction.itemRef);
        const fee = auctionFee(outcome.auction.currentBid ?? 0);
        await dmUser(
          client,
          outcome.auction.currentBidder!,
          `🎉 You won auction #${outcome.auction.id} — ${item} for ${outcome.auction.currentBid} gold! It's in your zoo/inventory now.`,
        );
        await dmUser(
          client,
          outcome.auction.sellerId,
          `💰 Your auction #${outcome.auction.id} sold — ${item} for ${outcome.auction.currentBid} gold (5% fee: ${fee}). You got ${outcome.proceeds} gold.`,
        );
      } else {
        summary.expired += 1;
        const item = describeAuctionItem(outcome.auction.itemType, outcome.auction.itemRef);
        await dmUser(
          client,
          outcome.auction.sellerId,
          `Your auction #${outcome.auction.id} for ${item} got no bids — it's back in your zoo/inventory.`,
        );
      }
    } catch (e) {
      summary.failed += 1;
      console.error(`uwu: auction close failed for #${a.id}:`, e instanceof Error ? e.message : e);
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Gems — user_wallet
// ---------------------------------------------------------------------------
//
// Gem earn sources (working defaults — the design leaves this open,
// §9.3 + §12): crates drop gems (§9.3, tables below), the shop sells
// rare items for gems (evolution stones, §9.1), sacrificing monsters
// yields gems by tier (Phase 1 TIERS gemYield — the sacrifice worker
// writes via grantGems), and tower/boss clears grant gems (towers
// worker: small final boss 5, big final boss 15, Main final boss 50 —
// see grantGems note below).
// ---------------------------------------------------------------------------

async function ensureWallet(db: SelenaDb, userId: string): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO user_wallet (user_id, gems) VALUES (?, 0)").run(userId);
}

/** Current gem balance (0 when the user has no wallet row yet). */
export async function getGems(db: SelenaDb, userId: string): Promise<number> {
  const row = (await db.prepare("SELECT gems FROM user_wallet WHERE user_id = ?").get(userId)) as
    | { gems: number }
    | undefined;
  return Number(row?.gems ?? 0);
}

/**
 * Grant gems to a user. Other systems (towers/bosses, sacrifice) use
 * exactly this: `INSERT INTO user_wallet (user_id, gems) VALUES (?, ?)
 * ON CONFLICT (user_id) DO UPDATE SET gems = user_wallet.gems +
 * EXCLUDED.gems` — one row per user, `gems` column, never negative
 * on the grant path. Returns the new balance.
 */
export async function grantGems(db: SelenaDb, userId: string, amount: number): Promise<number> {
  if (!Number.isInteger(amount) || amount <= 0) return getGems(db, userId);
  await ensureWallet(db, userId);
  // `gems + ?` form (not `gems - ?`): pg-mem evaluates `col - $param`
  // backwards; the two forms are identical on real Postgres.
  await db.prepare("UPDATE user_wallet SET gems = gems + ? WHERE user_id = ?").run(amount, userId);
  return getGems(db, userId);
}

/**
 * Spend gems — atomic guard, fail-closed: when the balance cannot
 * cover the amount the update touches 0 rows and this throws, so the
 * caller (inside a transaction) rolls the purchase back. Gems never
 * go negative.
 */
export async function spendGems(db: SelenaDb, userId: string, amount: number): Promise<number> {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("spendGems: amount must be a positive integer");
  await ensureWallet(db, userId);
  const res = await db
    .prepare("UPDATE user_wallet SET gems = gems + ? WHERE user_id = ? AND gems + ? >= 0")
    .run(-amount, userId, -amount);
  if (res.changes !== 1) throw new Error("Not enough gems");
  return getGems(db, userId);
}

// ---------------------------------------------------------------------------
// Shop — catalogue + date-seeded daily stock
// ---------------------------------------------------------------------------
//
// Design §9.1: refreshes daily at midnight UTC, SAME stock for
// everyone, limited qty per player per day (3 each), gold for most
// items, gems for rare ones. Stock is derived from the UTC date
// (date-seeded PRNG), so it changes automatically at midnight with
// no sweep and no stored schedule — shop_stock rows are written
// best-effort as an audit trail only.
//
// Catalogue (working defaults — prices from the design's ranges):
//   potions 100–500g · lure bait 300g · tower key 1,000g · crates
//   500–5,000g by tier · roll ticket 450g (cheaper than a 500g roll)
//   · skill book 800g · material bundle (×10) 200g · pet egg 1,500g
//   · evolution stone 30 gems · shop weapons by tier price.
// ---------------------------------------------------------------------------

export type ShopCurrency = "gold" | "gems";

export interface ShopItem {
  id: string;
  name: string;
  kind: "potion" | "bait" | "key" | "crate" | "ticket" | "weapon" | "pet-egg" | "material" | "skill-book" | "evolution-stone";
  price: number;
  currency: ShopCurrency;
  qtyPerPlayer: number;
  blurb: string;
  /** Roster/weapon id, crate tier slug, or material name — what buying grants. */
  ref: string;
}

export const SHOP_QTY_PER_PLAYER = 3;

const POTIONS: ShopItem[] = [
  { id: "heal-potion", name: "Heal Potion", kind: "potion", price: 100, currency: "gold", qtyPerPlayer: SHOP_QTY_PER_PLAYER, blurb: "Restores a monster after battle.", ref: "heal-potion" },
  { id: "catch-potion", name: "Catch Potion", kind: "potion", price: 250, currency: "gold", qtyPerPlayer: SHOP_QTY_PER_PLAYER, blurb: "+10% catch chance on your next hunt.", ref: "catch-potion" },
  { id: "xp-potion", name: "XP Potion", kind: "potion", price: 300, currency: "gold", qtyPerPlayer: SHOP_QTY_PER_PLAYER, blurb: "+50% XP on your next hunt or battle.", ref: "xp-potion" },
  { id: "antidote", name: "Antidote", kind: "potion", price: 150, currency: "gold", qtyPerPlayer: SHOP_QTY_PER_PLAYER, blurb: "Clears status effects (Purify).", ref: "antidote" },
];

export const SHOP_MATERIALS: readonly { id: string; name: string; material: string }[] = [
  { id: "material-shards", name: "Shard Bundle ×10", material: "shards" },
  { id: "material-scales", name: "Scale Bundle ×10", material: "scales" },
  { id: "material-fangs", name: "Fang Bundle ×10", material: "fangs" },
  { id: "material-feathers", name: "Feather Bundle ×10", material: "feathers" },
  { id: "material-crystals", name: "Crystal Bundle ×10", material: "crystals" },
  { id: "material-ores", name: "Ore Bundle ×10", material: "ores" },
];

/** Crate price in the shop, by tier (design §9.1: 500–5,000 by tier). */
export const SHOP_CRATE_PRICES: Record<string, number> = {
  wooden: 500,
  iron: 800,
  silver: 1500,
  golden: 3000,
  crystal: 5000,
};

/** Shop weapon price by tier (working default — below auction value for high tiers). */
export const SHOP_WEAPON_PRICES: Record<Tier, number> = {
  Common: 150,
  Uncommon: 400,
  Rare: 900,
  Epic: 2500,
  Legendary: 8000,
  Mythic: 20000,
  UwU: 50000,
};

/** Full catalogue (everything the shop can ever stock — the daily stock is a subset). */
export const SHOP_CATALOGUE: ShopItem[] = [
  ...POTIONS,
  { id: "lure-bait", name: "Lure Bait", kind: "bait", price: 300, currency: "gold", qtyPerPlayer: SHOP_QTY_PER_PLAYER, blurb: "+catch chance for your next hunt.", ref: "lure-bait" },
  { id: "tower-key", name: "Tower Key", kind: "key", price: 1000, currency: "gold", qtyPerPlayer: SHOP_QTY_PER_PLAYER, blurb: "One tower floor entry without the level requirement.", ref: "tower-key" },
  { id: "roll-ticket", name: "Roll Ticket", kind: "ticket", price: 450, currency: "gold", qtyPerPlayer: SHOP_QTY_PER_PLAYER, blurb: "One free uwu roll — doesn't count toward the 20/day cap.", ref: "roll-ticket" },
  { id: "skill-book", name: "Skill Book", kind: "skill-book", price: 800, currency: "gold", qtyPerPlayer: SHOP_QTY_PER_PLAYER, blurb: "Teaches a monster a new move or effect.", ref: "skill-book" },
  { id: "pet-egg", name: "Pet Egg", kind: "pet-egg", price: 1500, currency: "gold", qtyPerPlayer: SHOP_QTY_PER_PLAYER, blurb: "Hatches into a random pet.", ref: "pet-egg" },
  { id: "evolution-stone", name: "Evolution Stone", kind: "evolution-stone", price: 30, currency: "gems", qtyPerPlayer: SHOP_QTY_PER_PLAYER, blurb: "Evolves a +6 monster up one tier. (Mechanic unconfirmed — design §12 item 11.)", ref: "evolution-stone" },
  ...SHOP_MATERIALS.map((m) => ({
    id: m.id,
    name: m.name,
    kind: "material" as const,
    price: 200,
    currency: "gold" as const,
    qtyPerPlayer: SHOP_QTY_PER_PLAYER,
    blurb: `Ten ${m.material} for crafting and upgrades.`,
    ref: m.material,
  })),
  ...CRATE_TIERS.map((c) => ({
    id: `crate-${c.slug}`,
    name: c.name,
    kind: "crate" as const,
    price: SHOP_CRATE_PRICES[c.slug] ?? 500,
    currency: "gold" as const,
    qtyPerPlayer: SHOP_QTY_PER_PLAYER,
    blurb: `A ${c.name.toLowerCase()} — open it with uwu open.`,
    ref: c.slug,
  })),
];

export const SHOP_ITEM_BY_ID: Record<string, ShopItem> = Object.fromEntries(
  SHOP_CATALOGUE.map((i) => [i.id, i]),
);

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Today's stock for a UTC date ("YYYY-MM-DD") — pure and
 * deterministic: the same date always yields the same stock, and the
 * stock changes at midnight UTC with no sweep. Slots (design §9.1):
 * 2 potions (rotating), 1 bait, 1 key, 1 crate (tier weighted),
 * 1 roll ticket, 1 material bundle (rotating), 1 skill book, plus an
 * occasional slot ~3 days a week (random weapon, pet egg, or a
 * gem-priced evolution stone).
 */
export function generateShopStock(dateStr: string): ShopItem[] {
  const rand = mulberry32(fnv1a(dateStr));
  const shuffledPotions = [...POTIONS];
  for (let i = shuffledPotions.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffledPotions[i], shuffledPotions[j]] = [shuffledPotions[j]!, shuffledPotions[i]!];
  }
  const stock: ShopItem[] = [
    shuffledPotions[0]!,
    shuffledPotions[1]!,
    SHOP_ITEM_BY_ID["lure-bait"]!,
    SHOP_ITEM_BY_ID["tower-key"]!,
    SHOP_ITEM_BY_ID["roll-ticket"]!,
    SHOP_ITEM_BY_ID["skill-book"]!,
  ];
  // Crate slot — tier weighted toward the cheap end.
  const crateTier = weightedPick(
    [
      ["wooden", 40],
      ["iron", 35],
      ["silver", 15],
      ["golden", 10],
    ] as const,
    rand,
  );
  stock.push(SHOP_ITEM_BY_ID[`crate-${crateTier}`]!);
  // Material bundle — rotates through the six materials.
  const mat = SHOP_MATERIALS[Math.floor(rand() * SHOP_MATERIALS.length)]!;
  stock.push(SHOP_ITEM_BY_ID[mat.id]!);
  // Occasional slot (~3 days a week): a weapon, a pet egg, or a
  // gem-priced evolution stone.
  if (rand() < 3 / 7) {
    const pick = rand();
    if (pick < 0.5) {
      const tier = weightedPick(
        [
          ["Common", 45],
          ["Uncommon", 30],
          ["Rare", 15],
          ["Epic", 8],
          ["Legendary", 2],
        ] as const,
        rand,
      ) as Tier;
      const pool = WEAPONS.filter((w) => w.tier === tier);
      const weapon = pool[Math.floor(rand() * pool.length)]!;
      stock.push({
        id: `shop-weapon-${weapon.id}`,
        name: weapon.name,
        kind: "weapon",
        price: SHOP_WEAPON_PRICES[tier],
        currency: "gold",
        qtyPerPlayer: 1,
        blurb: `${tier} weapon, +${weapon.atk} ATK.`,
        ref: String(weapon.id),
      });
    } else if (pick < 0.8) {
      stock.push(SHOP_ITEM_BY_ID["pet-egg"]!);
    } else {
      stock.push(SHOP_ITEM_BY_ID["evolution-stone"]!);
    }
  }
  return stock;
}

/** Today's stock, persisting the rows into shop_stock best-effort (audit trail only). */
export async function getTodayStock(db: SelenaDb, dateStr: string): Promise<ShopItem[]> {
  const stock = generateShopStock(dateStr);
  try {
    for (const item of stock) {
      await db
        .prepare(
          "INSERT OR IGNORE INTO shop_stock (date, item_id, price, currency, qty_per_player) VALUES (?, ?, ?, ?, ?)",
        )
        .run(dateStr, item.id, item.price, item.currency, item.qtyPerPlayer);
    }
  } catch (e) {
    console.error("uwu: shop stock audit write failed:", e instanceof Error ? e.message : e);
  }
  return stock;
}

/** How many of an item a user has bought today. */
export async function getShopBuysToday(db: SelenaDb, dateStr: string, userId: string, itemId: string): Promise<number> {
  const row = (await db
    .prepare("SELECT qty FROM user_shop_buys WHERE date = ? AND user_id = ? AND item_id = ?")
    .get(dateStr, userId, itemId)) as { qty: number } | undefined;
  return Number(row?.qty ?? 0);
}

/**
 * Buy from today's shop. Fail-closed: unknown item (not in today's
 * stock), over the per-player daily limit, insufficient gold/gems —
 * all refuse before anything moves. Charge, grant, and the buys
 * record happen in one transaction.
 */
export async function buyFromShop(
  db: SelenaDb,
  guildId: string,
  userId: string,
  itemId: string,
  qty: number,
  nowMs: number,
): Promise<{ ok: boolean; error?: string; item?: ShopItem; qty?: number; total?: number; boughtToday?: number }> {
  if (!Number.isInteger(qty) || qty <= 0) {
    return { ok: false, error: "Quantity must be a positive whole number." };
  }
  const dateStr = utcDayString(nowMs);
  const stock = generateShopStock(dateStr);
  const item = stock.find((i) => i.id === itemId);
  if (!item) {
    return { ok: false, error: "That isn't in today's shop — check `uwu shop` for what's on sale." };
  }
  if (qty > item.qtyPerPlayer) {
    return { ok: false, error: `You can only buy ${item.qtyPerPlayer} of ${item.name} per day.` };
  }
  try {
    const out = await db.transaction(async (tx) => {
      const bought = await getShopBuysToday(tx, dateStr, userId, item.id);
      if (bought + qty > item.qtyPerPlayer) {
        throw new Error(
          `You already bought ${bought} × ${item.name} today — you can buy ${item.qtyPerPlayer - bought} more.`,
        );
      }
      const total = item.price * qty;
      if (item.currency === "gems") {
        await spendGems(tx, userId, total);
      } else {
        await addPoints(tx, guildId, userId, -total, `shop buy ${item.id} x${qty}`);
      }
      // Grant the purchase.
      if (item.kind === "crate") {
        for (let i = 0; i < qty; i++) await grantCrate(tx, userId, item.ref);
      } else if (item.kind === "weapon") {
        for (let i = 0; i < qty; i++) {
          await grantItem(tx, guildId, userId, "weapon", item.ref, nowMs, { source: "shop" });
        }
      } else if (item.kind === "material") {
        await tx
          .prepare(
            "INSERT INTO user_materials (user_id, material, qty) VALUES (?, ?, ?) " +
              "ON CONFLICT (user_id, material) DO UPDATE SET qty = user_materials.qty + EXCLUDED.qty",
          )
          .run(userId, item.ref, 10 * qty);
      } else {
        for (let i = 0; i < qty; i++) {
          await tx
            .prepare(
              "INSERT INTO user_items (user_id, item_id, qty) VALUES (?, ?, 1) " +
                "ON CONFLICT (user_id, item_id) DO UPDATE SET qty = user_items.qty + 1",
            )
            .run(userId, item.id);
        }
      }
      await tx
        .prepare(
          "INSERT INTO user_shop_buys (date, user_id, item_id, qty) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT (date, user_id, item_id) DO UPDATE SET qty = user_shop_buys.qty + EXCLUDED.qty",
        )
        .run(dateStr, userId, item.id, qty);
      return { boughtToday: bought + qty, total };
    });
    return { ok: true, item, qty, total: out.total, boughtToday: out.boughtToday };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't buy that." };
  }
}

// ---------------------------------------------------------------------------
// Crates — grant / list / open
// ---------------------------------------------------------------------------
//
// Drop sources (design §9.2): tower floors ~10%, hunts ~5%, final
// boss 100% one crate of the tower's tier — the towers/hunts workers
// grant crates with grantCrate(); this module owns OPENING only.
//
// Loot tables (working defaults — drop RATES per source are
// unconfirmed, design §12 item 18/20; the tables below are the
// crate-contents half, tuned so a Wooden Crate never holds Mythic
// loot and a Void Crate never holds Commons):
//   every crate: gold + shards (amount scales with tier)
//   gems:    Wooden 8% (1–2) · Iron 15% (2–4) · Silver 30% (3–6)
//            · Golden 50% (5–10) · Crystal always (8–15) · Void always (15–30)
//   potion:  Wooden 30% heal · Iron 50% any · Silver 60% any
//            · Golden 70% any · Crystal 70% any · Void 80% any
//   material bundle: Iron 20% ×3 · Silver 30% ×5 · Golden 40% ×8
//            · Crystal 50% ×10 · Void 60% ×15 (random material)
//   weapon of the crate's tier: Wooden 2% · Iron 5% · Silver 10%
//            · Golden 20% · Crystal 30% · Void 40%
//   pet one tier below the crate's tier: Silver 5% · Golden 10%
//            · Crystal 15% · Void 20%
//   monster of the crate's tier (owned, not caught — no cap):
//            Silver 2% · Golden 3% · Crystal 4% · Void 5%
//   skill book: Silver 15% · Golden 20% · Crystal 25% · Void 30%
//   tower key:  Golden 10% · Crystal 15% · Void 20%
//   roll ticket: Iron 10% ×1 · Silver 15% ×1 · Golden 20% ×2
//            · Crystal 25% ×3 · Void 30% ×5
//   evolution stone: Golden 5% · Crystal 15% · Void 30%
//   pet egg:  Silver 5% · Golden 10% · Crystal 15% · Void 20%
//   crate-in-crate (one tier down): Golden 10% Silver · Crystal 10%
//            Golden · Void 15% Crystal
// ---------------------------------------------------------------------------

/** Grant crates (used by towers/hunts/bosses — they only insert rows). */
export async function grantCrate(db: SelenaDb, userId: string, tier: string, qty = 1): Promise<void> {
  if (!CRATE_TIER_BY_SLUG[tier]) throw new Error(`grantCrate: unknown crate tier "${tier}"`);
  if (!Number.isInteger(qty) || qty <= 0) throw new Error("grantCrate: qty must be a positive integer");
  await db
    .prepare(
      "INSERT INTO user_crates (user_id, crate_tier, qty) VALUES (?, ?, ?) " +
        "ON CONFLICT (user_id, crate_tier) DO UPDATE SET qty = user_crates.qty + EXCLUDED.qty",
    )
    .run(userId, tier, qty);
}

/** Crates a user owns, richest tier first. */
export async function getUserCrates(db: SelenaDb, userId: string): Promise<{ tier: CrateTier; qty: number }[]> {
  const rows = (await db
    .prepare("SELECT crate_tier, qty FROM user_crates WHERE user_id = ? AND qty > 0")
    .all(userId)) as { crate_tier: string; qty: number }[];
  const order = ["void", "crystal", "golden", "silver", "iron", "wooden"];
  return rows
    .map((r) => ({ tier: CRATE_TIER_BY_SLUG[String(r.crate_tier)]!, qty: Number(r.qty) }))
    .filter((r) => r.tier)
    .sort((a, b) => order.indexOf(a.tier.slug) - order.indexOf(b.tier.slug));
}

export interface LootDrop {
  kind: "gold" | "gems" | "material" | "item" | "weapon" | "pet" | "monster" | "crate";
  ref: string;
  qty: number;
  label: string;
}

function rangeInt(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

function chance(rand: () => number, pct: number): boolean {
  return rand() * 100 < pct;
}

function randomWeaponOfTier(tier: Tier, rand: () => number): Weapon {
  const pool = WEAPONS.filter((w) => w.tier === tier);
  return pool[Math.floor(rand() * pool.length)]!;
}

function randomPetOfTier(tier: Tier, rand: () => number): Pet | undefined {
  const pool = PETS.filter((p) => p.tier === tier);
  if (pool.length === 0) return undefined;
  return pool[Math.floor(rand() * pool.length)]!;
}

function randomMonsterOfTier(tier: Tier, rand: () => number): Monster {
  return drawMonsterOfTier(tier, rand);
}

/**
 * Roll a crate's loot — pure (seeded rand in, drops out), so tests
 * can drive exact outcomes. See the table in the section comment
 * above for the per-tier numbers.
 */
export function rollCrateLoot(tierSlug: CrateTierSlug, rand: () => number = secureFloat): LootDrop[] {
  const crate = CRATE_TIER_BY_SLUG[tierSlug];
  if (!crate) throw new Error(`rollCrateLoot: unknown crate tier "${tierSlug}"`);
  const tier = crate.tier;
  const drops: LootDrop[] = [];
  const goldRanges: Record<CrateTierSlug, [number, number]> = {
    wooden: [50, 150],
    iron: [100, 300],
    silver: [250, 600],
    golden: [500, 1200],
    crystal: [1000, 2500],
    void: [2500, 5000],
  };
  const shardRanges: Record<CrateTierSlug, [number, number]> = {
    wooden: [1, 3],
    iron: [2, 5],
    silver: [5, 10],
    golden: [10, 20],
    crystal: [20, 40],
    void: [50, 80],
  };
  const [gMin, gMax] = goldRanges[tierSlug];
  const [sMin, sMax] = shardRanges[tierSlug];
  const gold = rangeInt(rand, gMin, gMax);
  drops.push({ kind: "gold", ref: "gold", qty: gold, label: `${gold} gold` });
  const shards = rangeInt(rand, sMin, sMax);
  drops.push({ kind: "material", ref: "shards", qty: shards, label: `${shards} shards` });

  const gemTable: Record<CrateTierSlug, [number, [number, number]] | null> = {
    wooden: [8, [1, 2]],
    iron: [15, [2, 4]],
    silver: [30, [3, 6]],
    golden: [50, [5, 10]],
    crystal: [100, [8, 15]],
    void: [100, [15, 30]],
  };
  const gemSpec = gemTable[tierSlug];
  if (gemSpec && chance(rand, gemSpec[0])) {
    const gems = rangeInt(rand, gemSpec[1][0], gemSpec[1][1]);
    drops.push({ kind: "gems", ref: "gems", qty: gems, label: `${gems} gems 💎` });
  }

  const potionChance: Record<CrateTierSlug, number> = {
    wooden: 30,
    iron: 50,
    silver: 60,
    golden: 70,
    crystal: 70,
    void: 80,
  };
  if (chance(rand, potionChance[tierSlug])) {
    const potion = tierSlug === "wooden" ? POTIONS[0]! : POTIONS[Math.floor(rand() * POTIONS.length)]!;
    drops.push({ kind: "item", ref: potion.id, qty: 1, label: `1 × ${potion.name}` });
  }

  const matTable: Record<CrateTierSlug, [number, number] | null> = {
    wooden: null,
    iron: [20, 3],
    silver: [30, 5],
    golden: [40, 8],
    crystal: [50, 10],
    void: [60, 15],
  };
  const matSpec = matTable[tierSlug];
  if (matSpec && chance(rand, matSpec[0])) {
    const mat = CRATE_MATERIALS[Math.floor(rand() * CRATE_MATERIALS.length)]!;
    drops.push({ kind: "material", ref: mat, qty: matSpec[1], label: `${matSpec[1]} ${mat}` });
  }

  const weaponChance: Record<CrateTierSlug, number> = {
    wooden: 2,
    iron: 5,
    silver: 10,
    golden: 20,
    crystal: 30,
    void: 40,
  };
  if (chance(rand, weaponChance[tierSlug])) {
    const weapon = randomWeaponOfTier(tier, rand);
    drops.push({ kind: "weapon", ref: String(weapon.id), qty: 1, label: `1 × ${weapon.name} (${weapon.tier})` });
  }

  // Pet one tier below the crate's tier (Wooden/Iron crates: no pets).
  const petTierDown: Partial<Record<CrateTierSlug, Tier>> = {
    silver: "Uncommon",
    golden: "Rare",
    crystal: "Epic",
    void: "Legendary",
  };
  const petChance: Partial<Record<CrateTierSlug, number>> = { silver: 5, golden: 10, crystal: 15, void: 20 };
  const petTier = petTierDown[tierSlug];
  if (petTier && chance(rand, petChance[tierSlug] ?? 0)) {
    const pet = randomPetOfTier(petTier, rand);
    if (pet) drops.push({ kind: "pet", ref: String(pet.id), qty: 1, label: `1 × ${pet.name} pet (${pet.tier})` });
  }

  const monsterChance: Partial<Record<CrateTierSlug, number>> = { silver: 2, golden: 3, crystal: 4, void: 5 };
  if (monsterChance[tierSlug] && chance(rand, monsterChance[tierSlug]!)) {
    const monster = randomMonsterOfTier(tier, rand);
    drops.push({ kind: "monster", ref: String(monster.id), qty: 1, label: `1 × ${monster.name} (${monster.tier})` });
  }

  const bookChance: Partial<Record<CrateTierSlug, number>> = { silver: 15, golden: 20, crystal: 25, void: 30 };
  if (bookChance[tierSlug] && chance(rand, bookChance[tierSlug]!)) {
    drops.push({ kind: "item", ref: "skill-book", qty: 1, label: "1 × Skill Book" });
  }
  const keyChance: Partial<Record<CrateTierSlug, number>> = { golden: 10, crystal: 15, void: 20 };
  if (keyChance[tierSlug] && chance(rand, keyChance[tierSlug]!)) {
    drops.push({ kind: "item", ref: "tower-key", qty: 1, label: "1 × Tower Key" });
  }
  const ticketTable: Partial<Record<CrateTierSlug, [number, number]>> = {
    iron: [10, 1],
    silver: [15, 1],
    golden: [20, 2],
    crystal: [25, 3],
    void: [30, 5],
  };
  const ticketSpec = ticketTable[tierSlug];
  if (ticketSpec && chance(rand, ticketSpec[0])) {
    drops.push({ kind: "item", ref: "roll-ticket", qty: ticketSpec[1], label: `${ticketSpec[1]} × Roll Ticket` });
  }
  const stoneChance: Partial<Record<CrateTierSlug, number>> = { golden: 5, crystal: 15, void: 30 };
  if (stoneChance[tierSlug] && chance(rand, stoneChance[tierSlug]!)) {
    drops.push({ kind: "item", ref: "evolution-stone", qty: 1, label: "1 × Evolution Stone" });
  }
  const eggChance: Partial<Record<CrateTierSlug, number>> = { silver: 5, golden: 10, crystal: 15, void: 20 };
  if (eggChance[tierSlug] && chance(rand, eggChance[tierSlug]!)) {
    drops.push({ kind: "item", ref: "pet-egg", qty: 1, label: "1 × Pet Egg" });
  }
  const innerCrate: Partial<Record<CrateTierSlug, [number, CrateTierSlug]>> = {
    golden: [10, "silver"],
    crystal: [10, "golden"],
    void: [15, "crystal"],
  };
  const innerSpec = innerCrate[tierSlug];
  if (innerSpec && chance(rand, innerSpec[0])) {
    const inner = CRATE_TIER_BY_SLUG[innerSpec[1]]!;
    drops.push({ kind: "crate", ref: inner.slug, qty: 1, label: `1 × ${inner.name}` });
  }
  return drops;
}

/**
 * Open one crate: consume it, roll its loot, write every drop into
 * the right table (gold via the economy, gems via the wallet,
 * materials/items/crates via their tables, weapons/pets/monsters via
 * the grant paths). One transaction — a failed drop write rolls the
 * whole open back, crate included. Returns the loot for the reply.
 */
export async function openCrate(
  db: SelenaDb,
  guildId: string,
  userId: string,
  tierSlug: string,
  nowMs: number,
  rand: () => number = secureFloat,
): Promise<{ ok: boolean; error?: string; tier?: CrateTier; drops?: LootDrop[] }> {
  const tier = CRATE_TIER_BY_SLUG[tierSlug];
  if (!tier) return { ok: false, error: `No crate tier called "${tierSlug}" — try wooden, iron, silver, golden, crystal or void.` };
  try {
    const drops = await db.transaction(async (tx) => {
      const row = (await tx
        .prepare("SELECT qty FROM user_crates WHERE user_id = ? AND crate_tier = ?")
        .get(userId, tierSlug)) as { qty: number } | undefined;
      const qty = Number(row?.qty ?? 0);
      if (qty <= 0) throw new Error(`You don't have a ${tier.name} to open.`);
      if (qty === 1) {
        await tx.prepare("DELETE FROM user_crates WHERE user_id = ? AND crate_tier = ?").run(userId, tierSlug);
      } else {
        await tx.prepare("UPDATE user_crates SET qty = qty - 1 WHERE user_id = ? AND crate_tier = ?").run(userId, tierSlug);
      }
      const rolled = rollCrateLoot(tierSlug as CrateTierSlug, rand);
      for (const drop of rolled) {
        if (drop.kind === "gold") {
          await addPoints(tx, guildId, userId, drop.qty, `crate open ${tierSlug}`);
        } else if (drop.kind === "gems") {
          await grantGems(tx, userId, drop.qty);
        } else if (drop.kind === "material") {
          await tx
            .prepare(
              "INSERT INTO user_materials (user_id, material, qty) VALUES (?, ?, ?) " +
                "ON CONFLICT (user_id, material) DO UPDATE SET qty = user_materials.qty + EXCLUDED.qty",
            )
            .run(userId, drop.ref, drop.qty);
        } else if (drop.kind === "item") {
          await tx
            .prepare(
              "INSERT INTO user_items (user_id, item_id, qty) VALUES (?, ?, ?) " +
                "ON CONFLICT (user_id, item_id) DO UPDATE SET qty = user_items.qty + EXCLUDED.qty",
            )
            .run(userId, drop.ref, drop.qty);
        } else if (drop.kind === "weapon") {
          await grantItem(tx, guildId, userId, "weapon", drop.ref, nowMs, { source: "crate" });
        } else if (drop.kind === "pet") {
          await grantItem(tx, guildId, userId, "pet", drop.ref, nowMs, { source: "crate" });
        } else if (drop.kind === "monster") {
          await grantItem(tx, guildId, userId, "monster", drop.ref, nowMs, { source: "crate", level: 1 });
        } else if (drop.kind === "crate") {
          await grantCrate(tx, userId, drop.ref);
        }
      }
      return rolled;
    });
    return { ok: true, tier, drops };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't open that crate." };
  }
}
