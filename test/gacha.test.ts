import { beforeEach, describe, expect, it } from "vitest";
import { type SelenaDb } from "../src/lib/db.js";
import { getTestDb } from "./testDb.js";
import { FakeButton, FakeChatInput } from "../src/lib/testkit.js";
import type { CommandContext } from "../src/lib/command.js";
import { mulberry32 } from "../src/lib/rng.js";
import * as lib from "../src/lib/gacha.js";
import { buttonHandlers, commands } from "../src/commands/gacha.js";

let db: SelenaDb;
let ctx: CommandContext;

beforeEach(async () => {
  db = getTestDb();
  ctx = { db, guildId: "guild-1" };
  lib.resetGachaCardCache();
});

const CARDS: lib.GachaCard[] = [
  { id: "card-miya", heroId: "miya", name: "Miya", rarity: "Common" },
  { id: "card-layla", heroId: "layla", name: "Layla", rarity: "Common" },
  { id: "card-tigreal", heroId: "tigreal", name: "Tigreal", rarity: "Rare" },
  { id: "card-eudora", heroId: "eudora", name: "Eudora", rarity: "Rare" },
  { id: "card-selena", heroId: "selena", name: "Selena", rarity: "Epic" },
  { id: "card-ling", heroId: "ling", name: "Ling", rarity: "Legendary" },
];

const cmd = (name: string) => commands.find((c) => c.data.name === name)!;

async function exec(name: string, opts: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const fake = new FakeChatInput({ commandName: name, options: opts, ...extra });
  await cmd(name).execute(fake as never, ctx);
  return fake;
}

async function seedCard(userId: string, cardId: string, count = 1): Promise<void> {
  await db.prepare("INSERT INTO gacha_cards (guild_id, user_id, card_id, count) VALUES (?, ?, ?, ?)").run(
    "guild-1",
    userId,
    cardId,
    count,
  );
}

const NOW = Date.UTC(2026, 10, 6, 12, 0);

// ---------------------------------------------------------------------------
// rollCard / distribution / pity (lib)
// ---------------------------------------------------------------------------

describe("rollCard", () => {
  it("roughly matches the 60/25/11/4 weights over many seeded rolls", async () => {
    const rand = mulberry32(42);
    const counts: Record<string, number> = { Common: 0, Rare: 0, Epic: 0, Legendary: 0 };
    const state = { last_roll: null, pity: 0, total_rolls: 0 };
    const N = 5000;
    for (let i = 0; i < N; i++) {
      const r = lib.rollCard(CARDS, state, rand);
      counts[r.rarity] = (counts[r.rarity] ?? 0) + 1;
    }
    expect(counts.Common! / N).toBeGreaterThan(0.56);
    expect(counts.Common! / N).toBeLessThan(0.64);
    expect(counts.Rare! / N).toBeGreaterThan(0.22);
    expect(counts.Rare! / N).toBeLessThan(0.28);
    expect(counts.Epic! / N).toBeGreaterThan(0.09);
    expect(counts.Epic! / N).toBeLessThan(0.13);
    expect(counts.Legendary! / N).toBeGreaterThan(0.025);
    expect(counts.Legendary! / N).toBeLessThan(0.055);
  });

  it("guarantees Epic+ at pity 10 and resets pity on Epic+", async () => {
    const pityState = { last_roll: null, pity: 10, total_rolls: 10 };
    for (const rand of [() => 0.01, () => 0.5, () => 0.99]) {
      const r = lib.rollCard(CARDS, pityState, rand);
      expect(["Epic", "Legendary"]).toContain(r.rarity);
      expect(r.newPity).toBe(0);
    }
    // Non-epic roll increments pity
    const r = lib.rollCard(CARDS, { last_roll: null, pity: 3, total_rolls: 3 }, () => 0.01);
    expect(r.rarity).toBe("Common");
    expect(r.newPity).toBe(4);
  });

  it("throws with no cards", async () => {
    expect(() => lib.rollCard([], null, () => 0.5)).toThrow("No gacha cards");
  });
});

// ---------------------------------------------------------------------------
// Cooldown + doRoll (lib)
// ---------------------------------------------------------------------------

describe("canRoll / doRoll", () => {
  it("enforces the 1-hour cooldown", async () => {
    expect(lib.canRoll(null, NOW).allowed).toBe(true);
    expect(lib.canRoll({ last_roll: NOW - 10 * 60 * 1000, pity: 0, total_rolls: 1 }, NOW).allowed).toBe(false);
    const remaining = lib.canRoll({ last_roll: NOW - 10 * 60 * 1000, pity: 0, total_rolls: 1 }, NOW).remainingMs;
    expect(remaining).toBeGreaterThan(49 * 60 * 1000);
    expect(lib.canRoll({ last_roll: NOW - 61 * 60 * 1000, pity: 0, total_rolls: 1 }, NOW).allowed).toBe(true);
  });

  it("rolls, persists the card and state, then blocks the second roll", async () => {
    const first = await lib.doRoll(db, "guild-1", "user-1", CARDS, NOW, mulberry32(7));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.totalRolls).toBe(1);
    const summary = await lib.collectionSummary(db, "guild-1", "user-1", CARDS);
    expect(summary.totalCards).toBe(1);
    expect(summary.totalDistinct).toBe(1);
    const state = await lib.getGachaState(db, "guild-1", "user-1");
    expect(state.total_rolls).toBe(1);
    expect(state.last_roll).toBe(NOW);

    const second = await lib.doRoll(db, "guild-1", "user-1", CARDS, NOW + 1000, mulberry32(8));
    expect(second).toMatchObject({ ok: false });
    if (!second.ok) expect(second.error).toContain("cooldown");

    const later = await lib.doRoll(db, "guild-1", "user-1", CARDS, NOW + 61 * 60 * 1000, mulberry32(9));
    expect(later.ok).toBe(true);
  });

  it("applies pity through doRoll after 10 non-epic rolls", async () => {
    // Force 10 Common rolls, then the 11th must be Epic+
    const alwaysCommon = () => 0.01;
    let now = NOW;
    for (let i = 0; i < 10; i++) {
      const r = await lib.doRoll(db, "guild-1", "user-1", CARDS, now, alwaysCommon);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.rarity).toBe("Common");
      now += 61 * 60 * 1000;
    }
    const state = await lib.getGachaState(db, "guild-1", "user-1");
    expect(state.pity).toBe(10);
    const eleventh = await lib.doRoll(db, "guild-1", "user-1", CARDS, now, alwaysCommon);
    expect(eleventh.ok).toBe(true);
    if (eleventh.ok) {
      expect(["Epic", "Legendary"]).toContain(eleventh.rarity);
      expect(eleventh.pity).toBe(0);
    }
  });

  it("errors when no cards are configured", async () => {
    expect(await lib.doRoll(db, "guild-1", "user-1", [], NOW)).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// Collection / swap / leaderboard (lib)
// ---------------------------------------------------------------------------

describe("collectionSummary", () => {
  it("groups owned cards by rarity with counts", async () => {
    await seedCard("user-1", "card-miya", 2);
    await seedCard("user-1", "card-selena", 1);
    await seedCard("user-1", "card-ling", 3);
    const s = await lib.collectionSummary(db, "guild-1", "user-1", CARDS);
    expect(s.totalDistinct).toBe(3);
    expect(s.totalCards).toBe(6);
    expect(s.byRarity.Common).toHaveLength(1);
    expect(s.byRarity.Common![0]).toMatchObject({ name: "Miya", count: 2 });
    expect(s.byRarity.Epic![0]!.name).toBe("Selena");
    expect(s.byRarity.Legendary![0]!.count).toBe(3);
    expect(await lib.collectionSummary(db, "guild-1", "nobody", CARDS)).toMatchObject({ totalDistinct: 0, totalCards: 0 });
  });

  it("groups under Unknown without a catalogue", async () => {
    await seedCard("user-1", "card-miya", 1);
    const s = await lib.collectionSummary(db, "guild-1", "user-1");
    expect(s.byRarity.Unknown).toHaveLength(1);
  });
});

describe("swapCards", () => {
  it("swaps both sides atomically", async () => {
    await seedCard("user-a", "card-miya", 2);
    await seedCard("user-b", "card-ling", 1);
    expect(await lib.swapCards(db, "guild-1", "user-a", "card-miya", "user-b", "card-ling")).toEqual({ ok: true });
    const a = await lib.collectionSummary(db, "guild-1", "user-a", CARDS);
    const b = await lib.collectionSummary(db, "guild-1", "user-b", CARDS);
    expect(a.byRarity.Common![0]!.count).toBe(1); // one Miya left
    expect(a.byRarity.Legendary![0]!.name).toBe("Ling");
    expect(b.byRarity.Legendary).toBeUndefined(); // Ling gone
    expect(b.byRarity.Common![0]!.name).toBe("Miya");
  });

  it("leaves both sides unchanged on failure", async () => {
    await seedCard("user-a", "card-miya", 1);
    await seedCard("user-b", "card-ling", 1);
    const before = JSON.stringify(await lib.collectionSummary(db, "guild-1", "user-a", CARDS)) +
      JSON.stringify(await lib.collectionSummary(db, "guild-1", "user-b", CARDS));
    expect(await lib.swapCards(db, "guild-1", "user-a", "card-miya", "user-b", "card-selena")).toMatchObject({ ok: false });
    expect(await lib.swapCards(db, "guild-1", "user-a", "card-miya", "user-a", "card-ling")).toMatchObject({ ok: false });
    const after = JSON.stringify(await lib.collectionSummary(db, "guild-1", "user-a", CARDS)) +
      JSON.stringify(await lib.collectionSummary(db, "guild-1", "user-b", CARDS));
    expect(after).toBe(before);
  });
});

describe("gachaLeaderboard", () => {
  it("orders by distinct cards, then total cards", async () => {
    await seedCard("u1", "card-miya", 1);
    await seedCard("u1", "card-layla", 1);
    await seedCard("u1", "card-tigreal", 1);
    await seedCard("u2", "card-miya", 4);
    await seedCard("u2", "card-layla", 1);
    await seedCard("u3", "card-miya", 1);
    await seedCard("u3", "card-layla", 1);
    const board = await lib.gachaLeaderboard(db, "guild-1");
    expect(board.map((e) => e.userId)).toEqual(["u1", "u2", "u3"]);
    expect(board[1]).toMatchObject({ distinctCards: 2, totalCards: 5 });
    expect(await lib.gachaLeaderboard(db, "other-guild")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mocked-client integration tests
// ---------------------------------------------------------------------------

describe("/roll command", () => {
  it("rolls a card and then hits the cooldown", async () => {
    const first = await exec("roll", {}, { userId: "user-1" });
    // Real catalogue (src/data/heroes.ts) is loaded: expect a card reply.
    expect(first.allText()).toMatch(/Common|Rare|Epic|Legendary/);
    expect(first.allText()).toContain("Odds");
    const second = await exec("roll", {}, { userId: "user-1" });
    expect(second.allText()).toContain("cooldown");
  });
});

describe("/collection command", () => {
  it("lists owned cards grouped by rarity", async () => {
    await seedCard("user-1", "card-miya", 2);
    await seedCard("user-1", "card-selena", 1);
    const res = await exec("collection", {}, { userId: "user-1", username: "one" });
    expect(res.allText()).toContain("Collection");
    expect(res.allText()).toContain("Miya");
    expect(res.allText()).toContain("Selena");
    expect(res.allText()).toContain("Common");
    expect(res.allText()).toContain("Epic");
  });

  it("reports an empty collection", async () => {
    const res = await exec("collection", {}, { userId: "nobody", username: "nobody" });
    expect(res.allText()).toContain("No cards yet");
  });
});

describe("/trade command + accept/decline buttons", () => {
  it("proposes a trade and completes the swap on accept", async () => {
    await seedCard("user-a", "card-miya", 1);
    await seedCard("user-b", "card-ling", 1);
    const proposed = await exec(
      "trade",
      {
        user: { id: "user-b", username: "bee" },
        "card-id": "card-miya",
        "their-card-id": "card-ling",
      },
      { userId: "user-a", username: "ay" },
    );
    expect(proposed.allText()).toContain("Trade proposal");
    expect(JSON.stringify(proposed.replies)).toContain("selena:trade:accept:user-a:user-b:card-miya:card-ling");

    const accept = new FakeButton({
      customId: "selena:trade:accept:user-a:user-b:card-miya:card-ling",
      userId: "user-b",
    });
    await buttonHandlers["selena:trade"]!(accept as never, ctx);
    expect(await lib.ownsCard(db, "guild-1", "user-a", "card-ling")).toBe(true);
    expect(await lib.ownsCard(db, "guild-1", "user-b", "card-miya")).toBe(true);
    expect(await lib.ownsCard(db, "guild-1", "user-a", "card-miya")).toBe(false);
  });

  it("decline leaves both collections unchanged", async () => {
    await seedCard("user-a", "card-miya", 1);
    await seedCard("user-b", "card-ling", 1);
    await exec(
      "trade",
      { user: { id: "user-b", username: "bee" }, "card-id": "card-miya", "their-card-id": "card-ling" },
      { userId: "user-a" },
    );
    const decline = new FakeButton({
      customId: "selena:trade:decline:user-a:user-b:card-miya:card-ling",
      userId: "user-b",
    });
    await buttonHandlers["selena:trade"]!(decline as never, ctx);
    expect(await lib.ownsCard(db, "guild-1", "user-a", "card-miya")).toBe(true);
    expect(await lib.ownsCard(db, "guild-1", "user-b", "card-ling")).toBe(true);
  });

  it("rejects trades for cards not owned, self-trades, and wrong-user accepts", async () => {
    const notOwned = await exec(
      "trade",
      { user: { id: "user-b", username: "bee" }, "card-id": "card-miya", "their-card-id": "card-ling" },
      { userId: "user-a" },
    );
    expect(notOwned.allText()).toContain("don't own");
    const self = await exec(
      "trade",
      { user: { id: "user-a", username: "ay" }, "card-id": "card-miya", "their-card-id": "card-ling" },
      { userId: "user-a" },
    );
    expect(self.allText()).toContain("can't trade with yourself");

    await seedCard("user-a", "card-miya", 1);
    await seedCard("user-b", "card-ling", 1);
    const stranger = new FakeButton({
      customId: "selena:trade:accept:user-a:user-b:card-miya:card-ling",
      userId: "user-c",
    });
    await buttonHandlers["selena:trade"]!(stranger as never, ctx);
    expect(await lib.ownsCard(db, "guild-1", "user-a", "card-miya")).toBe(true);
  });
});

describe("/gacha-leaderboard command", () => {
  it("lists top collectors", async () => {
    await seedCard("u1", "card-miya", 1);
    await seedCard("u1", "card-layla", 1);
    await seedCard("u2", "card-miya", 3);
    const res = await exec("gacha-leaderboard");
    expect(res.allText()).toContain("leaderboard");
    const idxU1 = res.allText().indexOf("<@u1>");
    const idxU2 = res.allText().indexOf("<@u2>");
    expect(idxU1).toBeGreaterThan(-1);
    expect(idxU2).toBeGreaterThan(idxU1); // u1 (2 distinct) ranks above u2 (1 distinct)
  });

  it("reports an empty leaderboard", async () => {
    const res = await exec("gacha-leaderboard");
    expect(res.allText()).toContain("Nobody owns any cards yet");
  });
});
