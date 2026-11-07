import { describe, expect, it, beforeEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import type { SelenaDb } from "../src/lib/db.js";
import { getTestDb } from "./testDb.js";
import { addPoints, getBalance } from "../src/lib/economy.js";
import { addMonster, createMonsterInstance, getOwnedCount, getUserInstances, utcDayString } from "../src/lib/huntDb.js";
import { mulberry32 } from "../src/lib/rng.js";
import { WEAPON_BY_ID } from "../src/lib/hunt.js";
import type { CommandContext, CommandInvocation, CommandOptions, ReplyPayload } from "../src/lib/command.js";
import {
  AUCTION_DURATION_MS,
  CRATE_TIERS,
  auctionFee,
  buyFromShop,
  cancelAuction,
  closeDueAuctions,
  generateShopStock,
  getAuction,
  getGems,
  getShopBuysToday,
  getTodayStock,
  getUserCrates,
  grantCrate,
  grantGems,
  listAuction,
  minNextBid,
  openCrate,
  placeBid,
  resolveListableItem,
  rollCrateLoot,
  sellerProceeds,
  spendGems,
  type CrateTierSlug,
} from "../src/lib/market.js";
import { commands } from "../src/commands/market.js";

const GUILD = "guild-1";
const SELLER = "seller-1";
const BIDDER1 = "bidder-1";
const BIDDER2 = "bidder-2";
const NOW = Date.parse("2026-11-07T12:00:00Z");

let db: SelenaDb;

beforeEach(() => {
  db = getTestDb();
});

class FakeInv implements CommandInvocation {
  user: { id: string; username: string };
  guildId = GUILD;
  channelId = "chan-1";
  options: CommandOptions;
  replies: ReplyPayload[] = [];

  constructor(userId: string, args: Record<string, string | number | null> = {}) {
    this.user = { id: userId, username: userId };
    this.options = {
      getString: (n: string) => (typeof args[n] === "string" ? (args[n] as string) : null),
      getInteger: (n: string) => (typeof args[n] === "number" ? (args[n] as number) : null),
      getNumber: (n: string) => (typeof args[n] === "number" ? (args[n] as number) : null),
      getBoolean: () => null,
      getUser: () => null,
      getRole: () => null,
    };
  }

  async reply(p: ReplyPayload): Promise<void> {
    this.replies.push(p);
  }

  async editReply(p: ReplyPayload): Promise<{ id: string }> {
    this.replies.push(p);
    return { id: "m1" };
  }

  async deferReply(): Promise<void> {}

  async followUp(p: ReplyPayload): Promise<void> {
    this.replies.push(p);
  }

  text(): string {
    return this.replies.map((r) => r.content ?? "").join("\n");
  }
}

const ctxFor = (testDb: SelenaDb): CommandContext => ({ db: testDb, guildId: GUILD });

async function giveGold(userId: string, amount: number): Promise<void> {
  await addPoints(db, GUILD, userId, amount, "test");
}

async function goldOf(userId: string): Promise<number> {
  return (await getBalance(db, GUILD, userId)).points;
}

async function giveMonster(userId: string, monsterId: number): Promise<void> {
  await addMonster(db, GUILD, userId, monsterId, "hunt", NOW);
}

async function listStoneBeetle(price = 100): Promise<number> {
  await giveMonster(SELLER, 26); // Stone Beetle
  const res = await listAuction(db, GUILD, SELLER, resolveListableItem("Stone Beetle")!, price, NOW);
  expect(res.ok).toBe(true);
  return res.auction!.id;
}

describe("auction fee math", () => {
  it("5% fee floors, seller gets the rest", () => {
    expect(auctionFee(1000)).toBe(50);
    expect(sellerProceeds(1000)).toBe(950);
    expect(auctionFee(101)).toBe(5);
    expect(sellerProceeds(101)).toBe(96);
    expect(auctionFee(100)).toBe(5);
    expect(sellerProceeds(100)).toBe(95);
  });

  it("minimum next bid is the start price, then +10% over current", () => {
    expect(minNextBid({ currentBid: null, startPrice: 100 } as never)).toBe(100);
    expect(minNextBid({ currentBid: 100, startPrice: 100 } as never)).toBe(110);
    expect(minNextBid({ currentBid: 150, startPrice: 100 } as never)).toBe(165);
    expect(minNextBid({ currentBid: 101, startPrice: 100 } as never)).toBe(112);
  });
});

describe("auction sell", () => {
  it("lists the item for 24h and removes it from the seller's zoo", async () => {
    await giveMonster(SELLER, 26);
    const res = await listAuction(db, GUILD, SELLER, resolveListableItem("Stone Beetle")!, 500, NOW);
    expect(res.ok).toBe(true);
    expect(res.auction!.endsAt).toBe(NOW + AUCTION_DURATION_MS);
    expect(res.auction!.status).toBe("open");
    expect(await getOwnedCount(db, GUILD, SELLER, 26)).toBe(0);
  });

  it("refuses an item the seller does not own", async () => {
    const res = await listAuction(db, GUILD, SELLER, resolveListableItem("Stone Beetle")!, 500, NOW);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/don't own/);
  });

  it("refuses a starting price below 100 gold", async () => {
    await giveMonster(SELLER, 26);
    const res = await listAuction(db, GUILD, SELLER, resolveListableItem("Stone Beetle")!, 99, NOW);
    expect(res.ok).toBe(false);
    expect(await getOwnedCount(db, GUILD, SELLER, 26)).toBe(1); // nothing moved
  });

  it("preserves a monster's level and fuse in the listing ref", async () => {
    await giveMonster(SELLER, 26);
    const instId = await createMonsterInstance(db, GUILD, SELLER, 26, 12, "hunt", NOW);
    await db.prepare("UPDATE user_monster_instances SET fuse_level = 2 WHERE id = ?").run(instId);
    const res = await listAuction(db, GUILD, SELLER, resolveListableItem("Stone Beetle")!, 500, NOW);
    expect(res.ok).toBe(true);
    expect(res.auction!.itemRef).toBe("26:12:2");
  });
});

describe("auction bidding (escrow / refund)", () => {
  it("escrows the bid gold immediately", async () => {
    const id = await listStoneBeetle(100);
    await giveGold(BIDDER1, 1000);
    const res = await placeBid(db, GUILD, id, BIDDER1, 100, NOW);
    expect(res.ok).toBe(true);
    expect(res.auction!.currentBid).toBe(100);
    expect(await goldOf(BIDDER1)).toBe(900);
  });

  it("refunds the outbid bidder at once", async () => {
    const id = await listStoneBeetle(100);
    await giveGold(BIDDER1, 1000);
    await giveGold(BIDDER2, 1000);
    expect((await placeBid(db, GUILD, id, BIDDER1, 100, NOW)).ok).toBe(true);
    expect(await goldOf(BIDDER1)).toBe(900);
    const res = await placeBid(db, GUILD, id, BIDDER2, 150, NOW);
    expect(res.ok).toBe(true);
    expect(res.refundedBidder).toBe(BIDDER1);
    expect(res.refundedAmount).toBe(100);
    expect(await goldOf(BIDDER1)).toBe(1000); // fully refunded
    expect(await goldOf(BIDDER2)).toBe(850);
  });

  it("refuses a bid below the 10% minimum raise", async () => {
    const id = await listStoneBeetle(100);
    await giveGold(BIDDER1, 1000);
    await giveGold(BIDDER2, 1000);
    expect((await placeBid(db, GUILD, id, BIDDER1, 100, NOW)).ok).toBe(true);
    const res = await placeBid(db, GUILD, id, BIDDER2, 109, NOW); // needs 110
    expect(res.ok).toBe(false);
    expect(await goldOf(BIDDER2)).toBe(1000); // nothing moved
  });

  it("refuses self-bids and bids the bidder cannot afford", async () => {
    const id = await listStoneBeetle(100);
    await giveGold(SELLER, 5000);
    expect((await placeBid(db, GUILD, id, SELLER, 200, NOW)).ok).toBe(false);
    await giveGold(BIDDER1, 50);
    const res = await placeBid(db, GUILD, id, BIDDER1, 100, NOW);
    expect(res.ok).toBe(false);
    expect(await goldOf(BIDDER1)).toBe(50);
  });

  it("refuses bids on unknown or closed auctions", async () => {
    await giveGold(BIDDER1, 1000);
    expect((await placeBid(db, GUILD, 999, BIDDER1, 100, NOW)).ok).toBe(false);
    const id = await listStoneBeetle(100);
    expect((await placeBid(db, GUILD, id, BIDDER1, 100, NOW + AUCTION_DURATION_MS + 1)).ok).toBe(false);
  });
});

describe("auction close", () => {
  it("winner gets the item, seller gets bid minus 5%", async () => {
    const id = await listStoneBeetle(100);
    await giveGold(BIDDER1, 1000);
    await giveGold(BIDDER2, 1000);
    await placeBid(db, GUILD, id, BIDDER1, 100, NOW);
    await placeBid(db, GUILD, id, BIDDER2, 500, NOW);
    const summary = await closeDueAuctions(db, null, NOW + AUCTION_DURATION_MS + 1);
    expect(summary).toEqual({ due: 1, sold: 1, expired: 0, failed: 0 });
    expect(await getOwnedCount(db, GUILD, BIDDER2, 26)).toBe(1);
    expect(await getOwnedCount(db, GUILD, SELLER, 26)).toBe(0);
    expect(await goldOf(SELLER)).toBe(475); // 500 - 5%
    expect(await goldOf(BIDDER2)).toBe(500); // escrowed 500, already paid
    expect(await goldOf(BIDDER1)).toBe(1000); // refunded
  });

  it("unsold items return to the seller", async () => {
    const id = await listStoneBeetle(100);
    const summary = await closeDueAuctions(db, null, NOW + AUCTION_DURATION_MS + 1);
    expect(summary).toEqual({ due: 1, sold: 0, expired: 1, failed: 0 });
    expect(await getOwnedCount(db, GUILD, SELLER, 26)).toBe(1);
    expect((await getAuction(db, id))!.status).toBe("expired");
  });

  it("does not close auctions before their 24h is up", async () => {
    await listStoneBeetle(100);
    const summary = await closeDueAuctions(db, null, NOW + AUCTION_DURATION_MS - 1);
    expect(summary.due).toBe(0);
    expect(await getOwnedCount(db, GUILD, SELLER, 26)).toBe(0); // still held
  });

  it("double-close is a no-op", async () => {
    const id = await listStoneBeetle(100);
    await giveGold(BIDDER1, 1000);
    await placeBid(db, GUILD, id, BIDDER1, 100, NOW);
    const first = await closeDueAuctions(db, null, NOW + AUCTION_DURATION_MS + 1);
    expect(first.sold).toBe(1);
    const second = await closeDueAuctions(db, null, NOW + AUCTION_DURATION_MS + 2);
    expect(second).toEqual({ due: 0, sold: 0, expired: 0, failed: 0 });
    expect(await getOwnedCount(db, GUILD, BIDDER1, 26)).toBe(1); // not duplicated
    expect(await goldOf(SELLER)).toBe(95); // paid once
  });

  it("returns a listed monster's level/fuse to the seller when unsold", async () => {
    await giveMonster(SELLER, 26);
    const instId = await createMonsterInstance(db, GUILD, SELLER, 26, 12, "hunt", NOW);
    await db.prepare("UPDATE user_monster_instances SET fuse_level = 2 WHERE id = ?").run(instId);
    const res = await listAuction(db, GUILD, SELLER, resolveListableItem("Stone Beetle")!, 500, NOW);
    expect(res.ok).toBe(true);
    await closeDueAuctions(db, null, NOW + AUCTION_DURATION_MS + 1);
    const instances = await getUserInstances(db, GUILD, SELLER, 26);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.level).toBe(12);
    expect(instances[0]!.fuseLevel).toBe(2);
  });

  it("never throws on an empty DB and settles silently with a null client", async () => {
    await expect(closeDueAuctions(db, null, NOW)).resolves.toEqual({ due: 0, sold: 0, expired: 0, failed: 0 });
  });

  it("DMs the winner and seller when a client is provided", async () => {
    const id = await listStoneBeetle(100);
    await giveGold(BIDDER1, 1000);
    await placeBid(db, GUILD, id, BIDDER1, 200, NOW);
    const dms: { userId: string; content: string }[] = [];
    const client = {
      users: {
        fetch: async (userId: string) => ({
          send: async (msg: { content: string }) => {
            dms.push({ userId, content: msg.content });
          },
        }),
      },
    };
    const summary = await closeDueAuctions(db, client as never, NOW + AUCTION_DURATION_MS + 1);
    expect(summary.sold).toBe(1);
    expect(dms.map((d) => d.userId).sort()).toEqual([BIDDER1, SELLER].sort());
    expect(dms.find((d) => d.userId === BIDDER1)!.content).toMatch(/won auction/);
    expect(dms.find((d) => d.userId === SELLER)!.content).toMatch(/190 gold/); // 200 - 10 fee
  });
});

describe("auction cancel", () => {
  it("returns the item when there are no bids", async () => {
    const id = await listStoneBeetle(100);
    const res = await cancelAuction(db, GUILD, id, SELLER, NOW);
    expect(res.ok).toBe(true);
    expect(await getOwnedCount(db, GUILD, SELLER, 26)).toBe(1);
  });

  it("refuses to cancel once a bid exists, or for a non-seller", async () => {
    const id = await listStoneBeetle(100);
    await giveGold(BIDDER1, 1000);
    await placeBid(db, GUILD, id, BIDDER1, 100, NOW);
    expect((await cancelAuction(db, GUILD, id, SELLER, NOW)).ok).toBe(false);
    expect((await cancelAuction(db, GUILD, id, BIDDER1, NOW)).ok).toBe(false);
    expect(await getOwnedCount(db, GUILD, SELLER, 26)).toBe(0); // still held
  });
});

describe("item resolution", () => {
  it("resolves monsters, weapons, pets, crates and shop items by name", () => {
    expect(resolveListableItem("Stone Beetle")).toMatchObject({ type: "monster", ref: "26" });
    expect(resolveListableItem("Wooden Sword")).toMatchObject({ type: "weapon", ref: "1" });
    expect(resolveListableItem("Pocket Slime")).toMatchObject({ type: "pet", ref: "1" });
    expect(resolveListableItem("Wooden Crate")).toMatchObject({ type: "crate", ref: "wooden" });
    expect(resolveListableItem("void crate")).toMatchObject({ type: "crate", ref: "void" });
    expect(resolveListableItem("Heal Potion")).toMatchObject({ type: "item", ref: "heal-potion" });
    expect(resolveListableItem("Nope Nothing Here")).toBeUndefined();
  });
});

describe("shop date-seeding", () => {
  it("same UTC date -> same stock, and the stock varies across days", () => {
    const a = generateShopStock("2026-11-07");
    const b = generateShopStock("2026-11-07");
    expect(a).toEqual(b);
    const seen = new Set<string>();
    for (let d = 8; d <= 21; d++) {
      seen.add(generateShopStock(`2026-11-${String(d).padStart(2, "0")}`).map((i) => i.id).join(","));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("always stocks bait, key, ticket and skill book, plus a crate and 2 potions", () => {
    for (const day of ["2026-11-07", "2026-11-08", "2026-11-09", "2026-12-25", "2027-01-01"]) {
      const ids = generateShopStock(day).map((i) => i.id);
      expect(ids).toContain("lure-bait");
      expect(ids).toContain("tower-key");
      expect(ids).toContain("roll-ticket");
      expect(ids).toContain("skill-book");
      expect(ids.filter((id) => id.startsWith("crate-"))).toHaveLength(1);
      expect(ids.filter((id) => id.endsWith("-potion") || id === "antidote")).toHaveLength(2);
    }
  });

  it("persists stock rows into shop_stock", async () => {
    const stock = await getTodayStock(db, "2026-11-07");
    const rows = (await db
      .prepare("SELECT item_id FROM shop_stock WHERE date = ?")
      .all("2026-11-07")) as { item_id: string }[];
    expect(rows.map((r) => r.item_id).sort()).toEqual(stock.map((i) => i.id).sort());
  });
});

describe("shop buying", () => {
  it("charges gold, grants the item, and tracks per-player daily qty", async () => {
    await giveGold(BIDDER1, 10000);
    const first = await buyFromShop(db, GUILD, BIDDER1, "lure-bait", 3, NOW);
    expect(first.ok).toBe(true);
    expect(first.total).toBe(900);
    expect(await goldOf(BIDDER1)).toBe(9100);
    expect(await getShopBuysToday(db, "2026-11-07", BIDDER1, "lure-bait")).toBe(3);
    const row = (await db
      .prepare("SELECT qty FROM user_items WHERE user_id = ? AND item_id = ?")
      .get(BIDDER1, "lure-bait")) as { qty: number } | undefined;
    expect(Number(row?.qty)).toBe(3);
    // 4th of the day is refused and moves no gold.
    const fourth = await buyFromShop(db, GUILD, BIDDER1, "lure-bait", 1, NOW);
    expect(fourth.ok).toBe(false);
    expect(await goldOf(BIDDER1)).toBe(9100);
  });

  it("refuses a single purchase over the daily limit and an item not in stock", async () => {
    await giveGold(BIDDER1, 10000);
    expect((await buyFromShop(db, GUILD, BIDDER1, "lure-bait", 4, NOW)).ok).toBe(false);
    expect((await buyFromShop(db, GUILD, BIDDER1, "heal-potion", 1, NOW)).ok).toBe(
      generateShopStock("2026-11-07").some((i) => i.id === "heal-potion"),
    );
    expect((await buyFromShop(db, GUILD, BIDDER1, "not-a-real-item", 1, NOW)).ok).toBe(false);
  });

  it("refuses when the buyer cannot afford it, moving nothing", async () => {
    await giveGold(BIDDER1, 100);
    const res = await buyFromShop(db, GUILD, BIDDER1, "lure-bait", 1, NOW);
    expect(res.ok).toBe(false);
    expect(await goldOf(BIDDER1)).toBe(100);
    expect(await getShopBuysToday(db, "2026-11-07", BIDDER1, "lure-bait")).toBe(0);
  });

  it("buying a crate from the shop grants a crate", async () => {
    await giveGold(BIDDER1, 10000);
    const crateId = generateShopStock("2026-11-07").find((i) => i.kind === "crate")!.id;
    const res = await buyFromShop(db, GUILD, BIDDER1, crateId, 1, NOW);
    expect(res.ok).toBe(true);
    const crates = await getUserCrates(db, BIDDER1);
    expect(crates).toHaveLength(1);
    expect(crates[0]!.qty).toBe(1);
  });

  it("gem-priced items charge gems, not gold", async () => {
    // Find a day whose occasional slot is the gem-priced evolution stone.
    let gemDay: string | null = null;
    for (let d = 0; d < 180; d++) {
      const date = new Date(Date.parse("2026-11-07T00:00:00Z") + d * 86_400_000).toISOString().slice(0, 10);
      if (generateShopStock(date).some((i) => i.currency === "gems")) {
        gemDay = date;
        break;
      }
    }
    expect(gemDay).not.toBeNull();
    const when = Date.parse(`${gemDay}T12:00:00Z`);
    await grantGems(db, BIDDER1, 100);
    await giveGold(BIDDER1, 10000);
    const res = await buyFromShop(db, GUILD, BIDDER1, "evolution-stone", 1, when);
    expect(res.ok).toBe(true);
    expect(res.total).toBe(30);
    expect(await getGems(db, BIDDER1)).toBe(70);
    expect(await goldOf(BIDDER1)).toBe(10000); // untouched
    const row = (await db
      .prepare("SELECT qty FROM user_items WHERE user_id = ? AND item_id = ?")
      .get(BIDDER1, "evolution-stone")) as { qty: number } | undefined;
    expect(Number(row?.qty)).toBe(1);
  });
});

describe("gems", () => {
  it("starts at 0, grants and spends, never goes negative", async () => {
    expect(await getGems(db, BIDDER1)).toBe(0);
    expect(await grantGems(db, BIDDER1, 10)).toBe(10);
    expect(await spendGems(db, BIDDER1, 4)).toBe(6);
    await expect(spendGems(db, BIDDER1, 100)).rejects.toThrow(/Not enough gems/);
    expect(await getGems(db, BIDDER1)).toBe(6);
  });
});

describe("crates", () => {
  it("grants and lists crates", async () => {
    await grantCrate(db, BIDDER1, "wooden", 2);
    await grantCrate(db, BIDDER1, "void", 1);
    const crates = await getUserCrates(db, BIDDER1);
    expect(crates.map((c) => `${c.tier.slug}×${c.qty}`)).toEqual(["void×1", "wooden×2"]);
  });

  it("opening a wooden crate consumes it and lands gold + shards", async () => {
    await giveGold(BIDDER1, 0);
    await grantCrate(db, BIDDER1, "wooden", 2);
    const before = await goldOf(BIDDER1);
    const res = await openCrate(db, GUILD, BIDDER1, "wooden", NOW, mulberry32(1));
    expect(res.ok).toBe(true);
    expect(res.drops!.find((d) => d.kind === "gold")!.qty).toBeGreaterThanOrEqual(50);
    expect(res.drops!.find((d) => d.kind === "gold")!.qty).toBeLessThanOrEqual(150);
    expect(await goldOf(BIDDER1)).toBe(before + res.drops!.find((d) => d.kind === "gold")!.qty);
    const shards = (await db
      .prepare("SELECT qty FROM user_materials WHERE user_id = ? AND material = ?")
      .get(BIDDER1, "shards")) as { qty: number } | undefined;
    expect(Number(shards?.qty)).toBeGreaterThanOrEqual(1);
    expect((await getUserCrates(db, BIDDER1)).find((c) => c.tier.slug === "wooden")!.qty).toBe(1);
  });

  it("every tier opens and lands its drops in the right tables", async () => {
    const tiers = CRATE_TIERS.map((c) => c.slug) as CrateTierSlug[];
    for (let i = 0; i < tiers.length; i++) {
      await grantCrate(db, BIDDER1, tiers[i]!, 1);
      const goldBefore = await goldOf(BIDDER1);
      const gemsBefore = await getGems(db, BIDDER1);
      const res = await openCrate(db, GUILD, BIDDER1, tiers[i]!, NOW, mulberry32(100 + i));
      expect(res.ok).toBe(true);
      expect(await goldOf(BIDDER1)).toBeGreaterThan(goldBefore);
      if (tiers[i] === "crystal" || tiers[i] === "void") {
        expect(await getGems(db, BIDDER1)).toBeGreaterThan(gemsBefore); // guaranteed gem drop
      }
      expect((await getUserCrates(db, BIDDER1)).find((c) => c.tier.slug === tiers[i])).toBeUndefined();
    }
  });

  it("refuses to open a crate the user does not own", async () => {
    const res = await openCrate(db, GUILD, BIDDER1, "void", NOW, mulberry32(1));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/don't have/);
  });

  it("loot tables: wooden never holds monsters/pets, void always holds gems in range", () => {
    for (let seed = 0; seed < 200; seed++) {
      const wooden = rollCrateLoot("wooden", mulberry32(seed));
      expect(wooden.some((d) => d.kind === "monster" || d.kind === "pet")).toBe(false);
      for (const d of wooden.filter((x) => x.kind === "weapon")) {
        expect(WEAPON_BY_ID.get(Number(d.ref))!.tier).toBe("Common");
      }
      const voidDrops = rollCrateLoot("void", mulberry32(seed));
      const gems = voidDrops.find((d) => d.kind === "gems")!;
      expect(gems).toBeDefined();
      expect(gems.qty).toBeGreaterThanOrEqual(15);
      expect(gems.qty).toBeLessThanOrEqual(30);
      const gold = voidDrops.find((d) => d.kind === "gold")!;
      expect(gold.qty).toBeGreaterThanOrEqual(2500);
      expect(gold.qty).toBeLessThanOrEqual(5000);
      const crystal = rollCrateLoot("crystal", mulberry32(seed));
      expect(crystal.some((d) => d.kind === "gems")).toBe(true);
    }
  });
});

describe("market commands (command-level)", () => {
  const auctionCmd = commands.find((c) => c.name === "auction")!;
  const shopCmd = commands.find((c) => c.name === "shop")!;
  const cratesCmd = commands.find((c) => c.name === "crates")!;
  const openCmd = commands.find((c) => c.name === "open")!;
  const gemsCmd = commands.find((c) => c.name === "gems")!;

  it("uwu auction sell / list / bid flow through the command", async () => {
    await giveMonster(SELLER, 26);
    await giveGold(BIDDER1, 1000);
    const sell = new FakeInv(SELLER, { action: "sell", target: "Stone Beetle 500" });
    await auctionCmd.execute(sell, ctxFor(db));
    expect(sell.text()).toMatch(/Listed #\d+ — Stone Beetle/);
    const list = new FakeInv(BIDDER1, { action: "list", target: null });
    await auctionCmd.execute(list, ctxFor(db));
    expect(list.text()).toMatch(/Stone Beetle/);
    const id = Number(/Listed #(\d+)/.exec(sell.text())![1]);
    const bid = new FakeInv(BIDDER1, { action: "bid", target: `${id} 500` });
    await auctionCmd.execute(bid, ctxFor(db));
    expect(bid.text()).toMatch(/top bidder/);
    expect(await goldOf(BIDDER1)).toBe(500);
    const info = new FakeInv(BIDDER1, { action: "info", target: String(id) });
    await auctionCmd.execute(info, ctxFor(db));
    expect(info.text()).toMatch(/Top bid: 500 gold/);
  });

  it("uwu shop shows stock and buys", async () => {
    await giveGold(BIDDER1, 10000);
    const show = new FakeInv(BIDDER1, { action: null, item: null });
    await shopCmd.execute(show, ctxFor(db));
    expect(show.text()).toMatch(/Today's shop/);
    expect(show.text()).toMatch(/Lure Bait/);
    const buy = new FakeInv(BIDDER1, { action: "buy", item: "Lure Bait 2" });
    await shopCmd.execute(buy, ctxFor(db));
    expect(buy.text()).toMatch(/Bought 2 × Lure Bait for 600 gold/);
  });

  it("uwu crates / open / gems", async () => {
    await grantCrate(db, BIDDER1, "iron", 2);
    await grantGems(db, BIDDER1, 7);
    const list = new FakeInv(BIDDER1);
    await cratesCmd.execute(list, ctxFor(db));
    expect(list.text()).toMatch(/Iron Crate ×2/);
    const open = new FakeInv(BIDDER1, { crate: "iron crate" });
    await openCmd.execute(open, ctxFor(db));
    expect(open.text()).toMatch(/You opened an Iron Crate!/);
    const gems = new FakeInv(BIDDER1);
    await gemsCmd.execute(gems, ctxFor(db));
    // Opening the crate can itself drop gems (Iron has a gem chance),
    // so the balance is 7 plus whatever the crate paid out — never less.
    const m = gems.text().match(/You have (\d+) gems/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(7);
  });
});

// ---------------------------------------------------------------------------
// Shop backgrounds (Worker C) — `uwu shop bg` / `uwu shop buy bg <name>`
//
// The real manifest (assets/profile-bgs/manifest.json, Worker A) is not
// on disk yet, so these tests point the loader at the same fixture
// manifest test/profile.test.ts uses (default + 10 static + 20
// animated) and re-import the market module fresh after
// vi.resetModules(), so it picks the fixture up. The statically
// imported `commands` above keep the empty catalogue — only the
// dynamically imported copy below is used here.
// ---------------------------------------------------------------------------

describe("shop backgrounds", () => {
  let bgShopCmd: { execute: (inv: CommandInvocation, ctx: CommandContext) => Promise<void> };
  let bgButtonHandlers: Record<string, (...args: never[]) => Promise<void>>;
  let bgProfileLib: typeof import("../src/lib/profile.js");

  beforeEach(async () => {
    db = getTestDb();
    process.env.SELENA_PROFILE_BGS_MANIFEST = fileURLToPath(
      new URL("./fixtures/profile-bgs/manifest.json", import.meta.url),
    );
    vi.resetModules();
    const fresh = await import("../src/commands/market.js");
    bgShopCmd = fresh.commands.find((c) => c.name === "shop")!;
    bgButtonHandlers = fresh.buttonHandlers;
    bgProfileLib = await import("../src/lib/profile.js");
  });

  /** Flip the bg list to `page` (0-based) via the ◀ N ▶ button handler. */
  async function flipBgPage(page: number): Promise<string> {
    const handler = bgButtonHandlers["selena:shopbg"]!;
    const updates: { content: string; components?: unknown }[] = [];
    await handler(
      {
        customId: `selena:shopbg:list:${page}`,
        user: { id: BIDDER1 },
        update: async (p: { content: string; components?: unknown }) => {
          updates.push(p);
        },
        reply: async () => {},
      } as never,
      ctxFor(db) as never,
    );
    expect(updates).toHaveLength(1);
    return String(updates[0]!.content);
  }

  function buttonLabels(payload: ReplyPayload): { label: string; disabled?: boolean }[] {
    const comps = (payload as unknown as {
      components?: { toJSON: () => { components: { label: string; disabled?: boolean }[] } }[];
    }).components;
    if (!comps) return [];
    return comps.flatMap((row) => row.toJSON().components.map((b) => ({ label: b.label, disabled: b.disabled })));
  }

  it("uwu shop bg page 1 lists backgrounds 1–10 in the OwO format", async () => {
    const inv = new FakeInv(BIDDER1, { action: "bg", item: null });
    await bgShopCmd.execute(inv, ctxFor(db));
    const text = inv.text();
    expect(text).toContain("30 total");
    expect(text).toContain("Page 1/3");
    // Numbered rows with dotted leaders and compact prices.
    expect(text).toMatch(/1  🖼️ Meadow Dawn\.+ 10K \[static\]/);
    expect(text).toMatch(/10  🖼️ Misty Lake\.+ 20K \[static\]/);
    // Page 1 is the 10 static backgrounds only — the GIFs live on later pages.
    expect(text).not.toContain("Starfall");
    expect(text).not.toContain("Static (10):");
    expect(text).not.toContain("Animated GIF (20):");
    // OwO-style ◀ N ▶ buttons: prev disabled, current page "1", next live.
    expect(buttonLabels(inv.replies[0]!).map((b) => b.label)).toEqual(["◀", "1", "▶"]);
    expect(buttonLabels(inv.replies[0]!)[0]!.disabled).toBe(true);
    expect(buttonLabels(inv.replies[0]!)[2]!.disabled).toBe(false);
  });

  it("flipping pages shows 11–20 then 21–30, and uwu shop bg 2 jumps to page 2", async () => {
    const page2 = await flipBgPage(1);
    expect(page2).toContain("Page 2/3");
    expect(page2).toMatch(/11  🖼️ Starfall\.+ 25K \[GIF\]/);
    expect(page2).toMatch(/20  🖼️ Butterfly Garden\.+ 45K \[GIF\]/);
    expect(page2).not.toContain("Meadow Dawn");
    const page3 = await flipBgPage(2);
    expect(page3).toContain("Page 3/3");
    expect(page3).toMatch(/21  🖼️ Cloud Drift\.+ 26K \[GIF\]/);
    expect(page3).toMatch(/30  🖼️ Cosmic Dust\.+ 44K \[GIF\]/);
    // `uwu shop bg 2` jumps straight to page 2.
    const inv = new FakeInv(BIDDER1, { action: "bg", item: "2" });
    await bgShopCmd.execute(inv, ctxFor(db));
    expect(inv.text()).toContain("Page 2/3");
    expect(inv.text()).toContain("Starfall");
  });

  it("uwu shop buy bg <number> buys by list number", async () => {
    await giveGold(BIDDER1, 100000);
    const buy1 = new FakeInv(BIDDER1, { action: "buy", item: "bg 1" });
    await bgShopCmd.execute(buy1, ctxFor(db));
    expect(buy1.text()).toContain("Bought **Meadow Dawn** for 10,000 gold");
    const buy11 = new FakeInv(BIDDER1, { action: "buy", item: "bg 11" });
    await bgShopCmd.execute(buy11, ctxFor(db));
    expect(buy11.text()).toContain("Bought **Starfall** for 25,000 gold");
    expect(await bgProfileLib.getOwnedBackgrounds(db, BIDDER1)).toEqual(["meadow-dawn", "starfall"]);
    const bad = new FakeInv(BIDDER1, { action: "buy", item: "bg 99" });
    await bgShopCmd.execute(bad, ctxFor(db));
    expect(bad.text()).toContain("no background #99");
    const zero = new FakeInv(BIDDER1, { action: "buy", item: "bg 0" });
    await bgShopCmd.execute(zero, ctxFor(db));
    expect(zero.text()).toContain("no background #0");
  });

  it("uwu shop buy bg buys one of each type and the daily shop is untouched", async () => {
    await giveGold(BIDDER1, 100000);
    const buyStatic = new FakeInv(BIDDER1, { action: "buy", item: "bg meadow-dawn" });
    await bgShopCmd.execute(buyStatic, ctxFor(db));
    expect(buyStatic.text()).toContain("Bought **Meadow Dawn** for 10,000 gold");
    const buyGif = new FakeInv(BIDDER1, { action: "buy", item: "bg starfall" });
    await bgShopCmd.execute(buyGif, ctxFor(db));
    expect(buyGif.text()).toContain("Bought **Starfall** for 25,000 gold");
    expect(buyGif.text()).toContain("65,000 gold left");
    expect(await bgProfileLib.getOwnedBackgrounds(db, BIDDER1)).toEqual(["meadow-dawn", "starfall"]);
    // Daily rotating stock is a separate path and still works.
    const buyDaily = new FakeInv(BIDDER1, { action: "buy", item: "Lure Bait" });
    await bgShopCmd.execute(buyDaily, ctxFor(db));
    expect(buyDaily.text()).toContain("Bought 1 × Lure Bait");
  });
});
