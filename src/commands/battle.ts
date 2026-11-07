import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { Command, CommandContext, CommandInvocation } from "../lib/command.js";
import { errorEmbed, fmt, resolveDisplayNames } from "../lib/command.js";
import { renderBattleCard, type BattleCardInput } from "../lib/battleCard.js";
import { addPoints } from "../lib/economy.js";
import { monsterEmoji } from "../lib/hunt.js";
import { awardGuildXpBestEffort } from "../lib/guilds.js";
import { secureFloat } from "../lib/rng.js";
import {
  BATTLE_CHALLENGE_TTL_MS,
  BATTLE_LOSE_GOLD,
  WAGER_CAP,
  createChallenge,
  expireBattleChallenges,
  getBattleCooldownRemainingMs,
  getBattleTeam,
  getEquippedWeapon,
  getChallenge,
  getGold,
  setBattleTimestamp,
  setChallengeStatus,
  settleBattle,
  simulateBattle,
  teamLine,
  type ChallengeRow,
  type TeamMemberInput,
} from "../lib/battle.js";

/**
 * 1v1 battles (Phase 2, design docs/hunt-world-phase2-design.md §5).
 *
 * `uwu battle @user [wager]` — challenge with Accept/Decline buttons,
 * 60s expiry. On accept the battle auto-plays top-3 vs top-3, editing
 * ONE message through the rounds, then posts the result. Winner 100
 * gold + XP, loser 25 gold; optional wager (cap 1,000) escrowed at
 * accept and paid to the winner. 1-minute cooldown per user between
 * battles, stored in user_battle so it survives redeploys.
 *
 * Plain-text OwO-style replies everywhere, except the battle replay
 * itself: each round edits ONE message with a battle card image
 * (HP bars, fainted state) via src/lib/battleCard.ts, with the old
 * plain-text edits as the fallback whenever a render fails. All
 * persistent state in Supabase — never in-memory.
 *
 * The 60s due-task sweep in src/index.ts is expected to call the
 * re-exported expireBattleChallenges(db, nowMs) — this module does NOT
 * wire itself into index.ts.
 */

export { expireBattleChallenges };

/** Delay between round edits in the battle replay (tests set it to 0). */
export const battleReplay = { delayMs: 750 };

/**
 * Test seam for the battle card renderer (same pattern as battleReplay):
 * the replay calls `battleCardRenderer.render(...)`, never the imported
 * function directly, so tests can stub it (e.g. make it throw) without
 * touching the module import.
 */
export const battleCardRenderer = { render: renderBattleCard };

/**
 * Plain display names for the battle card — mentions (`<@id>`) would
 * render literally in the image. Challenger: guild member display name
 * when fetchable, else the raw id (no username is available for the
 * challenger on the accept interaction). Opponent (the acceptor):
 * guild display name when the fetch worked, else `inv.user.username`
 * (always present), else the raw id. Never throws — a name lookup can
 * never crash a battle.
 */
async function resolveBattleNames(
  inv: any,
  challengerId: string,
  opponentId: string,
): Promise<{ aName: string; bName: string }> {
  let aName = challengerId;
  let bName = inv.user?.username ?? opponentId;
  try {
    const names = await resolveDisplayNames(inv, [challengerId, opponentId]);
    aName = names[0] ?? challengerId;
    const oppDisplay = names[1];
    if (oppDisplay && oppDisplay !== opponentId) bName = oppDisplay;
  } catch {
    // Fallbacks above already stand.
  }
  return { aName, bName };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function replyError(inv: CommandInvocation, message: string): Promise<void> {
  await inv.reply({ embeds: [errorEmbed(message).toJSON()], ephemeral: true });
}

function teamBlock(label: string, team: readonly TeamMemberInput[]): string {
  return `${label}:\n${team.map((m) => `  ${monsterEmoji(m.monster)} ${teamLine(m)}`).join("\n")}`;
}

export const commands: Command[] = [
  {
    name: "battle",
    description: "Challenge another trainer to a 1v1 monster battle (optional wager up to 1,000 gold).",
    aliases: ["fight", "duel"],
    args: [
      { name: "opponent", type: "user", required: true },
      { name: "wager", type: "integer" },
    ],
    async execute(inv, ctx) {
      const opponent = inv.options.getUser("opponent");
      const wager = inv.options.getInteger("wager") ?? 0;
      if (!opponent) {
        await replyError(inv, "Challenge who? `uwu battle @user` — or add a wager: `uwu battle @user 500`.");
        return;
      }
      if (opponent.id === inv.user.id) {
        await replyError(inv, "You can't battle yourself — find a rival!");
        return;
      }
      if ((opponent as { bot?: boolean }).bot) {
        await replyError(inv, "Bots don't battle — challenge a real trainer.");
        return;
      }
      if (wager < 0) {
        await replyError(inv, "A wager can't be negative.");
        return;
      }
      if (wager > WAGER_CAP) {
        await replyError(inv, `Wagers are capped at ${fmt(WAGER_CAP)} gold per battle.`);
        return;
      }
      const now = Date.now();
      const myCooldown = await getBattleCooldownRemainingMs(ctx.db, inv.user.id, now);
      if (myCooldown > 0) {
        await replyError(
          inv,
          `You battled too recently — wait ${Math.ceil(myCooldown / 1000)}s before challenging again.`,
        );
        return;
      }
      const oppCooldown = await getBattleCooldownRemainingMs(ctx.db, opponent.id, now);
      if (oppCooldown > 0) {
        await replyError(
          inv,
          `${opponent.username} battled too recently — wait ${Math.ceil(oppCooldown / 1000)}s before challenging them.`,
        );
        return;
      }
      const myTeam = await getBattleTeam(ctx.db, ctx.guildId, inv.user.id);
      if (myTeam.length === 0) {
        await replyError(inv, "Your zoo is empty — hunt or roll for monsters first, then battle!");
        return;
      }
      const oppTeam = await getBattleTeam(ctx.db, ctx.guildId, opponent.id);
      if (oppTeam.length === 0) {
        await replyError(inv, `${opponent.username} has no monsters in their zoo yet — they need to hunt or roll first.`);
        return;
      }
      if (wager > 0) {
        const balance = await getGold(ctx.db, ctx.guildId, inv.user.id);
        if (balance < wager) {
          await replyError(inv, `You only have ${fmt(balance)} gold — not enough to wager ${fmt(wager)}.`);
          return;
        }
      }
      let challenge: ChallengeRow;
      try {
        challenge = await createChallenge(ctx.db, {
          challengerId: inv.user.id,
          opponentId: opponent.id,
          wager,
          channelId: inv.channelId ?? "",
          guildId: ctx.guildId,
          nowMs: now,
        });
      } catch (e) {
        console.error("uwu: battle challenge create failed:", e instanceof Error ? e.message : e);
        await replyError(inv, "Couldn't create the challenge — try again in a moment.");
        return;
      }
      const wagerLine =
        wager > 0 ? `\n💰 Wager: ${fmt(wager)} gold each — winner takes ${fmt(2 * wager)}!` : "";
      await inv.reply({
        content:
          `⚔️ <@${inv.user.id}> challenges <@${opponent.id}> to a monster battle!\n\n` +
          `${teamBlock(inv.user.username + "'s team", myTeam)}\n\n` +
          `<@${opponent.id}>, you have ${Math.round(BATTLE_CHALLENGE_TTL_MS / 1000)} seconds to accept or decline.${wagerLine}`,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`selena:battle:accept:${challenge.id}`)
              .setLabel("Accept")
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`selena:battle:decline:${challenge.id}`)
              .setLabel("Decline")
              .setStyle(ButtonStyle.Danger),
          ),
        ],
      });
    },
  },
];

/** Run the battle after an accept: escrow, simulate, settle, replay. */
async function runAcceptedBattle(
  inv: any,
  ctx: CommandContext,
  challenge: ChallengeRow,
): Promise<void> {
  const db = ctx.db;
  const guildId = challenge.guildId;
  const fail = async (message: string): Promise<void> => {
    await setChallengeStatus(db, challenge.id, "expired");
    await inv.editReply({ content: message, components: [] });
  };

  // Re-check cooldowns (either side may have battled since the challenge).
  for (const userId of [challenge.challengerId, challenge.opponentId]) {
    const cd = await getBattleCooldownRemainingMs(db, userId, Date.now());
    if (cd > 0) {
      await fail(`⏳ One side battled too recently — wait ${Math.ceil(cd / 1000)}s and challenge again.`);
      return;
    }
  }
  const aTeam = await getBattleTeam(db, guildId, challenge.challengerId);
  const bTeam = await getBattleTeam(db, guildId, challenge.opponentId);
  if (aTeam.length === 0 || bTeam.length === 0) {
    await fail("One side has no monsters in their zoo anymore — battle cancelled, no gold moved.");
    return;
  }

  // Wager escrow (fail closed): verify BOTH balances first, then deduct.
  // If the second deduction fails, the first is refunded on the spot —
  // a wager never leaves one side hanging.
  if (challenge.wager > 0) {
    let aBal: number;
    let bBal: number;
    try {
      aBal = await getGold(db, guildId, challenge.challengerId);
      bBal = await getGold(db, guildId, challenge.opponentId);
    } catch (e) {
      console.error("uwu: battle escrow balance read failed:", e instanceof Error ? e.message : e);
      await fail("💰 Couldn't check the wager — battle cancelled, no gold moved.");
      return;
    }
    if (aBal < challenge.wager || bBal < challenge.wager) {
      await fail(
        `💰 Someone can't cover the ${fmt(challenge.wager)} gold wager anymore — battle cancelled, no gold moved.`,
      );
      return;
    }
    try {
      await addPoints(db, guildId, challenge.challengerId, -challenge.wager, "battle wager escrow");
      try {
        await addPoints(db, guildId, challenge.opponentId, -challenge.wager, "battle wager escrow");
      } catch (e) {
        await addPoints(db, guildId, challenge.challengerId, challenge.wager, "battle wager refund");
        throw e;
      }
    } catch (e) {
      console.error("uwu: battle escrow failed:", e instanceof Error ? e.message : e);
      await fail("💰 The wager couldn't be held — battle cancelled, no gold moved.");
      return;
    }
  }

  await setChallengeStatus(db, challenge.id, "accepted");
  const aWeapon = await getEquippedWeapon(db, guildId, challenge.challengerId);
  const bWeapon = await getEquippedWeapon(db, guildId, challenge.opponentId);
  const result = simulateBattle(
    {
      ownerId: challenge.challengerId,
      ownerName: `<@${challenge.challengerId}>`,
      team: aTeam,
      weaponAtk: aWeapon?.atk,
      weaponEffects: aWeapon?.effects,
    },
    {
      ownerId: challenge.opponentId,
      ownerName: `<@${challenge.opponentId}>`,
      team: bTeam,
      weaponAtk: bWeapon?.atk,
      weaponEffects: bWeapon?.effects,
    },
    secureFloat,
  );
  const settled = await settleBattle(db, {
    guildId,
    aId: challenge.challengerId,
    bId: challenge.opponentId,
    winner: result.winner,
    wager: challenge.wager,
    aTeam,
    bTeam,
  });
  const endNow = Date.now();
  await setBattleTimestamp(db, challenge.challengerId, endNow);
  await setBattleTimestamp(db, challenge.opponentId, endNow);

  // Display names for the card (resolved once, after settlement —
  // settlement must complete regardless of display).
  const { aName, bName } = await resolveBattleNames(inv, challenge.challengerId, challenge.opponentId);

  // Shared card fields. The wager is omitted when 0 so the card never
  // shows a "0 gold wager" line.
  const cardBase = {
    aName,
    bName,
    roundsTotal: result.roundsFought,
    ...(challenge.wager > 0 ? { wager: challenge.wager } : {}),
  };

  /** Render one battle card; null on failure (caller falls back to text). */
  const renderCard = async (
    input: Omit<BattleCardInput, "aName" | "bName" | "roundsTotal" | "wager">,
  ): Promise<Buffer | null> => {
    try {
      return await battleCardRenderer.render({ ...cardBase, ...input });
    } catch (e) {
      console.error("uwu: battle card render failed:", e instanceof Error ? e.message : e);
      return null;
    }
  };

  // Opening card (round 0, full-HP snapshot). If it fails to render or
  // edit, the plain-text round edits below are the fallback.
  const openingPng = await renderCard({
    aFighters: result.opening.aFighters,
    bFighters: result.opening.bFighters,
    round: 0,
    actionLine: "The battle begins!",
  });
  if (openingPng) {
    try {
      await inv.editReply({ files: [new AttachmentBuilder(openingPng, { name: "battle.png" })], components: [] });
    } catch (e) {
      console.error("uwu: battle opening edit failed:", e instanceof Error ? e.message : e);
    }
  }

  const header =
    `⚔️ Battle — <@${challenge.challengerId}> vs <@${challenge.opponentId}>` +
    (challenge.wager > 0 ? ` · 💰 ${fmt(challenge.wager)} gold wager` : "");
  const shown: string[] = [];
  for (const round of result.rounds) {
    shown.push(...round.lines);
    const window = shown.slice(-8);
    const textContent =
      `${header}\n\nRound ${round.n} — ${result.roundsFought} rounds total\n${window.join("\n")}\n\n${round.aLine}\n${round.bLine}`;
    // The round's last line is the action line — simple and honest.
    const png = await renderCard({
      aFighters: round.aFighters,
      bFighters: round.bFighters,
      round: round.n,
      actionLine: round.lines[round.lines.length - 1] ?? "",
    });
    try {
      if (png) {
        // editReply with files REPLACES the previous attachment — the
        // message never accumulates one card per round.
        await inv.editReply({ files: [new AttachmentBuilder(png, { name: "battle.png" })], components: [] });
      } else {
        await inv.editReply({ content: textContent, components: [] });
      }
    } catch {
      break; // Message gone — the result edit below still tries once.
    }
    await sleep(battleReplay.delayMs);
  }

  let finalText: string;
  if (result.winner === "draw") {
    finalText =
      `🤝 It's a draw after ${result.roundsFought} rounds! Both trainers get ${BATTLE_LOSE_GOLD} gold` +
      ` (+${settled.aXp} / +${settled.bXp} XP).` +
      (challenge.wager > 0 ? " Wagers refunded." : "");
  } else {
    const winnerId = result.winner === "A" ? challenge.challengerId : challenge.opponentId;
    const loserId = result.winner === "A" ? challenge.opponentId : challenge.challengerId;
    // Guild XP (Phase 2 §3.2): 50 per battle win, best-effort.
    await awardGuildXpBestEffort(db, winnerId, 50);
    const winnerGold = result.winner === "A" ? settled.aGold : settled.bGold;
    const winnerXp = result.winner === "A" ? settled.aXp : settled.bXp;
    const loserGold = result.winner === "A" ? settled.bGold : settled.aGold;
    const loserXp = result.winner === "A" ? settled.bXp : settled.aXp;
    const blow = result.finalBlow
      ? ` ${result.finalBlow.attackerName} landed the final blow on ${result.finalBlow.targetName} with ${result.finalBlow.move}!`
      : "";
    finalText =
      `🏆 <@${winnerId}> wins!${blow}\n` +
      `Winner: +${fmt(winnerGold)} gold, +${winnerXp} XP` +
      (challenge.wager > 0 ? ` (includes the ${fmt(2 * challenge.wager)} gold wager pot)` : "") +
      ` · Loser: +${fmt(loserGold)} gold, +${loserXp} XP.\n` +
      `⚔️ ${result.roundsFought} rounds.`;
  }
  if (settled.monsterLevelUps.length > 0) {
    finalText += `\n${settled.monsterLevelUps.join("\n")}`;
  }
  // Final card (winner only — a draw keeps the plain-text final edit
  // entirely). The text result rides along as the message content so
  // the outcome stays readable/searchable. On render failure the
  // plain-text final edit is the fallback, level-up lines included.
  let finalPng: Buffer | null = null;
  if (result.winner !== "draw") {
    const winnerName = result.winner === "A" ? aName : bName;
    const winnerXp = result.winner === "A" ? settled.aXp : settled.bXp;
    const winnerStreak = result.winner === "A" ? settled.aStreak : settled.bStreak;
    const lastRound = result.rounds[result.rounds.length - 1];
    const blow = result.finalBlow;
    finalPng = await renderCard({
      aFighters: lastRound?.aFighters ?? result.opening.aFighters,
      bFighters: lastRound?.bFighters ?? result.opening.bFighters,
      round: result.roundsFought,
      actionLine: blow
        ? `${blow.attackerName} landed the final blow on ${blow.targetName} with ${blow.move}!`
        : `${winnerName} wins the battle!`,
      footer: { winnerName, roundsFought: result.roundsFought, winnerXp, winnerStreak },
    });
  }
  try {
    if (finalPng) {
      await inv.editReply({
        content: finalText,
        files: [new AttachmentBuilder(finalPng, { name: "battle.png" })],
        components: [],
      });
    } else {
      await inv.editReply({ content: finalText, components: [] });
    }
  } catch (e) {
    console.error("uwu: battle final edit failed:", e instanceof Error ? e.message : e);
  }
}

async function handleBattleButton(inv: any, ctx: CommandContext): Promise<void> {
  const parts = String(inv.customId ?? "").split(":");
  const action = parts[2] ?? "";
  const challengeId = Number(parts[3] ?? "0");
  const challenge =
    Number.isInteger(challengeId) && challengeId > 0 ? await getChallenge(ctx.db, challengeId) : null;
  if (!challenge) {
    await inv.reply({
      content: "This challenge is gone — send a new one with `uwu battle @user`.",
      ephemeral: true,
    });
    return;
  }
  if (inv.user?.id !== challenge.opponentId) {
    await inv.reply({ content: "Only the challenged trainer can answer this.", ephemeral: true });
    return;
  }
  if (challenge.status !== "pending") {
    await inv.reply({ content: "This challenge is already over.", ephemeral: true });
    return;
  }
  if (Date.now() > challenge.expiresAt) {
    await setChallengeStatus(ctx.db, challenge.id, "expired");
    await inv.deferUpdate();
    await inv.editReply({
      content: "⏰ That battle challenge expired — no answer in 60 seconds. No gold moved.",
      components: [],
    });
    return;
  }
  if (action === "decline") {
    await setChallengeStatus(ctx.db, challenge.id, "declined");
    await inv.deferUpdate();
    await inv.editReply({
      content: `🙅 <@${challenge.opponentId}> declined the battle challenge. No gold moved.`,
      components: [],
    });
    return;
  }
  if (action !== "accept") {
    await inv.reply({ content: "Unknown battle action.", ephemeral: true });
    return;
  }
  await inv.deferUpdate();
  await runAcceptedBattle(inv, ctx, challenge);
}

export const buttonHandlers: Record<string, (inv: any, ctx: CommandContext) => Promise<void>> = {
  "selena:battle": handleBattleButton,
};

export const modalHandlers: Record<string, (...args: never[]) => Promise<void>> = {};
