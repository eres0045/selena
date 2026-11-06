import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
} from "discord.js";
import type { Command, CommandContext } from "../lib/command.js";
import { errorEmbed, fmt, pointsEmbed } from "../lib/command.js";
import { getBalance } from "../lib/economy.js";
import {
  blackjackGames,
  blackjackValue,
  coinflipOutcome,
  createBlackjackGame,
  creditWin,
  dealerPlay,
  drawCard,
  endBlackjackGame,
  getBlackjackGame,
  highlowOutcome,
  isBlackjack,
  isValidRouletteBet,
  placeBet,
  rouletteOutcome,
  rouletteRoll,
  scratchDraw,
  settleBlackjack,
  slotsSpin,
  type BlackjackGame,
} from "../lib/casino.js";
import { secureFloat } from "../lib/rng.js";

type Interaction = Parameters<Command["execute"]>[0];

async function replyError(interaction: Interaction, message: string): Promise<void> {
  await interaction.reply({ embeds: [errorEmbed(message).toJSON()], ephemeral: true });
}

/**
 * Build a SlashCommandBuilder without chaining add*Option calls onto the
 * `data:` expression: chaining narrows the type to
 * SlashCommandOptionsOnlyBuilder, which is not assignable to the
 * SlashCommandBuilder type the Command interface requires.
 */
function buildCmd(name: string, description: string, configure: (b: SlashCommandBuilder) => void): SlashCommandBuilder {
  const b = new SlashCommandBuilder().setName(name).setDescription(description);
  configure(b);
  return b;
}

/** Read and validate the bet option; returns null after replying on bad input. */
async function readBet(interaction: Interaction): Promise<number | null> {
  const bet = interaction.options.getInteger("bet");
  if (bet === null || !Number.isInteger(bet) || bet <= 0) {
    await replyError(interaction, "Bet must be a positive whole number of points.");
    return null;
  }
  return bet;
}

function handText(hand: string[], hideSecond = false): string {
  if (hideSecond && hand.length > 1) return `${hand[0]} ❓ (${blackjackValue([hand[0] as string])}+?)`;
  return `${hand.join(" ")} (**${blackjackValue(hand)}**)`;
}

function bjButtons(gameId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`selena:bj:${gameId}:hit`).setLabel("Hit").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`selena:bj:${gameId}:stand`).setLabel("Stand").setStyle(ButtonStyle.Success),
  );
}

function bjEmbed(game: BlackjackGame, opts: { over: boolean; note?: string }): ReturnType<typeof pointsEmbed> {
  const player = blackjackValue(game.playerHand);
  const dealer = blackjackValue(game.dealerHand);
  const title = opts.over ? "🃏 Blackjack — Finished" : "🃏 Blackjack";
  const description =
    `**Your hand:** ${handText(game.playerHand)}\n` +
    `**Dealer:** ${opts.over ? handText(game.dealerHand) : handText(game.dealerHand, true)}\n` +
    (opts.note ? `\n${opts.note}` : "");
  return pointsEmbed(title, description).addFields(
    { name: "Bet", value: fmt(game.bet), inline: true },
    { name: "Your total", value: String(player), inline: true },
    { name: "Dealer total", value: opts.over ? String(dealer) : "?", inline: true },
  );
}

export const commands: Command[] = [
  {
    data: buildCmd(
      "slots",
      "Spin the 3-reel slot machine. Jackpot 7️⃣7️⃣7️⃣ pays 50x, any 3-of-a-kind 10x, a pair 2x.",
      (b) => {
        b.addIntegerOption((o) => o.setName("bet").setDescription("Points to bet").setRequired(true).setMinValue(1));
      },
    ),
    async execute(interaction, ctx) {
      const bet = await readBet(interaction);
      if (bet === null) return;
      const placed = placeBet(ctx.db, ctx.guildId, interaction.user.id, bet, "slots");
      if (!placed.ok) {
        await replyError(interaction, placed.error ?? "Could not place that bet.");
        return;
      }
      const spin = slotsSpin(secureFloat);
      const winAmount = bet * spin.multiplier;
      if (winAmount > 0) creditWin(ctx.db, ctx.guildId, interaction.user.id, winAmount, "slots win");
      const balance = getBalance(ctx.db, ctx.guildId, interaction.user.id).points;
      const outcome =
        spin.multiplier > 0
          ? `You won **${fmt(winAmount)} points** (${spin.multiplier}x)!`
          : "No match — better luck next spin.";
      await interaction.reply({
        embeds: [
          pointsEmbed("🎰 Slots", `${spin.symbols.join(" | ")}\n\n${outcome}`)
            .addFields(
              { name: "Bet", value: fmt(bet), inline: true },
              { name: "Multiplier", value: `${spin.multiplier}x`, inline: true },
              { name: "Balance", value: fmt(balance), inline: true },
            )
            .setFooter({ text: "Odds: jackpot 7️⃣7️⃣7️⃣ 50x · 3-of-a-kind 10x · pair 2x · house edge ~10.9%. Points only, no real money." })
            .toJSON(),
        ],
      });
    },
  },
  {
    data: buildCmd("blackjack", "Play blackjack against the dealer. Dealer stands on 17. Blackjack pays 3:2.", (b) => {
      b.addIntegerOption((o) => o.setName("bet").setDescription("Points to bet").setRequired(true).setMinValue(1));
    }),
    async execute(interaction, ctx) {
      const bet = await readBet(interaction);
      if (bet === null) return;
      const placed = placeBet(ctx.db, ctx.guildId, interaction.user.id, bet, "blackjack");
      if (!placed.ok) {
        await replyError(interaction, placed.error ?? "Could not place that bet.");
        return;
      }
      const game = createBlackjackGame(ctx.guildId, interaction.user.id, bet);
      // Natural blackjack settles immediately — no buttons needed.
      if (isBlackjack(game.playerHand)) {
        const settled = settleBlackjack(game.playerHand, game.dealerHand);
        const winAmount = Math.floor(bet * settled.multiplier);
        if (winAmount > 0) creditWin(ctx.db, ctx.guildId, interaction.user.id, winAmount, "blackjack win");
        endBlackjackGame(game.id);
        const note =
          settled.outcome === "player_blackjack"
            ? `🎉 **Blackjack!** You won **${fmt(winAmount)} points** (3:2).`
            : `Both you and the dealer have blackjack — push, your **${fmt(bet)} points** are returned.`;
        await interaction.reply({ embeds: [bjEmbed(game, { over: true, note }).toJSON()] });
        return;
      }
      const replyMsg = (await interaction.reply({
        embeds: [bjEmbed(game, { over: false, note: "Hit or Stand?" }).toJSON()],
        components: [bjButtons(game.id)],
        fetchReply: true,
      })) as unknown as { id?: string } | undefined;
      if (replyMsg && typeof replyMsg.id === "string") {
        game.messageId = replyMsg.id;
        blackjackGames.set(replyMsg.id, game);
      }
    },
  },
  {
    data: buildCmd(
      "roulette",
      "Bet on the European roulette wheel. Red/black/even/odd pay 2x, a single number pays 36x.",
      (b) => {
        b.addIntegerOption((o) => o.setName("bet").setDescription("Points to bet").setRequired(true).setMinValue(1));
        b.addStringOption((o) =>
          o.setName("bet-on").setDescription("red, black, even, odd, or a number 0-36").setRequired(true),
        );
      },
    ),
    async execute(interaction, ctx) {
      const bet = await readBet(interaction);
      if (bet === null) return;
      const betOn = interaction.options.getString("bet-on");
      if (!betOn || !isValidRouletteBet(betOn)) {
        await replyError(interaction, "Invalid bet. Bet on red, black, even, odd, or a single number 0-36.");
        return;
      }
      const placed = placeBet(ctx.db, ctx.guildId, interaction.user.id, bet, "roulette");
      if (!placed.ok) {
        await replyError(interaction, placed.error ?? "Could not place that bet.");
        return;
      }
      const result = rouletteOutcome(betOn, rouletteRoll());
      const winAmount = bet * result.multiplier;
      if (winAmount > 0) creditWin(ctx.db, ctx.guildId, interaction.user.id, winAmount, "roulette win");
      const balance = getBalance(ctx.db, ctx.guildId, interaction.user.id).points;
      const outcome = result.win
        ? `🎉 You won **${fmt(winAmount)} points** (${result.multiplier}x)!`
        : "You lost this spin.";
      await interaction.reply({
        embeds: [
          pointsEmbed("🎡 Roulette", `The ball landed on **${result.roll} ${result.color}**.\nYou bet on **${result.betOn}**.\n\n${outcome}`)
            .addFields(
              { name: "Bet", value: fmt(bet), inline: true },
              { name: "Multiplier", value: `${result.multiplier}x`, inline: true },
              { name: "Balance", value: fmt(balance), inline: true },
            )
            .setFooter({ text: "European wheel (single zero) · even-money 2x · single number 36x · house edge 2.70%. Points only, no real money." })
            .toJSON(),
        ],
      });
    },
  },
  {
    data: buildCmd("coinflip", "Flip a coin. Call it right and win 1.9x your bet.", (b) => {
      b.addIntegerOption((o) => o.setName("bet").setDescription("Points to bet").setRequired(true).setMinValue(1));
      b.addStringOption((o) =>
        o
          .setName("guess")
          .setDescription("Heads or tails")
          .setRequired(true)
          .addChoices({ name: "Heads", value: "heads" }, { name: "Tails", value: "tails" }),
      );
    }),
    async execute(interaction, ctx) {
      const bet = await readBet(interaction);
      if (bet === null) return;
      const guess = interaction.options.getString("guess");
      if (guess !== "heads" && guess !== "tails") {
        await replyError(interaction, "Guess must be heads or tails.");
        return;
      }
      const placed = placeBet(ctx.db, ctx.guildId, interaction.user.id, bet, "coinflip");
      if (!placed.ok) {
        await replyError(interaction, placed.error ?? "Could not place that bet.");
        return;
      }
      const result = coinflipOutcome(guess, secureFloat());
      const winAmount = Math.floor(bet * result.multiplier);
      if (winAmount > 0) creditWin(ctx.db, ctx.guildId, interaction.user.id, winAmount, "coinflip win");
      const balance = getBalance(ctx.db, ctx.guildId, interaction.user.id).points;
      const outcome = result.win
        ? `🎉 You won **${fmt(winAmount)} points** (1.9x)!`
        : "Wrong call — you lost this flip.";
      await interaction.reply({
        embeds: [
          pointsEmbed("🪙 Coinflip", `You called **${guess}**. The coin landed **${result.result}**.\n\n${outcome}`)
            .addFields(
              { name: "Bet", value: fmt(bet), inline: true },
              { name: "Balance", value: fmt(balance), inline: true },
            )
            .setFooter({ text: "50/50 flip · win pays 1.9x · house edge 5%. Points only, no real money." })
            .toJSON(),
        ],
      });
    },
  },
  {
    data: buildCmd(
      "highlow",
      "Guess whether the next card is higher or lower. Win pays 1.9x, a tie pushes your bet back.",
      (b) => {
        b.addIntegerOption((o) => o.setName("bet").setDescription("Points to bet").setRequired(true).setMinValue(1));
        b.addStringOption((o) =>
          o
            .setName("guess")
            .setDescription("Will the next card be higher or lower?")
            .setRequired(true)
            .addChoices({ name: "Higher", value: "higher" }, { name: "Lower", value: "lower" }),
        );
      },
    ),
    async execute(interaction, ctx) {
      const bet = await readBet(interaction);
      if (bet === null) return;
      const guess = interaction.options.getString("guess");
      if (guess !== "higher" && guess !== "lower") {
        await replyError(interaction, "Guess must be higher or lower.");
        return;
      }
      const placed = placeBet(ctx.db, ctx.guildId, interaction.user.id, bet, "highlow");
      if (!placed.ok) {
        await replyError(interaction, placed.error ?? "Could not place that bet.");
        return;
      }
      // Guess is locked in before any card is revealed, so extreme first
      // cards cannot be exploited (see lib/casino.ts edge notes).
      const card = drawCard();
      const next = drawCard();
      const result = highlowOutcome(card, guess, next);
      const winAmount = Math.floor(bet * result.multiplier);
      if (winAmount > 0) creditWin(ctx.db, ctx.guildId, interaction.user.id, winAmount, "highlow win");
      const balance = getBalance(ctx.db, ctx.guildId, interaction.user.id).points;
      const outcome =
        result.outcome === "win"
          ? `🎉 You won **${fmt(winAmount)} points** (1.9x)!`
          : result.outcome === "push"
            ? `Tie — your **${fmt(bet)} points** are returned.`
            : "Wrong guess — you lost this round.";
      await interaction.reply({
        embeds: [
          pointsEmbed(
            "🔼🔽 High / Low",
            `First card: **${card}** → next card: **${next}**\nYou guessed **${guess}**.\n\n${outcome}`,
          )
            .addFields(
              { name: "Bet", value: fmt(bet), inline: true },
              { name: "Balance", value: fmt(balance), inline: true },
            )
            .setFooter({ text: "Cards 1-13 · win pays 1.9x · tie pushes · house edge ~4.6%. Points only, no real money." })
            .toJSON(),
        ],
      });
    },
  },
  {
    data: buildCmd(
      "scratch",
      "Scratch a card: reveal 3 symbols. 3 matching pay 5x, 2 matching pay your bet back.",
      (b) => {
        b.addIntegerOption((o) => o.setName("bet").setDescription("Points to bet").setRequired(true).setMinValue(1));
      },
    ),
    async execute(interaction, ctx) {
      const bet = await readBet(interaction);
      if (bet === null) return;
      const placed = placeBet(ctx.db, ctx.guildId, interaction.user.id, bet, "scratch");
      if (!placed.ok) {
        await replyError(interaction, placed.error ?? "Could not place that bet.");
        return;
      }
      const result = scratchDraw(secureFloat);
      const winAmount = bet * result.multiplier;
      if (winAmount > 0) creditWin(ctx.db, ctx.guildId, interaction.user.id, winAmount, "scratch win");
      const balance = getBalance(ctx.db, ctx.guildId, interaction.user.id).points;
      const outcome =
        result.multiplier === 5
          ? `🎉 Three of a kind! You won **${fmt(winAmount)} points** (5x)!`
          : result.multiplier === 1
            ? `Two matching — your **${fmt(bet)} points** are returned.`
            : "No match — better luck next card.";
      await interaction.reply({
        embeds: [
          pointsEmbed("🎫 Scratch Card", `${result.symbols.join("  ")}\n\n${outcome}`)
            .addFields(
              { name: "Bet", value: fmt(bet), inline: true },
              { name: "Multiplier", value: `${result.multiplier}x`, inline: true },
              { name: "Balance", value: fmt(balance), inline: true },
            )
            .setFooter({ text: "Odds: 3 matching 5x · 2 matching 1x · house edge 12.5%. Points only, no real money." })
            .toJSON(),
        ],
      });
    },
  },
];

// ---------------------------------------------------------------------------
// Blackjack button flow (customId: selena:bj:<gameId>:hit|stand)
// ---------------------------------------------------------------------------

async function handleBlackjackButton(interaction: any, ctx: CommandContext): Promise<void> {
  const parts = String(interaction.customId ?? "").split(":");
  const gameId = parts[2] ?? "";
  const action = parts[3] ?? "";
  // Look up by game id from the customId; fall back to the message id key
  // (the game is also stored under its message id once the reply is known).
  const game: BlackjackGame | undefined =
    getBlackjackGame(gameId) ?? getBlackjackGame(interaction.message?.id ?? "");
  if (!game) {
    await interaction.reply({ content: "This blackjack game has expired or was already finished.", ephemeral: true });
    return;
  }
  if (interaction.user?.id !== game.userId) {
    await interaction.reply({ content: "Only the player who started this game can use these buttons.", ephemeral: true });
    return;
  }
  if (action !== "hit" && action !== "stand") {
    await interaction.reply({ content: "Unknown blackjack action.", ephemeral: true });
    return;
  }

  const settleAndShow = async (note: string): Promise<void> => {
    const settled = settleBlackjack(game.playerHand, game.dealerHand);
    const winAmount = Math.floor(game.bet * settled.multiplier);
    if (winAmount > 0) creditWin(ctx.db, ctx.guildId, game.userId, winAmount, "blackjack win");
    endBlackjackGame(game.id);
    const balance = getBalance(ctx.db, ctx.guildId, game.userId).points;
    const resultNote =
      settled.outcome === "player_blackjack"
        ? `🎉 **Blackjack!** You won **${fmt(winAmount)} points** (3:2).`
        : settled.outcome === "win"
          ? `🎉 You won **${fmt(winAmount)} points**!`
          : settled.outcome === "push"
            ? `Push — your **${fmt(game.bet)} points** are returned.`
            : `You lost **${fmt(game.bet)} points**.`;
    await interaction.update({
      embeds: [
        bjEmbed(game, { over: true, note: `${note}\n${resultNote}\nBalance: **${fmt(balance)} points**` }).toJSON(),
      ],
      components: [],
    });
  };

  if (action === "hit") {
    const card = game.deck.pop();
    if (card) game.playerHand.push(card);
    if (blackjackValue(game.playerHand) > 21) {
      await settleAndShow("💥 **Bust!** You went over 21.");
      return;
    }
    if (blackjackValue(game.playerHand) === 21) {
      dealerPlay(game.deck, game.dealerHand);
      await settleAndShow("You hit 21 — the dealer plays out.");
      return;
    }
    await interaction.update({
      embeds: [bjEmbed(game, { over: false, note: "Hit or Stand?" }).toJSON()],
      components: [bjButtons(game.id)],
    });
    return;
  }

  // Stand: dealer plays, then settle.
  dealerPlay(game.deck, game.dealerHand);
  await settleAndShow("You stood — the dealer plays out.");
}

export const buttonHandlers: Record<string, (interaction: any, ctx: CommandContext) => Promise<void>> = {
  "selena:bj": handleBlackjackButton,
};
