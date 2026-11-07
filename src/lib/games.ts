import type { SelenaDb } from "./db.js";
import { secureFloat } from "./rng.js";
import { isTriviaAnswerCorrect, type TriviaQuestion } from "./trivia.js";

export { isTriviaAnswerCorrect };
export type { TriviaQuestion };

export const TRIVIA_POINTS = 25;
export const TRIVIA_TIME_LIMIT_MS = 30_000;

// ---------------------------------------------------------------------------
// Points helper (shared by trivia rewards).
// ---------------------------------------------------------------------------

export async function awardPoints(db: SelenaDb, guildId: string, userId: string, delta: number, reason: string): Promise<void> {
  await db.prepare(
    `INSERT INTO users (guild_id, user_id, points, xp, level) VALUES (?, ?, ?, 0, 0)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET points = users.points + excluded.points`,
  ).run(guildId, userId, delta);
  await db.prepare(
    "INSERT INTO point_ledger (guild_id, user_id, delta, reason, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(guildId, userId, delta, reason, Date.now());
}

// ---------------------------------------------------------------------------
// Tic-tac-toe — pure logic.
// ---------------------------------------------------------------------------

export type TttPlayer = "X" | "O";
export type TttBoard = (TttPlayer | null)[];

const TTT_LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export function emptyTttBoard(): TttBoard {
  return Array<TttPlayer | null>(9).fill(null);
}

/** "X" | "O" when someone won, "draw" when the board is full, else null. */
export function tttWinner(board: TttBoard): TttPlayer | "draw" | null {
  for (const [a, b, c] of TTT_LINES) {
    const v = board[a];
    if (v && v === board[b] && v === board[c]) return v;
  }
  return board.every((cell) => cell !== null) ? "draw" : null;
}

/** New board with the move applied, or null when the cell is taken / out of range. */
export function tttApplyMove(board: TttBoard, index: number, player: TttPlayer): TttBoard | null {
  if (!Number.isInteger(index) || index < 0 || index > 8) return null;
  if (board[index] !== null) return null;
  const next = [...board];
  next[index] = player;
  return next;
}

export function tttRender(board: TttBoard): string {
  const emoji = (v: TttPlayer | null, i: number): string =>
    v === "X" ? "❌" : v === "O" ? "⭕" : `${i + 1}️⃣`;
  const rows = [0, 3, 6].map((s) => board.slice(s, s + 3).map((v, j) => emoji(v, s + j)).join(" "));
  return rows.join("\n");
}

// ---------------------------------------------------------------------------
// Connect 4 — pure logic. Board is 6 rows x 7 cols, row 0 is the top.
// ---------------------------------------------------------------------------

export type C4Player = "R" | "Y";
export type C4Board = (C4Player | null)[][]; // [row][col]

export const C4_ROWS = 6;
export const C4_COLS = 7;

export function emptyC4Board(): C4Board {
  return Array.from({ length: C4_ROWS }, () => Array<C4Player | null>(C4_COLS).fill(null));
}

/** Drop a disc; returns the new board + the row it landed on, or null when the column is full/invalid. */
export function c4Drop(board: C4Board, col: number, player: C4Player): { board: C4Board; row: number } | null {
  if (!Number.isInteger(col) || col < 0 || col >= C4_COLS) return null;
  for (let row = C4_ROWS - 1; row >= 0; row--) {
    if (board[row]![col] === null) {
      const next = board.map((r) => [...r]);
      next[row]![col] = player;
      return { board: next, row };
    }
  }
  return null;
}

/** Winning player, or null when nobody has won yet. */
export function c4Winner(board: C4Board): C4Player | null {
  const dirs: readonly (readonly [number, number])[] = [
    [0, 1], // horizontal
    [1, 0], // vertical
    [1, 1], // diagonal down-right
    [1, -1], // diagonal down-left
  ];
  for (let r = 0; r < C4_ROWS; r++) {
    for (let c = 0; c < C4_COLS; c++) {
      const v = board[r]![c];
      if (!v) continue;
      for (const [dr, dc] of dirs) {
        let ok = true;
        for (let k = 1; k < 4; k++) {
          const nr = r + dr * k;
          const nc = c + dc * k;
          if (nr < 0 || nr >= C4_ROWS || nc < 0 || nc >= C4_COLS || board[nr]![nc] !== v) {
            ok = false;
            break;
          }
        }
        if (ok) return v;
      }
    }
  }
  return null;
}

export function c4IsFull(board: C4Board): boolean {
  return board.every((row) => row.every((cell) => cell !== null));
}

export function c4Render(board: C4Board): string {
  const emoji = (v: C4Player | null): string => (v === "R" ? "🔴" : v === "Y" ? "🟡" : "⚪");
  const lines = board.map((row) => row.map(emoji).join(" "));
  lines.push("1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Rock-paper-scissors — pure logic.
// ---------------------------------------------------------------------------

export type RpsChoice = "rock" | "paper" | "scissors";
export const RPS_CHOICES: readonly RpsChoice[] = ["rock", "paper", "scissors"];

const RPS_BEATS: Record<RpsChoice, RpsChoice> = {
  rock: "scissors",
  paper: "rock",
  scissors: "paper",
};

/** Outcome for player A: "win" | "lose" | "draw". */
export function rpsOutcome(a: RpsChoice, b: RpsChoice): "win" | "lose" | "draw" {
  if (a === b) return "draw";
  return RPS_BEATS[a] === b ? "win" : "lose";
}

export function rpsEmoji(choice: RpsChoice): string {
  return choice === "rock" ? "🪨" : choice === "paper" ? "📄" : "✂️";
}

// ---------------------------------------------------------------------------
// Word chain — pure state machine (last-letter rule, no repeats).
// ---------------------------------------------------------------------------

export interface WordChainState {
  used: string[];
  lastWord: string | null;
  /** Letter the next word must start with (null until the first word). */
  currentLetter: string | null;
  moves: number;
  startedAt: number;
}

export function createWordChain(): WordChainState {
  return { used: [], lastWord: null, currentLetter: null, moves: 0, startedAt: Date.now() };
}

export function isValidWord(word: string, state: WordChainState): { ok: boolean; reason?: string } {
  const w = word.trim().toLowerCase();
  if (w.length < 3) return { ok: false, reason: "Words must be at least 3 letters long." };
  if (!/^[a-z]+$/.test(w)) return { ok: false, reason: "Words may only contain letters a–z." };
  if (state.currentLetter && w[0] !== state.currentLetter) {
    return { ok: false, reason: `Your word must start with "${state.currentLetter.toUpperCase()}".` };
  }
  if (state.used.includes(w)) return { ok: false, reason: `"${w}" was already used in this chain.` };
  return { ok: true };
}

/** Returns a new state with the word applied, or the same state + a reason when invalid. */
export function submitWord(
  state: WordChainState,
  word: string,
): { ok: boolean; reason?: string; state: WordChainState } {
  const check = isValidWord(word, state);
  if (!check.ok) return { ok: false, reason: check.reason, state };
  const w = word.trim().toLowerCase();
  return {
    ok: true,
    state: {
      ...state,
      used: [...state.used, w],
      lastWord: w,
      currentLetter: w[w.length - 1]!,
      moves: state.moves + 1,
    },
  };
}

// ---------------------------------------------------------------------------
// Giveaway — pure winner picking (Fisher-Yates partial shuffle).
// ---------------------------------------------------------------------------

export function pickWinners<T>(entries: readonly T[], count: number, rand: () => number = secureFloat): T[] {
  if (count <= 0 || entries.length === 0) return [];
  const pool = [...entries];
  const n = Math.min(count, pool.length);
  const winners: T[] = [];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    winners.push(pool[i]!);
  }
  return winners;
}

// ---------------------------------------------------------------------------
// Polls — vote upsert + counting (one vote per user, stored in poll_votes).
// ---------------------------------------------------------------------------

export async function recordPollVote(db: SelenaDb, pollId: number, userId: string, optionIndex: number): Promise<void> {
  await db.prepare(
    `INSERT INTO poll_votes (poll_id, user_id, option_index) VALUES (?, ?, ?)
     ON CONFLICT(poll_id, user_id) DO UPDATE SET option_index = excluded.option_index`,
  ).run(pollId, userId, optionIndex);
}

export async function getPollCounts(db: SelenaDb, pollId: number, optionCount: number): Promise<number[]> {
  const rows = await db
    .prepare("SELECT option_index, COUNT(*) AS c FROM poll_votes WHERE poll_id = ? GROUP BY option_index")
    .all(pollId) as { option_index: number; c: number }[];
  const counts = Array<number>(optionCount).fill(0);
  for (const row of rows) {
    if (row.option_index >= 0 && row.option_index < optionCount) counts[row.option_index] = Number(row.c);
  }
  return counts;
}

/** Pure count from an in-memory vote list (used by tests and embeds). */
export function countPollVotes(votes: readonly { option_index: number }[], optionCount: number): number[] {
  const counts = Array<number>(optionCount).fill(0);
  for (const v of votes) {
    if (v.option_index >= 0 && v.option_index < optionCount) counts[v.option_index]! += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Live game sessions.
// Game state lives in module-level Maps keyed by a game id that is encoded
// in each button's customId (e.g. selena:ttt:<gameId>:<cell>). The id — not a
// Discord message id — is the key, because a slash-command reply does not
// hand back a message id without fetchReply, and the test fakes return none.
// ---------------------------------------------------------------------------

export interface TttGame {
  id: string;
  guildId: string;
  playerX: string;
  playerO: string;
  playerXName: string;
  playerOName: string;
  board: TttBoard;
  turn: TttPlayer;
  status: "active" | "done";
  winner?: TttPlayer | "draw";
}

export interface C4Game {
  id: string;
  guildId: string;
  playerR: string;
  playerY: string;
  playerRName: string;
  playerYName: string;
  board: C4Board;
  turn: C4Player;
  status: "active" | "done";
  winner?: C4Player | "draw";
}

export interface RpsGame {
  id: string;
  guildId: string;
  challengerId: string;
  opponentId: string;
  challengerName: string;
  opponentName: string;
  picks: Partial<Record<string, RpsChoice>>;
  status: "active" | "done";
  winnerId?: string | null;
}

export interface TriviaGame {
  id: string;
  guildId: string;
  question: TriviaQuestion;
  answeredBy: string | null;
  expiresAt: number;
}

export const tttGames = new Map<string, TttGame>();
export const c4Games = new Map<string, C4Game>();
export const rpsGames = new Map<string, RpsGame>();
export const triviaGames = new Map<string, TriviaGame>();
/** One active word-chain game per guild. */
export const wordChainGames = new Map<string, WordChainState>();

/** Clear all live game state (tests use this between cases). */
export function resetGameState(): void {
  tttGames.clear();
  c4Games.clear();
  rpsGames.clear();
  triviaGames.clear();
  wordChainGames.clear();
}

export function newGameId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(secureFloat() * 1_000_000).toString(36)}`;
}
