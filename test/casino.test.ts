import { describe, it, expect, beforeEach } from "vitest";
import { type SelenaDb } from "../src/lib/db.js";
import { getTestDb } from "./testDb.js";
import { FakeButton, FakeChatInput } from "../src/lib/testkit.js";
import { addPoints, getBalance } from "../src/lib/economy.js";
import {
  blackjackGames,
  blackjackValue,
  buildDeck,
  CASINO_RAND,
  coinflipOutcome,
  createBlackjackGame,
  createHighlowGame,
  createMinesGame,
  creditWin,
  dealerPlay,
  getHighlowGame,
  getMinesGame,
  HIGHLOW_SAME_MIN_MULTIPLIER,
  highlowCashOut,
  highlowGames,
  highlowGuessWin,
  highlowLadderMultiplier,
  highLowRankName,
  isBlackjack,
  minesCashOut,
  minesGames,
  minesMultiplier,
  placeBet,
  randomSuit,
  rankOf,
  rouletteOutcome,
  scratchOutcome,
  settleBlackjack,
  slotsSpin,
  suitOf,
} from "../src/lib/casino.js";
import { buttonHandlers, commands as casinoCommands } from "../src/commands/casino.js";
import { SLOT_SPIN, VISUAL_SUSPENSE } from "../src/lib/visualgames.js";
import type { CommandContext } from "../src/lib/command.js";

let db: SelenaDb;
let ctx: CommandContext;
const GUILD = "guild-1";

async function seed(userId: string, points: number): Promise<void> {
  await addPoints(db, GUILD, userId, points, "seed");
}

function findCommand(name: string) {
  const cmd = casinoCommands.find((c) => c.name === name);
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
  highlowGames.clear();
  minesGames.clear();
  CASINO_RAND.fn = null;
  // The visual games wait ~2.4s between the spin and the reveal edit;
  // tests exercise the flow, not the wait.
  VISUAL_SUSPENSE.ms = 0;
  SLOT_SPIN.frameMs = 0;
});

/** Click a casino button (selena:bj / selena:hl / selena:mines) and return the FakeButton. */
async function click(customId: string, userId = "user-1") {
  const btn = new FakeButton({ customId, userId, guildId: GUILD });
  const key = customId.split(":").slice(0, 2).join(":");
  await buttonHandlers[key]!(btn, ctx);
  return btn;
}

/** Content of the last editReply on a FakeButton (or FakeChatInput). */
function editedContent(fake: { replies: Array<{ kind: string; payload: unknown }> }): string {
  const edit = fake.replies.find((r) => r.kind === "editReply");
  const p = edit?.payload as { content?: string } | undefined;
  return p?.content ?? "";
}

/** Serialised components (ActionRow JSON) of the last editReply. */
function editedComponents(fake: {
  replies: Array<{ kind: string; payload: unknown }>;
}): Array<Record<string, unknown>> {
  const edit = fake.replies.find((r) => r.kind === "editReply");
  const p = edit?.payload as { components?: Array<{ toJSON: () => Record<string, unknown> }> } | undefined;
  return (p?.components ?? []).map((c) => c.toJSON());
}

/** Content of the first ephemeral reply on a FakeButton. */
function replyContent(btn: FakeButton): string {
  const reply = btn.replies.find((r) => r.kind === "reply");
  const p = reply?.payload as { content?: string } | undefined;
  return p?.content ?? "";
}

/** All button custom_ids in the last editReply, flattened across rows. */
function buttonIds(fake: { replies: Array<{ kind: string; payload: unknown }> }): string[] {
  const rows = editedComponents(fake);
  const ids: string[] = [];
  for (const row of rows) {
    const comps = row.components as Array<Record<string, unknown>> | undefined;
    for (const c of comps ?? []) if (typeof c.custom_id === "string") ids.push(c.custom_id);
  }
  return ids;
}

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
// Card codes (rank+suit) — the deck behind the text card displays
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

describe("highlow streak rules", () => {
  it("highlowGuessWin: higher / lower / same resolve on the rank", async () => {
    expect(highlowGuessWin(5, "higher", 9)).toBe(true);
    expect(highlowGuessWin(5, "higher", 2)).toBe(false);
    expect(highlowGuessWin(9, "lower", 3)).toBe(true);
    expect(highlowGuessWin(9, "lower", 12)).toBe(false);
    // A tie is NOT higher or lower — only "same" wins it.
    expect(highlowGuessWin(7, "higher", 7)).toBe(false);
    expect(highlowGuessWin(7, "lower", 7)).toBe(false);
    expect(highlowGuessWin(7, "same", 7)).toBe(true);
    expect(highlowGuessWin(7, "same", 8)).toBe(false);
  });

  it("ladder: 1.8x, 3.2x, 5x, 7.5x, 11x, then x1.5 per step", async () => {
    expect(highlowLadderMultiplier(0)).toBe(0);
    expect(highlowLadderMultiplier(1)).toBe(1.8);
    expect(highlowLadderMultiplier(2)).toBe(3.2);
    expect(highlowLadderMultiplier(3)).toBe(5);
    expect(highlowLadderMultiplier(4)).toBe(7.5);
    expect(highlowLadderMultiplier(5)).toBe(11);
    expect(highlowLadderMultiplier(6)).toBeCloseTo(16.5, 10);
    expect(highlowLadderMultiplier(7)).toBeCloseTo(24.75, 10);
  });

  it("cash out is floor(bet x multiplier), 0 at streak 0", async () => {
    const game = createHighlowGame(GUILD, "user-1", 10);
    expect(highlowCashOut(game)).toBe(0);
    game.streak = 1;
    game.multiplier = highlowLadderMultiplier(1);
    expect(highlowCashOut(game)).toBe(18);
    game.streak = 2;
    game.multiplier = highlowLadderMultiplier(2);
    expect(highlowCashOut(game)).toBe(32);
    // A correct Same jumps the multiplier to at least 10x.
    game.multiplier = Math.max(game.multiplier, HIGHLOW_SAME_MIN_MULTIPLIER);
    expect(highlowCashOut(game)).toBe(100);
  });

  it("createHighlowGame stores the first card and registers the game", async () => {
    const game = createHighlowGame(GUILD, "user-1", 10);
    expect(game.currentRank).toBeGreaterThanOrEqual(1);
    expect(game.currentRank).toBeLessThanOrEqual(13);
    expect(game.streak).toBe(0);
    expect(game.multiplier).toBe(0);
    expect(getHighlowGame(game.id)).toBe(game);
  });
});

describe("minesMultiplier", () => {
  it("3 mines ladder: 1.40x, 2.08x, 3.38x, 6.28x, 14.61x, 54.35x", async () => {
    expect(minesMultiplier(3, 0)).toBe(0);
    expect(minesMultiplier(3, 1)).toBeCloseTo(1.4, 10);
    expect(minesMultiplier(3, 2)).toBeCloseTo(2.08, 10);
    expect(minesMultiplier(3, 3)).toBeCloseTo(3.38, 10);
    expect(minesMultiplier(3, 4)).toBeCloseTo(6.28, 10);
    expect(minesMultiplier(3, 5)).toBeCloseTo(14.61, 10);
    expect(minesMultiplier(3, 6)).toBeCloseTo(54.35, 10);
  });

  it("more mines pay more per pick; 1 mine's full board pays ~5.04x", async () => {
    expect(minesMultiplier(5, 1)).toBeGreaterThan(minesMultiplier(3, 1));
    expect(minesMultiplier(1, 1)).toBeCloseTo(1.05, 10);
    expect(minesMultiplier(1, 8)).toBeCloseTo(5.04, 10);
  });

  it("createMinesGame places exactly N mines on distinct tiles", async () => {
    const game = createMinesGame(GUILD, "user-1", 10, 5);
    expect(game.mineTiles).toHaveLength(5);
    expect(new Set(game.mineTiles).size).toBe(5);
    for (const t of game.mineTiles) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(8);
    }
    expect(game.safePicks).toBe(0);
    expect(getMinesGame(game.id)).toBe(game);
    expect(minesCashOut(game)).toBe(0);
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
    expect(fake.allText()).toMatch(/SLOTS/);
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

  it("defers immediately and replies with ONE plain-text message (no embed, no image)", async () => {
    await seed("user-1", 1000);
    const fake = await run("blackjack", { bet: 100 });
    expect(fake.replies[0]?.kind).toBe("deferReply");
    const edit = fake.replies.find((r) => r.kind === "editReply");
    expect(edit).toBeDefined();
    const payload = edit!.payload as {
      content?: string;
      files?: Array<{ name?: string | null }>;
      embeds?: unknown[];
      components?: unknown[];
    };
    // OwO-style plain text: content only, no embed, no attached image —
    // and the Hit/Stand buttons ride on the plain-text message.
    expect(payload.embeds).toBeUndefined();
    expect(payload.files ?? []).toHaveLength(0);
    expect(payload.components?.length).toBe(1);
    // Glyph card faces with OwO bracket totals: dealer hides the hole
    // card as [?+?] + face-down 🂠, player shows [total].
    expect(payload.content).toMatch(/Blackjack/);
    expect(payload.content).toMatch(/Dealer \[\?\+\?\]: .+ 🂠/);
    expect(payload.content).toMatch(/tester \[\d+\]:/);
    expect(payload.content).toMatch(/Bet 100 · /);
    expect(payload.content).toMatch(/Balance [\d,]+ gold/);
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
    // OwO-style: one plain-text message, no embed, naming the bust.
    const edit = btn.replies.find((r) => r.kind === "editReply");
    const payload = edit?.payload as { content?: string; embeds?: unknown[] } | undefined;
    expect(payload?.embeds).toBeUndefined();
    expect(payload?.content).toMatch(/Bust/);
    expect(payload?.content).toMatch(/lost 100 gold/);
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
    // OwO-style: one plain-text message, no embed, naming the win.
    const edit = btn.replies.find((r) => r.kind === "editReply");
    const payload = edit?.payload as { content?: string; embeds?: unknown[] } | undefined;
    expect(payload?.embeds).toBeUndefined();
    expect(payload?.content).toMatch(/won 200 gold/);
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

describe("visual games: OwO-style plain text, no embed, no attached images", () => {
  function edits(fake: FakeChatInput) {
    return fake.replies.filter((r) => r.kind === "editReply");
  }
  function fileNames(payload: unknown): string[] {
    const p = payload as { files?: Array<{ name?: string | null }> };
    return (p.files ?? []).map((f) => f.name ?? "");
  }
  function contentOf(payload: unknown): string {
    const p = payload as { content?: string; embeds?: unknown[] };
    expect(p.embeds).toBeUndefined();
    return p.content ?? "";
  }

  it("coinflip: defers, shows a plain toss line, then edits to the real result", async () => {
    await seed("user-1", 1000);
    const fake = await run("coinflip", { bet: 100, guess: "heads" });
    expect(fake.replies[0]?.kind).toBe("deferReply");
    const [spin, settled] = edits(fake);
    expect(spin).toBeDefined();
    expect(settled).toBeDefined();
    // Suspense: plain text only, no image — and it names the guess but NOT the result.
    const spinText = contentOf(spin!.payload);
    expect(spinText).toMatch(/Flipping/);
    expect(spinText).not.toMatch(/landed \*\*/);
    expect(fileNames(spin!.payload)).toEqual([]);
    // Settle: still no image — only the text changes, naming the real
    // landed face with its small face emoji (🪙 heads / ⭐ tails).
    expect(fileNames(settled!.payload)).toEqual([]);
    const settledText = contentOf(settled!.payload);
    const landed = /landed \*\*(heads|tails)\*\*/.exec(settledText)?.[1];
    expect(landed).toMatch(/^(heads|tails)$/);
    expect(settledText).toContain(landed === "heads" ? "🪙" : "⭐");
  });

  it("slots: defers, spins through random-symbol frames, then edits to the real symbols", async () => {
    await seed("user-1", 1000);
    const fake = await run("slots", { bet: 100 });
    expect(fake.replies[0]?.kind).toBe("deferReply");
    const frames = edits(fake);
    // 4 spinning frames + the settle edit, all on the same message.
    expect(frames).toHaveLength(5);
    // Every spinning frame carries the ___SLOTS___ header and a symbol
    // row; none of them names the real result.
    for (const frame of frames.slice(0, 4)) {
      const text = contentOf(frame.payload);
      expect(text).toMatch(/^___SLOTS___\n/);
      expect(text).toMatch(/🍒|🍋|🍇|🔔|⭐|💎|🍀|7️⃣/);
      expect(text).toMatch(/Spinning…/);
      expect(fileNames(frame.payload)).toEqual([]);
    }
    // The settled frame shows the REAL drawn symbols as a text row.
    const settledText = contentOf(frames[4]!.payload);
    expect(fileNames(frames[4]!.payload)).toEqual([]);
    expect(settledText).toMatch(/^___SLOTS___\n/);
    expect(settledText).toMatch(/🍒|🍋|🍇|🔔|⭐|💎|🍀|7️⃣/);
    expect(settledText).toMatch(/ \| /);
    expect(settledText).toMatch(/won|No match/);
    expect(settledText).toMatch(/Bet 100 · Multiplier \dx · Balance [\d,]+ gold/);
  });

  it("roulette: defers, shows a plain spin line, then edits to the real number", async () => {
    await seed("user-1", 1000);
    const fake = await run("roulette", { bet: 100, "bet-on": "red" });
    expect(fake.replies[0]?.kind).toBe("deferReply");
    const [spin, settled] = edits(fake);
    expect(spin).toBeDefined();
    expect(settled).toBeDefined();
    const spinText = contentOf(spin!.payload);
    expect(spinText).toMatch(/Spinning…/);
    expect(fileNames(spin!.payload)).toEqual([]);
    expect(fileNames(settled!.payload)).toEqual([]);
    const settledText = contentOf(settled!.payload);
    const rolled = /landed on \*\*(\d+) /.exec(settledText)?.[1];
    expect(rolled).toMatch(/^\d+$/);
  });

  it("scratch: defers, shows a plain scratch line, then edits to the real symbols", async () => {
    await seed("user-1", 1000);
    const fake = await run("scratch", { bet: 100 });
    expect(fake.replies[0]?.kind).toBe("deferReply");
    const [spin, settled] = edits(fake);
    expect(spin).toBeDefined();
    expect(settled).toBeDefined();
    const spinText = contentOf(spin!.payload);
    expect(spinText).toMatch(/Scratching…/);
    expect(fileNames(spin!.payload)).toEqual([]);
    expect(fileNames(settled!.payload)).toEqual([]);
    const settledText = contentOf(settled!.payload);
    // The settled text shows the REAL drawn symbols as a text row.
    expect(settledText).toMatch(/🍒|⭐|💎|7️⃣/);
    expect(settledText).toMatch(/won|returned|No match/);
  });

  it("visual games reply with a single message (defer + 2 edits), never a new reply", async () => {
    await seed("user-1", 1000);
    const fake = await run("coinflip", { bet: 100, guess: "tails" });
    expect(fake.replies.map((r) => r.kind)).toEqual(["deferReply", "editReply", "editReply"]);
  });
});

describe("/highlow command (streak game)", () => {
  it("starts a streak game: plain-text header + 4 buttons, bet deducted", async () => {
    await seed("user-1", 1000);
    const fake = await run("highlow", { bet: 100 });
    expect(fake.replies[0]?.kind).toBe("deferReply");
    const edit = fake.replies.find((r) => r.kind === "editReply");
    expect(edit).toBeDefined();
    const payload = edit!.payload as {
      content?: string;
      files?: Array<{ name?: string | null }>;
      embeds?: unknown[];
    };
    expect(payload.embeds).toBeUndefined();
    expect(payload.files ?? []).toHaveLength(0);
    expect(payload.content).toMatch(/High \/ Low/);
    expect(payload.content).toMatch(/started a HighLow game\./);
    expect(payload.content).toMatch(/Bet: 100 · Streak: 0 · Cash Out: 0 \(0\.00x\)/);
    expect(payload.content).toMatch(/Current: .+   Next: 🂠/);
    expect(payload.content).toMatch(/higher, lower, or the same value\?/);
    // Four buttons: Higher / Lower / Same / Cash Out.
    const ids = buttonIds(fake);
    expect(ids).toHaveLength(4);
    expect(ids[0]).toMatch(/^selena:hl:.+:higher$/);
    expect(ids[1]).toMatch(/^selena:hl:.+:lower$/);
    expect(ids[2]).toMatch(/^selena:hl:.+:same$/);
    expect(ids[3]).toMatch(/^selena:hl:.+:cashout$/);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(900);
  });

  it("Higher click, correct: streak 1, cash out 18 (1.80x) on a 10 bet", async () => {
    await seed("user-1", 1000);
    const fake = await run("highlow", { bet: 10 });
    const gameId = buttonIds(fake)[0]!.split(":")[2]!;
    const game = getHighlowGame(gameId)!;
    game.currentRank = 5;
    game.currentCode = "5H";
    // Force the next draw to Q (rank 12): 1 + floor(0.9 * 13) = 12.
    CASINO_RAND.fn = seqRand([0.9, 0.0]);
    const btn = await click(`selena:hl:${gameId}:higher`);
    const text = editedContent(btn);
    expect(text).toMatch(/The next card was 🂭 — correct!/);
    expect(text).toMatch(/Bet: 10 · Streak: 1 · Cash Out: 18 \(1\.80x\)/);
    expect(text).toMatch(/Current: 🂭   Next: 🂠/);
    // Nothing banked yet — the bet stays deducted until cash out.
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(990);
    expect(getHighlowGame(gameId)).toBeDefined();
  });

  it("wrong guess ends the streak and loses the bet", async () => {
    await seed("user-1", 1000);
    const fake = await run("highlow", { bet: 10 });
    const gameId = buttonIds(fake)[0]!.split(":")[2]!;
    const game = getHighlowGame(gameId)!;
    game.currentRank = 5;
    game.currentCode = "5H";
    // Force the next draw to 2 (rank 2): 1 + floor(0.1 * 13) = 2.
    CASINO_RAND.fn = seqRand([0.1, 0.0]);
    const btn = await click(`selena:hl:${gameId}:higher`);
    const text = editedContent(btn);
    expect(text).toMatch(/The next card was 🂢 — wrong! Streak over, you lost 10 gold\./);
    expect(text).toMatch(/Bet: 10 · Streak: 0 · Cash Out: 0/);
    expect(editedComponents(btn)).toEqual([]);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(990);
    expect(getHighlowGame(gameId)).toBeUndefined();
  });

  it("Same correct jumps the multiplier to 10x", async () => {
    await seed("user-1", 1000);
    const fake = await run("highlow", { bet: 10 });
    const gameId = buttonIds(fake)[0]!.split(":")[2]!;
    const game = getHighlowGame(gameId)!;
    game.currentRank = 7;
    game.currentCode = "7D";
    // Force the next draw to 7: 1 + floor(0.5 * 13) = 7.
    CASINO_RAND.fn = seqRand([0.5, 0.0]);
    const btn = await click(`selena:hl:${gameId}:same`);
    const text = editedContent(btn);
    expect(text).toMatch(/The next card was .+ — SAME! Huge!/);
    expect(text).toMatch(/Bet: 10 · Streak: 1 · Cash Out: 100 \(10\.00x\)/);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(990);
  });

  it("Cash Out banks the current value and ends the game", async () => {
    await seed("user-1", 1000);
    const fake = await run("highlow", { bet: 10 });
    const gameId = buttonIds(fake)[0]!.split(":")[2]!;
    const game = getHighlowGame(gameId)!;
    game.currentRank = 5;
    game.currentCode = "5H";
    CASINO_RAND.fn = seqRand([0.9, 0.0]);
    await click(`selena:hl:${gameId}:higher`);
    const btn = await click(`selena:hl:${gameId}:cashout`);
    const text = editedContent(btn);
    expect(text).toMatch(/You cashed out 18 gold \(1\.80x\)!/);
    expect(editedComponents(btn)).toEqual([]);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(1008);
    expect(getHighlowGame(gameId)).toBeUndefined();
  });

  it("error path: bet of 0 is rejected", async () => {
    await seed("user-1", 100);
    const fake = await run("highlow", { bet: 0 });
    expect(fake.allText()).toMatch(/positive/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(100);
  });

  it("error path: bet above the balance is rejected", async () => {
    await seed("user-1", 50);
    const fake = await run("highlow", { bet: 500 });
    expect(fake.allText()).toMatch(/insufficient/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(50);
  });

  it("error path: another user cannot click the buttons", async () => {
    await seed("user-1", 1000);
    const fake = await run("highlow", { bet: 10 });
    const gameId = buttonIds(fake)[0]!.split(":")[2]!;
    const btn = await click(`selena:hl:${gameId}:higher`, "user-2");
    expect(replyContent(btn)).toMatch(/Only the player who started this game/);
    expect(getHighlowGame(gameId)).toBeDefined();
  });

  it("error path: an unknown game replies ephemeral", async () => {
    const btn = await click("selena:hl:no-such-game:higher");
    expect(replyContent(btn)).toMatch(/expired or was already finished/);
  });
});

describe("/mines command", () => {
  it("starts a game: plain-text header + 3x3 '?' grid + Cash Out, bet deducted", async () => {
    await seed("user-1", 1000);
    const fake = await run("mines", { bet: 10 });
    expect(fake.replies[0]?.kind).toBe("deferReply");
    const edit = fake.replies.find((r) => r.kind === "editReply");
    expect(edit).toBeDefined();
    const payload = edit!.payload as {
      content?: string;
      files?: Array<{ name?: string | null }>;
      embeds?: unknown[];
    };
    expect(payload.embeds).toBeUndefined();
    expect(payload.files ?? []).toHaveLength(0);
    expect(payload.content).toMatch(/Mines/);
    expect(payload.content).toMatch(/started a mines game\./);
    expect(payload.content).toMatch(/Bet: 10 · Mines: 3 · Cash Out: 0 \(0\.00x\) · Next: 14 \(1\.40x\)/);
    // 3 tile rows of 3 "?" buttons + a Cash Out row.
    const rows = editedComponents(fake);
    expect(rows).toHaveLength(4);
    const tileLabels = rows
      .slice(0, 3)
      .flatMap((r) => (r.components as Array<Record<string, unknown>>).map((c) => c.label));
    expect(tileLabels).toEqual(["?", "?", "?", "?", "?", "?", "?", "?", "?"]);
    const cashRow = rows[3]!.components as Array<Record<string, unknown>>;
    expect(cashRow).toHaveLength(1);
    expect(cashRow[0]!.label).toBe("Cash Out");
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(990);
  });

  it("safe pick reveals a gem and grows Cash Out / Next", async () => {
    await seed("user-1", 1000);
    const fake = await run("mines", { bet: 10 });
    const ids = buttonIds(fake);
    const gameId = ids[0]!.split(":")[2]!;
    const game = getMinesGame(gameId)!;
    const safe = [0, 1, 2, 3, 4, 5, 6, 7, 8].find((t) => !game.mineTiles.includes(t))!;
    const btn = await click(`selena:mines:${gameId}:tile:${safe}`);
    const text = editedContent(btn);
    expect(text).toMatch(/💎 Safe! 1 safe tile revealed/);
    expect(text).toMatch(/Bet: 10 · Mines: 3 · Cash Out: 14 \(1\.40x\) · Next: 20 \(2\.08x\)/);
    // The picked tile now shows 💎 and is disabled.
    const rows = editedComponents(btn);
    const picked = (rows[Math.floor(safe / 3)]!.components as Array<Record<string, unknown>>)[safe % 3]!;
    expect(picked.label).toBe("💎");
    expect(picked.disabled).toBe(true);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(990);
  });

  it("mine hit ends the game, loses the bet, reveals the board", async () => {
    await seed("user-1", 1000);
    const fake = await run("mines", { bet: 10 });
    const ids = buttonIds(fake);
    const gameId = ids[0]!.split(":")[2]!;
    const game = getMinesGame(gameId)!;
    const mine = game.mineTiles[0]!;
    const btn = await click(`selena:mines:${gameId}:tile:${mine}`);
    const text = editedContent(btn);
    expect(text).toMatch(/💥 You hit a mine! You lost 10 gold\./);
    expect(text).toMatch(/Bet: 10 · Mines: 3 · Cash Out: 0/);
    // The board is revealed: every mine shows 💣 and all buttons disabled.
    const rows = editedComponents(btn);
    const labels = rows
      .slice(0, 3)
      .flatMap((r) => (r.components as Array<Record<string, unknown>>).map((c) => c.label));
    expect(labels.filter((l) => l === "💣")).toHaveLength(3);
    for (const row of rows) {
      for (const c of row.components as Array<Record<string, unknown>>) expect(c.disabled).toBe(true);
    }
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(990);
    expect(getMinesGame(gameId)).toBeUndefined();
  });

  it("Cash Out banks the current value and ends the game", async () => {
    await seed("user-1", 1000);
    const fake = await run("mines", { bet: 10 });
    const ids = buttonIds(fake);
    const gameId = ids[0]!.split(":")[2]!;
    const game = getMinesGame(gameId)!;
    const safe = [0, 1, 2, 3, 4, 5, 6, 7, 8].find((t) => !game.mineTiles.includes(t))!;
    await click(`selena:mines:${gameId}:tile:${safe}`);
    const btn = await click(`selena:mines:${gameId}:cashout`);
    const text = editedContent(btn);
    expect(text).toMatch(/You cashed out 14 gold \(1\.40x\)!/);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(1004);
    expect(getMinesGame(gameId)).toBeUndefined();
  });

  it("clearing the board banks the max payout", async () => {
    await seed("user-1", 1000);
    const fake = await run("mines", { bet: 10, mines: 1 });
    const ids = buttonIds(fake);
    const gameId = ids[0]!.split(":")[2]!;
    const game = getMinesGame(gameId)!;
    const safeTiles = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((t) => !game.mineTiles.includes(t));
    expect(safeTiles).toHaveLength(8);
    let last: FakeButton | undefined;
    for (const t of safeTiles) last = await click(`selena:mines:${gameId}:tile:${t}`);
    const text = editedContent(last!);
    // 1 mine, 8 safe picks: 5.04x on a 10 bet = 50 gold.
    expect(text).toMatch(/🏆 You cleared the board! You won 50 gold!/);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(1040);
    expect(getMinesGame(gameId)).toBeUndefined();
  });

  it("error path: mines outside 1-5 are rejected", async () => {
    await seed("user-1", 100);
    const fake = await run("mines", { bet: 10, mines: 9 });
    expect(fake.allText()).toMatch(/between 1 and 5/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(100);
  });

  it("error path: bet above the balance is rejected", async () => {
    await seed("user-1", 50);
    const fake = await run("mines", { bet: 500 });
    expect(fake.allText()).toMatch(/insufficient/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(50);
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
