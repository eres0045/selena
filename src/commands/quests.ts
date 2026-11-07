import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { Command, CommandContext, CommandInvocation, ReplyPayload } from "../lib/command.js";
import { fmt } from "../lib/command.js";
import {
  buildQuestLogEmbed,
  claimQuests,
  getQuestLog,
  rewardText,
  type QuestLogEntry,
} from "../lib/quests.js";

/**
 * Daily quest commands (Worker C):
 *
 *   uwu quests            today's quest log (embed + Claim button)
 *   uwu q                 alias
 *   uwu quests claim      claim every completed quest (gold + gems)
 *
 * Quests are DAILY + GLOBAL: the same 3 quests for everyone, picked
 * deterministically from the pool by UTC date (src/lib/quests.ts).
 * They reset at midnight UTC. No reroll, no lock in v1 — each user
 * tracks their own progress against the shared set, and claims pay
 * out once per quest per day (claimQuests is one transaction with an
 * INSERT OR IGNORE once-only guard).
 */

const CLAIM_BUTTON_ID = "selena:quests:claim";

function claimButtonRow(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(CLAIM_BUTTON_ID)
        .setLabel("🎁 Claim")
        .setStyle(ButtonStyle.Success),
    ),
  ];
}

function displayNameOf(inv: CommandInvocation): string {
  return inv.user.displayName ?? inv.user.username;
}

/** Fresh quest-log payload for a user: embed + Claim button. */
async function questLogPayload(
  db: CommandContext["db"],
  userId: string,
  displayName: string,
): Promise<ReplyPayload> {
  const log = await getQuestLog(db, userId);
  return {
    embeds: [buildQuestLogEmbed(log, displayName).toJSON()],
    components: claimButtonRow(),
  };
}

/** One claim attempt, as reply text. Shared by `uwu quests claim` and the Claim button. */
async function claimText(
  db: CommandContext["db"],
  guildId: string,
  userId: string,
): Promise<{ text: string; claimed: QuestLogEntry[] }> {
  const { claimed, totalGold, totalGems } = await claimQuests(db, guildId, userId);
  if (claimed.length === 0) {
    const log = await getQuestLog(db, userId);
    const alreadyClaimed = log.quests.filter((q) => q.completed && q.claimed);
    if (alreadyClaimed.length > 0) {
      const names = alreadyClaimed.map((q) => q.def.title).join(", ");
      return {
        text:
          `Nothing left to claim — you already claimed ${alreadyClaimed.length} quest${alreadyClaimed.length > 1 ? "s" : ""} today (${names}). ` +
          `New quests arrive at midnight UTC.`,
        claimed,
      };
    }
    return { text: "Nothing to claim — finish a quest first. See `uwu quests` for today's quests.", claimed };
  }
  const lines = claimed.map((q) => `• ${q.def.title} — ${rewardText(q.def)}`);
  const total =
    totalGems > 0
      ? `+${fmt(totalGold)} gold + ${totalGems} gem${totalGems > 1 ? "s" : ""}`
      : `+${fmt(totalGold)} gold`;
  return {
    text:
      `🎁 Claimed ${claimed.length} quest${claimed.length > 1 ? "s" : ""} — ${total}:\n` +
      lines.join("\n"),
    claimed,
  };
}

export const commands: Command[] = [
  {
    name: "quests",
    description: "Show today's daily quests.",
    aliases: ["q"],
    args: [{ name: "action", type: "string" }],
    async execute(inv, ctx) {
      const action = (inv.options.getString("action") ?? "").trim().toLowerCase();
      if (action === "claim") {
        const { text } = await claimText(ctx.db, ctx.guildId, inv.user.id);
        await inv.reply({ content: text });
        return;
      }
      // Unknown first arg shows the log (never an error) — same as no-arg.
      await inv.reply(await questLogPayload(ctx.db, inv.user.id, displayNameOf(inv)));
    },
  },
];

/**
 * Claim button (`selena:quests:claim`). Routed by the first two
 * customId segments (`selena:quests`, see src/index.ts) — the same
 * convention as the tower list buttons (`selena:tower:list:<page>`).
 * Runs the same claim flow as `uwu quests claim`, then UPDATES the
 * quest message in place with the fresh embed (claimed quests show
 * ✅ Claimed) and the claim result as the message content. Falls back
 * to an ephemeral reply when the interaction can't be updated.
 */
async function handleClaimButton(inv: any, ctx: CommandContext): Promise<void> {
  const userId = String(inv.user?.id ?? "");
  try {
    const { text } = await claimText(ctx.db, ctx.guildId, userId);
    const displayName = String(inv.user?.displayName ?? inv.user?.username ?? "you");
    const payload = await questLogPayload(ctx.db, userId, displayName);
    await inv.update({ content: text, ...payload });
  } catch (e) {
    try {
      await inv.reply({ content: "Couldn't claim that — try `uwu quests claim` again.", ephemeral: true });
    } catch {
      // The interaction is already answered/expired; nothing more to do.
    }
    // Swallowed like the tower list handler: the fallback reply above
    // is the user-visible error; no rethrow (index.ts would only log it).
  }
}

export const buttonHandlers: Record<string, (...args: never[]) => Promise<void>> = {
  "selena:quests": handleClaimButton as (...args: never[]) => Promise<void>,
};

export const modalHandlers: Record<string, (...args: never[]) => Promise<void>> = {};
