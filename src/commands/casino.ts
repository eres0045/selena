import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  type APIEmbed,
} from "discord.js";
import type { Command, CommandContext } from "../lib/command.js";
import { errorEmbed, fmt, pointsEmbed } from "../lib/command.js";
import { getBalance } from "../lib/economy.js";
import { CARD_SUITS } from "../lib/cards.js";
import { composeHandStrip, type StripCard } from "../lib/handstrip.js";
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
  highLowRankName,
  isBlackjack,
  isValidRouletteBet,
  placeBet,
  randomSuit,
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

function bjButtons(gameId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`selena:bj:${gameId}:hit`).setLabel("Hit").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`selena:bj:${gameId}:stand`).setLabel("Stand").setStyle(ButtonStyle.Success),
  );
}

/**
 * OwO-style embed colours: blue while the game is live, green on a win
 * (including a natural blackjack), red on a loss, gray on a push.
 */
export type BjOutcome = "playing" | "win" | "lose" | "push" | "blackjack";

export const BJ_COLORS: Record<BjOutcome, number> = {
  playing: 0x5865f2,
  win: 0x2ecc71,
  lose: 0xe74c3c,
  push: 0x95a5a6,
  blackjack: 0x2ecc71,
};

/** Settle outcome (lib/casino.ts) -> embed outcome colour. */
export function bjOutcomeOf(settled: { outcome: string }): BjOutcome {
  if (settled.outcome === "player_blackjack") return "blackjack";
  if (settled.outcome === "win") return "win";
  if (settled.outcome === "push") return "push";
  return "lose";
}

/**
 * The blackjack embed carries NO description and NO fields: embed text
 * always renders ABOVE the image and reads badly. The hands — with their
 * labels and totals — live in the strip image itself, and the bet/result
 * line lives in the FOOTER (below the image).
 */
function bjEmbed(
  game: BlackjackGame,
  opts: { over: boolean; outcome: BjOutcome; footerLine: string },
  balance: number,
): ReturnType<typeof pointsEmbed> {
  const title = opts.over ? "🃏 Blackjack — Finished" : "🃏 Blackjack";
  return pointsEmbed(title, "")
    .setColor(BJ_COLORS[opts.outcome])
    .setFooter({
      text: `Bet ${fmt(game.bet)} · ${opts.footerLine} · Balance ${fmt(balance)} points`,
    });
}

/**
 * One compact OwO-style embed for a blackjack game state: a single small
 * strip image (dealer row on top, player row below, ~50px per card,
 * ~280px-wide file, transparent background) with the newly dealt cards
 * flipping — each row labelled in-image ("DEALER 17" / "YOU 15", "?" for
 * the dealer's total while the hole card is hidden). The dealer's hole
 * card stays face-down until the hand is over. When a card has no
 * rendered flip GIF (or a label no sprite) the strip cannot be built
 * and the reply falls back to the text-only embed.
 */
async function bjReplyPayload(
  game: BlackjackGame,
  opts: { over: boolean; outcome: BjOutcome; footerLine: string },
  ctx: CommandContext,
): Promise<{
  embeds: APIEmbed[];
  files: AttachmentBuilder[];
}> {
  const balance = (await getBalance(ctx.db, game.guildId, game.userId)).points;
  const embed = bjEmbed(game, opts, balance);
  const player = blackjackValue(game.playerHand);
  const dealer = blackjackValue(game.dealerHand);
  const freshDeal = !opts.over && game.playerHand.length === 2;
  const dealerRow: StripCard[] = game.dealerHand.map((code, i) => ({
    code,
    faceDown: !opts.over && i === 1,
    animate: !opts.over && i === 0 && freshDeal,
  }));
  const playerRow: StripCard[] = game.playerHand.map((code, i) => ({
    code,
    animate: !opts.over && (freshDeal || i === game.playerHand.length - 1),
  }));
  const strip = await composeHandStrip(
    [dealerRow, playerRow],
    [
      { title: "DEALER", value: opts.over ? String(dealer) : "?" },
      { title: "YOU", value: String(player) },
    ],
  );
  if (!strip) return { embeds: [embed.toJSON()], files: [] };
  embed.setImage("attachment://hand.gif");
  return {
    embeds: [embed.toJSON()],
    files: [new AttachmentBuilder(strip.buffer, { name: "hand.gif" })],
  };
}

/**
 * Explicit balance pre-check (defense in depth behind the atomic placeBet
 * below): a bet can never exceed the balance, and the error names the
 * balance so the player sees why. Runs before any defer, so the error
 * stays ephemeral.
 */
async function checkBalance(
  interaction: Interaction,
  ctx: CommandContext,
  bet: number,
): Promise<boolean> {
  const balance = (await getBalance(ctx.db, ctx.guildId, interaction.user.id)).points;
  if (bet > balance) {
    await replyError(
      interaction,
      `Insufficient points. You have ${fmt(balance)} points, but bet ${fmt(bet)}.`,
    );
    return false;
  }
  return true;
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
      const placed = await placeBet(ctx.db, ctx.guildId, interaction.user.id, bet, "slots");
      if (!placed.ok) {
        await replyError(interaction, placed.error ?? "Could not place that bet.");
        return;
      }
      const spin = slotsSpin(secureFloat);
      const winAmount = bet * spin.multiplier;
      if (winAmount > 0) await creditWin(ctx.db, ctx.guildId, interaction.user.id, winAmount, "slots win");
      const balance = (await getBalance(ctx.db, ctx.guildId, interaction.user.id)).points;
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
      if (!(await checkBalance(interaction, ctx, bet))) return;
      const placed = await placeBet(ctx.db, ctx.guildId, interaction.user.id, bet, "blackjack");
      if (!placed.ok) {
        await replyError(interaction, placed.error ?? "Could not place that bet.");
        return;
      }
      // Acknowledge immediately so the reply never waits on a slow container.
      await interaction.deferReply();
      const game = createBlackjackGame(ctx.guildId, interaction.user.id, bet);
      // Natural blackjack settles immediately — no buttons needed.
      if (isBlackjack(game.playerHand)) {
        const settled = settleBlackjack(game.playerHand, game.dealerHand);
        const winAmount = Math.floor(bet * settled.multiplier);
        if (winAmount > 0) await creditWin(ctx.db, ctx.guildId, interaction.user.id, winAmount, "blackjack win");
        endBlackjackGame(game.id);
        const footerLine =
          settled.outcome === "player_blackjack"
            ? `🎉 Blackjack! You won ${fmt(winAmount)} points (3:2).`
            : `Both you and the dealer have blackjack — push, your ${fmt(bet)} points are returned.`;
        await interaction.editReply(
          await bjReplyPayload(game, { over: true, outcome: bjOutcomeOf(settled), footerLine }, ctx),
        );
        return;
      }
      const replyMsg = (await interaction.editReply({
        ...(await bjReplyPayload(game, { over: false, outcome: "playing", footerLine: "Hit or Stand?" }, ctx)),
        components: [bjButtons(game.id)],
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
      const placed = await placeBet(ctx.db, ctx.guildId, interaction.user.id, bet, "roulette");
      if (!placed.ok) {
        await replyError(interaction, placed.error ?? "Could not place that bet.");
        return;
      }
      const result = rouletteOutcome(betOn, rouletteRoll());
      const winAmount = bet * result.multiplier;
      if (winAmount > 0) await creditWin(ctx.db, ctx.guildId, interaction.user.id, winAmount, "roulette win");
      const balance = (await getBalance(ctx.db, ctx.guildId, interaction.user.id)).points;
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
      const placed = await placeBet(ctx.db, ctx.guildId, interaction.user.id, bet, "coinflip");
      if (!placed.ok) {
        await replyError(interaction, placed.error ?? "Could not place that bet.");
        return;
      }
      const result = coinflipOutcome(guess, secureFloat());
      const winAmount = Math.floor(bet * result.multiplier);
      if (winAmount > 0) await creditWin(ctx.db, ctx.guildId, interaction.user.id, winAmount, "coinflip win");
      const balance = (await getBalance(ctx.db, ctx.guildId, interaction.user.id)).points;
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
      if (!(await checkBalance(interaction, ctx, bet))) return;
      const placed = await placeBet(ctx.db, ctx.guildId, interaction.user.id, bet, "highlow");
      if (!placed.ok) {
        await replyError(interaction, placed.error ?? "Could not place that bet.");
        return;
      }
      // Acknowledge immediately so the reply never waits on a slow container.
      await interaction.deferReply();
      // Guess is locked in before any card is revealed, so extreme first
      // cards cannot be exploited (see lib/casino.ts edge notes).
      const card = drawCard();
      const next = drawCard();
      const result = highlowOutcome(card, guess, next);
      const winAmount = Math.floor(bet * result.multiplier);
      if (winAmount > 0) await creditWin(ctx.db, ctx.guildId, interaction.user.id, winAmount, "highlow win");
      const balance = (await getBalance(ctx.db, ctx.guildId, interaction.user.id)).points;
      const outcome =
        result.outcome === "win"
          ? `You won ${fmt(winAmount)} points (1.9x)!`
          : result.outcome === "push"
            ? `Tie — your ${fmt(bet)} points are returned.`
            : "Wrong guess — you lost this round.";
      // Display suits are random (the draw is rank-only); the two codes
      // must differ so the same physical card never shows twice.
      const cardSuit = randomSuit();
      let nextSuit = randomSuit();
      if (next === card && nextSuit === cardSuit) {
        nextSuit = CARD_SUITS[(CARD_SUITS.indexOf(nextSuit) + 1) % CARD_SUITS.length] as (typeof CARD_SUITS)[number];
      }
      const cardCode = `${highLowRankName(card)}${cardSuit}`;
      const nextCode = `${highLowRankName(next)}${nextSuit}`;
      // One compact embed: no description above the image (it reads
      // badly) — the two cards are labelled in-image ("FIRST 12" /
      // "NEXT 10", two rows so each card has its own label) and the
      // bet/guess/result line sits in the footer, below the image.
      // Outcome colours match OwO: green on a win, red on a loss, gray
      // on a push.
      const hlColor =
        result.outcome === "win" ? BJ_COLORS.win : result.outcome === "push" ? BJ_COLORS.push : BJ_COLORS.lose;
      const embed = pointsEmbed("🔼🔽 High / Low", "")
        .setColor(hlColor)
        .setFooter({
          text: `Bet ${fmt(bet)} · You guessed ${guess} · ${outcome} · Balance ${fmt(balance)} points`,
        });
      const strip = await composeHandStrip(
        [[{ code: cardCode }], [{ code: nextCode, animate: true }]],
        [
          { title: "FIRST", value: String(card) },
          { title: "NEXT", value: String(next) },
        ],
      );
      const files: AttachmentBuilder[] = [];
      if (strip) {
        embed.setImage("attachment://hand.gif");
        files.push(new AttachmentBuilder(strip.buffer, { name: "hand.gif" }));
      }
      await interaction.editReply({ embeds: [embed.toJSON()], files });
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
      const placed = await placeBet(ctx.db, ctx.guildId, interaction.user.id, bet, "scratch");
      if (!placed.ok) {
        await replyError(interaction, placed.error ?? "Could not place that bet.");
        return;
      }
      const result = scratchDraw(secureFloat);
      const winAmount = bet * result.multiplier;
      if (winAmount > 0) await creditWin(ctx.db, ctx.guildId, interaction.user.id, winAmount, "scratch win");
      const balance = (await getBalance(ctx.db, ctx.guildId, interaction.user.id)).points;
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

  // Acknowledge immediately: composing the strip image takes a moment and
  // the button ack must not wait on it.
  await interaction.deferUpdate();

  const settleAndShow = async (note: string): Promise<void> => {
    const settled = settleBlackjack(game.playerHand, game.dealerHand);
    const winAmount = Math.floor(game.bet * settled.multiplier);
    if (winAmount > 0) await creditWin(ctx.db, ctx.guildId, game.userId, winAmount, "blackjack win");
    endBlackjackGame(game.id);
    const resultNote =
      settled.outcome === "player_blackjack"
        ? `🎉 Blackjack! You won ${fmt(winAmount)} points (3:2).`
        : settled.outcome === "win"
          ? `You won ${fmt(winAmount)} points!`
          : settled.outcome === "push"
            ? `Push — your ${fmt(game.bet)} points are returned.`
            : `You lost ${fmt(game.bet)} points.`;
    await interaction.editReply({
      ...(await bjReplyPayload(
        game,
        {
          over: true,
          outcome: bjOutcomeOf(settled),
          footerLine: `${note} · ${resultNote}`,
        },
        ctx,
      )),
      components: [],
    });
  };

  if (action === "hit") {
    const card = game.deck.pop();
    if (card) game.playerHand.push(card);
    if (blackjackValue(game.playerHand) > 21) {
      await settleAndShow("💥 Bust! You went over 21.");
      return;
    }
    if (blackjackValue(game.playerHand) === 21) {
      dealerPlay(game.deck, game.dealerHand);
      await settleAndShow("You hit 21 — the dealer plays out.");
      return;
    }
    await interaction.editReply({
      ...(await bjReplyPayload(game, { over: false, outcome: "playing", footerLine: "Hit or Stand?" }, ctx)),
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
