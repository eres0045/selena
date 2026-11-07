import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  type APIEmbed,
} from "discord.js";
import type { Command, CommandContext, CommandInvocation } from "../lib/command.js";
import { emoji } from "../lib/emoji.js";
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
import {
  VISUAL_SUSPENSE,
  coinflipFlipPath,
  coinflipLandedPath,
  composeCoinflipResult,
  composeRouletteResult,
  composeScratch,
  composeScratchResult,
  composeSlotsResult,
  composeSlotsSettled,
  rouletteSpinPath,
  rouletteWheelPath,
  sleep,
  slotsSpinPath,
  tryReadAsset,
} from "../lib/visualgames.js";

type Inv = CommandInvocation;

async function replyError(inv: Inv, message: string): Promise<void> {
  await inv.reply({ embeds: [errorEmbed(message).toJSON()], ephemeral: true });
}

/** Read and validate the bet option; returns null after replying on bad input. */
async function readBet(inv: Inv): Promise<number | null> {
  const bet = inv.options.getInteger("bet");
  if (bet === null || !Number.isInteger(bet) || bet <= 0) {
    await replyError(inv, "Bet must be a positive whole number of gold.");
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
      text: `Bet ${fmt(game.bet)} · ${opts.footerLine} · Balance ${fmt(balance)} gold`,
    });
}

/**
 * One compact OwO-style embed for a blackjack game state: a single small
 * strip image (dealer row on top, player row below, ~100px per card,
 * ~700px-wide file, transparent background) with the newly dealt cards
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
 * ONE continuous motion (Ronit: the animation must not cut/glitch at
 * the end and then show the result — it has to look like the thing
 * actually landed). The caller defers FIRST (before composing, so the
 * ~1s composition never eats the 3s ack window), then this sends ONE
 * play-once GIF that IS the result — the coin tosses and lands on the
 * real face, the reels stop on the real symbols, the ball settles in
 * the real pocket, the foil peels to the real symbols — and freezes
 * there. ~2.4s later it edits the SAME reply and changes ONLY the
 * text: the settled edit carries NO `files` key at all (Discord keeps
 * the attachment already on the message; the embed still points at
 * attachment://game.gif). Passing `files: []` would REMOVE the
 * attachment — so the settled edit must omit `files` entirely.
 */
async function playSingleGif(
  inv: Inv,
  gif: Buffer,
  suspenseEmbed: ReturnType<typeof pointsEmbed>,
  settledEmbed: ReturnType<typeof pointsEmbed>,
): Promise<void> {
  suspenseEmbed.setImage("attachment://game.gif");
  settledEmbed.setImage("attachment://game.gif");
  await inv.editReply({
    embeds: [suspenseEmbed.toJSON()],
    files: [new AttachmentBuilder(gif, { name: "game.gif" })],
  });
  await sleep(VISUAL_SUSPENSE.ms);
  await inv.editReply({ embeds: [settledEmbed.toJSON()] });
}

/**
 * FALLBACK two-image flow (only when the runtime composition fails):
 * the generic suspense GIF, then an edit to the settled image + result.
 * The caller already deferred (before composing) — this never defers.
 * When the spin asset is missing (spin === null) the suspense is
 * skipped and the settled reply goes out directly, so a missing file
 * can never break the game.
 */
async function playVisual(
  inv: Inv,
  spin: { embeds: APIEmbed[]; files: AttachmentBuilder[] } | null,
  settled: { embeds: APIEmbed[]; files: AttachmentBuilder[] },
): Promise<void> {
  if (spin) {
    await inv.editReply(spin);
    await sleep(VISUAL_SUSPENSE.ms);
  }
  await inv.editReply(settled);
}

/** Embed + image payload, or the text-only payload when image is null. */
function attachPayload(
  embed: ReturnType<typeof pointsEmbed>,
  image: { buffer: Buffer; name: string } | null,
): { embeds: APIEmbed[]; files: AttachmentBuilder[] } {
  if (!image) return { embeds: [embed.toJSON()], files: [] };
  embed.setImage(`attachment://${image.name}`);
  return {
    embeds: [embed.toJSON()],
    files: [new AttachmentBuilder(image.buffer, { name: image.name })],
  };
}

/**
 * Explicit balance pre-check (defense in depth behind the atomic placeBet
 * below): a bet can never exceed the balance, and the error names the
 * balance so the player sees why. Runs before any defer, so the error
 * stays ephemeral.
 */
async function checkBalance(
  inv: Inv,
  ctx: CommandContext,
  bet: number,
): Promise<boolean> {
  const balance = (await getBalance(ctx.db, ctx.guildId, inv.user.id)).points;
  if (bet > balance) {
    await replyError(
      inv,
      `Insufficient gold. You have ${fmt(balance)} gold, but bet ${fmt(bet)}.`,
    );
    return false;
  }
  return true;
}

export const commands: Command[] = [
  {
    name: "slots",
    description: "Spin the 3-reel slot machine. Jackpot 7️⃣7️⃣7️⃣ pays 50x, any 3-of-a-kind 10x, a pair 2x.",
    aliases: ["slot", "spin"],
    args: [{ name: "bet", type: "integer", required: true }],
    async execute(inv, ctx) {
      const bet = await readBet(inv);
      if (bet === null) return;
      const placed = await placeBet(ctx.db, ctx.guildId, inv.user.id, bet, "slots");
      if (!placed.ok) {
        await replyError(inv, placed.error ?? "Could not place that bet.");
        return;
      }
      const spin = slotsSpin(secureFloat);
      const winAmount = bet * spin.multiplier;
      if (winAmount > 0) await creditWin(ctx.db, ctx.guildId, inv.user.id, winAmount, "slots win");
      const balance = (await getBalance(ctx.db, ctx.guildId, inv.user.id)).points;
      const outcome =
        spin.multiplier > 0
          ? `You won **${fmt(winAmount)} gold** (${spin.multiplier}x)!`
          : "No match — better luck next spin.";
      const settledEmbed = pointsEmbed(emoji("slots") + " Slots", outcome)
        .addFields(
          { name: "Bet", value: fmt(bet), inline: true },
          { name: "Multiplier", value: `${spin.multiplier}x`, inline: true },
          { name: "Balance", value: fmt(balance), inline: true },
        )
        .setFooter({ text: "Odds: jackpot 7️⃣7️⃣7️⃣ 50x · 3-of-a-kind 10x · pair 2x · house edge ~10.9%. Gold only, no real money." })
        .setColor(spin.multiplier > 0 ? BJ_COLORS.win : BJ_COLORS.lose);
      const spinEmbed = pointsEmbed(emoji("slots") + " Slots", "Spinning…")
        .addFields({ name: "Bet", value: fmt(bet), inline: true })
        .setColor(BJ_COLORS.playing);
      // Defer BEFORE composing: the runtime GIF takes ~1s and the ack
      // window is 3s. Then one continuous motion (the reels stop on
      // the real symbols and freeze); the settle edit changes only
      // the text. Falls back to the two-image flow when composing
      // fails — the game never breaks on a missing asset.
      await inv.deferReply();
      const gif = await composeSlotsResult(spin.symbols).catch(() => null);
      if (gif) {
        await playSingleGif(inv, gif, spinEmbed, settledEmbed);
        return;
      }
      // The settled strip shows the REAL result symbols (never a canned
      // 7-7-7); the text symbols stay only as the no-asset fallback.
      const settledStrip = await composeSlotsSettled(spin.symbols);
      if (!settledStrip) settledEmbed.setDescription(`${spin.symbols.join(" | ")}\n\n${outcome}`);
      const spinBuf = tryReadAsset(slotsSpinPath());
      await playVisual(
        inv,
        spinBuf ? attachPayload(spinEmbed, { buffer: spinBuf, name: "spin.gif" }) : null,
        attachPayload(settledEmbed, settledStrip ? { buffer: settledStrip, name: "settled.gif" } : null),
      );
    },
  },
  {
    name: "blackjack",
    description: "Play blackjack against the dealer. Dealer stands on 17. Blackjack pays 3:2.",
    aliases: ["bj", "21"],
    args: [{ name: "bet", type: "integer", required: true }],
    async execute(inv, ctx) {
      const bet = await readBet(inv);
      if (bet === null) return;
      if (!(await checkBalance(inv, ctx, bet))) return;
      const placed = await placeBet(ctx.db, ctx.guildId, inv.user.id, bet, "blackjack");
      if (!placed.ok) {
        await replyError(inv, placed.error ?? "Could not place that bet.");
        return;
      }
      // Acknowledge immediately so the reply never waits on a slow container.
      await inv.deferReply();
      const game = createBlackjackGame(ctx.guildId, inv.user.id, bet);
      // Natural blackjack settles immediately — no buttons needed.
      if (isBlackjack(game.playerHand)) {
        const settled = settleBlackjack(game.playerHand, game.dealerHand);
        const winAmount = Math.floor(bet * settled.multiplier);
        if (winAmount > 0) await creditWin(ctx.db, ctx.guildId, inv.user.id, winAmount, "blackjack win");
        endBlackjackGame(game.id);
        const footerLine =
          settled.outcome === "player_blackjack"
            ? `${emoji("party")} Blackjack! You won ${fmt(winAmount)} gold (3:2).`
            : `Both you and the dealer have blackjack — push, your ${fmt(bet)} gold are returned.`;
        await inv.editReply(
          await bjReplyPayload(game, { over: true, outcome: bjOutcomeOf(settled), footerLine }, ctx),
        );
        return;
      }
      const replyMsg = (await inv.editReply({
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
    name: "roulette",
    description: "Bet on the European roulette wheel. Red/black/even/odd pay 2x, a single number pays 36x.",
    aliases: ["roul"],
    args: [{ name: "bet", type: "integer", required: true }, { name: "bet-on", type: "string", required: true }],
    async execute(inv, ctx) {
      const bet = await readBet(inv);
      if (bet === null) return;
      const betOn = inv.options.getString("bet-on");
      if (!betOn || !isValidRouletteBet(betOn)) {
        await replyError(inv, "Invalid bet. Bet on red, black, even, odd, or a single number 0-36.");
        return;
      }
      const placed = await placeBet(ctx.db, ctx.guildId, inv.user.id, bet, "roulette");
      if (!placed.ok) {
        await replyError(inv, placed.error ?? "Could not place that bet.");
        return;
      }
      const result = rouletteOutcome(betOn, rouletteRoll());
      const winAmount = bet * result.multiplier;
      if (winAmount > 0) await creditWin(ctx.db, ctx.guildId, inv.user.id, winAmount, "roulette win");
      const balance = (await getBalance(ctx.db, ctx.guildId, inv.user.id)).points;
      const outcome = result.win
        ? `${emoji("party")} You won **${fmt(winAmount)} gold** (${result.multiplier}x)!`
        : "You lost this spin.";
      const settledEmbed = pointsEmbed(emoji("roulette") + " Roulette", `The ball landed on **${result.roll} ${result.color}**.\nYou bet on **${result.betOn}**.\n\n${outcome}`)
        .addFields(
          { name: "Bet", value: fmt(bet), inline: true },
          { name: "Multiplier", value: `${result.multiplier}x`, inline: true },
          { name: "Balance", value: fmt(balance), inline: true },
        )
        .setFooter({ text: "European wheel (single zero) · even-money 2x · single number 36x · house edge 2.70%. Gold only, no real money." })
        .setColor(result.win ? BJ_COLORS.win : BJ_COLORS.lose);
      const spinEmbed = pointsEmbed(emoji("roulette") + " Roulette", "Spinning…")
        .addFields(
          { name: "Bet", value: fmt(bet), inline: true },
          { name: "You bet on", value: `**${result.betOn}**`, inline: true },
        )
        .setColor(BJ_COLORS.playing);
      // Defer BEFORE composing: the runtime GIF takes ~1s and the ack
      // window is 3s. Then one continuous motion (the ball rolls into
      // the real pocket and stops); the settle edit changes only the
      // text. Falls back to the two-image flow when composing fails.
      await inv.deferReply();
      const gif = await composeRouletteResult(result.roll).catch(() => null);
      if (gif) {
        await playSingleGif(inv, gif, spinEmbed, settledEmbed);
        return;
      }
      // Settled wheel: the ball sits on the ACTUAL winning pocket.
      const wheelBuf = tryReadAsset(rouletteWheelPath(result.roll));
      const spinBuf = tryReadAsset(rouletteSpinPath());
      await playVisual(
        inv,
        spinBuf ? attachPayload(spinEmbed, { buffer: spinBuf, name: "spin.gif" }) : null,
        attachPayload(
          settledEmbed,
          wheelBuf ? { buffer: wheelBuf, name: `wheel-${String(result.roll).padStart(2, "0")}.png` } : null,
        ),
      );
    },
  },
  {
    name: "coinflip",
    description: "Flip a coin. Call it right and win 1.9x your bet.",
    aliases: ["cf", "flip", "coin"],
    args: [{ name: "bet", type: "integer", required: true }, { name: "guess", type: "string", required: true }],
    async execute(inv, ctx) {
      const bet = await readBet(inv);
      if (bet === null) return;
      const guess = inv.options.getString("guess");
      if (guess !== "heads" && guess !== "tails") {
        await replyError(inv, "Guess must be heads or tails.");
        return;
      }
      const placed = await placeBet(ctx.db, ctx.guildId, inv.user.id, bet, "coinflip");
      if (!placed.ok) {
        await replyError(inv, placed.error ?? "Could not place that bet.");
        return;
      }
      const result = coinflipOutcome(guess, secureFloat());
      const winAmount = Math.floor(bet * result.multiplier);
      if (winAmount > 0) await creditWin(ctx.db, ctx.guildId, inv.user.id, winAmount, "coinflip win");
      const balance = (await getBalance(ctx.db, ctx.guildId, inv.user.id)).points;
      const outcome = result.win
        ? `${emoji("party")} You won **${fmt(winAmount)} gold** (1.9x)!`
        : "Wrong call — you lost this flip.";
      const settledEmbed = pointsEmbed(emoji("coin") + " Coinflip", `You called **${guess}**. The coin landed **${result.result}**.\n\n${outcome}`)
        .addFields(
          { name: "Bet", value: fmt(bet), inline: true },
          { name: "Balance", value: fmt(balance), inline: true },
        )
        .setFooter({ text: "50/50 flip · win pays 1.9x · house edge 5%. Gold only, no real money." })
        .setColor(result.win ? BJ_COLORS.win : BJ_COLORS.lose);
      const spinEmbed = pointsEmbed(emoji("coin") + " Coinflip", "Flipping…")
        .addFields(
          { name: "Bet", value: fmt(bet), inline: true },
          { name: "You called", value: `**${guess}**`, inline: true },
        )
        .setColor(BJ_COLORS.playing);
      // Defer BEFORE composing: the runtime GIF takes ~1s and the ack
      // window is 3s. Then one continuous motion (the toss lands on
      // the real face and freezes); the settle edit changes only the
      // text. Falls back to the two-image flow when composing fails.
      await inv.deferReply();
      const gif = await composeCoinflipResult(result.result).catch(() => null);
      if (gif) {
        await playSingleGif(inv, gif, spinEmbed, settledEmbed);
        return;
      }
      // The coin spins, then LANDS on the actual result face (heads = the
      // $ face, tails = the star disc — same canvas, so the edit feels
      // like the coin just stops).
      const landedBuf = tryReadAsset(coinflipLandedPath(result.result));
      const spinBuf = tryReadAsset(coinflipFlipPath());
      await playVisual(
        inv,
        spinBuf ? attachPayload(spinEmbed, { buffer: spinBuf, name: "flip.gif" }) : null,
        attachPayload(settledEmbed, landedBuf ? { buffer: landedBuf, name: `${result.result}.png` } : null),
      );
    },
  },
  {
    name: "highlow",
    description: "Guess whether the next card is higher or lower. Win pays 1.9x, a tie pushes your bet back.",
    aliases: ["hl"],
    args: [{ name: "bet", type: "integer", required: true }, { name: "guess", type: "string", required: true }],
    async execute(inv, ctx) {
      const bet = await readBet(inv);
      if (bet === null) return;
      const guess = inv.options.getString("guess");
      if (guess !== "higher" && guess !== "lower") {
        await replyError(inv, "Guess must be higher or lower.");
        return;
      }
      if (!(await checkBalance(inv, ctx, bet))) return;
      const placed = await placeBet(ctx.db, ctx.guildId, inv.user.id, bet, "highlow");
      if (!placed.ok) {
        await replyError(inv, placed.error ?? "Could not place that bet.");
        return;
      }
      // Acknowledge immediately so the reply never waits on a slow container.
      await inv.deferReply();
      // Guess is locked in before any card is revealed, so extreme first
      // cards cannot be exploited (see lib/casino.ts edge notes).
      const card = drawCard();
      const next = drawCard();
      const result = highlowOutcome(card, guess, next);
      const winAmount = Math.floor(bet * result.multiplier);
      if (winAmount > 0) await creditWin(ctx.db, ctx.guildId, inv.user.id, winAmount, "highlow win");
      const balance = (await getBalance(ctx.db, ctx.guildId, inv.user.id)).points;
      const outcome =
        result.outcome === "win"
          ? `You won ${fmt(winAmount)} gold (1.9x)!`
          : result.outcome === "push"
            ? `Tie — your ${fmt(bet)} gold are returned.`
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
          text: `Bet ${fmt(bet)} · You guessed ${guess} · ${outcome} · Balance ${fmt(balance)} gold`,
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
      await inv.editReply({ embeds: [embed.toJSON()], files });
    },
  },
  {
    name: "scratch",
    description: "Scratch a card: reveal 3 symbols. 3 matching pay 5x, 2 matching pay your bet back.",
    aliases: ["scratchcard", "sc"],
    args: [{ name: "bet", type: "integer", required: true }],
    async execute(inv, ctx) {
      const bet = await readBet(inv);
      if (bet === null) return;
      const placed = await placeBet(ctx.db, ctx.guildId, inv.user.id, bet, "scratch");
      if (!placed.ok) {
        await replyError(inv, placed.error ?? "Could not place that bet.");
        return;
      }
      const result = scratchDraw(secureFloat);
      const winAmount = bet * result.multiplier;
      if (winAmount > 0) await creditWin(ctx.db, ctx.guildId, inv.user.id, winAmount, "scratch win");
      const balance = (await getBalance(ctx.db, ctx.guildId, inv.user.id)).points;
      const outcome =
        result.multiplier === 5
          ? `${emoji("party")} Three of a kind! You won **${fmt(winAmount)} gold** (5x)!`
          : result.multiplier === 1
            ? `Two matching — your **${fmt(bet)} gold** are returned.`
            : "No match — better luck next card.";
      // Defer BEFORE composing: the runtime GIF takes ~1s and the ack
      // window is 3s. Then one continuous motion (the foil peels to
      // the real symbols and holds); the settle edit changes only
      // the text. Falls back to the two-image flow when composing
      // fails — the game never breaks on a missing asset.
      await inv.deferReply();
      const gif = await composeScratchResult(result.symbols).catch(() => null);
      if (gif) {
        const settledEmbed = pointsEmbed("🎫 Scratch Card", outcome)
          .addFields(
            { name: "Bet", value: fmt(bet), inline: true },
            { name: "Multiplier", value: `${result.multiplier}x`, inline: true },
            { name: "Balance", value: fmt(balance), inline: true },
          )
          .setFooter({ text: "Odds: 3 matching 5x · 2 matching 1x · house edge 12.5%. Gold only, no real money." })
          .setColor(
            result.multiplier === 5 ? BJ_COLORS.win : result.multiplier === 1 ? BJ_COLORS.push : BJ_COLORS.lose,
          );
        const spinEmbed = pointsEmbed("🎫 Scratch Card", "Scratching…")
          .addFields({ name: "Bet", value: fmt(bet), inline: true })
          .setColor(BJ_COLORS.playing);
        await playSingleGif(inv, gif, spinEmbed, settledEmbed);
        return;
      }
      // Visual reveal: three covered foil tiles first, then the same
      // three tiles revealed with the real drawn symbols. The text
      // symbols stay only as the no-asset fallback.
      const revealedStrip = await composeScratch(result.symbols);
      const coveredStrip = await composeScratch(null);
      const settledEmbed = pointsEmbed(
        "🎫 Scratch Card",
        revealedStrip ? outcome : `${result.symbols.join("  ")}\n\n${outcome}`,
      )
        .addFields(
          { name: "Bet", value: fmt(bet), inline: true },
          { name: "Multiplier", value: `${result.multiplier}x`, inline: true },
          { name: "Balance", value: fmt(balance), inline: true },
        )
        .setFooter({ text: "Odds: 3 matching 5x · 2 matching 1x · house edge 12.5%. Gold only, no real money." })
        .setColor(
          result.multiplier === 5 ? BJ_COLORS.win : result.multiplier === 1 ? BJ_COLORS.push : BJ_COLORS.lose,
        );
      const spinEmbed = pointsEmbed("🎫 Scratch Card", "Scratching…")
        .addFields({ name: "Bet", value: fmt(bet), inline: true })
        .setColor(BJ_COLORS.playing);
      await playVisual(
        inv,
        coveredStrip ? attachPayload(spinEmbed, { buffer: coveredStrip, name: "covered.gif" }) : null,
        attachPayload(settledEmbed, revealedStrip ? { buffer: revealedStrip, name: "revealed.gif" } : null),
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Blackjack button flow (customId: selena:bj:<gameId>:hit|stand)
// ---------------------------------------------------------------------------

async function handleBlackjackButton(inv: any, ctx: CommandContext): Promise<void> {
  const parts = String(inv.customId ?? "").split(":");
  const gameId = parts[2] ?? "";
  const action = parts[3] ?? "";
  // Look up by game id from the customId; fall back to the message id key
  // (the game is also stored under its message id once the reply is known).
  const game: BlackjackGame | undefined =
    getBlackjackGame(gameId) ?? getBlackjackGame(inv.message?.id ?? "");
  if (!game) {
    await inv.reply({ content: "This blackjack game has expired or was already finished.", ephemeral: true });
    return;
  }
  if (inv.user?.id !== game.userId) {
    await inv.reply({ content: "Only the player who started this game can use these buttons.", ephemeral: true });
    return;
  }
  if (action !== "hit" && action !== "stand") {
    await inv.reply({ content: "Unknown blackjack action.", ephemeral: true });
    return;
  }

  // Acknowledge immediately: composing the strip image takes a moment and
  // the button ack must not wait on it.
  await inv.deferUpdate();

  const settleAndShow = async (note: string): Promise<void> => {
    const settled = settleBlackjack(game.playerHand, game.dealerHand);
    const winAmount = Math.floor(game.bet * settled.multiplier);
    if (winAmount > 0) await creditWin(ctx.db, ctx.guildId, game.userId, winAmount, "blackjack win");
    endBlackjackGame(game.id);
    const resultNote =
      settled.outcome === "player_blackjack"
        ? `${emoji("party")} Blackjack! You won ${fmt(winAmount)} gold (3:2).`
        : settled.outcome === "win"
          ? `You won ${fmt(winAmount)} gold!`
          : settled.outcome === "push"
            ? `Push — your ${fmt(game.bet)} gold are returned.`
            : `You lost ${fmt(game.bet)} gold.`;
    await inv.editReply({
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
    await inv.editReply({
      ...(await bjReplyPayload(game, { over: false, outcome: "playing", footerLine: "Hit or Stand?" }, ctx)),
      components: [bjButtons(game.id)],
    });
    return;
  }

  // Stand: dealer plays, then settle.
  dealerPlay(game.deck, game.dealerHand);
  await settleAndShow("You stood — the dealer plays out.");
}

export const buttonHandlers: Record<string, (inv: any, ctx: CommandContext) => Promise<void>> = {
  "selena:bj": handleBlackjackButton,
};
