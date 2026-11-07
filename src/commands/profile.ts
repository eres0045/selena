import { AttachmentBuilder } from "discord.js";
import type { Command, CommandContext, CommandInvocation, ReplyPayload } from "../lib/command.js";
import { errorEmbed } from "../lib/command.js";
import { getBalance } from "../lib/economy.js";
import { getUserXp, rankCard } from "../lib/levels.js";
import { getGems } from "../lib/market.js";
import { getUserGuild } from "../lib/guilds.js";
import {
  ABOUT_MAX_CHARS,
  equipBackground,
  findBackground,
  getGlobalRank,
  getUserProfile,
  setAbout,
} from "../lib/profile.js";
import { backgroundPath } from "../lib/profileBgs.js";
import { renderProfileCard } from "../lib/profileCard.js";

/**
 * Profile commands (Worker C):
 *
 *   uwu profile            your profile card (800x500 animated GIF)
 *   uwu profile bg <name>  equip an owned background (same as `uwu bg`)
 *   uwu bg <name>          equip an owned background by name or id
 *   uwu about <text>       set your About Me line (max 100 chars;
 *                          empty shows the current one)
 *
 * The card is sent as an image attachment (profile.gif). On ANY render
 * failure the command falls back to the plain-text errorEmbed path —
 * never a crash, never a broken file. Backgrounds are bought in the
 * shop (`uwu shop bg`, `uwu shop buy bg <name>`), not here.
 */

async function replyError(
  inv: { reply: (p: ReplyPayload) => Promise<void> },
  msg: string,
): Promise<void> {
  await inv.reply({ embeds: [errorEmbed(msg).toJSON()] });
}

/** Fetch the user's avatar bytes, or null when there is none / it fails. */
async function fetchAvatarBuffer(inv: CommandInvocation): Promise<Buffer | null> {
  const urlFn = (inv.user as { displayAvatarURL?: () => string }).displayAvatarURL;
  if (typeof urlFn !== "function") return null;
  let url: string;
  try {
    url = urlFn();
  } catch {
    return null;
  }
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function handleEquip(
  inv: CommandInvocation,
  ctx: CommandContext,
  query: string,
): Promise<void> {
  const q = query.trim();
  if (!q) {
    await replyError(inv, "Which background? `uwu bg <name>` — see `uwu shop bg` for the full list.");
    return;
  }
  const bg = findBackground(q);
  if (!bg) {
    await replyError(inv, `I don't know a background called "${q}" — see \`uwu shop bg\` for the full list.`);
    return;
  }
  try {
    const res = await equipBackground(ctx.db, inv.user.id, bg.id);
    if (!res.ok) {
      await replyError(inv, res.error ?? "Couldn't equip that background.");
      return;
    }
    await inv.reply({ content: `🖼️ Equipped **${res.bgName}** as your profile background. See it with \`uwu profile\`.` });
  } catch (e) {
    console.error("uwu: bg equip failed:", e instanceof Error ? e.message : e);
    await replyError(inv, "Couldn't equip that background — try again in a bit.");
  }
}

async function handleProfileShow(inv: CommandInvocation, ctx: CommandContext): Promise<void> {
  const userId = inv.user.id;
  try {
    const profile = await getUserProfile(ctx.db, userId);
    const bgPath = backgroundPath(profile.equippedBg);
    if (!bgPath) {
      await replyError(
        inv,
        "Profile backgrounds aren't available yet — the background catalogue hasn't landed. Try again later.",
      );
      return;
    }
    const { xp } = await getUserXp(ctx.db, ctx.guildId, userId);
    const card = rankCard(xp);
    const rank = await getGlobalRank(ctx.db, userId);
    const balance = await getBalance(ctx.db, ctx.guildId, userId);
    const gems = await getGems(ctx.db, userId);
    const monstersRow = (await ctx.db
      .prepare("SELECT COALESCE(SUM(count), 0) AS total FROM user_monsters WHERE guild_id = ? AND user_id = ?")
      .get(ctx.guildId, userId)) as { total: number } | undefined;
    const guild = await getUserGuild(ctx.db, userId);
    const avatarBuffer = await fetchAvatarBuffer(inv);
    const gif = await renderProfileCard({
      backgroundPath: bgPath,
      avatarBuffer,
      displayName: inv.user.displayName ?? inv.user.username,
      level: card.level,
      rank,
      xpIntoLevel: card.xpIntoLevel,
      xpForNextLevel: card.xpIntoLevel + card.xpNeeded,
      gold: balance.points,
      gems,
      about: profile.about,
      monstersCaught: Number(monstersRow?.total ?? 0),
      guildName: guild ? guild.name : null,
    });
    const attachment = new AttachmentBuilder(gif, { name: "profile.gif" });
    await inv.reply({ files: [attachment] });
  } catch (e) {
    // ANY render failure (renderer missing, avatar fetch blew up, card
    // draw failed) lands here: plain-text error, never a crash.
    console.error("uwu: profile card failed:", e instanceof Error ? e.message : e);
    await replyError(inv, "Couldn't draw your profile card right now — try again in a bit.");
  }
}

async function handleAbout(
  inv: CommandInvocation,
  ctx: CommandContext,
  text: string | null,
): Promise<void> {
  try {
    if (text === null || text.trim() === "") {
      const profile = await getUserProfile(ctx.db, inv.user.id);
      await inv.reply({
        content: profile.about
          ? `Your About Me:\n"${profile.about}"\nChange it with \`uwu about <text>\` (max ${ABOUT_MAX_CHARS} chars).`
          : `You haven't set an About Me yet — set one with \`uwu about <text>\` (max ${ABOUT_MAX_CHARS} chars).`,
      });
      return;
    }
    const res = await setAbout(ctx.db, inv.user.id, text);
    if (!res.ok) {
      await replyError(inv, res.error ?? "Couldn't set your About Me.");
      return;
    }
    await inv.reply({ content: `✏️ Your About Me is now:\n"${res.about}"` });
  } catch (e) {
    console.error("uwu: about failed:", e instanceof Error ? e.message : e);
    await replyError(inv, "Couldn't set your About Me — try again in a bit.");
  }
}

export const commands: Command[] = [
  {
    name: "profile",
    description: "Show your profile card (level, rank, gold, gems, monsters, guild).",
    aliases: ["p"],
    args: [
      { name: "action", type: "string" },
      { name: "target", type: "string", rest: true },
    ],
    async execute(inv, ctx) {
      const action = (inv.options.getString("action") ?? "").trim().toLowerCase();
      const target = inv.options.getString("target") ?? "";
      if (action === "bg") return handleEquip(inv, ctx, target);
      if (action) {
        await inv.reply({
          content: "`uwu profile` shows your card · `uwu profile bg <name>` equips a background you own.",
        });
        return;
      }
      return handleProfileShow(inv, ctx);
    },
  },
  {
    name: "bg",
    description: "Equip a profile background you own (by name or id).",
    aliases: ["background"],
    args: [{ name: "name", type: "string", rest: true }],
    async execute(inv, ctx) {
      return handleEquip(inv, ctx, inv.options.getString("name") ?? "");
    },
  },
  {
    name: "about",
    description: "Set your About Me line for your profile card (max 100 chars).",
    aliases: ["aboutme"],
    args: [{ name: "text", type: "string", rest: true }],
    async execute(inv, ctx) {
      return handleAbout(inv, ctx, inv.options.getString("text"));
    },
  },
];

export const buttonHandlers: Record<string, (...args: never[]) => Promise<void>> = {};

export const modalHandlers: Record<string, (...args: never[]) => Promise<void>> = {};
