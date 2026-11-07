import type { SelenaDb } from "./db.js";
import { secureFloat, secureInt, weightedPick } from "./rng.js";
import { addPoints, getBalance } from "./economy.js";
import { CARD_RANKS, CARD_SUITS } from "./cards.js";

/**
 * Casino — points-only gambling, no real money.
 *
 * House-edge notes (multiplier = total credits returned per 1 bet):
 * - Slots: 8 equally-weighted symbols; P(3 same) = 1/64, P(exactly 2 same) =
 *   21/64. RTP = (1/512)*50 [jackpot 7s] + (7/512)*10 [other 3-of-a-kind]
 *   + (21/64)*2 [pair] = 0.8907 -> house edge ~10.9%.
 * - Blackjack: standard rules, dealer stands on all 17s, blackjack pays 3:2.
 *   Edge ~0.5% under optimal play (positive because the player busts first
 *   and the dealer acts last); looser play only increases the edge.
 * - Roulette: European single-zero wheel, 37 pockets. Even-money and
 *   straight-up bets both return 36/37 = 97.3% -> house edge 2.70%.
 * - Coinflip: nominally 50/50 paying 2x would be a 0% edge, so the payout is
 *   1.9x (stated in the help text) -> house edge 5%.
 * - High/low (streak game): one bet starts a streak. Each round the
 *   player guesses Higher / Lower / Same on the next card (rank 1-13,
 *   uniform). P(Higher or Lower correct) = 6/13, P(Same) = 1/13.
 *   Cash-out multiplier ladder after N correct Higher/Lower guesses:
 *   1.80x, 3.20x, 5.00x, 7.50x, 11.00x, then x1.5 per step — below the
 *   fair (13/6)^N at every step, so the house keeps an edge. A correct
 *   Same jumps the multiplier to at least 10x. Cash out banks
 *   floor(bet x multiplier); a wrong guess loses the bet.
 * - Mines (OwO-style): one bet starts a 3x3 grid hiding N mines
 *   (default 3, 1-5). Each safe pick grows the cash-out multiplier:
 *   fair multiplier after k safe picks = product of (9-i)/(9-m-i),
 *   discounted 0.93^k for the house edge, rounded to 2dp. On 3 mines:
 *   1.40x, 2.08x, 3.38x, 6.28x, 14.61x, 54.35x. Cash out banks
 *   floor(bet x multiplier); a mine loses the bet. Clearing every
 *   safe tile banks the max payout automatically.
 * - Scratch: 4 equally-weighted symbols; P(3 match) = 1/16, P(exactly 2
 *   match) = 9/16. RTP = (1/16)*5 + (9/16)*1 = 0.875 -> house edge 12.5%.
 *
 * All fractional payouts are rounded DOWN to whole points (points are
 * integers), which only ever helps the house.
 */

// ---------------------------------------------------------------------------
// Shared betting primitives
// ---------------------------------------------------------------------------

/**
 * Atomically deduct a bet. Single UPDATE ... WHERE points >= amount, so the
 * balance can never go below 0, even under concurrency.
 */
export async function placeBet(
  db: SelenaDb,
  guildId: string,
  userId: string,
  amount: number,
  reason = "bet",
): Promise<{ ok: boolean; balance?: number; error?: string }> {
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, error: "Bet must be a positive whole number of gold." };
  }
  // Ensure the user row exists so a missing row reads as "insufficient",
  // not as a crash.
  await db.prepare("INSERT OR IGNORE INTO users (guild_id, user_id) VALUES (?, ?)").run(guildId, userId);
  // NOTE: points + (-amount), not points - amount — pg-mem (the test
  // double) evaluates `col - $param` backwards; identical on real Postgres.
  const result = await db
    .prepare("UPDATE users SET points = points + ? WHERE guild_id = ? AND user_id = ? AND points >= ?")
    .run(-amount, guildId, userId, amount);
  if (result.changes !== 1) {
    return { ok: false, error: "Insufficient gold." };
  }
  await db.prepare(
    "INSERT INTO point_ledger (guild_id, user_id, delta, reason, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(guildId, userId, -amount, reason, Date.now());
  return { ok: true, balance: (await getBalance(db, guildId, userId)).points };
}

/** Credit winnings (amount must be >= 0). Returns the new balance. */
export async function creditWin(
  db: SelenaDb,
  guildId: string,
  userId: string,
  amount: number,
  reason = "win",
): Promise<number> {
  if (amount <= 0) return (await getBalance(db, guildId, userId)).points;
  return await addPoints(db, guildId, userId, Math.floor(amount), reason);
}

/**
 * Test hook (same pattern as VISUAL_SUSPENSE in visualgames.ts): when
 * set, the draw functions below use this rand instead of secureFloat,
 * so button-handler tests can force the next card / mine layout.
 * Production code never sets it.
 */
export const CASINO_RAND: { fn: (() => number) | null } = { fn: null };

function casinoRand(): () => number {
  return CASINO_RAND.fn ?? secureFloat;
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

export const SLOT_SYMBOLS = ["🍒", "🍋", "🍇", "🔔", "⭐", "💎", "🍀", "7️⃣"] as const;
export const SLOT_JACKPOT_SYMBOL = "7️⃣";
const SLOT_WEIGHTS: ReadonlyArray<readonly [string, number]> = SLOT_SYMBOLS.map((s) => [s, 1] as const);

export interface SlotsResult {
  symbols: string[];
  /** Total credits returned per 1 bet: 50 (jackpot), 10 (3-of-a-kind), 2 (pair), 0. */
  multiplier: number;
  jackpot: boolean;
}

export function slotsSpin(rand: () => number = secureFloat): SlotsResult {
  const symbols = [weightedPick(SLOT_WEIGHTS, rand), weightedPick(SLOT_WEIGHTS, rand), weightedPick(SLOT_WEIGHTS, rand)];
  let multiplier = 0;
  let jackpot = false;
  if (symbols[0] === symbols[1] && symbols[1] === symbols[2]) {
    jackpot = symbols[0] === SLOT_JACKPOT_SYMBOL;
    multiplier = jackpot ? 50 : 10;
  } else if (symbols[0] === symbols[1] || symbols[1] === symbols[2] || symbols[0] === symbols[2]) {
    multiplier = 2;
  }
  return { symbols, multiplier, jackpot };
}

// ---------------------------------------------------------------------------
// Blackjack
// ---------------------------------------------------------------------------

export type BlackjackHand = string[]; // card codes: "AS", "10H", "KD" (plain ranks also accepted)

export const BLACKJACK_RANKS: readonly string[] = CARD_RANKS;

/**
 * Rank part of a card. Accepts full codes ("AS", "10H") and plain ranks
 * ("A", "10") — the plain-rank form is what older hands/tests use.
 */
export function rankOf(card: string): string {
  if ((CARD_RANKS as readonly string[]).includes(card)) return card;
  return card.slice(0, -1);
}

/** Suit letter of a full card code ("AS" -> "S"), or null for a plain rank. */
export function suitOf(card: string): string | null {
  if ((CARD_RANKS as readonly string[]).includes(card)) return null;
  return card.slice(-1);
}

/** A random suit letter, for display-only suits (high/low draws rank only). */
export function randomSuit(rand: () => number = secureFloat): (typeof CARD_SUITS)[number] {
  return CARD_SUITS[Math.floor(rand() * CARD_SUITS.length)] as (typeof CARD_SUITS)[number];
}

/** High/low rank number (1 = Ace low ... 13 = King) as a card rank string. */
export function highLowRankName(rank: number): string {
  if (rank === 1) return "A";
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  return String(rank);
}

export function blackjackValue(hand: BlackjackHand): number {
  let total = 0;
  let aces = 0;
  for (const card of hand) {
    const rank = rankOf(card);
    if (rank === "A") {
      aces += 1;
      total += 11;
    } else if (rank === "J" || rank === "Q" || rank === "K") {
      total += 10;
    } else {
      total += Number.parseInt(rank, 10);
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

export function isBlackjack(hand: BlackjackHand): boolean {
  return hand.length === 2 && blackjackValue(hand) === 21;
}

/** Full 52-card deck as rank+suit codes ("AS", "10H", ...), one of each. */
export function buildDeck(): string[] {
  const deck: string[] = [];
  for (const suit of CARD_SUITS) for (const r of CARD_RANKS) deck.push(`${r}${suit}`);
  return deck;
}

export function shuffleDeck(deck: string[], rand: () => number = secureFloat): string[] {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j] as string, deck[i] as string];
  }
  return deck;
}

export interface BlackjackDeal {
  playerHand: BlackjackHand;
  dealerHand: BlackjackHand;
  deck: string[];
}

export function dealBlackjack(rand: () => number = secureFloat): BlackjackDeal {
  const deck = shuffleDeck(buildDeck(), rand);
  const playerHand = [deck.pop() as string, deck.pop() as string];
  const dealerHand = [deck.pop() as string, deck.pop() as string];
  return { playerHand, dealerHand, deck };
}

/** Dealer draws until 17 or more (stands on all 17s, including soft 17). */
export function dealerPlay(deck: string[], dealerHand: BlackjackHand): BlackjackHand {
  while (blackjackValue(dealerHand) < 17) {
    const card = deck.pop();
    if (!card) break;
    dealerHand.push(card);
  }
  return dealerHand;
}

export type BlackjackOutcome = "player_blackjack" | "win" | "lose" | "push" | "dealer_blackjack";

/**
 * Settle a finished blackjack hand. Multiplier = total credits returned per
 * 1 bet (player blackjack 2.5 = stake back + 3:2 profit; win 2; push 1; lose 0).
 * A player bust is a loss even if the dealer would also bust.
 */
export function settleBlackjack(
  playerHand: BlackjackHand,
  dealerHand: BlackjackHand,
): { outcome: BlackjackOutcome; multiplier: number } {
  const player = blackjackValue(playerHand);
  const dealer = blackjackValue(dealerHand);
  const playerBj = isBlackjack(playerHand);
  const dealerBj = isBlackjack(dealerHand);
  if (playerBj && dealerBj) return { outcome: "push", multiplier: 1 };
  if (playerBj) return { outcome: "player_blackjack", multiplier: 2.5 };
  if (dealerBj) return { outcome: "dealer_blackjack", multiplier: 0 };
  if (player > 21) return { outcome: "lose", multiplier: 0 };
  if (dealer > 21) return { outcome: "win", multiplier: 2 };
  if (player > dealer) return { outcome: "win", multiplier: 2 };
  if (player < dealer) return { outcome: "lose", multiplier: 0 };
  return { outcome: "push", multiplier: 1 };
}

export interface BlackjackGame {
  id: string;
  guildId: string;
  userId: string;
  bet: number;
  playerHand: BlackjackHand;
  dealerHand: BlackjackHand;
  deck: string[];
  createdAt: number;
  messageId?: string;
}

/** Live blackjack games, keyed by game id (and by message id once known). */
export const blackjackGames = new Map<string, BlackjackGame>();

export function createBlackjackGame(
  guildId: string,
  userId: string,
  bet: number,
  rand: () => number = secureFloat,
): BlackjackGame {
  const { playerHand, dealerHand, deck } = dealBlackjack(rand);
  const id = `bj_${Date.now().toString(36)}_${Math.floor(secureFloat() * 1e9).toString(36)}`;
  const game: BlackjackGame = { id, guildId, userId, bet, playerHand, dealerHand, deck, createdAt: Date.now() };
  blackjackGames.set(id, game);
  return game;
}

export function getBlackjackGame(id: string): BlackjackGame | undefined {
  return blackjackGames.get(id);
}

export function endBlackjackGame(id: string): void {
  const game = blackjackGames.get(id);
  if (game?.messageId) blackjackGames.delete(game.messageId);
  blackjackGames.delete(id);
}

// ---------------------------------------------------------------------------
// Roulette (European, single zero, 0-36)
// ---------------------------------------------------------------------------

export const RED_NUMBERS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

export function rouletteColor(roll: number): "red" | "black" | "green" {
  if (roll === 0) return "green";
  return RED_NUMBERS.has(roll) ? "red" : "black";
}

/** Accepts "red" | "black" | "even" | "odd" | "0".."36" (case-insensitive). */
export function isValidRouletteBet(betOn: string): boolean {
  const b = betOn.trim().toLowerCase();
  if (b === "red" || b === "black" || b === "even" || b === "odd") return true;
  return /^\d+$/.test(b) && Number(b) >= 0 && Number(b) <= 36;
}

export interface RouletteResult {
  betOn: string;
  roll: number;
  color: "red" | "black" | "green";
  win: boolean;
  /** Total return per 1 bet: 2 for even-money, 36 for a straight number, 0 on loss. */
  multiplier: number;
  valid: boolean;
}

export function rouletteOutcome(betOn: string, roll: number): RouletteResult {
  const b = betOn.trim().toLowerCase();
  const color = rouletteColor(roll);
  if (!isValidRouletteBet(betOn)) return { betOn: b, roll, color, win: false, multiplier: 0, valid: false };
  let win = false;
  let multiplier = 0;
  if (b === "red") {
    win = color === "red";
    multiplier = win ? 2 : 0;
  } else if (b === "black") {
    win = color === "black";
    multiplier = win ? 2 : 0;
  } else if (b === "even") {
    win = roll !== 0 && roll % 2 === 0;
    multiplier = win ? 2 : 0;
  } else if (b === "odd") {
    win = roll % 2 === 1;
    multiplier = win ? 2 : 0;
  } else {
    win = roll === Number(b);
    multiplier = win ? 36 : 0;
  }
  return { betOn: b, roll, color, win, multiplier, valid: true };
}

/** Roll a European roulette number, 0-36. */
export function rouletteRoll(): number {
  return secureInt(0, 37);
}

// ---------------------------------------------------------------------------
// Coinflip
// ---------------------------------------------------------------------------

export interface CoinflipResult {
  guess: "heads" | "tails";
  result: "heads" | "tails";
  win: boolean;
  /** Total return per 1 bet: 1.9 on a win (see house-edge note above), 0 on loss. */
  multiplier: number;
}

export function coinflipOutcome(guess: "heads" | "tails", roll: number): CoinflipResult {
  const result: "heads" | "tails" = roll < 0.5 ? "heads" : "tails";
  const win = guess === result;
  return { guess, result, win, multiplier: win ? 1.9 : 0 };
}

// ---------------------------------------------------------------------------
// High / Low — streak game (OwO-style)
// ---------------------------------------------------------------------------

export type HighLowGuess = "higher" | "lower" | "same";

/** Did this guess win? Higher: next > current; Lower: next < current; Same: next === current. */
export function highlowGuessWin(current: number, guess: HighLowGuess, next: number): boolean {
  if (guess === "higher") return next > current;
  if (guess === "lower") return next < current;
  return next === current;
}

/**
 * Cash-out multiplier after N correct Higher/Lower guesses in a row.
 * 1.80x, 3.20x, 5.00x, 7.50x, 11.00x, then x1.5 per further streak step.
 * Below the fair (13/6)^N at every step (fair: 2.17x, 4.69x, 10.17x…),
 * so the house keeps an edge on every cash-out.
 */
const HIGHLOW_LADDER = [0, 1.8, 3.2, 5, 7.5, 11];

export function highlowLadderMultiplier(streak: number): number {
  if (streak <= 0) return 0;
  if (streak < HIGHLOW_LADDER.length) return HIGHLOW_LADDER[streak] as number;
  return (HIGHLOW_LADDER[HIGHLOW_LADDER.length - 1] as number) * Math.pow(1.5, streak - HIGHLOW_LADDER.length + 1);
}

/** A correct "Same" guess pays big: the multiplier jumps to at least 10x. */
export const HIGHLOW_SAME_MIN_MULTIPLIER = 10;

/** Draw a card rank 1-13 (1 = Ace low, 13 = King). */
export function drawCard(rand: () => number = casinoRand()): number {
  return 1 + Math.floor(rand() * 13);
}

/** Draw a High/Low card: a rank plus a random display suit (code for glyphs). */
export function drawHighlowCard(rand: () => number = casinoRand()): { rank: number; code: string } {
  const rank = drawCard(rand);
  return { rank, code: `${highLowRankName(rank)}${randomSuit(rand)}` };
}

export interface HighlowGame {
  id: string;
  guildId: string;
  userId: string;
  bet: number;
  currentRank: number;
  currentCode: string;
  streak: number;
  /** Cash-out multiplier (ladder value; Same corrects raise it to >= 10x). */
  multiplier: number;
  createdAt: number;
  messageId?: string;
}

/** Live High/Low streak games, keyed by game id (and by message id once known). */
export const highlowGames = new Map<string, HighlowGame>();

export function createHighlowGame(
  guildId: string,
  userId: string,
  bet: number,
  rand: () => number = casinoRand(),
): HighlowGame {
  const first = drawHighlowCard(rand);
  const id = `hl_${Date.now().toString(36)}_${Math.floor(secureFloat() * 1e9).toString(36)}`;
  const game: HighlowGame = {
    id,
    guildId,
    userId,
    bet,
    currentRank: first.rank,
    currentCode: first.code,
    streak: 0,
    multiplier: 0,
    createdAt: Date.now(),
  };
  highlowGames.set(id, game);
  return game;
}

export function getHighlowGame(id: string): HighlowGame | undefined {
  return highlowGames.get(id);
}

export function endHighlowGame(id: string): void {
  const game = highlowGames.get(id);
  if (game?.messageId) highlowGames.delete(game.messageId);
  highlowGames.delete(id);
}

/** Whole-gold cash-out value for a game right now (0 while streak is 0). */
export function highlowCashOut(game: HighlowGame): number {
  return Math.floor(game.bet * game.multiplier);
}

// ---------------------------------------------------------------------------
// Mines — 3x3 grid (OwO-style)
// ---------------------------------------------------------------------------

/**
 * Cash-out multiplier after k safe picks with m mines on a 9-tile grid.
 * Fair multiplier = product over picks of (9-i)/(9-m-i); discounted
 * 0.93^k for the house edge, rounded to 2dp. On 3 mines the ladder is
 * 1.40x, 2.08x, 3.38x, 6.28x, 14.61x, 54.35x.
 */
export function minesMultiplier(mines: number, safePicks: number): number {
  if (safePicks <= 0) return 0;
  let fair = 1;
  for (let i = 0; i < safePicks; i++) {
    fair *= (9 - i) / (9 - mines - i);
  }
  return Math.round(fair * Math.pow(0.93, safePicks) * 100) / 100;
}

export interface MinesGame {
  id: string;
  guildId: string;
  userId: string;
  bet: number;
  mines: number;
  /** Tile indexes (0-8) hiding mines. */
  mineTiles: number[];
  /** Tile indexes the player has revealed. */
  revealed: number[];
  safePicks: number;
  createdAt: number;
  messageId?: string;
}

/** Live mines games, keyed by game id (and by message id once known). */
export const minesGames = new Map<string, MinesGame>();

export function createMinesGame(
  guildId: string,
  userId: string,
  bet: number,
  mines = 3,
  rand: () => number = casinoRand(),
): MinesGame {
  const positions = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [positions[i], positions[j]] = [positions[j] as number, positions[i] as number];
  }
  const id = `mn_${Date.now().toString(36)}_${Math.floor(secureFloat() * 1e9).toString(36)}`;
  const game: MinesGame = {
    id,
    guildId,
    userId,
    bet,
    mines,
    mineTiles: positions.slice(0, mines),
    revealed: [],
    safePicks: 0,
    createdAt: Date.now(),
  };
  minesGames.set(id, game);
  return game;
}

export function getMinesGame(id: string): MinesGame | undefined {
  return minesGames.get(id);
}

export function endMinesGame(id: string): void {
  const game = minesGames.get(id);
  if (game?.messageId) minesGames.delete(game.messageId);
  minesGames.delete(id);
}

/** Whole-gold cash-out value for a mines game right now. */
export function minesCashOut(game: MinesGame): number {
  return Math.floor(game.bet * minesMultiplier(game.mines, game.safePicks));
}

// ---------------------------------------------------------------------------
// Scratch card
// ---------------------------------------------------------------------------

export const SCRATCH_SYMBOLS = ["🍒", "⭐", "💎", "7️⃣"] as const;
const SCRATCH_WEIGHTS: ReadonlyArray<readonly [string, number]> = SCRATCH_SYMBOLS.map((s) => [s, 1] as const);

export interface ScratchResult {
  symbols: string[];
  /** Total return per 1 bet: 5 (3 matching), 1 (2 matching), 0 otherwise. */
  multiplier: number;
}

export function scratchOutcome(symbols: string[]): ScratchResult {
  let multiplier = 0;
  if (symbols[0] === symbols[1] && symbols[1] === symbols[2]) multiplier = 5;
  else if (symbols[0] === symbols[1] || symbols[1] === symbols[2] || symbols[0] === symbols[2]) multiplier = 1;
  return { symbols, multiplier };
}

export function scratchDraw(rand: () => number = secureFloat): ScratchResult {
  const symbols = [
    weightedPick(SCRATCH_WEIGHTS, rand),
    weightedPick(SCRATCH_WEIGHTS, rand),
    weightedPick(SCRATCH_WEIGHTS, rand),
  ];
  return scratchOutcome(symbols);
}
