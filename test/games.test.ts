import { describe, expect, it, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";

// Vite 5 (vitest 2.1) does not recognise `node:sqlite` as a builtin and
// resolves it to the bare specifier `sqlite`, which fails to load. Redirect
// the import to Node's real builtin through the CJS loader instead. (This is
// a test-runner workaround only — src code still imports `node:sqlite`.)
vi.mock("node:sqlite", () => {
  const req = createRequire(import.meta.url);
  return req("node:sqlite");
});

import type { CommandInvocation } from "../src/lib/command.js";
import { FakeButton, FakeChatInput } from "../src/lib/testkit.js";
import { type SelenaDb } from "../src/lib/db.js";
import { getTestDb } from "./testDb.js";
import { mulberry32 } from "../src/lib/rng.js";
import {
  GENERAL_QUESTIONS,
  isTriviaAnswerCorrect,
  pickTriviaQuestion,
  validateBank,
} from "../src/lib/trivia.js";
import {
  TRIVIA_POINTS,
  c4Drop,
  c4Winner,
  countPollVotes,
  createWordChain,
  emptyC4Board,
  emptyTttBoard,
  getPollCounts,
  pickWinners,
  recordPollVote,
  resetGameState,
  rpsOutcome,
  submitWord,
  triviaGames,
  tttApplyMove,
  tttGames,
  tttWinner,
  wordChainGames,
  c4Games,
  rpsGames,
  type C4Board,
  type RpsChoice,
  type TttBoard,
} from "../src/lib/games.js";
import { buttonHandlers, commands } from "../src/commands/games.js";

/** Extract content + embed title/description/fields from a reply payload (EmbedBuilder-aware). */
function payloadText(payload: unknown): string {
  const p = payload as { content?: string; embeds?: Array<{ toJSON?: () => unknown }> };
  const parts: string[] = [];
  if (typeof p?.content === "string") parts.push(p.content);
  for (const e of p?.embeds ?? []) {
    const j = (typeof e?.toJSON === "function" ? e.toJSON() : e) as {
      title?: string;
      description?: string;
      fields?: Array<{ name: string; value: string }>;
    };
    if (j?.title) parts.push(j.title);
    if (j?.description) parts.push(j.description);
    for (const f of j?.fields ?? []) parts.push(`${f.name}: ${f.value}`);
  }
  return parts.join("\n");
}

let db: SelenaDb;

beforeEach(async () => {
  db = getTestDb();
  resetGameState();
});

async function run(
  name: string,
  options: Record<string, unknown> = {},
  userId = "user-1",
  username = "tester",
): Promise<FakeChatInput> {
  const cmd = commands.find((c) => c.name === name);
  if (!cmd) throw new Error(`command ${name} not found`);
  const fake = new FakeChatInput({ commandName: name, options, userId, username });
  await cmd.execute(fake as unknown as CommandInvocation, { db, guildId: "guild-1" });
  return fake;
}

function replyText(fake: FakeChatInput): string {
  return payloadText(fake.firstReplyPayload());
}

function buttonText(btn: FakeButton): string {
  return btn.replies.map((r) => payloadText(r.payload)).join("\n");
}

async function userPoints(userId: string): Promise<number> {
  const row = await db
    .prepare("SELECT points FROM users WHERE guild_id = ? AND user_id = ?")
    .get("guild-1", userId) as { points: number } | undefined;
  return Number(row?.points ?? 0);
}

const OPP = { id: "user-2", username: "opponent" };

// ---------------------------------------------------------------------------
// Lib: tic-tac-toe
// ---------------------------------------------------------------------------

describe("tic-tac-toe logic", () => {
  it("detects a row win for X", async () => {
    const board = emptyTttBoard();
    board[0] = "X";
    board[1] = "X";
    board[2] = "X";
    expect(tttWinner(board)).toBe("X");
  });

  it("detects a diagonal win for O", async () => {
    const board = emptyTttBoard();
    board[0] = "O";
    board[4] = "O";
    board[8] = "O";
    expect(tttWinner(board)).toBe("O");
  });

  it("detects a column win", async () => {
    const board = emptyTttBoard();
    board[1] = "X";
    board[4] = "X";
    board[7] = "X";
    expect(tttWinner(board)).toBe("X");
  });

  it("detects a draw on a full board with no winner", async () => {
    const board: TttBoard = [
      "X", "O", "X",
      "X", "O", "O",
      "O", "X", "X",
    ];
    expect(tttWinner(board)).toBe("draw");
  });

  it("returns null mid-game", async () => {
    const board = emptyTttBoard();
    board[0] = "X";
    board[4] = "O";
    expect(tttWinner(board)).toBeNull();
  });

  it("rejects moves on taken or out-of-range cells", async () => {
    const board = emptyTttBoard();
    const next = tttApplyMove(board, 0, "X");
    expect(next).not.toBeNull();
    expect(tttApplyMove(next!, 0, "O")).toBeNull();
    expect(tttApplyMove(next!, 9, "O")).toBeNull();
    expect(tttApplyMove(next!, -1, "O")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lib: connect 4
// ---------------------------------------------------------------------------

function dropSeq(board: C4Board, moves: [number, "R" | "Y"][]): C4Board {
  let b = board;
  for (const [col, player] of moves) {
    const res = c4Drop(b, col, player);
    if (!res) throw new Error(`drop failed at col ${col}`);
    b = res.board;
  }
  return b;
}

describe("connect 4 logic", () => {
  it("detects a horizontal win", async () => {
    const board = dropSeq(emptyC4Board(), [
      [0, "R"], [1, "R"], [2, "R"], [3, "R"],
    ]);
    expect(c4Winner(board)).toBe("R");
  });

  it("detects a vertical win", async () => {
    const board = dropSeq(emptyC4Board(), [
      [0, "Y"], [0, "Y"], [0, "Y"], [0, "Y"],
    ]);
    expect(c4Winner(board)).toBe("Y");
  });

  it("detects a diagonal win", async () => {
    const board = dropSeq(emptyC4Board(), [
      [0, "R"],
      [1, "Y"], [1, "R"],
      [2, "Y"], [2, "Y"], [2, "R"],
      [3, "Y"], [3, "Y"], [3, "Y"], [3, "R"],
    ]);
    expect(c4Winner(board)).toBe("R");
  });

  it("returns null with no four in a row", async () => {
    const board = dropSeq(emptyC4Board(), [[0, "R"], [1, "Y"], [2, "R"]]);
    expect(c4Winner(board)).toBeNull();
  });

  it("returns null when a column is full or out of range", async () => {
    let board = emptyC4Board();
    for (let i = 0; i < 6; i++) {
      const res = c4Drop(board, 0, i % 2 === 0 ? "R" : "Y");
      expect(res).not.toBeNull();
      board = res!.board;
    }
    expect(c4Drop(board, 0, "R")).toBeNull();
    expect(c4Drop(board, 7, "R")).toBeNull();
    expect(c4Drop(board, -1, "R")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lib: rock-paper-scissors
// ---------------------------------------------------------------------------

describe("rpsOutcome", () => {
  it("covers all nine matchups", async () => {
    const beats: Record<RpsChoice, RpsChoice> = { rock: "scissors", paper: "rock", scissors: "paper" };
    const choices: RpsChoice[] = ["rock", "paper", "scissors"];
    for (const a of choices) {
      for (const b of choices) {
        const expected = a === b ? "draw" : beats[a] === b ? "win" : "lose";
        expect(rpsOutcome(a, b)).toBe(expected);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Lib: trivia banks
// ---------------------------------------------------------------------------

describe("trivia bank", () => {
  it("has at least 20 general-knowledge questions", async () => {
    expect(GENERAL_QUESTIONS.length).toBeGreaterThanOrEqual(20);
  });

  it("every question has 4 distinct options and a valid answerIndex", async () => {
    expect(validateBank(GENERAL_QUESTIONS)).toEqual([]);
  });

  it("checks answers correctly", async () => {
    const q = GENERAL_QUESTIONS[0]!;
    expect(isTriviaAnswerCorrect(q, q.answerIndex)).toBe(true);
    expect(isTriviaAnswerCorrect(q, (q.answerIndex + 1) % 4)).toBe(false);
  });

  it("picks a question from the bank", async () => {
    expect(GENERAL_QUESTIONS).toContain(pickTriviaQuestion());
  });
});

// ---------------------------------------------------------------------------
// Lib: word chain
// ---------------------------------------------------------------------------

describe("word chain", () => {
  it("accepts a valid first word", async () => {
    const state = createWordChain();
    const res = submitWord(state, "apple");
    expect(res.ok).toBe(true);
    expect(res.state.currentLetter).toBe("e");
    expect(res.state.moves).toBe(1);
  });

  it("accepts a word starting with the last letter", async () => {
    const s1 = submitWord(createWordChain(), "apple").state;
    expect(submitWord(s1, "elephant").ok).toBe(true);
  });

  it("rejects a word with the wrong starting letter", async () => {
    const s1 = submitWord(createWordChain(), "apple").state;
    const res = submitWord(s1, "banana");
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/must start with "E"/i);
  });

  it("rejects repeats", async () => {
    // apple -> egg -> grape leaves the chain on "e", so "egg" is both a
    // legal next letter and a repeat.
    const s1 = submitWord(createWordChain(), "apple").state;
    const s2 = submitWord(s1, "egg").state;
    const s3 = submitWord(s2, "grape").state;
    const res = submitWord(s3, "egg");
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/already used/i);
  });

  it("rejects short words and non-letters", async () => {
    const state = createWordChain();
    expect(submitWord(state, "ab").ok).toBe(false);
    expect(submitWord(state, "hello1").ok).toBe(false);
    expect(submitWord(state, "hello world").ok).toBe(false);
  });

  it("does not mutate the input state", async () => {
    const state = createWordChain();
    submitWord(state, "apple");
    expect(state.used).toEqual([]);
    expect(state.moves).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Lib: giveaway winner picking
// ---------------------------------------------------------------------------

describe("pickWinners", () => {
  const entries = ["a", "b", "c", "d", "e"];

  it("picks the requested count, all unique and from the entries", async () => {
    const winners = pickWinners(entries, 2, mulberry32(11));
    expect(winners).toHaveLength(2);
    expect(new Set(winners).size).toBe(2);
    for (const w of winners) expect(entries).toContain(w);
  });

  it("is deterministic with a seeded rand", async () => {
    expect(pickWinners(entries, 3, mulberry32(99))).toEqual(pickWinners(entries, 3, mulberry32(99)));
  });

  it("returns all entries when count exceeds them, and none for count 0", async () => {
    expect(pickWinners(entries, 10, mulberry32(1)).sort()).toEqual([...entries].sort());
    expect(pickWinners(entries, 0)).toEqual([]);
    expect(pickWinners([], 2)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Lib: poll votes
// ---------------------------------------------------------------------------

describe("poll votes", () => {
  it("counts votes per option (pure)", async () => {
    expect(
      countPollVotes(
        [{ option_index: 0 }, { option_index: 0 }, { option_index: 1 }],
        3,
      ),
    ).toEqual([2, 1, 0]);
  });

  it("upserts one vote per user and counts from the DB", async () => {
    await db.prepare(
      "INSERT INTO polls (guild_id, channel_id, message_id, question, options_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("guild-1", "", null, "Best lane?", JSON.stringify(["Mid", "Gold", "EXP"]), "user-1", Date.now());
    const pollId = 1;
    await recordPollVote(db, pollId, "user-1", 0);
    await recordPollVote(db, pollId, "user-2", 1);
    await recordPollVote(db, pollId, "user-1", 1); // change vote
    expect(await getPollCounts(db, pollId, 3)).toEqual([0, 2, 0]);
    const rows = await db.prepare("SELECT COUNT(*) AS c FROM poll_votes WHERE poll_id = ?").get(pollId) as { c: number };
    expect(rows.c).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Commands: /tictactoe, /connect4, /rps
// ---------------------------------------------------------------------------

describe("/tictactoe command", () => {
  it("starts a game against an opponent", async () => {
    const fake = await run("tictactoe", { opponent: OPP });
    expect(replyText(fake)).toMatch(/Tic-Tac-Toe/);
    expect(tttGames.size).toBe(1);
  });

  it("errors when playing against yourself", async () => {
    const fake = await run("tictactoe", { opponent: { id: "user-1", username: "tester" } });
    expect(replyText(fake)).toMatch(/against yourself/i);
  });

  it("errors with no opponent", async () => {
    const fake = await run("tictactoe", {});
    expect(replyText(fake)).toMatch(/Something went wrong|opponent/i);
  });
});

describe("/connect4 command", () => {
  it("starts a game against an opponent", async () => {
    const fake = await run("connect4", { opponent: OPP });
    expect(replyText(fake)).toMatch(/Connect 4/);
    expect(c4Games.size).toBe(1);
  });

  it("errors when playing against yourself", async () => {
    const fake = await run("connect4", { opponent: { id: "user-1", username: "tester" } });
    expect(replyText(fake)).toMatch(/against yourself/i);
  });
});

describe("/rps command", () => {
  it("starts a game against an opponent", async () => {
    const fake = await run("rps", { opponent: OPP });
    expect(replyText(fake)).toMatch(/Rock Paper Scissors/);
    expect(rpsGames.size).toBe(1);
  });

  it("errors when playing against yourself", async () => {
    const fake = await run("rps", { opponent: { id: "user-1", username: "tester" } });
    expect(replyText(fake)).toMatch(/against yourself/i);
  });
});

// ---------------------------------------------------------------------------
// Button handlers: full games via FakeButton
// ---------------------------------------------------------------------------

describe("tic-tac-toe button handler", () => {
  async function click(gameId: string, cell: number, userId: string): Promise<FakeButton> {
    const btn = new FakeButton({ customId: `selena:ttt:${gameId}:${cell}`, userId });
    await buttonHandlers["selena:ttt"]!(btn, { db, guildId: "guild-1" });
    return btn;
  }

  it("plays a full game to an X win", async () => {
    await run("tictactoe", { opponent: OPP });
    const gameId = [...tttGames.keys()][0]!;
    // X: 0,1,2 — O: 3,4
    await click(gameId, 0, "user-1");
    await click(gameId, 3, "user-2");
    await click(gameId, 1, "user-1");
    await click(gameId, 4, "user-2");
    const final = await click(gameId, 2, "user-1");
    expect(buttonText(final)).toMatch(/wins!/);
    expect(tttGames.get(gameId)!.status).toBe("done");
  });

  it("rejects clicks from non-players and wrong turns", async () => {
    await run("tictactoe", { opponent: OPP });
    const gameId = [...tttGames.keys()][0]!;
    const stranger = await click(gameId, 0, "user-99");
    expect(buttonText(stranger)).toMatch(/Only the two players/);
    const wrongTurn = await click(gameId, 0, "user-2");
    expect(buttonText(wrongTurn)).toMatch(/not your turn/i);
  });

  it("rejects a click on a taken square", async () => {
    await run("tictactoe", { opponent: OPP });
    const gameId = [...tttGames.keys()][0]!;
    await click(gameId, 0, "user-1");
    const taken = await click(gameId, 0, "user-2");
    expect(buttonText(taken)).toMatch(/already taken/i);
  });

  it("errors for an unknown game", async () => {
    const btn = new FakeButton({ customId: "selena:ttt:nope:0", userId: "user-1" });
    await buttonHandlers["selena:ttt"]!(btn, { db, guildId: "guild-1" });
    expect(buttonText(btn)).toMatch(/no longer exists/i);
  });
});

describe("connect 4 button handler", () => {
  it("plays a vertical win for the challenger", async () => {
    await run("connect4", { opponent: OPP });
    const gameId = [...c4Games.keys()][0]!;
    const click = async (col: number, userId: string) => {
      const btn = new FakeButton({ customId: `selena:c4:${gameId}:${col}`, userId });
      await buttonHandlers["selena:c4"]!(btn, { db, guildId: "guild-1" });
      return btn;
    };
    await click(0, "user-1");
    await click(1, "user-2");
    await click(0, "user-1");
    await click(1, "user-2");
    await click(0, "user-1");
    await click(1, "user-2");
    const final = await click(0, "user-1");
    expect(buttonText(final)).toMatch(/wins!/);
    expect(c4Games.get(gameId)!.status).toBe("done");
  });

  it("rejects a full column", async () => {
    await run("connect4", { opponent: OPP });
    const gameId = [...c4Games.keys()][0]!;
    const click = async (col: number, userId: string) => {
      const btn = new FakeButton({ customId: `selena:c4:${gameId}:${col}`, userId });
      await buttonHandlers["selena:c4"]!(btn, { db, guildId: "guild-1" });
      return btn;
    };
    // Fill column 0 (6 discs), alternating players.
    for (let i = 0; i < 3; i++) {
      await click(0, "user-1");
      await click(0, "user-2");
    }
    // Column 0 is now full; next player to move gets the full-column error.
    const full = await click(0, "user-1");
    expect(buttonText(full)).toMatch(/column is full/i);
  });
});

describe("rock-paper-scissors button handler", () => {
  it("resolves rock vs scissors as a challenger win", async () => {
    await run("rps", { opponent: OPP });
    const gameId = [...rpsGames.keys()][0]!;
    const click = async (choice: string, userId: string) => {
      const btn = new FakeButton({ customId: `selena:rps:${gameId}:${choice}`, userId });
      await buttonHandlers["selena:rps"]!(btn, { db, guildId: "guild-1" });
      return btn;
    };
    await click("rock", "user-1");
    const final = await click("scissors", "user-2");
    expect(buttonText(final)).toMatch(/wins!/);
    expect(buttonText(final)).toMatch(/rock/);
    expect(buttonText(final)).toMatch(/scissors/);
  });

  it("rejects a second pick from the same player", async () => {
    await run("rps", { opponent: OPP });
    const gameId = [...rpsGames.keys()][0]!;
    const click = async (choice: string, userId: string) => {
      const btn = new FakeButton({ customId: `selena:rps:${gameId}:${choice}`, userId });
      await buttonHandlers["selena:rps"]!(btn, { db, guildId: "guild-1" });
      return btn;
    };
    await click("rock", "user-1");
    const again = await click("paper", "user-1");
    expect(buttonText(again)).toMatch(/already picked/i);
  });
});

// ---------------------------------------------------------------------------
// Commands: /trivia
// ---------------------------------------------------------------------------

describe("/trivia command", () => {
  it("asks a general-knowledge question with 4 buttons", async () => {
    const fake = await run("trivia", {});
    const text = replyText(fake);
    expect(text).toMatch(/Trivia/);
    expect(text).toMatch(/\*\*A\.\*\*/);
    expect(text).toMatch(/\*\*D\.\*\*/);
    expect(triviaGames.size).toBe(1);
  });
});

describe("trivia button handler", () => {
  it("awards 25 points for a correct first answer", async () => {
    await run("trivia", {});
    const game = [...triviaGames.values()][0]!;
    const btn = new FakeButton({
      customId: `selena:trivia:${game.id}:${game.question.answerIndex}`,
      userId: "user-9",
    });
    await buttonHandlers["selena:trivia"]!(btn, { db, guildId: "guild-1" });
    expect(await userPoints("user-9")).toBe(TRIVIA_POINTS);
    expect(buttonText(btn)).toMatch(/got it right/);
  });

  it("awards nothing for a wrong answer, and blocks a second answer", async () => {
    await run("trivia", {});
    const game = [...triviaGames.values()][0]!;
    const wrong = (game.question.answerIndex + 1) % 4;
    const btn = new FakeButton({ customId: `selena:trivia:${game.id}:${wrong}`, userId: "user-9" });
    await buttonHandlers["selena:trivia"]!(btn, { db, guildId: "guild-1" });
    expect(await userPoints("user-9")).toBe(0);
    expect(buttonText(btn)).toMatch(/got it wrong/);
    const second = new FakeButton({
      customId: `selena:trivia:${game.id}:${game.question.answerIndex}`,
      userId: "user-10",
    });
    await buttonHandlers["selena:trivia"]!(second, { db, guildId: "guild-1" });
    expect(buttonText(second)).toMatch(/already answered/i);
  });
});

// ---------------------------------------------------------------------------
// Commands: /wordchain
// ---------------------------------------------------------------------------

describe("/wordchain command", () => {
  it("starts a game, then accepts a chain of valid words", async () => {
    expect(replyText(await run("wordchain", {}))).toMatch(/new word chain has started/i);
    const a = await run("wordchain", { word: "apple" });
    expect(replyText(a)).toMatch(/Next word must start with \*\*E\*\*/);
    const b = await run("wordchain", { word: "elephant" });
    expect(replyText(b)).toMatch(/Next word must start with \*\*T\*\*/);
  });

  it("errors when starting a second game", async () => {
    await run("wordchain", {});
    const fake = await run("wordchain", {});
    expect(replyText(fake)).toMatch(/already running/i);
  });

  it("errors when submitting with no active game", async () => {
    const fake = await run("wordchain", { word: "apple" });
    expect(replyText(fake)).toMatch(/No word chain is running/i);
  });

  it("errors on a repeat or a wrong-letter word", async () => {
    await run("wordchain", {});
    await run("wordchain", { word: "apple" });
    await run("wordchain", { word: "elephant" });
    const repeat = await run("wordchain", { word: "apple" });
    expect(replyText(repeat)).toMatch(/already used|must start with/i);
    const wrongLetter = await run("wordchain", { word: "banana" });
    expect(replyText(wrongLetter)).toMatch(/must start with/i);
    expect(wordChainGames.get("guild-1")!.moves).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Commands: /giveaway
// ---------------------------------------------------------------------------

describe("/giveaway command", () => {
  it("creates a giveaway row and replies with an entry button", async () => {
    const fake = await run("giveaway", { prize: "1000 Diamonds", duration: 60, winners: 2 });
    expect(replyText(fake)).toMatch(/1000 Diamonds/);
    const row = await db.prepare("SELECT * FROM giveaways WHERE id = 1").get() as Record<string, unknown>;
    expect(row.prize).toBe("1000 Diamonds");
    expect(row.winners_count).toBe(2);
    expect(Number(row.ended)).toBe(0);
    const payload = fake.firstReplyPayload() as { components?: unknown[] };
    expect(payload.components?.length).toBe(1);
  });

  it("errors on an invalid duration or winner count", async () => {
    const badDuration = await run("giveaway", { prize: "x", duration: 0, winners: 1 });
    expect(replyText(badDuration)).toMatch(/Duration must be/i);
    const badWinners = await run("giveaway", { prize: "x", duration: 60, winners: 0 });
    expect(replyText(badWinners)).toMatch(/Winners must be/i);
  });

  it("errors with no prize", async () => {
    const fake = await run("giveaway", { duration: 60, winners: 1 });
    expect(replyText(fake)).toMatch(/Something went wrong|prize/i);
  });
});

describe("giveaway button handler", () => {
  it("enters the user once, then reports already-entered", async () => {
    await run("giveaway", { prize: "Skin", duration: 60, winners: 1 });
    const join = async (userId: string) => {
      const btn = new FakeButton({ customId: "selena:giveaway:join:1", userId });
      await buttonHandlers["selena:giveaway"]!(btn, { db, guildId: "guild-1" });
      return btn;
    };
    expect(buttonText(await join("user-2"))).toMatch(/You're in!/);
    expect(buttonText(await join("user-2"))).toMatch(/already entered/i);
    expect(buttonText(await join("user-3"))).toMatch(/You're in!/);
    const rows = await db.prepare("SELECT COUNT(*) AS c FROM giveaway_entries WHERE giveaway_id = 1").get() as {
      c: number;
    };
    expect(rows.c).toBe(2);
  });

  it("errors for an unknown giveaway", async () => {
    const btn = new FakeButton({ customId: "selena:giveaway:join:999", userId: "user-2" });
    await buttonHandlers["selena:giveaway"]!(btn, { db, guildId: "guild-1" });
    expect(buttonText(btn)).toMatch(/no longer exists/i);
  });
});

// ---------------------------------------------------------------------------
// Commands: /poll
// ---------------------------------------------------------------------------

describe("/poll command", () => {
  it("creates a poll row and shows zeroed counts", async () => {
    const fake = await run("poll", { question: "Best lane?", option1: "Mid", option2: "Gold" });
    expect(replyText(fake)).toMatch(/Best lane\?/);
    expect(replyText(fake)).toMatch(/0 total votes/);
    const row = await db.prepare("SELECT * FROM polls WHERE id = 1").get() as Record<string, unknown>;
    expect(JSON.parse(row.options_json as string)).toEqual(["Mid", "Gold"]);
  });

  it("errors on duplicate options", async () => {
    const fake = await run("poll", { question: "Q?", option1: "Mid", option2: "mid" });
    expect(replyText(fake)).toMatch(/must all be different/i);
  });

  it("errors with fewer than two options", async () => {
    const fake = await run("poll", { question: "Q?", option1: "Mid" });
    expect(replyText(fake)).toMatch(/at least two options/i);
  });

  it("errors with no question", async () => {
    const fake = await run("poll", { option1: "A", option2: "B" });
    expect(replyText(fake)).toMatch(/Something went wrong|question/i);
  });
});

describe("poll button handler", () => {
  it("records votes, lets a user change their vote, and shows live counts", async () => {
    await run("poll", { question: "Best lane?", option1: "Mid", option2: "Gold", option3: "EXP" });
    const vote = async (idx: number, userId: string) => {
      const btn = new FakeButton({ customId: `selena:poll:1:${idx}`, userId });
      await buttonHandlers["selena:poll"]!(btn, { db, guildId: "guild-1" });
      return btn;
    };
    await vote(0, "user-2");
    await vote(1, "user-3");
    const changed = await vote(1, "user-2"); // user-2 switches Mid -> Gold
    expect(buttonText(changed)).toMatch(/Gold.*2 votes/);
    expect(await getPollCounts(db, 1, 3)).toEqual([0, 2, 0]);
  });

  it("errors for an unknown poll", async () => {
    const btn = new FakeButton({ customId: "selena:poll:999:0", userId: "user-2" });
    await buttonHandlers["selena:poll"]!(btn, { db, guildId: "guild-1" });
    expect(buttonText(btn)).toMatch(/no longer exists/i);
  });
});
