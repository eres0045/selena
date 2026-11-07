import { describe, it, expect, beforeEach } from "vitest";
import { type SelenaDb } from "../src/lib/db.js";
import { getTestDb } from "./testDb.js";
import { FakeButton, FakeChatInput } from "../src/lib/testkit.js";
import { addPoints, getBalance } from "../src/lib/economy.js";
import {
  blackjackGames,
  blackjackValue,
  buildDeck,
  coinflipOutcome,
  createBlackjackGame,
  creditWin,
  dealerPlay,
  highlowOutcome,
  highLowRankName,
  isBlackjack,
  placeBet,
  randomSuit,
  rankOf,
  rouletteOutcome,
  scratchOutcome,
  SCRATCH_SYMBOLS,
  settleBlackjack,
  SLOT_SYMBOLS,
  slotsSpin,
  suitOf,
} from "../src/lib/casino.js";
import { buttonHandlers, commands as casinoCommands } from "../src/commands/casino.js";
import { VISUAL_SUSPENSE } from "../src/lib/visualgames.js";
import type { CommandContext } from "../src/lib/command.js";

let db: SelenaDb;
let ctx: CommandContext;
const GUILD = "guild-1";

async function seed(userId: string, points: number): Promise<void> {
  await addPoints(db, GUILD, userId, points, "seed");
}

function findCommand(name: string) {
  const cmd = casinoCommands.find((c) => c.data.name === name);
  if (!cmd) throw new Error(`command not found: ${name}`);
  return cmd;
}

async function run(name: string, options: Record<string, unknown>, userId = "user-1", username = "tester") {
  const cmd = findCommand(name);
  const fake = new FakeChatInput({ commandName: name, options, userId, username, guildId: GUILD });
  await cmd.execute(fake as never, ctx);
  return fake;
}

/** Deterministic rand cycling through the given values. */
function seqRand(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length] as number;
}

beforeEach(async () => {
  db = getTestDb();
  ctx = { db, guildId: GUILD };
  blackjackGames.clear();
  // The visual games wait ~2.4s between the spin and the reveal edit;
  // tests exercise the flow, not the wait.
  VISUAL_SUSPENSE.ms = 0;
});

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

describe("slotsSpin", () => {
  it("jackpot: three 7s pay 50x", async () => {
    const r = slotsSpin(() => 0.99);
    expect(r.symbols).toEqual(["7️⃣", "7️⃣", "7️⃣"]);
    expect(r.multiplier).toBe(50);
    expect(r.jackpot).toBe(true);
  });

  it("three of a kind (non-jackpot) pays 10x", async () => {
    const r = slotsSpin(() => 0.01); // 🍒
    expect(r.symbols).toEqual(["🍒", "🍒", "🍒"]);
    expect(r.multiplier).toBe(10);
  });

  it("exactly two matching pays 2x", async () => {
    const r = slotsSpin(seqRand([0.01, 0.01, 0.5])); // 🍒 🍒 ⭐
    expect(r.multiplier).toBe(2);
  });

  it("no match pays 0", async () => {
    const r = slotsSpin(seqRand([0.01, 0.2, 0.4])); // 🍒 🍋 🍇
    expect(r.multiplier).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Card codes (rank+suit) — the deck behind the animated flip GIFs
// ---------------------------------------------------------------------------

describe("card codes", () => {
  it("buildDeck returns 52 unique rank+suit codes", async () => {
    const deck = buildDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck).size).toBe(52);
    for (const code of deck) expect(code).toMatch(/^(A|[2-9]|10|J|Q|K)[SHDC]$/);
  });

  it("rankOf/suitOf split codes and pass plain ranks through", async () => {
    expect(rankOf("10H")).toBe("10");
    expect(rankOf("AS")).toBe("A");
    expect(rankOf("10")).toBe("10");
    expect(rankOf("K")).toBe("K");
    expect(suitOf("AS")).toBe("S");
    expect(suitOf("10")).toBeNull();
  });

  it("blackjackValue works on full codes", async () => {
    expect(blackjackValue(["AS", "10H"])).toBe(21);
    expect(blackjackValue(["10D", "KH"])).toBe(20);
    expect(blackjackValue(["AS", "9C", "5D"])).toBe(15);
    expect(blackjackValue(["AD", "AC", "9H"])).toBe(21);
  });

  it("highLowRankName maps 1/11/12/13 to A/J/Q/K", async () => {
    expect(highLowRankName(1)).toBe("A");
    expect(highLowRankName(11)).toBe("J");
    expect(highLowRankName(12)).toBe("Q");
    expect(highLowRankName(13)).toBe("K");
    expect(highLowRankName(7)).toBe("7");
  });

  it("randomSuit returns a suit letter", async () => {
    for (let i = 0; i < 20; i++) expect(["S", "H", "D", "C"]).toContain(randomSuit());
  });
});

// ---------------------------------------------------------------------------
// Blackjack math
// ---------------------------------------------------------------------------

describe("blackjackValue", () => {
  it("adds number cards and face cards as 10", async () => {
    expect(blackjackValue(["10", "K"])).toBe(20);
    expect(blackjackValue(["2", "3", "4"])).toBe(9);
  });

  it("counts a single ace as 11 when it fits", async () => {
    expect(blackjackValue(["A", "9"])).toBe(20);
  });

  it("downgrades aces to 1 to avoid busting", async () => {
    expect(blackjackValue(["A", "9", "5"])).toBe(15);
    expect(blackjackValue(["A", "A", "9"])).toBe(21);
    expect(blackjackValue(["A", "A", "A", "9"])).toBe(12);
  });

  it("reports a bust over 21", async () => {
    expect(blackjackValue(["10", "9", "5"])).toBe(24);
  });
});

describe("blackjack outcomes", () => {
  it("detects a natural blackjack", async () => {
    expect(isBlackjack(["A", "K"])).toBe(true);
    expect(isBlackjack(["A", "K", "2"])).toBe(false);
    expect(isBlackjack(["10", "9", "2"])).toBe(false);
  });

  it("player blackjack pays 2.5x; dealer blackjack beats a plain 21", async () => {
    expect(settleBlackjack(["A", "K"], ["10", "7"])).toEqual({ outcome: "player_blackjack", multiplier: 2.5 });
    expect(settleBlackjack(["A", "K"], ["A", "Q"])).toEqual({ outcome: "push", multiplier: 1 });
    expect(settleBlackjack(["10", "9", "2"], ["A", "K"])).toEqual({ outcome: "dealer_blackjack", multiplier: 0 });
  });

  it("bust loses even if the dealer also busts", async () => {
    expect(settleBlackjack(["10", "9", "5"], ["10", "9", "5"])).toEqual({ outcome: "lose", multiplier: 0 });
  });

  it("dealer bust wins, higher hand wins, equal hands push", async () => {
    expect(settleBlackjack(["10", "8"], ["10", "9", "5"])).toEqual({ outcome: "win", multiplier: 2 });
    expect(settleBlackjack(["10", "9"], ["10", "8"])).toEqual({ outcome: "win", multiplier: 2 });
    expect(settleBlackjack(["10", "8"], ["10", "9"])).toEqual({ outcome: "lose", multiplier: 0 });
    expect(settleBlackjack(["10", "8"], ["9", "9"])).toEqual({ outcome: "push", multiplier: 1 });
  });

  it("dealer stands on 17 and draws below it", async () => {
    const hand = dealerPlay(["5"], ["10", "6"]);
    expect(hand).toEqual(["10", "6", "5"]);
    expect(blackjackValue(hand)).toBe(21);
    const stood = dealerPlay(["K"], ["10", "7"]);
    expect(stood).toEqual(["10", "7"]);
  });
});

// ---------------------------------------------------------------------------
// Roulette / coinflip / high-low / scratch math
// ---------------------------------------------------------------------------

describe("rouletteOutcome", () => {
  it("red wins on a red number, loses on black and on 0", async () => {
    expect(rouletteOutcome("red", 3).win).toBe(true);
    expect(rouletteOutcome("red", 3).multiplier).toBe(2);
    expect(rouletteOutcome("red", 2).win).toBe(false);
    expect(rouletteOutcome("red", 0).win).toBe(false);
  });

  it("black wins on a black number", async () => {
    expect(rouletteOutcome("black", 2)).toMatchObject({ win: true, multiplier: 2 });
    expect(rouletteOutcome("black", 1).win).toBe(false);
  });

  it("even/odd pay 2x and lose on 0", async () => {
    expect(rouletteOutcome("even", 4)).toMatchObject({ win: true, multiplier: 2 });
    expect(rouletteOutcome("even", 0).win).toBe(false);
    expect(rouletteOutcome("odd", 5)).toMatchObject({ win: true, multiplier: 2 });
    expect(rouletteOutcome("odd", 4).win).toBe(false);
  });

  it("a straight number pays 36x only on an exact hit", async () => {
    expect(rouletteOutcome("17", 17)).toMatchObject({ win: true, multiplier: 36 });
    expect(rouletteOutcome("17", 18)).toMatchObject({ win: false, multiplier: 0 });
    expect(rouletteOutcome("0", 0)).toMatchObject({ win: true, multiplier: 36 });
  });

  it("invalid bet-on is flagged", async () => {
    expect(rouletteOutcome("purple", 3).valid).toBe(false);
    expect(rouletteOutcome("37", 3).valid).toBe(false);
    expect(rouletteOutcome("-1", 3).valid).toBe(false);
  });
});

describe("coinflipOutcome", () => {
  it("heads wins when the roll is heads, pays 1.9x", async () => {
    expect(coinflipOutcome("heads", 0.2)).toMatchObject({ result: "heads", win: true, multiplier: 1.9 });
    expect(coinflipOutcome("heads", 0.8)).toMatchObject({ result: "tails", win: false, multiplier: 0 });
  });

  it("tails wins when the roll is tails", async () => {
    expect(coinflipOutcome("tails", 0.8)).toMatchObject({ result: "tails", win: true, multiplier: 1.9 });
  });
});

describe("highlowOutcome", () => {
  it("higher wins when the next card is higher, pays 1.9x", async () => {
    expect(highlowOutcome(5, "higher", 9)).toMatchObject({ outcome: "win", win: true, multiplier: 1.9 });
    expect(highlowOutcome(5, "higher", 2)).toMatchObject({ outcome: "lose", win: false, multiplier: 0 });
  });

  it("lower wins when the next card is lower", async () => {
    expect(highlowOutcome(9, "lower", 3)).toMatchObject({ outcome: "win", multiplier: 1.9 });
    expect(highlowOutcome(9, "lower", 12).outcome).toBe("lose");
  });

  it("a tie is a push returning the bet (1x)", async () => {
    expect(highlowOutcome(7, "higher", 7)).toMatchObject({ outcome: "push", push: true, multiplier: 1 });
  });
});

describe("scratchOutcome", () => {
  it("three matching pay 5x", async () => {
    expect(scratchOutcome(["💎", "💎", "💎"]).multiplier).toBe(5);
  });

  it("two matching pay 1x (bet back)", async () => {
    expect(scratchOutcome(["🍒", "🍒", "⭐"]).multiplier).toBe(1);
    expect(scratchOutcome(["🍒", "⭐", "⭐"]).multiplier).toBe(1);
  });

  it("no match pays 0", async () => {
    expect(scratchOutcome(["🍒", "⭐", "💎"]).multiplier).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// placeBet / creditWin
// ---------------------------------------------------------------------------

describe("placeBet atomicity", () => {
  it("deducts the bet and returns the new balance", async () => {
    await seed("user-1", 100);
    const r = await placeBet(db, GUILD, "user-1", 40);
    expect(r).toEqual({ ok: true, balance: 60 });
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(60);
  });

  it("rejects a bet larger than the balance and changes nothing", async () => {
    await seed("user-1", 50);
    const r = await placeBet(db, GUILD, "user-1", 51);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/insufficient/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(50);
  });

  it("rejects zero / negative / non-integer bets without touching the balance", async () => {
    await seed("user-1", 50);
    expect((await placeBet(db, GUILD, "user-1", 0)).ok).toBe(false);
    expect((await placeBet(db, GUILD, "user-1", -10)).ok).toBe(false);
    expect((await placeBet(db, GUILD, "user-1", 1.5)).ok).toBe(false);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(50);
  });

  it("never drives the balance below zero, even for the exact balance", async () => {
    await seed("user-1", 50);
    expect((await placeBet(db, GUILD, "user-1", 50)).ok).toBe(true);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(0);
    expect((await placeBet(db, GUILD, "user-1", 1)).ok).toBe(false);
  });

  it("creditWin adds winnings and logs them", async () => {
    await seed("user-1", 100);
    expect(await creditWin(db, GUILD, "user-1", 90, "test win")).toBe(190);
  });
});

// ---------------------------------------------------------------------------
// Commands (mocked client): happy path + error path per command
// ---------------------------------------------------------------------------

describe("/slots command", () => {
  it("happy path: replies with a spin result and a balance", async () => {
    await seed("user-1", 1000);
    const fake = await run("slots", { bet: 100 });
    expect(fake.allText()).toMatch(/Slots/);
    expect(fake.replies.length).toBeGreaterThan(0);
    const bal = (await getBalance(db, GUILD, "user-1")).points;
    expect(bal).toBeGreaterThanOrEqual(0);
    expect(bal).toBeLessThanOrEqual(1000 + 100 * 50);
  });

  it("error path: bet of 0 is rejected and the balance is untouched", async () => {
    await seed("user-1", 100);
    const fake = await run("slots", { bet: 0 });
    expect(fake.allText()).toMatch(/positive/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(100);
  });

  it("error path: bet above the balance is rejected", async () => {
    await seed("user-1", 50);
    const fake = await run("slots", { bet: 500 });
    expect(fake.allText()).toMatch(/insufficient/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(50);
  });
});

describe("/blackjack command", () => {
  it("happy path: replies with a game (buttons, or an immediate blackjack settle)", async () => {
    await seed("user-1", 1000);
    const fake = await run("blackjack", { bet: 100 });
    expect(fake.allText()).toMatch(/Blackjack/i);
    // Balance is 900 while a game is in progress (bet deducted), or up to
    // 1150 if a natural blackjack settled immediately (1000 - 100 + 250).
    expect((await getBalance(db, GUILD, "user-1")).points).toBeLessThanOrEqual(1150);
    expect((await getBalance(db, GUILD, "user-1")).points).toBeGreaterThanOrEqual(900);
  });

  it("error path: bet of 0 is rejected", async () => {
    await seed("user-1", 100);
    const fake = await run("blackjack", { bet: 0 });
    expect(fake.allText()).toMatch(/positive/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(100);
  });

  it("error path: bet above the balance is rejected", async () => {
    await seed("user-1", 50);
    const fake = await run("blackjack", { bet: 500 });
    expect(fake.allText()).toMatch(/insufficient/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(50);
  });
  it("error path: bet of 1 with a 0 balance is rejected and no game starts", async () => {
    // Fresh user: 0 points, no daily claimed — the exact live-test case.
    const fake = await run("blackjack", { bet: 1 });
    expect(fake.allText()).toMatch(/insufficient/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(0);
    expect(blackjackGames.size).toBe(0);
  });

  it("defers immediately and replies with ONE compact embed (blue, playing)", async () => {
    await seed("user-1", 1000);
    const fake = await run("blackjack", { bet: 100 });
    expect(fake.replies[0]?.kind).toBe("deferReply");
    const edit = fake.replies.find((r) => r.kind === "editReply");
    expect(edit).toBeDefined();
    const payload = edit!.payload as {
      files?: Array<{ name?: string | null }>;
      embeds?: Array<{
        image?: { url?: string };
        color?: number;
        description?: string | null;
        fields?: unknown[];
        footer?: { text?: string };
      }>;
    };
    // OwO-style: exactly one embed, one small strip GIF, blue while playing.
    expect(payload.embeds?.length).toBe(1);
    const gifFiles = (payload.files ?? []).filter((f) => f.name?.endsWith(".gif"));
    expect(gifFiles).toHaveLength(1);
    expect(gifFiles[0]?.name).toBe("hand.gif");
    expect(payload.embeds?.[0]?.image?.url).toBe("attachment://hand.gif");
    expect(payload.embeds?.[0]?.color).toBe(0x5865f2);
    // The image explains itself (labels + totals in-strip): nothing sits
    // above the cards, and the bet/result line is in the footer below.
    expect(payload.embeds?.[0]?.description).toBeFalsy();
    expect(payload.embeds?.[0]?.fields).toBeUndefined();
    expect(payload.embeds?.[0]?.footer?.text).toMatch(/Bet 100 · /);
    expect(payload.embeds?.[0]?.footer?.text).toMatch(/Balance [\d,]+ points/);
  });
});

describe("blackjack button flow", () => {
  it("hit that busts settles as a loss and removes the game", async () => {
    await seed("user-1", 1000);
    const game = createBlackjackGame(GUILD, "user-1", 100);
    // Force a deterministic losing hand: 10+6, next card K -> bust.
    game.playerHand = ["10", "6"];
    game.dealerHand = ["9", "7"];
    game.deck = ["K"];
    const btn = new FakeButton({ customId: `selena:bj:${game.id}:hit`, userId: "user-1", guildId: GUILD });
    await buttonHandlers["selena:bj"]!(btn, ctx);
    expect(btn.replies.length).toBeGreaterThan(0);
    expect(blackjackGames.has(game.id)).toBe(false);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(1000); // bet was never deducted here; loss = no credit
    // OwO-style: one compact embed, red on a loss.
    const edit = btn.replies.find((r) => r.kind === "editReply");
    const payload = edit?.payload as { embeds?: Array<{ color?: number }> } | undefined;
    expect(payload?.embeds?.length).toBe(1);
    expect(payload?.embeds?.[0]?.color).toBe(0xe74c3c);
  });

  it("stand lets the dealer play and settles (dealer bust = player win 2x)", async () => {
    await seed("user-1", 1000);
    await placeBet(db, GUILD, "user-1", 100, "blackjack");
    const game = createBlackjackGame(GUILD, "user-1", 100);
    game.playerHand = ["10", "7"]; // 17
    game.dealerHand = ["10", "6"]; // 16, draws K and busts
    game.deck = ["K"];
    const btn = new FakeButton({ customId: `selena:bj:${game.id}:stand`, userId: "user-1", guildId: GUILD });
    await buttonHandlers["selena:bj"]!(btn, ctx);
    expect(blackjackGames.has(game.id)).toBe(false);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(1100); // 1000 - 100 + 200
    // OwO-style: one compact embed, green on a win.
    const edit = btn.replies.find((r) => r.kind === "editReply");
    const payload = edit?.payload as { embeds?: Array<{ color?: number }> } | undefined;
    expect(payload?.embeds?.length).toBe(1);
    expect(payload?.embeds?.[0]?.color).toBe(0x2ecc71);
  });

  it("error path: a different user cannot press the buttons", async () => {
    await seed("user-1", 1000);
    const game = createBlackjackGame(GUILD, "user-1", 100);
    game.playerHand = ["10", "6"];
    game.dealerHand = ["9", "7"];
    game.deck = ["5"];
    const btn = new FakeButton({ customId: `selena:bj:${game.id}:hit`, userId: "user-2", guildId: GUILD });
    await buttonHandlers["selena:bj"]!(btn, ctx);
    expect(blackjackGames.has(game.id)).toBe(true); // game untouched
    expect(game.playerHand).toEqual(["10", "6"]);
  });

  it("error path: an expired/unknown game id is rejected", async () => {
    const btn = new FakeButton({ customId: "selena:bj:no-such-game:hit", userId: "user-1", guildId: GUILD });
    await buttonHandlers["selena:bj"]!(btn, ctx);
    expect(btn.replies.length).toBeGreaterThan(0);
  });
});

describe("/roulette command", () => {
  it("happy path: replies with the roll and a balance", async () => {
    await seed("user-1", 1000);
    const fake = await run("roulette", { bet: 100, "bet-on": "red" });
    expect(fake.allText()).toMatch(/Roulette/);
    expect((await getBalance(db, GUILD, "user-1")).points).toBeGreaterThanOrEqual(0);
  });

  it("error path: bet of 0 is rejected", async () => {
    await seed("user-1", 100);
    const fake = await run("roulette", { bet: 0, "bet-on": "red" });
    expect(fake.allText()).toMatch(/positive/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(100);
  });

  it("error path: bet above the balance is rejected", async () => {
    await seed("user-1", 50);
    const fake = await run("roulette", { bet: 500, "bet-on": "red" });
    expect(fake.allText()).toMatch(/insufficient/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(50);
  });

  it("error path: invalid bet-on is rejected before any deduction", async () => {
    await seed("user-1", 100);
    const fake = await run("roulette", { bet: 10, "bet-on": "purple" });
    expect(fake.allText()).toMatch(/invalid bet/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(100);
    const outOfRange = await run("roulette", { bet: 10, "bet-on": "37" });
    expect(outOfRange.allText()).toMatch(/invalid bet/i);
  });
});

describe("/coinflip command", () => {
  it("happy path: replies with the flip result", async () => {
    await seed("user-1", 1000);
    const fake = await run("coinflip", { bet: 100, guess: "heads" });
    expect(fake.allText()).toMatch(/Coinflip/);
    expect(fake.allText()).toMatch(/heads|tails/);
    expect((await getBalance(db, GUILD, "user-1")).points).toBeGreaterThanOrEqual(0);
  });

  it("error path: bet of 0 is rejected", async () => {
    await seed("user-1", 100);
    const fake = await run("coinflip", { bet: 0, guess: "heads" });
    expect(fake.allText()).toMatch(/positive/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(100);
  });

  it("error path: bet above the balance is rejected", async () => {
    await seed("user-1", 50);
    const fake = await run("coinflip", { bet: 500, guess: "tails" });
    expect(fake.allText()).toMatch(/insufficient/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(50);
  });

  it("error path: invalid guess is rejected", async () => {
    await seed("user-1", 100);
    const fake = await run("coinflip", { bet: 10, guess: "edge" });
    expect(fake.allText()).toMatch(/heads or tails/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(100);
  });
});

describe("visual games: suspense -> reveal flow (tiny emoji, NO images)", () => {
  function edits(fake: FakeChatInput) {
    return fake.replies.filter((r) => r.kind === "editReply");
  }
  function fileNames(payload: unknown): string[] {
    const p = payload as { files?: Array<{ name?: string | null }> };
    return (p.files ?? []).map((f) => f.name ?? "");
  }
  function embedOf(payload: unknown): { title?: string; description?: string; image?: { url?: string } } | undefined {
    const p = payload as { embeds?: Array<{ title?: string; description?: string; image?: { url?: string } }> };
    return p.embeds?.[0];
  }
  /** No attached files and no embed image: tiny emoji only. */
  function expectNoImages(payload: unknown): void {
    expect(fileNames(payload)).toEqual([]);
    expect(embedOf(payload)?.image).toBeUndefined();
  }

  it("coinflip: defers, shows the spinning coin, then edits to the landed face emoji matching the result text", async () => {
    await seed("user-1", 1000);
    const fake = await run("coinflip", { bet: 100, guess: "heads" });
    expect(fake.replies[0]?.kind).toBe("deferReply");
    const [spin, settled] = edits(fake);
    expect(spin).toBeDefined();
    expect(settled).toBeDefined();
    expect(embedOf(spin!.payload)?.description).toMatch(/Flipping/);
    expectNoImages(spin!.payload);
    const settledDesc = embedOf(settled!.payload)?.description ?? "";
    const landed = /landed \*\*(heads|tails)\*\*/.exec(settledDesc)?.[1];
    expect(landed).toMatch(/^(heads|tails)$/);
    // The landed face emoji sits in the text (custom <a:heads:id> once
    // uploaded, 🪙 / ⭐ fallback until then).
    expect(settledDesc).toMatch(landed === "heads" ? /🪙|<a:heads:\d+>/ : /⭐|<a:tails:\d+>/);
    expectNoImages(settled!.payload);
  });

  it("slots: defers, shows the spinning machine, then edits to the three REAL result symbols inline", async () => {
    await seed("user-1", 1000);
    const fake = await run("slots", { bet: 100 });
    expect(fake.replies[0]?.kind).toBe("deferReply");
    const [spin, settled] = edits(fake);
    expect(spin).toBeDefined();
    expect(settled).toBeDefined();
    expect(embedOf(spin!.payload)?.description).toMatch(/Spinning/);
    expectNoImages(spin!.payload);
    const settledDesc = embedOf(settled!.payload)?.description ?? "";
    const shown = settledDesc.split("\n")[0]?.split(" ") ?? [];
    expect(shown).toHaveLength(3);
    for (const s of shown) expect(SLOT_SYMBOLS).toContain(s);
    expectNoImages(settled!.payload);
  });

  it("roulette: defers, shows the spinning wheel, then edits to the rolled number + colour dot", async () => {
    await seed("user-1", 1000);
    const fake = await run("roulette", { bet: 100, "bet-on": "red" });
    expect(fake.replies[0]?.kind).toBe("deferReply");
    const [spin, settled] = edits(fake);
    expect(spin).toBeDefined();
    expect(settled).toBeDefined();
    expect(embedOf(spin!.payload)?.description).toMatch(/Spinning/);
    expectNoImages(spin!.payload);
    const settledDesc = embedOf(settled!.payload)?.description ?? "";
    const m = /landed on \*\*(\d+)\*\* (🔴|⚫|🟢)/.exec(settledDesc);
    expect(m).not.toBeNull();
    const rolled = Number(m?.[1]);
    expect(rolled).toBeGreaterThanOrEqual(0);
    expect(rolled).toBeLessThanOrEqual(36);
    // 0 is green; every other number carries a red or black dot.
    if (rolled === 0) expect(m?.[2]).toBe("🟢");
    else expect(["🔴", "⚫"]).toContain(m?.[2]);
    expectNoImages(settled!.payload);
  });

  it("scratch: defers, shows the covered tiles, then edits to the three REAL drawn symbols inline", async () => {
    await seed("user-1", 1000);
    const fake = await run("scratch", { bet: 100 });
    expect(fake.replies[0]?.kind).toBe("deferReply");
    const [spin, settled] = edits(fake);
    expect(spin).toBeDefined();
    expect(settled).toBeDefined();
    expect(embedOf(spin!.payload)?.description).toMatch(/Scratching/);
    expect(embedOf(spin!.payload)?.description).toContain("❓ ❓ ❓");
    expectNoImages(spin!.payload);
    const settledDesc = embedOf(settled!.payload)?.description ?? "";
    const shown = settledDesc.split("\n")[0]?.split(" ") ?? [];
    expect(shown).toHaveLength(3);
    for (const s of shown) expect(SCRATCH_SYMBOLS).toContain(s);
    expectNoImages(settled!.payload);
  });

  it("visual games reply with a single message (defer + 2 edits), never a new reply", async () => {
    await seed("user-1", 1000);
    const fake = await run("coinflip", { bet: 100, guess: "tails" });
    expect(fake.replies.map((r) => r.kind)).toEqual(["deferReply", "editReply", "editReply"]);
  });
});

describe("/highlow command", () => {
  it("happy path: replies with both cards and a balance", async () => {
    await seed("user-1", 1000);
    const fake = await run("highlow", { bet: 100, guess: "higher" });
    expect(fake.allText()).toMatch(/High \/ Low/);
    expect((await getBalance(db, GUILD, "user-1")).points).toBeGreaterThanOrEqual(0);
  });

  it("defers immediately and replies with ONE compact embed (outcome colour)", async () => {
    await seed("user-1", 1000);
    const fake = await run("highlow", { bet: 100, guess: "higher" });
    expect(fake.replies[0]?.kind).toBe("deferReply");
    const edit = fake.replies.find((r) => r.kind === "editReply");
    expect(edit).toBeDefined();
    const payload = edit!.payload as {
      files?: Array<{ name?: string | null }>;
      embeds?: Array<{
        image?: { url?: string };
        color?: number;
        description?: string | null;
        fields?: unknown[];
        footer?: { text?: string };
      }>;
    };
    expect(payload.embeds?.length).toBe(1);
    const gifFiles = (payload.files ?? []).filter((f) => f.name?.endsWith(".gif"));
    expect(gifFiles).toHaveLength(1);
    expect(gifFiles[0]?.name).toBe("hand.gif");
    expect(payload.embeds?.[0]?.image?.url).toBe("attachment://hand.gif");
    // Green win / red loss / gray push.
    expect([0x2ecc71, 0xe74c3c, 0x95a5a6]).toContain(payload.embeds?.[0]?.color);
    // Nothing above the cards; the bet/guess/result line is in the footer.
    expect(payload.embeds?.[0]?.description).toBeFalsy();
    expect(payload.embeds?.[0]?.fields).toBeUndefined();
    expect(payload.embeds?.[0]?.footer?.text).toMatch(/Bet 100 · You guessed higher · /);
    expect(payload.embeds?.[0]?.footer?.text).toMatch(/Balance [\d,]+ points/);
  });

  it("error path: bet of 0 is rejected", async () => {
    await seed("user-1", 100);
    const fake = await run("highlow", { bet: 0, guess: "higher" });
    expect(fake.allText()).toMatch(/positive/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(100);
  });

  it("error path: bet above the balance is rejected", async () => {
    await seed("user-1", 50);
    const fake = await run("highlow", { bet: 500, guess: "lower" });
    expect(fake.allText()).toMatch(/insufficient/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(50);
  });

  it("error path: invalid guess is rejected", async () => {
    await seed("user-1", 100);
    const fake = await run("highlow", { bet: 10, guess: "sideways" });
    expect(fake.allText()).toMatch(/higher or lower/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(100);
  });
});

describe("/scratch command", () => {
  it("happy path: replies with three symbols and a balance", async () => {
    await seed("user-1", 1000);
    const fake = await run("scratch", { bet: 100 });
    expect(fake.allText()).toMatch(/Scratch/);
    expect((await getBalance(db, GUILD, "user-1")).points).toBeGreaterThanOrEqual(0);
  });

  it("error path: bet of 0 is rejected", async () => {
    await seed("user-1", 100);
    const fake = await run("scratch", { bet: 0 });
    expect(fake.allText()).toMatch(/positive/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(100);
  });

  it("error path: bet above the balance is rejected", async () => {
    await seed("user-1", 50);
    const fake = await run("scratch", { bet: 500 });
    expect(fake.allText()).toMatch(/insufficient/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(50);
  });
});
