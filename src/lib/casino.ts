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
 * - High/low: the guess is made BEFORE any card is revealed (choice option),
 *   so the player cannot exploit extreme first cards (a revealed 1 would win
 *   12/13 of the time). Blind, P(win) = 6/13, P(push on tie) = 1/13.
 *   RTP = (6/13)*1.9 + (1/13)*1 = 0.9538 -> house edge ~4.6%.
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
export function placeBet(
  db: SelenaDb,
  guildId: string,
  userId: string,
  amount: number,
  reason = "bet",
): { ok: boolean; balance?: number; error?: string } {
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, error: "Bet must be a positive whole number of points." };
  }
  // Ensure the user row exists so a missing row reads as "insufficient",
  // not as a crash.
  db.prepare("INSERT OR IGNORE INTO users (guild_id, user_id) VALUES (?, ?)").run(guildId, userId);
  const result = db
    .prepare("UPDATE users SET points = points - ? WHERE guild_id = ? AND user_id = ? AND points >= ?")
    .run(amount, guildId, userId, amount);
  if (result.changes !== 1) {
    return { ok: false, error: "Insufficient points." };
  }
  db.prepare(
    "INSERT INTO point_ledger (guild_id, user_id, delta, reason, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(guildId, userId, -amount, reason, Date.now());
  return { ok: true, balance: getBalance(db, guildId, userId).points };
}

/** Credit winnings (amount must be >= 0). Returns the new balance. */
export function creditWin(
  db: SelenaDb,
  guildId: string,
  userId: string,
  amount: number,
  reason = "win",
): number {
  if (amount <= 0) return getBalance(db, guildId, userId).points;
  return addPoints(db, guildId, userId, Math.floor(amount), reason);
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
// High / Low
// ---------------------------------------------------------------------------

export type HighLowGuess = "higher" | "lower";

export interface HighLowResult {
  card: number;
  next: number;
  guess: HighLowGuess;
  outcome: "win" | "lose" | "push";
  win: boolean;
  push: boolean;
  /** Total return per 1 bet: 1.9 on a win, 1 on a tie (push), 0 on a loss. */
  multiplier: number;
}

export function highlowOutcome(card: number, guess: HighLowGuess, next: number): HighLowResult {
  if (next === card) {
    return { card, next, guess, outcome: "push", win: false, push: true, multiplier: 1 };
  }
  const win = guess === "higher" ? next > card : next < card;
  return { card, next, guess, outcome: win ? "win" : "lose", win, push: false, multiplier: win ? 1.9 : 0 };
}

/** Draw a card rank 1-13 (1 = Ace low, 13 = King). */
export function drawCard(): number {
  return secureInt(1, 14);
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
