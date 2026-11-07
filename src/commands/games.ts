import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  type EmbedBuilder,
} from "discord.js";
import {
  errorEmbed,
  fmt,
  selenaEmbed,
  type Command,
  type CommandContext,
} from "../lib/command.js";
import { emoji } from "../lib/emoji.js";
import {
  GUESS_HERO_POINTS,
  TRIVIA_POINTS,
  TRIVIA_TIME_LIMIT_MS,
  awardPoints,
  c4Drop,
  c4Games,
  c4IsFull,
  c4Render,
  c4Winner,
  checkGuess,
  createWordChain,
  emptyC4Board,
  emptyTttBoard,
  getPollCounts,
  guessHeroRounds,
  newGameId,
  pickGuessHero,
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
import { isTriviaAnswerCorrect, pickTriviaQuestion, type TriviaCategory } from "../lib/trivia.js";

/**
 * Games slash commands + button handlers.
 *
 * Game state lives in module-level Maps in ../lib/games.ts, keyed by a game
 * id encoded in each button's customId (e.g. selena:ttt:<gameId>:<cell>).
 * Button handlers are exported keyed by customId prefix so the bot runtime
 * (index.ts, owned by another worker) can route on prefix.
 *
 * NOTE (runtime): /giveaway auto-draw on expiry needs a timer in index.ts
 * that, when a giveaway's ends_at passes, reads giveaway_entries, calls
 * pickWinners(), marks the giveaway ended, and announces the winners.
 * That timer is deliberately NOT built here — index.ts belongs to another
 * worker. The DB row + entry button + pickWinners() in this module are
 * complete and ready for it.
 */

type AnyInteraction = Parameters<Command["execute"]>[0];

async function replyError(interaction: AnyInteraction, message: string): Promise<void> {
  await interaction.reply({ embeds: [errorEmbed(message)], ephemeral: true });
}

function truncateLabel(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------------------------------------------------------------------------
// Tic-tac-toe
// ---------------------------------------------------------------------------

function tttEmbed(game: TttGame): EmbedBuilder {
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
  return selenaEmbed(
    `Tic-Tac-Toe — ${xName} ❌ vs ${oName} ⭕`,
    `${tttRender(game.board)}\n\n${status}`,
  );
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

async function handleTtt(interaction: any, _ctx: CommandContext): Promise<void> {
  const parts = String(interaction.customId).split(":");
  const game = tttGames.get(parts[2] ?? "");
  const cell = Number(parts[3]);
  if (!game) {
    await interaction.reply({ content: "This tic-tac-toe game has ended or no longer exists.", ephemeral: true });
    return;
  }
  const symbol: TttPlayer | null =
    interaction.user.id === game.playerX ? "X" : interaction.user.id === game.playerO ? "O" : null;
  if (!symbol) {
    await interaction.reply({ content: "Only the two players in this game can click.", ephemeral: true });
    return;
  }
  if (game.status !== "active") {
    await interaction.reply({ content: "This game is already over.", ephemeral: true });
    return;
  }
  if (game.turn !== symbol) {
    await interaction.reply({ content: "It's not your turn yet.", ephemeral: true });
    return;
  }
  const next = tttApplyMove(game.board, cell, symbol);
  if (!next) {
    await interaction.reply({ content: "That square is already taken.", ephemeral: true });
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
  await interaction.update({ embeds: [tttEmbed(game)], components: tttComponents(game) });
}

// ---------------------------------------------------------------------------
// Connect 4
// ---------------------------------------------------------------------------

function c4Embed(game: C4Game): EmbedBuilder {
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
  return selenaEmbed(
    `Connect 4 — ${game.playerRName} 🔴 vs ${game.playerYName} 🟡`,
    `${c4Render(game.board)}\n\n${status}`,
  );
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

async function handleC4(interaction: any, _ctx: CommandContext): Promise<void> {
  const parts = String(interaction.customId).split(":");
  const game = c4Games.get(parts[2] ?? "");
  const col = Number(parts[3]);
  if (!game) {
    await interaction.reply({ content: "This Connect 4 game has ended or no longer exists.", ephemeral: true });
    return;
  }
  const symbol: C4Player | null =
    interaction.user.id === game.playerR ? "R" : interaction.user.id === game.playerY ? "Y" : null;
  if (!symbol) {
    await interaction.reply({ content: "Only the two players in this game can click.", ephemeral: true });
    return;
  }
  if (game.status !== "active") {
    await interaction.reply({ content: "This game is already over.", ephemeral: true });
    return;
  }
  if (game.turn !== symbol) {
    await interaction.reply({ content: "It's not your turn yet.", ephemeral: true });
    return;
  }
  const dropped = c4Drop(game.board, col, symbol);
  if (!dropped) {
    await interaction.reply({ content: "That column is full — pick another one.", ephemeral: true });
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
  await interaction.update({ embeds: [c4Embed(game)], components: c4Components(game) });
}

// ---------------------------------------------------------------------------
// Rock-paper-scissors
// ---------------------------------------------------------------------------

function rpsEmbed(game: RpsGame): EmbedBuilder {
  if (game.status === "done") {
    const a = game.picks[game.challengerId]!;
    const b = game.picks[game.opponentId]!;
    const result =
      game.winnerId === null
        ? "It's a draw! 🤝"
        : game.winnerId === game.challengerId
          ? `${emoji("trophy")} <@${game.challengerId}> wins!`
          : `${emoji("trophy")} <@${game.opponentId}> wins!`;
    return selenaEmbed(
      `Rock Paper Scissors — ${game.challengerName} vs ${game.opponentName}`,
      `<@${game.challengerId}> played ${rpsEmoji(a)} **${a}**\n<@${game.opponentId}> played ${rpsEmoji(b)} **${b}**\n\n${result}`,
    );
  }
  const pickedChallenger = !!game.picks[game.challengerId];
  const pickedOpponent = !!game.picks[game.opponentId];
  const waiting = pickedChallenger
    ? `Waiting for <@${game.opponentId}> to pick…`
    : pickedOpponent
      ? `Waiting for <@${game.challengerId}> to pick…`
      : "Both players pick — challenger first, then the opponent.";
  return selenaEmbed(
    `Rock Paper Scissors — ${game.challengerName} vs ${game.opponentName}`,
    `🪨 Rock • 📄 Paper • ✂️ Scissors — best of 1.\n\n${waiting}`,
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

async function handleRps(interaction: any, _ctx: CommandContext): Promise<void> {
  const parts = String(interaction.customId).split(":");
  const game = rpsGames.get(parts[2] ?? "");
  const choice = parts[3] as RpsChoice;
  if (!game) {
    await interaction.reply({ content: "This rock-paper-scissors game has ended or no longer exists.", ephemeral: true });
    return;
  }
  if (!["rock", "paper", "scissors"].includes(choice)) {
    await interaction.reply({ content: "Invalid choice.", ephemeral: true });
    return;
  }
  if (game.status !== "active") {
    await interaction.reply({ content: "This game is already over.", ephemeral: true });
    return;
  }
  const isPlayer = interaction.user.id === game.challengerId || interaction.user.id === game.opponentId;
  if (!isPlayer) {
    await interaction.reply({ content: "Only the two players in this game can click.", ephemeral: true });
    return;
  }
  if (game.picks[interaction.user.id]) {
    await interaction.reply({ content: "You already picked — waiting for your opponent.", ephemeral: true });
    return;
  }
  game.picks[interaction.user.id] = choice;
  if (game.picks[game.challengerId] && game.picks[game.opponentId]) {
    const outcome = rpsOutcome(game.picks[game.challengerId]!, game.picks[game.opponentId]!);
    game.status = "done";
    game.winnerId = outcome === "draw" ? null : outcome === "win" ? game.challengerId : game.opponentId;
  }
  await interaction.update({ embeds: [rpsEmbed(game)], components: rpsComponents(game) });
}

// ---------------------------------------------------------------------------
// Trivia
// ---------------------------------------------------------------------------

function triviaEmbed(game: TriviaGame, reveal: boolean, pickedIndex?: number): EmbedBuilder {
  const q = game.question;
  const lines = q.options.map((opt, i) => {
    const letter = String.fromCharCode(65 + i);
    let marker = "";
    if (reveal) {
      if (i === q.answerIndex) marker = " ✅";
      else if (i === pickedIndex) marker = " ❌";
    }
    return `**${letter}.** ${opt}${marker}`;
  });
  const footer = reveal
    ? game.answeredBy
      ? `Answered by <@${game.answeredBy}>. Correct answer: ${String.fromCharCode(65 + q.answerIndex)}.`
      : `Correct answer: ${String.fromCharCode(65 + q.answerIndex)}.`
    : `You have ${TRIVIA_TIME_LIMIT_MS / 1000} seconds — first answer counts! Worth ${TRIVIA_POINTS} points.`;
  return selenaEmbed(`🧠 Trivia`, `${q.question}\n\n${lines.join("\n")}\n\n${footer}`);
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

async function handleTrivia(interaction: any, ctx: CommandContext): Promise<void> {
  const parts = String(interaction.customId).split(":");
  const game = triviaGames.get(parts[2] ?? "");
  const idx = Number(parts[3]);
  if (!game) {
    await interaction.reply({ content: "This trivia question has expired.", ephemeral: true });
    return;
  }
  if (Date.now() > game.expiresAt) {
    triviaGames.delete(game.id);
    await interaction.reply({ content: "Time's up! This trivia question has expired.", ephemeral: true });
    return;
  }
  if (game.answeredBy) {
    await interaction.reply({ content: "This question was already answered.", ephemeral: true });
    return;
  }
  if (!Number.isInteger(idx) || idx < 0 || idx > 3) {
    await interaction.reply({ content: "Invalid answer.", ephemeral: true });
    return;
  }
  const correct = isTriviaAnswerCorrect(game.question, idx);
  game.answeredBy = interaction.user.id;
  if (correct) {
    await awardPoints(ctx.db, ctx.guildId, interaction.user.id, TRIVIA_POINTS, "trivia");
  }
  const embed = triviaEmbed(game, true, idx).setDescription(
    `${game.question.question}\n\n${game.question.options
      .map((opt, i) => {
        const letter = String.fromCharCode(65 + i);
        const marker = i === game.question.answerIndex ? " ✅" : i === idx ? " ❌" : "";
        return `**${letter}.** ${opt}${marker}`;
      })
      .join("\n")}\n\n${
      correct
        ? `${emoji("party")} <@${interaction.user.id}> got it right and earned **${TRIVIA_POINTS} points**!`
        : `❌ <@${interaction.user.id}> got it wrong. The correct answer was **${String.fromCharCode(65 + game.question.answerIndex)}**.`
    }`,
  );
  await interaction.update({ embeds: [embed], components: triviaComponentsFor(game, true) });
}

// ---------------------------------------------------------------------------
// Giveaway
// ---------------------------------------------------------------------------

async function handleGiveaway(interaction: any, ctx: CommandContext): Promise<void> {
  const parts = String(interaction.customId).split(":");
  const giveawayId = Number(parts[3]);
  if (!Number.isInteger(giveawayId)) {
    await interaction.reply({ content: "Invalid giveaway.", ephemeral: true });
    return;
  }
  const row = await ctx.db
    .prepare("SELECT id, ended FROM giveaways WHERE id = ?")
    .get(giveawayId) as { id: number; ended: number } | undefined;
  if (!row) {
    await interaction.reply({ content: "That giveaway no longer exists.", ephemeral: true });
    return;
  }
  if (row.ended) {
    await interaction.reply({ content: "That giveaway has already ended.", ephemeral: true });
    return;
  }
  const res = await ctx.db
    .prepare("INSERT OR IGNORE INTO giveaway_entries (giveaway_id, user_id) VALUES (?, ?)")
    .run(giveawayId, interaction.user.id);
  if (res.changes === 0) {
    await interaction.reply({ content: "You're already entered in this giveaway. " + emoji("party"), ephemeral: true });
    return;
  }
  await interaction.reply({ content: "You're in! Good luck. " + emoji("party"), ephemeral: true });
}

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

function pollEmbed(question: string, options: string[], counts: number[]): EmbedBuilder {
  const total = counts.reduce((s, c) => s + c, 0);
  const lines = options.map((opt, i) => {
    const count = counts[i] ?? 0;
    const pct = total === 0 ? 0 : Math.round((count / total) * 100);
    const bar = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
    return `**${i + 1}. ${opt}** — ${count} vote${count === 1 ? "" : "s"} (${pct}%)\n${bar}`;
  });
  return selenaEmbed(
    `📊 ${question}`,
    `${lines.join("\n\n")}\n\n*${total} total vote${total === 1 ? "" : "s"} — click a button to vote (one vote per person, click again to change it).*`,
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

async function handlePoll(interaction: any, ctx: CommandContext): Promise<void> {
  const parts = String(interaction.customId).split(":");
  const pollId = Number(parts[2]);
  const idx = Number(parts[3]);
  const row = await ctx.db
    .prepare("SELECT id, question, options_json FROM polls WHERE id = ?")
    .get(pollId) as { id: number; question: string; options_json: string } | undefined;
  if (!row) {
    await interaction.reply({ content: "That poll no longer exists.", ephemeral: true });
    return;
  }
  let options: string[];
  try {
    options = JSON.parse(row.options_json) as string[];
  } catch {
    await interaction.reply({ content: "That poll is broken (bad options data).", ephemeral: true });
    return;
  }
  if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) {
    await interaction.reply({ content: "Invalid poll option.", ephemeral: true });
    return;
  }
  await recordPollVote(ctx.db, pollId, interaction.user.id, idx);
  const counts = await getPollCounts(ctx.db, pollId, options.length);
  await interaction.update({ embeds: [pollEmbed(row.question, options, counts)], components: pollComponents(pollId, options, counts) });
}

export const buttonHandlers: Record<string, (interaction: any, ctx: CommandContext) => Promise<void>> = {
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

function requireOpponent(interaction: AnyInteraction): { id: string; username: string } | null {
  return interaction.options.getUser("opponent");
}

/**
 * Build a SlashCommandBuilder with statement-style calls. Chaining
 * .add*Option() narrows the type to SlashCommandOptionsOnlyBuilder, which
 * the scaffold's Command interface (data: SlashCommandBuilder) rejects;
 * calling the adders as statements keeps the wide SlashCommandBuilder type.
 */
function slash(
  name: string,
  description: string,
  configure?: (b: SlashCommandBuilder) => void,
): SlashCommandBuilder {
  const b = new SlashCommandBuilder();
  b.setName(name);
  b.setDescription(description);
  configure?.(b);
  return b;
}

export const commands: Command[] = [
  {
    data: slash("tictactoe", "Challenge a member to tic-tac-toe.", (b) => {
      b.addUserOption((o) => o.setName("opponent").setDescription("Who to play against").setRequired(true));
    }),
    async execute(interaction, _ctx) {
      const opponent = requireOpponent(interaction);
      if (!opponent) {
        await replyError(interaction, "Pick an opponent to play against!");
        return;
      }
      if (opponent.id === interaction.user.id) {
        await replyError(interaction, "You can't play tic-tac-toe against yourself!");
        return;
      }
      const game: TttGame = {
        id: newGameId("ttt"),
        guildId: interaction.guildId ?? "",
        playerX: interaction.user.id,
        playerO: opponent.id,
        playerXName: interaction.user.username,
        playerOName: opponent.username,
        board: emptyTttBoard(),
        turn: "X",
        status: "active",
      };
      tttGames.set(game.id, game);
      await interaction.reply({ embeds: [tttEmbed(game)], components: tttComponents(game) });
    },
  },
  {
    data: slash("connect4", "Challenge a member to Connect 4.", (b) => {
      b.addUserOption((o) => o.setName("opponent").setDescription("Who to play against").setRequired(true));
    }),
    async execute(interaction, _ctx) {
      const opponent = requireOpponent(interaction);
      if (!opponent) {
        await replyError(interaction, "Pick an opponent to play against!");
        return;
      }
      if (opponent.id === interaction.user.id) {
        await replyError(interaction, "You can't play Connect 4 against yourself!");
        return;
      }
      const game: C4Game = {
        id: newGameId("c4"),
        guildId: interaction.guildId ?? "",
        playerR: interaction.user.id,
        playerY: opponent.id,
        playerRName: interaction.user.username,
        playerYName: opponent.username,
        board: emptyC4Board(),
        turn: "R",
        status: "active",
      };
      c4Games.set(game.id, game);
      await interaction.reply({ embeds: [c4Embed(game)], components: c4Components(game) });
    },
  },
  {
    data: slash("rps", "Challenge a member to rock-paper-scissors (best of 1).", (b) => {
      b.addUserOption((o) => o.setName("opponent").setDescription("Who to play against").setRequired(true));
    }),
    async execute(interaction, _ctx) {
      const opponent = requireOpponent(interaction);
      if (!opponent) {
        await replyError(interaction, "Pick an opponent to play against!");
        return;
      }
      if (opponent.id === interaction.user.id) {
        await replyError(interaction, "You can't play rock-paper-scissors against yourself!");
        return;
      }
      const game: RpsGame = {
        id: newGameId("rps"),
        guildId: interaction.guildId ?? "",
        challengerId: interaction.user.id,
        opponentId: opponent.id,
        challengerName: interaction.user.username,
        opponentName: opponent.username,
        picks: {},
        status: "active",
      };
      rpsGames.set(game.id, game);
      await interaction.reply({ embeds: [rpsEmbed(game)], components: rpsComponents(game) });
    },
  },
  {
    data: slash("trivia", "Answer a timed trivia question — first correct answer earns points.", (b) => {
      b.addStringOption((o) =>
        o
          .setName("category")
          .setDescription("Question category (random if omitted)")
          .setRequired(false)
          .addChoices(
            { name: "MLBB", value: "mlbb" },
            { name: "General", value: "general" },
          ),
      );
    }),
    async execute(interaction, _ctx) {
      const category = interaction.options.getString("category");
      if (category !== null && category !== "mlbb" && category !== "general") {
        await replyError(interaction, 'Category must be "mlbb" or "general".');
        return;
      }
      const picked: TriviaCategory = (category as TriviaCategory | null) ?? (Math.random() < 0.5 ? "mlbb" : "general");
      const question = pickTriviaQuestion(picked);
      const game: TriviaGame = {
        id: newGameId("triv"),
        guildId: interaction.guildId ?? "",
        question,
        answeredBy: null,
        expiresAt: Date.now() + TRIVIA_TIME_LIMIT_MS,
      };
      triviaGames.set(game.id, game);
      await interaction.reply({ embeds: [triviaEmbed(game, false)], components: triviaComponentsFor(game, false) });
    },
  },
  {
    data: slash("wordchain", "Play word chain: each word must start with the last letter of the previous word.", (b) => {
      b.addStringOption((o) =>
        o.setName("word").setDescription("Your word (omit to start a new game)").setRequired(false),
      );
    }),
    async execute(interaction, _ctx) {
      const guildId = interaction.guildId ?? "";
      const word = interaction.options.getString("word");
      if (!word) {
        if (wordChainGames.has(guildId)) {
          await replyError(
            interaction,
            "A word chain is already running in this server — play it with /wordchain word:<your word>.",
          );
          return;
        }
        wordChainGames.set(guildId, createWordChain());
        await interaction.reply({
          embeds: [
            selenaEmbed(
              "🔗 Word Chain",
              "A new word chain has started!\n\n**Rules:** each word must be at least 3 letters, letters only, start with the last letter of the previous word, and never repeat a word.\n\nPlay with `/wordchain word:<your word>` — any word can start the chain.",
            ),
          ],
        });
        return;
      }
      const state = wordChainGames.get(guildId);
      if (!state) {
        await replyError(interaction, "No word chain is running — start one with /wordchain first.");
        return;
      }
      const result = submitWord(state, word);
      if (!result.ok) {
        await replyError(interaction, result.reason ?? "That word doesn't work.");
        return;
      }
      wordChainGames.set(guildId, result.state);
      await interaction.reply({
        embeds: [
          selenaEmbed(
            "🔗 Word Chain",
            `**${interaction.user.username}** played **${word.trim().toLowerCase()}**.\n\n` +
              `Next word must start with **${result.state.currentLetter!.toUpperCase()}**.\n` +
              `Chain length: ${result.state.moves} word${result.state.moves === 1 ? "" : "s"}.`,
          ),
        ],
      });
    },
  },
  {
    data: slash("guesshero", "Guess the MLBB hero from a clue. You get 3 attempts.", (b) => {
      b.addStringOption((o) =>
        o.setName("guess").setDescription("Your hero guess (omit to start a round)").setRequired(false),
      );
    }),
    async execute(interaction, ctx) {
      const guildId = interaction.guildId ?? "";
      const key = `${guildId}:${interaction.user.id}`;
      const guess = interaction.options.getString("guess");
      if (!guess) {
        const hero = pickGuessHero();
        guessHeroRounds.set(key, { guildId, userId: interaction.user.id, hero, attemptsLeft: 3, startedAt: Date.now() });
        await interaction.reply({
          embeds: [
            selenaEmbed(
              "🦸 Guess the Hero",
              `**Role:** ${hero.role}\n**Lane:** ${hero.lane}\n**Clue:** ${hero.clue}\n\n` +
                `You have **3 attempts**. Guess with \`/guesshero guess:<hero name>\`. ` +
                `A correct guess earns **${GUESS_HERO_POINTS} points**.`,
            ),
          ],
        });
        return;
      }
      const round = guessHeroRounds.get(key);
      if (!round) {
        await replyError(interaction, "No round is running for you — start one with /guesshero first.");
        return;
      }
      if (checkGuess(round.hero, guess)) {
        guessHeroRounds.delete(key);
        await awardPoints(ctx.db, guildId, interaction.user.id, GUESS_HERO_POINTS, "guesshero");
        await interaction.reply({
          embeds: [
            selenaEmbed(
              emoji("party") + " Correct!",
              `It was **${round.hero.hero}**! <@${interaction.user.id}> earned **${GUESS_HERO_POINTS} points**.`,
            ),
          ],
        });
        return;
      }
      round.attemptsLeft -= 1;
      if (round.attemptsLeft <= 0) {
        guessHeroRounds.delete(key);
        await interaction.reply({
          embeds: [
            selenaEmbed(
              "😢 Out of attempts!",
              `The hero was **${round.hero.hero}** (${round.hero.role}, ${round.hero.lane}). Better luck next time — start a new round with /guesshero.`,
            ),
          ],
        });
        return;
      }
      await interaction.reply({
        embeds: [
          selenaEmbed(
            "❌ Not quite!",
            `"${guess.trim()}" isn't the hero. You have **${round.attemptsLeft}** attempt${round.attemptsLeft === 1 ? "" : "s"} left.`,
          ),
        ],
      });
    },
  },
  {
    data: slash("giveaway", "Start a giveaway. Winners are drawn automatically when it ends.", (b) => {
      b.addStringOption((o) => o.setName("prize").setDescription("What the winners get").setRequired(true));
      b.addIntegerOption((o) =>
        o.setName("duration").setDescription("Duration in minutes (1–10080)").setRequired(true).setMinValue(1).setMaxValue(10080),
      );
      b.addIntegerOption((o) =>
        o.setName("winners").setDescription("Number of winners (1–10)").setRequired(true).setMinValue(1).setMaxValue(10),
      );
    }),
    async execute(interaction, ctx) {
      const prize = interaction.options.getString("prize");
      const duration = interaction.options.getInteger("duration");
      const winners = interaction.options.getInteger("winners");
      if (!prize?.trim()) {
        await replyError(interaction, "Tell me what the prize is!");
        return;
      }
      if (prize.trim().length > 200) {
        await replyError(interaction, "The prize description is too long (max 200 characters).");
        return;
      }
      if (duration === null || duration < 1 || duration > 10080) {
        await replyError(interaction, "Duration must be between 1 and 10080 minutes.");
        return;
      }
      if (winners === null || winners < 1 || winners > 10) {
        await replyError(interaction, "Winners must be between 1 and 10.");
        return;
      }
      const endsAt = Date.now() + duration * 60_000;
      const res = await ctx.db
        .prepare(
          "INSERT INTO giveaways (guild_id, channel_id, message_id, prize, ends_at, winners_count, ended, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
        )
        .run(ctx.guildId, "", null, prize.trim(), endsAt, winners, interaction.user.id, Date.now());
      const giveawayId = Number(res.lastInsertRowid);
      const endsIn = duration >= 60 ? `${(duration / 60).toFixed(1)} hours` : `${duration} minutes`;
      const button = new ButtonBuilder()
        .setCustomId(`selena:giveaway:join:${giveawayId}`)
        .setLabel("🎉 Enter Giveaway")
        .setStyle(ButtonStyle.Success);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);
      await interaction.reply({
        embeds: [
          selenaEmbed(
            emoji("party") + " Giveaway!",
            `**Prize:** ${prize.trim()}\n**Winners:** ${fmt(winners)}\n**Ends in:** ${endsIn}\n\nClick the button below to enter! Winners are drawn automatically when the giveaway ends.`,
          ).setFooter({ text: `Giveaway #${giveawayId}` }),
        ],
        components: [row],
      });
    },
  },
  {
    data: slash("poll", "Start a button poll — one vote per person, click again to change it.", (b) => {
      b.addStringOption((o) => o.setName("question").setDescription("The poll question").setRequired(true));
      b.addStringOption((o) => o.setName("option1").setDescription("First option").setRequired(true));
      b.addStringOption((o) => o.setName("option2").setDescription("Second option").setRequired(true));
      b.addStringOption((o) => o.setName("option3").setDescription("Third option (optional)").setRequired(false));
      b.addStringOption((o) => o.setName("option4").setDescription("Fourth option (optional)").setRequired(false));
    }),
    async execute(interaction, ctx) {
      const question = interaction.options.getString("question");
      const rawOptions = [
        interaction.options.getString("option1"),
        interaction.options.getString("option2"),
        interaction.options.getString("option3"),
        interaction.options.getString("option4"),
      ];
      if (!question?.trim()) {
        await replyError(interaction, "Ask a question for the poll!");
        return;
      }
      const options = rawOptions.filter((o): o is string => !!o?.trim()).map((o) => o.trim());
      if (options.length < 2) {
        await replyError(interaction, "A poll needs at least two options.");
        return;
      }
      if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) {
        await replyError(interaction, "Poll options must all be different.");
        return;
      }
      const res = await ctx.db
        .prepare(
          "INSERT INTO polls (guild_id, channel_id, message_id, question, options_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(ctx.guildId, "", null, question.trim(), JSON.stringify(options), interaction.user.id, Date.now());
      const pollId = Number(res.lastInsertRowid);
      const counts = Array<number>(options.length).fill(0);
      await interaction.reply({
        embeds: [pollEmbed(question.trim(), options, counts)],
        components: pollComponents(pollId, options, counts),
      });
    },
  },
];
