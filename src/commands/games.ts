import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import {
  errorEmbed,
  fmt,
  type Command,
  type CommandContext,
  type CommandInvocation,
} from "../lib/command.js";
import { emoji } from "../lib/emoji.js";
import {
  TRIVIA_POINTS,
  TRIVIA_TIME_LIMIT_MS,
  awardPoints,
  c4Drop,
  c4Games,
  c4IsFull,
  c4Render,
  c4Winner,
  createWordChain,
  emptyC4Board,
  emptyTttBoard,
  getPollCounts,
  newGameId,
  recordPollVote,
  rpsEmoji,
  rpsGames,
  rpsOutcome,
  submitWord,
  triviaGames,
  tttApplyMove,
  tttGames,
  tttRender,
  tttWinner,
  wordChainGames,
  type C4Game,
  type C4Player,
  type RpsChoice,
  type RpsGame,
  type TriviaGame,
  type TttGame,
  type TttPlayer,
} from "../lib/games.js";
import { isTriviaAnswerCorrect, pickTriviaQuestion } from "../lib/trivia.js";

/**
 * Games slash commands + button handlers.
 *
 * Game state lives in module-level Maps in ../lib/games.ts, keyed by a game
 * id encoded in each button's customId (e.g. selena:ttt:<gameId>:<cell>).
 * Button handlers are exported keyed by customId prefix so the bot runtime
 * (index.ts, owned by another worker) can route on prefix.
 *
 * NOTE (runtime): uwu giveaway auto-draw on expiry needs a timer in index.ts
 * that, when a giveaway's ends_at passes, reads giveaway_entries, calls
 * pickWinners(), marks the giveaway ended, and announces the winners.
 * That timer is deliberately NOT built here — index.ts belongs to another
 * worker. The DB row + entry button + pickWinners() in this module are
 * complete and ready for it.
 */

type AnyInv = CommandInvocation;

async function replyError(inv: AnyInv, message: string): Promise<void> {
  await inv.reply({ embeds: [errorEmbed(message)], ephemeral: true });
}

function truncateLabel(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------------------------------------------------------------------------
// Tic-tac-toe
// ---------------------------------------------------------------------------

/** OwO-style plain text, no embed box: title line, board, status. */
function tttText(game: TttGame): string {
  const xName = game.playerXName;
  const oName = game.playerOName;
  let status: string;
  if (game.status === "done") {
    status =
      game.winner === "draw"
        ? "It's a draw! 🤝"
        : game.winner === "X"
          ? `${emoji("trophy")} <@${game.playerX}> (❌) wins!`
          : `${emoji("trophy")} <@${game.playerO}> (⭕) wins!`;
  } else {
    status = game.turn === "X" ? `❌ <@${game.playerX}>'s turn` : `⭕ <@${game.playerO}>'s turn`;
  }
  return `Tic-Tac-Toe — ${xName} ❌ vs ${oName} ⭕\n${tttRender(game.board)}\n\n${status}`;
}

function tttComponents(game: TttGame): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let r = 0; r < 3; r++) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (let c = 0; c < 3; c++) {
      const idx = r * 3 + c;
      const cell = game.board[idx];
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`selena:ttt:${game.id}:${idx}`)
          .setLabel(cell === "X" ? "❌" : cell === "O" ? "⭕" : String(idx + 1))
          .setStyle(cell ? ButtonStyle.Secondary : ButtonStyle.Primary)
          .setDisabled(game.status !== "active" || cell !== null),
      );
    }
    rows.push(row);
  }
  return rows;
}

async function handleTtt(inv: any, _ctx: CommandContext): Promise<void> {
  const parts = String(inv.customId).split(":");
  const game = tttGames.get(parts[2] ?? "");
  const cell = Number(parts[3]);
  if (!game) {
    await inv.reply({ content: "This tic-tac-toe game has ended or no longer exists.", ephemeral: true });
    return;
  }
  const symbol: TttPlayer | null =
    inv.user.id === game.playerX ? "X" : inv.user.id === game.playerO ? "O" : null;
  if (!symbol) {
    await inv.reply({ content: "Only the two players in this game can click.", ephemeral: true });
    return;
  }
  if (game.status !== "active") {
    await inv.reply({ content: "This game is already over.", ephemeral: true });
    return;
  }
  if (game.turn !== symbol) {
    await inv.reply({ content: "It's not your turn yet.", ephemeral: true });
    return;
  }
  const next = tttApplyMove(game.board, cell, symbol);
  if (!next) {
    await inv.reply({ content: "That square is already taken.", ephemeral: true });
    return;
  }
  game.board = next;
  const result = tttWinner(game.board);
  if (result === "X" || result === "O") {
    game.status = "done";
    game.winner = result;
  } else if (result === "draw") {
    game.status = "done";
    game.winner = "draw";
  } else {
    game.turn = symbol === "X" ? "O" : "X";
  }
  await inv.update({ content: tttText(game), components: tttComponents(game) });
}

// ---------------------------------------------------------------------------
// Connect 4
// ---------------------------------------------------------------------------

/** OwO-style plain text, no embed box: title line, board, status. */
function c4Text(game: C4Game): string {
  let status: string;
  if (game.status === "done") {
    status =
      game.winner === "draw"
        ? "It's a draw! 🤝"
        : game.winner === "R"
          ? `${emoji("trophy")} <@${game.playerR}> (🔴) wins!`
          : `${emoji("trophy")} <@${game.playerY}> (🟡) wins!`;
  } else {
    status = game.turn === "R" ? `🔴 <@${game.playerR}>'s turn` : `🟡 <@${game.playerY}>'s turn`;
  }
  return `Connect 4 — ${game.playerRName} 🔴 vs ${game.playerYName} 🟡\n${c4Render(game.board)}\n\n${status}`;
}

function c4Components(game: C4Game): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>();
  for (let col = 0; col < 7; col++) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`selena:c4:${game.id}:${col}`)
        .setLabel(String(col + 1))
        .setEmoji("⬇️")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(game.status !== "active" || game.board[0]![col] !== null),
    );
  }
  return [row];
}

async function handleC4(inv: any, _ctx: CommandContext): Promise<void> {
  const parts = String(inv.customId).split(":");
  const game = c4Games.get(parts[2] ?? "");
  const col = Number(parts[3]);
  if (!game) {
    await inv.reply({ content: "This Connect 4 game has ended or no longer exists.", ephemeral: true });
    return;
  }
  const symbol: C4Player | null =
    inv.user.id === game.playerR ? "R" : inv.user.id === game.playerY ? "Y" : null;
  if (!symbol) {
    await inv.reply({ content: "Only the two players in this game can click.", ephemeral: true });
    return;
  }
  if (game.status !== "active") {
    await inv.reply({ content: "This game is already over.", ephemeral: true });
    return;
  }
  if (game.turn !== symbol) {
    await inv.reply({ content: "It's not your turn yet.", ephemeral: true });
    return;
  }
  const dropped = c4Drop(game.board, col, symbol);
  if (!dropped) {
    await inv.reply({ content: "That column is full — pick another one.", ephemeral: true });
    return;
  }
  game.board = dropped.board;
  const winner = c4Winner(game.board);
  if (winner) {
    game.status = "done";
    game.winner = winner;
  } else if (c4IsFull(game.board)) {
    game.status = "done";
    game.winner = "draw";
  } else {
    game.turn = symbol === "R" ? "Y" : "R";
  }
  await inv.update({ content: c4Text(game), components: c4Components(game) });
}

// ---------------------------------------------------------------------------
// Rock-paper-scissors
// ---------------------------------------------------------------------------

/** OwO-style plain text, no embed box. */
function rpsText(game: RpsGame): string {
  if (game.status === "done") {
    const a = game.picks[game.challengerId]!;
    const b = game.picks[game.opponentId]!;
    const result =
      game.winnerId === null
        ? "It's a draw! 🤝"
        : game.winnerId === game.challengerId
          ? `${emoji("trophy")} <@${game.challengerId}> wins!`
          : `${emoji("trophy")} <@${game.opponentId}> wins!`;
    return (
      `Rock Paper Scissors — ${game.challengerName} vs ${game.opponentName}\n` +
      `<@${game.challengerId}> played ${rpsEmoji(a)} ${a}\n<@${game.opponentId}> played ${rpsEmoji(b)} ${b}\n\n${result}`
    );
  }
  const pickedChallenger = !!game.picks[game.challengerId];
  const pickedOpponent = !!game.picks[game.opponentId];
  const waiting = pickedChallenger
    ? `Waiting for <@${game.opponentId}> to pick…`
    : pickedOpponent
      ? `Waiting for <@${game.challengerId}> to pick…`
      : "Both players pick — challenger first, then the opponent.";
  return (
    `Rock Paper Scissors — ${game.challengerName} vs ${game.opponentName}\n` +
    `🪨 Rock • 📄 Paper • ✂️ Scissors — best of 1.\n\n${waiting}`
  );
}

function rpsComponents(game: RpsGame): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const choice of ["rock", "paper", "scissors"] as const) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`selena:rps:${game.id}:${choice}`)
        .setLabel(choice === "rock" ? "Rock" : choice === "paper" ? "Paper" : "Scissors")
        .setEmoji(rpsEmoji(choice))
        .setStyle(ButtonStyle.Primary)
        .setDisabled(game.status !== "active"),
    );
  }
  return [row];
}

async function handleRps(inv: any, _ctx: CommandContext): Promise<void> {
  const parts = String(inv.customId).split(":");
  const game = rpsGames.get(parts[2] ?? "");
  const choice = parts[3] as RpsChoice;
  if (!game) {
    await inv.reply({ content: "This rock-paper-scissors game has ended or no longer exists.", ephemeral: true });
    return;
  }
  if (!["rock", "paper", "scissors"].includes(choice)) {
    await inv.reply({ content: "Invalid choice.", ephemeral: true });
    return;
  }
  if (game.status !== "active") {
    await inv.reply({ content: "This game is already over.", ephemeral: true });
    return;
  }
  const isPlayer = inv.user.id === game.challengerId || inv.user.id === game.opponentId;
  if (!isPlayer) {
    await inv.reply({ content: "Only the two players in this game can click.", ephemeral: true });
    return;
  }
  if (game.picks[inv.user.id]) {
    await inv.reply({ content: "You already picked — waiting for your opponent.", ephemeral: true });
    return;
  }
  game.picks[inv.user.id] = choice;
  if (game.picks[game.challengerId] && game.picks[game.opponentId]) {
    const outcome = rpsOutcome(game.picks[game.challengerId]!, game.picks[game.opponentId]!);
    game.status = "done";
    game.winnerId = outcome === "draw" ? null : outcome === "win" ? game.challengerId : game.opponentId;
  }
  await inv.update({ content: rpsText(game), components: rpsComponents(game) });
}

// ---------------------------------------------------------------------------
// Trivia
// ---------------------------------------------------------------------------

/**
 * OwO-style plain text, no embed box. When a result line is given (the
 * answer handler), it replaces the footer — the correct/wrong outcome.
 */
function triviaText(game: TriviaGame, reveal: boolean, pickedIndex?: number, resultLine?: string): string {
  const q = game.question;
  const lines = q.options.map((opt, i) => {
    const letter = String.fromCharCode(65 + i);
    let marker = "";
    if (reveal) {
      if (i === q.answerIndex) marker = " ✅";
      else if (i === pickedIndex) marker = " ❌";
    }
    return `${letter}. ${opt}${marker}`;
  });
  const footer =
    resultLine ??
    (reveal
      ? game.answeredBy
        ? `Answered by <@${game.answeredBy}>. Correct answer: ${String.fromCharCode(65 + q.answerIndex)}.`
        : `Correct answer: ${String.fromCharCode(65 + q.answerIndex)}.`
      : `You have ${TRIVIA_TIME_LIMIT_MS / 1000} seconds — first answer counts! Worth ${TRIVIA_POINTS} gold.`);
  return `🧠 Trivia\n${q.question}\n\n${lines.join("\n")}\n\n${footer}`;
}

/** Build trivia buttons with the real game id baked into the customId. */
function triviaComponentsFor(game: TriviaGame, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>();
  game.question.options.forEach((opt, i) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`selena:trivia:${game.id}:${i}`)
        .setLabel(truncateLabel(`${String.fromCharCode(65 + i)}. ${opt}`, 80))
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    );
  });
  return [row];
}

async function handleTrivia(inv: any, ctx: CommandContext): Promise<void> {
  const parts = String(inv.customId).split(":");
  const game = triviaGames.get(parts[2] ?? "");
  const idx = Number(parts[3]);
  if (!game) {
    await inv.reply({ content: "This trivia question has expired.", ephemeral: true });
    return;
  }
  if (Date.now() > game.expiresAt) {
    triviaGames.delete(game.id);
    await inv.reply({ content: "Time's up! This trivia question has expired.", ephemeral: true });
    return;
  }
  if (game.answeredBy) {
    await inv.reply({ content: "This question was already answered.", ephemeral: true });
    return;
  }
  if (!Number.isInteger(idx) || idx < 0 || idx > 3) {
    await inv.reply({ content: "Invalid answer.", ephemeral: true });
    return;
  }
  const correct = isTriviaAnswerCorrect(game.question, idx);
  game.answeredBy = inv.user.id;
  if (correct) {
    await awardPoints(ctx.db, ctx.guildId, inv.user.id, TRIVIA_POINTS, "trivia");
  }
  const resultLine = correct
    ? `${emoji("party")} <@${inv.user.id}> got it right and earned ${TRIVIA_POINTS} gold!`
    : `❌ <@${inv.user.id}> got it wrong. The correct answer was ${String.fromCharCode(65 + game.question.answerIndex)}.`;
  await inv.update({
    content: triviaText(game, true, idx, resultLine),
    components: triviaComponentsFor(game, true),
  });
}

// ---------------------------------------------------------------------------
// Giveaway
// ---------------------------------------------------------------------------

async function handleGiveaway(inv: any, ctx: CommandContext): Promise<void> {
  const parts = String(inv.customId).split(":");
  const giveawayId = Number(parts[3]);
  if (!Number.isInteger(giveawayId)) {
    await inv.reply({ content: "Invalid giveaway.", ephemeral: true });
    return;
  }
  const row = await ctx.db
    .prepare("SELECT id, ended FROM giveaways WHERE id = ?")
    .get(giveawayId) as { id: number; ended: number } | undefined;
  if (!row) {
    await inv.reply({ content: "That giveaway no longer exists.", ephemeral: true });
    return;
  }
  if (row.ended) {
    await inv.reply({ content: "That giveaway has already ended.", ephemeral: true });
    return;
  }
  const res = await ctx.db
    .prepare("INSERT OR IGNORE INTO giveaway_entries (giveaway_id, user_id) VALUES (?, ?)")
    .run(giveawayId, inv.user.id);
  if (res.changes === 0) {
    await inv.reply({ content: "You're already entered in this giveaway. " + emoji("party"), ephemeral: true });
    return;
  }
  await inv.reply({ content: "You're in! Good luck. " + emoji("party"), ephemeral: true });
}

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

/** OwO-style plain text, no embed box: question, options with vote bars, total. */
function pollText(question: string, options: string[], counts: number[]): string {
  const total = counts.reduce((s, c) => s + c, 0);
  const lines = options.map((opt, i) => {
    const count = counts[i] ?? 0;
    const pct = total === 0 ? 0 : Math.round((count / total) * 100);
    const bar = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
    return `${i + 1}. ${opt} — ${count} vote${count === 1 ? "" : "s"} (${pct}%)\n${bar}`;
  });
  return (
    `📊 ${question}\n${lines.join("\n\n")}\n\n` +
    `${total} total vote${total === 1 ? "" : "s"} — click a button to vote (one vote per person, click again to change it).`
  );
}

function pollComponents(pollId: number, options: string[], counts: number[]): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>();
  options.forEach((opt, i) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`selena:poll:${pollId}:${i}`)
        .setLabel(truncateLabel(`${opt} (${counts[i] ?? 0})`, 80))
        .setStyle(ButtonStyle.Primary),
    );
  });
  return [row];
}

async function handlePoll(inv: any, ctx: CommandContext): Promise<void> {
  const parts = String(inv.customId).split(":");
  const pollId = Number(parts[2]);
  const idx = Number(parts[3]);
  const row = await ctx.db
    .prepare("SELECT id, question, options_json FROM polls WHERE id = ?")
    .get(pollId) as { id: number; question: string; options_json: string } | undefined;
  if (!row) {
    await inv.reply({ content: "That poll no longer exists.", ephemeral: true });
    return;
  }
  let options: string[];
  try {
    options = JSON.parse(row.options_json) as string[];
  } catch {
    await inv.reply({ content: "That poll is broken (bad options data).", ephemeral: true });
    return;
  }
  if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) {
    await inv.reply({ content: "Invalid poll option.", ephemeral: true });
    return;
  }
  await recordPollVote(ctx.db, pollId, inv.user.id, idx);
  const counts = await getPollCounts(ctx.db, pollId, options.length);
  await inv.update({ content: pollText(row.question, options, counts), components: pollComponents(pollId, options, counts) });
}

export const buttonHandlers: Record<string, (inv: any, ctx: CommandContext) => Promise<void>> = {
  "selena:ttt": handleTtt,
  "selena:c4": handleC4,
  "selena:rps": handleRps,
  "selena:trivia": handleTrivia,
  "selena:giveaway": handleGiveaway,
  "selena:poll": handlePoll,
};

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

function requireOpponent(inv: AnyInv): { id: string; username: string } | null {
  return inv.options.getUser("opponent");
}

export const commands: Command[] = [
  {
    name: "tictactoe",
    description: "Challenge a member to tic-tac-toe.",
    aliases: ["ttt", "tic"],
    args: [{ name: "opponent", type: "user", required: true }],
    async execute(inv, _ctx) {
      const opponent = requireOpponent(inv);
      if (!opponent) {
        await replyError(inv, "Pick an opponent to play against!");
        return;
      }
      if (opponent.id === inv.user.id) {
        await replyError(inv, "You can't play tic-tac-toe against yourself!");
        return;
      }
      const game: TttGame = {
        id: newGameId("ttt"),
        guildId: inv.guildId ?? "",
        playerX: inv.user.id,
        playerO: opponent.id,
        playerXName: inv.user.username,
        playerOName: opponent.username,
        board: emptyTttBoard(),
        turn: "X",
        status: "active",
      };
      tttGames.set(game.id, game);
      await inv.reply({ content: tttText(game), components: tttComponents(game) });
    },
  },
  {
    name: "connect4",
    description: "Challenge a member to Connect 4.",
    aliases: ["c4", "connectfour"],
    args: [{ name: "opponent", type: "user", required: true }],
    async execute(inv, _ctx) {
      const opponent = requireOpponent(inv);
      if (!opponent) {
        await replyError(inv, "Pick an opponent to play against!");
        return;
      }
      if (opponent.id === inv.user.id) {
        await replyError(inv, "You can't play Connect 4 against yourself!");
        return;
      }
      const game: C4Game = {
        id: newGameId("c4"),
        guildId: inv.guildId ?? "",
        playerR: inv.user.id,
        playerY: opponent.id,
        playerRName: inv.user.username,
        playerYName: opponent.username,
        board: emptyC4Board(),
        turn: "R",
        status: "active",
      };
      c4Games.set(game.id, game);
      await inv.reply({ content: c4Text(game), components: c4Components(game) });
    },
  },
  {
    name: "rps",
    description: "Challenge a member to rock-paper-scissors (best of 1).",
    aliases: ["rockpaperscissors", "rock"],
    args: [{ name: "opponent", type: "user", required: true }],
    async execute(inv, _ctx) {
      const opponent = requireOpponent(inv);
      if (!opponent) {
        await replyError(inv, "Pick an opponent to play against!");
        return;
      }
      if (opponent.id === inv.user.id) {
        await replyError(inv, "You can't play rock-paper-scissors against yourself!");
        return;
      }
      const game: RpsGame = {
        id: newGameId("rps"),
        guildId: inv.guildId ?? "",
        challengerId: inv.user.id,
        opponentId: opponent.id,
        challengerName: inv.user.username,
        opponentName: opponent.username,
        picks: {},
        status: "active",
      };
      rpsGames.set(game.id, game);
      await inv.reply({ content: rpsText(game), components: rpsComponents(game) });
    },
  },
  {
    name: "trivia",
    description: "Answer a timed trivia question — first correct answer earns gold.",
    aliases: ["quiz"],
    async execute(inv, _ctx) {
      const question = pickTriviaQuestion();
      const game: TriviaGame = {
        id: newGameId("triv"),
        guildId: inv.guildId ?? "",
        question,
        answeredBy: null,
        expiresAt: Date.now() + TRIVIA_TIME_LIMIT_MS,
      };
      triviaGames.set(game.id, game);
      await inv.reply({ content: triviaText(game, false), components: triviaComponentsFor(game, false) });
    },
  },
  {
    name: "wordchain",
    description: "Play word chain: each word must start with the last letter of the previous word.",
    aliases: ["wc", "word"],
    args: [{ name: "word", type: "string" }],
    async execute(inv, _ctx) {
      const guildId = inv.guildId ?? "";
      const word = inv.options.getString("word");
      if (!word) {
        if (wordChainGames.has(guildId)) {
          await replyError(
            inv,
            "A word chain is already running in this server — play it with uwu wordchain <your word>.",
          );
          return;
        }
        wordChainGames.set(guildId, createWordChain());
        await inv.reply({
          content:
            "🔗 Word Chain\nA new word chain has started!\n\nRules: each word must be at least 3 letters, letters only, start with the last letter of the previous word, and never repeat a word.\n\nPlay with `uwu wordchain <your word>` — any word can start the chain.",
        });
        return;
      }
      const state = wordChainGames.get(guildId);
      if (!state) {
        await replyError(inv, "No word chain is running — start one with uwu wordchain first.");
        return;
      }
      const result = submitWord(state, word);
      if (!result.ok) {
        await replyError(inv, result.reason ?? "That word doesn't work.");
        return;
      }
      wordChainGames.set(guildId, result.state);
      await inv.reply({
        content:
          `🔗 Word Chain\n${inv.user.username} played ${word.trim().toLowerCase()}.\n\n` +
          `Next word must start with ${result.state.currentLetter!.toUpperCase()}.\n` +
          `Chain length: ${result.state.moves} word${result.state.moves === 1 ? "" : "s"}.`,
      });
    },
  },
  {
    name: "giveaway",
    description: "Start a giveaway. Winners are drawn automatically when it ends.",
    aliases: ["gaway", "gw"],
    args: [{ name: "prize", type: "string", required: true }, { name: "duration", type: "integer", required: true }, { name: "winners", type: "integer", required: true }],
    async execute(inv, ctx) {
      const prize = inv.options.getString("prize");
      const duration = inv.options.getInteger("duration");
      const winners = inv.options.getInteger("winners");
      if (!prize?.trim()) {
        await replyError(inv, "Tell me what the prize is!");
        return;
      }
      if (prize.trim().length > 200) {
        await replyError(inv, "The prize description is too long (max 200 characters).");
        return;
      }
      if (duration === null || duration < 1 || duration > 10080) {
        await replyError(inv, "Duration must be between 1 and 10080 minutes.");
        return;
      }
      if (winners === null || winners < 1 || winners > 10) {
        await replyError(inv, "Winners must be between 1 and 10.");
        return;
      }
      const endsAt = Date.now() + duration * 60_000;
      const res = await ctx.db
        .prepare(
          "INSERT INTO giveaways (guild_id, channel_id, message_id, prize, ends_at, winners_count, ended, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
        )
        .run(ctx.guildId, "", null, prize.trim(), endsAt, winners, inv.user.id, Date.now());
      const giveawayId = Number(res.lastInsertRowid);
      const endsIn = duration >= 60 ? `${(duration / 60).toFixed(1)} hours` : `${duration} minutes`;
      const button = new ButtonBuilder()
        .setCustomId(`selena:giveaway:join:${giveawayId}`)
        .setLabel("🎉 Enter Giveaway")
        .setStyle(ButtonStyle.Success);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);
      await inv.reply({
        content:
          `${emoji("party")} Giveaway!\nPrize: ${prize.trim()}\nWinners: ${fmt(winners)}\nEnds in: ${endsIn}\n\nClick the button below to enter! Winners are drawn automatically when the giveaway ends.\nGiveaway #${giveawayId}`,
        components: [row],
      });
    },
  },
  {
    name: "poll",
    description: "Start a button poll — one vote per person, click again to change it.",
    aliases: ["vote"],
    args: [{ name: "question", type: "string", required: true }, { name: "option1", type: "string", required: true }, { name: "option2", type: "string", required: true }, { name: "option3", type: "string" }, { name: "option4", type: "string" }],
    async execute(inv, ctx) {
      const question = inv.options.getString("question");
      const rawOptions = [
        inv.options.getString("option1"),
        inv.options.getString("option2"),
        inv.options.getString("option3"),
        inv.options.getString("option4"),
      ];
      if (!question?.trim()) {
        await replyError(inv, "Ask a question for the poll!");
        return;
      }
      const options = rawOptions.filter((o): o is string => !!o?.trim()).map((o) => o.trim());
      if (options.length < 2) {
        await replyError(inv, "A poll needs at least two options.");
        return;
      }
      if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) {
        await replyError(inv, "Poll options must all be different.");
        return;
      }
      const res = await ctx.db
        .prepare(
          "INSERT INTO polls (guild_id, channel_id, message_id, question, options_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(ctx.guildId, "", null, question.trim(), JSON.stringify(options), inv.user.id, Date.now());
      const pollId = Number(res.lastInsertRowid);
      const counts = Array<number>(options.length).fill(0);
      await inv.reply({
        content: pollText(question.trim(), options, counts),
        components: pollComponents(pollId, options, counts),
      });
    },
  },
];
