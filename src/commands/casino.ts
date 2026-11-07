import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { Command, CommandContext, CommandInvocation } from "../lib/command.js";
import { emoji } from "../lib/emoji.js";
import { fmt } from "../lib/command.js";
import { getBalance } from "../lib/economy.js";
import { CARD_BACK, cardGlyph } from "../lib/cards.js";
import {
  blackjackGames,
  blackjackValue,
  coinflipOutcome,
  createBlackjackGame,
  createHighlowGame,
  createMinesGame,
  creditWin,
  dealerPlay,
  drawHighlowCard,
  endBlackjackGame,
  endHighlowGame,
  endMinesGame,
  getBlackjackGame,
  getHighlowGame,
  getMinesGame,
  HIGHLOW_SAME_MIN_MULTIPLIER,
  highlowCashOut,
  highlowGames,
  highlowGuessWin,
  highlowLadderMultiplier,
  isBlackjack,
  isValidRouletteBet,
  minesCashOut,
  minesGames,
  minesMultiplier,
  placeBet,
  rouletteOutcome,
  rouletteRoll,
  scratchDraw,
  settleBlackjack,
  SLOT_SYMBOLS,
  slotsSpin,
  type BlackjackGame,
  type HighlowGame,
  type HighLowGuess,
  type MinesGame,
} from "../lib/casino.js";
import { secureFloat } from "../lib/rng.js";
import { SLOT_SPIN, VISUAL_SUSPENSE, sleep } from "../lib/visualgames.js";

type Inv = CommandInvocation;

async function replyError(inv: Inv, message: string): Promise<void> {
  await inv.reply({ content: message });
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
 * OwO-style plain-text blackjack: no embed box, no attached images —
 * just short text lines, like OwO's games. The hands are plain text —
 * "K♠ Q♥ (20)" — with the dealer's hole card hidden as "?" while the
 * hand is live. The bet/result/balance line is the last line.
 */
function bjText(
  game: BlackjackGame,
  opts: { over: boolean; footerLine: string; playerName: string },
  balance: number,
): string {
  const title = opts.over ? "🃏 Blackjack — Finished" : "🃏 Blackjack";
  const player = blackjackValue(game.playerHand);
  const dealer = blackjackValue(game.dealerHand);
  const upCard = game.dealerHand[0] ? cardGlyph(game.dealerHand[0]) : "?";
  const dealerLine = opts.over
    ? `Dealer [${dealer}]: ${game.dealerHand.map(cardGlyph).join(" ")}`
    : `Dealer [?+?]: ${upCard} ${CARD_BACK}`;
  const playerLine = `${opts.playerName} [${player}]: ${game.playerHand.map(cardGlyph).join(" ")}`;
  return `${title}\n${dealerLine}\n${playerLine}\nBet ${fmt(game.bet)} · ${opts.footerLine} · Balance ${fmt(balance)} gold`;
}

/**
 * One compact OwO-style plain-text message for a blackjack game state:
 * text hands only, no embed, no strip image. The dealer's hole card
 * stays "?" until the hand is over.
 */
async function bjReplyPayload(
  game: BlackjackGame,
  opts: { over: boolean; footerLine: string; playerName: string },
  ctx: CommandContext,
): Promise<{
  content: string;
}> {
  const balance = (await getBalance(ctx.db, game.guildId, game.userId)).points;
  return { content: bjText(game, opts, balance) };
}

/**
 * OwO-style plain-text flow: the caller defers FIRST, then this edits
 * the SAME message twice — a short plain suspense line, a short
 * suspense beat, then the settled plain text. No embed box, no
 * attached images anywhere. The settled text always shows the REAL
 * server-drawn result, never a different one. (The old GIF flows —
 * playSingleGif / playVisual / attachPayload — are gone; the
 * composition helpers and asset files stay on disk unused.)
 */
async function playTiny(inv: Inv, suspenseText: string, settledText: string): Promise<void> {
  await inv.editReply({ content: suspenseText });
  await sleep(VISUAL_SUSPENSE.ms);
  await inv.editReply({ content: settledText });
}

function randomSlotSymbol(): string {
  return SLOT_SYMBOLS[Math.floor(secureFloat() * SLOT_SYMBOLS.length)] as string;
}

/**
 * OwO-style slots spin: the same message is edited through a few
 * spinning frames — random reel symbols changing, like the reels are
 * turning — then settles on the REAL drawn result. Plain text only,
 * `___SLOTS___` header on every frame, ~2s of spin in total.
 */
async function playSlotsSpinning(inv: Inv, settledText: string): Promise<void> {
  for (let i = 0; i < SLOT_SPIN.frames; i++) {
    const frame = [randomSlotSymbol(), randomSlotSymbol(), randomSlotSymbol()].join(" | ");
    await inv.editReply({ content: `___SLOTS___\n${frame}\nSpinning…` });
    await sleep(SLOT_SPIN.frameMs);
  }
  await inv.editReply({ content: settledText });
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
      const settledText =
        `___SLOTS___\n${spin.symbols.join(" | ")}\n${outcome}\n` +
        `Bet ${fmt(bet)} · Multiplier ${spin.multiplier}x · Balance ${fmt(balance)} gold`;
      // OwO-style spin: one message, 4 quick edits cycling random
      // symbols (the reels turning), then the final edit shows the
      // REAL drawn symbols.
      await inv.deferReply();
      await playSlotsSpinning(inv, settledText);
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
          await bjReplyPayload(game, { over: true, footerLine, playerName: inv.user.username }, ctx),
        );
        return;
      }
      const replyMsg = (await inv.editReply({
        ...(await bjReplyPayload(
          game,
          { over: false, footerLine: "Hit or Stand?", playerName: inv.user.username },
          ctx,
        )),
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
      const settledText =
        `${emoji("roulette")} Roulette\nThe ball landed on **${result.roll} ${result.color}**.\nYou bet on **${result.betOn}**.\n${outcome}\n` +
        `Bet ${fmt(bet)} · Multiplier ${result.multiplier}x · Balance ${fmt(balance)} gold`;
      const spinText = `${emoji("roulette")} Roulette\nSpinning…`;
      // OwO-style flow: plain "Spinning…", a suspense beat, then the
      // same message edited to the real rolled number.
      await inv.deferReply();
      await playTiny(inv, spinText, settledText);
    },
  },
  {
    name: "coinflip",
    description: "Flip a coin — `uwu cf 10 heads`. Call it right and win 1.9x your bet.",
    aliases: ["cf", "flip", "coin"],
    args: [{ name: "bet", type: "integer", required: true }, { name: "guess", type: "string", required: true }],
    async execute(inv, ctx) {
      const bet = await readBet(inv);
      if (bet === null) return;
      const guess = inv.options.getString("guess");
      if (guess !== "heads" && guess !== "tails") {
        await replyError(inv, "Heads or tails? Try `uwu cf 10 heads`.");
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
      const faceEmoji = result.result === "heads" ? "🪙" : "⭐";
      const settledText =
        `${emoji("coin")} Coinflip\nYou called **${guess}**. The coin landed **${result.result}** ${faceEmoji}.\n${outcome}\n` +
        `Bet ${fmt(bet)} · Balance ${fmt(balance)} gold`;
      const spinText = `${emoji("coin")} Coinflip\nYou called **${guess}**.\nFlipping…`;
      // OwO-style flow: plain "Flipping…", a suspense beat, then the
      // same message edited to the real landed face.
      await inv.deferReply();
      await playTiny(inv, spinText, settledText);
    },
  },
  {
    name: "highlow",
    description:
      "High / Low STREAK game — guess the next card to grow your multiplier, cash out any time. Ladder 1.8x → 3.2x → 5x → 7.5x → 11x (then ×1.5/step); a correct Same pays 10x. `uwu hl 10`.",
    aliases: ["hl"],
    args: [{ name: "bet", type: "integer", required: true }],
    async execute(inv, ctx) {
      const bet = await readBet(inv);
      if (bet === null) return;
      if (!(await checkBalance(inv, ctx, bet))) return;
      const placed = await placeBet(ctx.db, ctx.guildId, inv.user.id, bet, "highlow");
      if (!placed.ok) {
        await replyError(inv, placed.error ?? "Could not place that bet.");
        return;
      }
      // Acknowledge immediately so the reply never waits on a slow container.
      await inv.deferReply();
      const game = createHighlowGame(ctx.guildId, inv.user.id, bet);
      const replyMsg = (await inv.editReply({
        content: hlText(game, `<@${inv.user.id}> started a HighLow game.`, "playing"),
        components: [hlButtons(game.id)],
      })) as unknown as { id?: string } | undefined;
      if (replyMsg && typeof replyMsg.id === "string") {
        game.messageId = replyMsg.id;
        highlowGames.set(replyMsg.id, game);
      }
    },
  },
  {
    name: "mines",
    description:
      "Mines — reveal safe tiles on a 3x3 grid to grow your multiplier. `uwu mines 10` (3 mines) or `uwu mines 10 5`. First safe pick on 3 mines pays 1.40x; cash out any time, hit a mine and lose the bet.",
    aliases: ["mine"],
    args: [
      { name: "bet", type: "integer", required: true },
      { name: "mines", type: "integer", required: false },
    ],
    async execute(inv, ctx) {
      const bet = await readBet(inv);
      if (bet === null) return;
      const mineCount = inv.options.getInteger("mines") ?? 3;
      if (!Number.isInteger(mineCount) || mineCount < 1 || mineCount > 5) {
        await replyError(inv, "Mines must be between 1 and 5. Try `uwu mines 10 3`.");
        return;
      }
      if (!(await checkBalance(inv, ctx, bet))) return;
      const placed = await placeBet(ctx.db, ctx.guildId, inv.user.id, bet, "mines");
      if (!placed.ok) {
        await replyError(inv, placed.error ?? "Could not place that bet.");
        return;
      }
      await inv.deferReply();
      const game = createMinesGame(ctx.guildId, inv.user.id, bet, mineCount);
      const replyMsg = (await inv.editReply({
        content: minesText(game, `<@${inv.user.id}> started a mines game.`, "playing"),
        components: minesButtons(game, false),
      })) as unknown as { id?: string } | undefined;
      if (replyMsg && typeof replyMsg.id === "string") {
        game.messageId = replyMsg.id;
        minesGames.set(replyMsg.id, game);
      }
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
      // OwO-style flow: plain "Scratching…", a suspense beat, then the
      // same message edited to the real drawn symbols.
      const settledText =
        `🎫 Scratch Card\n${result.symbols.join("  ")}\n${outcome}\n` +
        `Bet ${fmt(bet)} · Multiplier ${result.multiplier}x · Balance ${fmt(balance)} gold`;
      const spinText = "🎫 Scratch Card\nScratching…";
      await inv.deferReply();
      await playTiny(inv, spinText, settledText);
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

  // Acknowledge immediately: the button ack must not wait on the DB.
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
          footerLine: `${note} · ${resultNote}`,
          playerName: inv.user?.username ?? "Player",
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
      ...(await bjReplyPayload(
        game,
        { over: false, footerLine: "Hit or Stand?", playerName: inv.user?.username ?? "Player" },
        ctx,
      )),
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
  "selena:hl": handleHighlowButton,
  "selena:mines": handleMinesButton,
};

/**
 * Mines — OwO-style plain text with a 3x3 grid of "?" buttons plus a
 * Cash Out button. A safe tile reveals 💎 and grows the multiplier and
 * the Cash Out value ("Next:" shows what one more safe pick would pay);
 * a mine ends the game, loses the bet, and reveals the board; Cash Out
 * banks the current value. Clearing every safe tile banks the max
 * payout automatically. State lives in the same in-memory per-user map
 * mechanism blackjack uses (minesGames in lib/casino.ts) — a redeploy
 * strands an open mines game, same as an open blackjack hand.
 */
function minesButtons(game: MinesGame, over: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let r = 0; r < 3; r++) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (let c = 0; c < 3; c++) {
      const idx = r * 3 + c;
      const revealed = game.revealed.includes(idx);
      const isMine = game.mineTiles.includes(idx);
      const btn = new ButtonBuilder().setCustomId(`selena:mines:${game.id}:tile:${idx}`);
      if (revealed) {
        btn
          .setLabel(isMine ? "💣" : "💎")
          .setDisabled(true)
          .setStyle(isMine ? ButtonStyle.Danger : ButtonStyle.Success);
      } else if (over) {
        btn
          .setLabel(isMine ? "💣" : "?")
          .setDisabled(true)
          .setStyle(isMine ? ButtonStyle.Danger : ButtonStyle.Secondary);
      } else {
        btn.setLabel("?").setStyle(ButtonStyle.Secondary);
      }
      row.addComponents(btn);
    }
    rows.push(row);
  }
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`selena:mines:${game.id}:cashout`)
        .setLabel("Cash Out")
        .setStyle(ButtonStyle.Success)
        .setDisabled(over),
    ),
  );
  return rows;
}

/** OwO-style mines text: header, Bet / Mines / Cash Out (Nx) / Next. */
function minesText(game: MinesGame, note: string, state: "playing" | "lost" | "cashed" | "cleared"): string {
  const header = `💣 Mines\n${note}`;
  if (state === "lost") {
    return `${header}\nBet: ${fmt(game.bet)} · Mines: ${game.mines} · Cash Out: 0`;
  }
  const cashOut = minesCashOut(game);
  const mult = minesMultiplier(game.mines, game.safePicks).toFixed(2);
  if (state !== "playing") {
    return `${header}\nBet: ${fmt(game.bet)} · Mines: ${game.mines} · Cash Out: ${fmt(cashOut)} (${mult}x)`;
  }
  const nextMult = minesMultiplier(game.mines, game.safePicks + 1);
  const nextValue = Math.floor(game.bet * nextMult);
  return (
    `${header}\n` +
    `Bet: ${fmt(game.bet)} · Mines: ${game.mines} · Cash Out: ${fmt(cashOut)} (${mult}x) · Next: ${fmt(nextValue)} (${nextMult.toFixed(2)}x)`
  );
}

async function handleMinesButton(inv: any, ctx: CommandContext): Promise<void> {
  const parts = String(inv.customId ?? "").split(":");
  const gameId = parts[2] ?? "";
  const action = parts[3] ?? "";
  const game = getMinesGame(gameId) ?? getMinesGame(inv.message?.id ?? "");
  if (!game) {
    await inv.reply({ content: "This mines game has expired or was already finished.", ephemeral: true });
    return;
  }
  if (inv.user?.id !== game.userId) {
    await inv.reply({ content: "Only the player who started this game can use these buttons.", ephemeral: true });
    return;
  }
  if (action !== "tile" && action !== "cashout") {
    await inv.reply({ content: "Unknown mines action.", ephemeral: true });
    return;
  }
  await inv.deferUpdate();
  if (action === "cashout") {
    const cashOut = minesCashOut(game);
    if (cashOut > 0) await creditWin(ctx.db, ctx.guildId, game.userId, cashOut, "mines cashout");
    const mult = minesMultiplier(game.mines, game.safePicks).toFixed(2);
    endMinesGame(game.id);
    await inv.editReply({
      content: minesText(game, `You cashed out ${fmt(cashOut)} gold (${mult}x)!`, "cashed"),
      components: minesButtons(game, true),
    });
    return;
  }
  const tile = Number(parts[4]);
  if (!Number.isInteger(tile) || tile < 0 || tile > 8 || game.revealed.includes(tile)) {
    // Already revealed (or bogus): just re-render the current board.
    await inv.editReply({
      content: minesText(game, "Pick a tile — each safe tile grows your multiplier. Cash out any time.", "playing"),
      components: minesButtons(game, false),
    });
    return;
  }
  game.revealed.push(tile);
  if (game.mineTiles.includes(tile)) {
    endMinesGame(game.id);
    await inv.editReply({
      content: minesText(game, `💥 You hit a mine! You lost ${fmt(game.bet)} gold.`, "lost"),
      components: minesButtons(game, true),
    });
    return;
  }
  game.safePicks += 1;
  if (game.safePicks >= 9 - game.mines) {
    // Board cleared — every safe tile revealed. Bank the max payout.
    const cashOut = minesCashOut(game);
    if (cashOut > 0) await creditWin(ctx.db, ctx.guildId, game.userId, cashOut, "mines cleared");
    endMinesGame(game.id);
    await inv.editReply({
      content: minesText(game, `🏆 You cleared the board! You won ${fmt(cashOut)} gold!`, "cleared"),
      components: minesButtons(game, true),
    });
    return;
  }
  await inv.editReply({
    content: minesText(
      game,
      `💎 Safe! ${game.safePicks} safe tile${game.safePicks === 1 ? "" : "s"} revealed — multiplier grows.`,
      "playing",
    ),
    components: minesButtons(game, false),
  });
}

/**
 * High / Low streak game — OwO-style plain text with buttons.
 * One bet starts a streak; each round shows the current card (Unicode
 * glyph) and a face-down next card. Higher / Lower / Same via buttons;
 * a correct guess grows the streak and the cash-out multiplier, a wrong
 * guess ends the streak and loses the bet. Cash Out banks the current
 * value and ends the game. Ladder: 1.8x, 3.2x, 5x, 7.5x, 11x, then
 * x1.5/step; a correct Same jumps the multiplier to at least 10x.
 * State lives in the same in-memory per-user map mechanism blackjack
 * uses (highlowGames in lib/casino.ts) — a redeploy strands an open
 * streak game, same as an open blackjack hand.
 */
function hlButtons(gameId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`selena:hl:${gameId}:higher`).setLabel("Higher").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`selena:hl:${gameId}:lower`).setLabel("Lower").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`selena:hl:${gameId}:same`).setLabel("Same").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`selena:hl:${gameId}:cashout`).setLabel("Cash Out").setStyle(ButtonStyle.Success),
  );
}

/** OwO-style High / Low text: header, Bet / Streak / Cash Out (Nx), current + face-down next card. */
function hlText(game: HighlowGame, note: string, state: "playing" | "lost" | "cashed"): string {
  const header = `🔼🔽 High / Low\n${note}`;
  if (state === "lost") {
    return `${header}\nBet: ${fmt(game.bet)} · Streak: ${game.streak} · Cash Out: 0`;
  }
  const cashOut = highlowCashOut(game);
  const mult = game.multiplier.toFixed(2);
  const status = `Bet: ${fmt(game.bet)} · Streak: ${game.streak} · Cash Out: ${fmt(cashOut)} (${mult}x)`;
  if (state === "cashed") return `${header}\n${status}`;
  return (
    `${header}\n${status}\n` +
    `Current: ${cardGlyph(game.currentCode)}   Next: ${CARD_BACK}\n` +
    "Is the next card higher, lower, or the same value?"
  );
}

async function handleHighlowButton(inv: any, ctx: CommandContext): Promise<void> {
  const parts = String(inv.customId ?? "").split(":");
  const gameId = parts[2] ?? "";
  const action = parts[3] ?? "";
  const game = getHighlowGame(gameId) ?? getHighlowGame(inv.message?.id ?? "");
  if (!game) {
    await inv.reply({ content: "This HighLow game has expired or was already finished.", ephemeral: true });
    return;
  }
  if (inv.user?.id !== game.userId) {
    await inv.reply({ content: "Only the player who started this game can use these buttons.", ephemeral: true });
    return;
  }
  if (action !== "higher" && action !== "lower" && action !== "same" && action !== "cashout") {
    await inv.reply({ content: "Unknown HighLow action.", ephemeral: true });
    return;
  }
  await inv.deferUpdate();
  if (action === "cashout") {
    const cashOut = highlowCashOut(game);
    if (cashOut > 0) await creditWin(ctx.db, ctx.guildId, game.userId, cashOut, "highlow cashout");
    const mult = game.multiplier.toFixed(2);
    endHighlowGame(game.id);
    await inv.editReply({
      content: hlText(game, `You cashed out ${fmt(cashOut)} gold (${mult}x)!`, "cashed"),
      components: [],
    });
    return;
  }
  // Guess: draw the next card and resolve it against the current card.
  const next = drawHighlowCard();
  const guess = action as HighLowGuess;
  if (!highlowGuessWin(game.currentRank, guess, next.rank)) {
    endHighlowGame(game.id);
    await inv.editReply({
      content: hlText(
        game,
        `The next card was ${cardGlyph(next.code)} — wrong! Streak over, you lost ${fmt(game.bet)} gold.`,
        "lost",
      ),
      components: [],
    });
    return;
  }
  // Correct: advance the streak, grow the multiplier, the drawn card
  // becomes the new current card.
  game.streak += 1;
  game.multiplier = highlowLadderMultiplier(game.streak);
  if (guess === "same") game.multiplier = Math.max(game.multiplier, HIGHLOW_SAME_MIN_MULTIPLIER);
  game.currentRank = next.rank;
  game.currentCode = next.code;
  const note =
    guess === "same"
      ? `The next card was ${cardGlyph(next.code)} — SAME! Huge!`
      : `The next card was ${cardGlyph(next.code)} — correct!`;
  await inv.editReply({
    content: hlText(game, note, "playing"),
    components: [hlButtons(game.id)],
  });
}
