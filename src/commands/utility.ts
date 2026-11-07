import type { Command, CommandInvocation } from "../lib/command.js";
import { errorEmbed, fmt } from "../lib/command.js";
import { getUserXp, progressBar, rankCard } from "../lib/levels.js";

// ---------------------------------------------------------------------------
// Pure DB helpers (exported so tests can exercise them without Discord).
// ---------------------------------------------------------------------------

export async function setAfk(db: Parameters<typeof getUserXp>[0], guildId: string, userId: string, reason: string | null, nowMs = Date.now()): Promise<void> {
  await db.prepare(
    `INSERT INTO users (guild_id, user_id, afk_reason, afk_since) VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET afk_reason = excluded.afk_reason, afk_since = excluded.afk_since`,
  ).run(guildId, userId, reason, reason ? nowMs : null);
}

export async function getAfk(db: Parameters<typeof getUserXp>[0], guildId: string, userId: string): Promise<{ reason: string | null; since: number | null }> {
  const row = await db.prepare("SELECT afk_reason, afk_since FROM users WHERE guild_id = ? AND user_id = ?").get(guildId, userId) as
    | { afk_reason: string | null; afk_since: number | null }
    | undefined;
  return { reason: row?.afk_reason ?? null, since: row?.afk_since ?? null };
}

export async function createReminder(
  db: Parameters<typeof getUserXp>[0],
  guildId: string,
  userId: string,
  channelId: string,
  text: string,
  minutes: number,
  nowMs = Date.now(),
): Promise<{ id: number; dueAt: number }> {
  const dueAt = nowMs + Math.floor(minutes) * 60_000;
  const r = await db
    .prepare("INSERT INTO reminders (guild_id, user_id, channel_id, text, due_at, delivered, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
    .run(guildId, userId, channelId, text, dueAt, nowMs);
  return { id: Number(r.lastInsertRowid), dueAt };
}

export interface LeaderboardEntry {
  user_id: string;
  xp: number;
  points: number;
}

export async function topByXp(db: Parameters<typeof getUserXp>[0], guildId: string, limit = 10): Promise<LeaderboardEntry[]> {
  return await db
    .prepare("SELECT user_id, xp, points FROM users WHERE guild_id = ? ORDER BY xp DESC, user_id ASC LIMIT ?")
    .all(guildId, limit) as unknown as LeaderboardEntry[];
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

type AnyInv = CommandInvocation;

function avatarUrlFor(inv: AnyInv, userId: string): string {
  const user = (inv as unknown as { user?: { displayAvatarURL?: () => string } }).user;
  // Real discord.js Users have displayAvatarURL(); the test fake does not,
  // so fall back to the deterministic default-avatar CDN URL.
  if (typeof user?.displayAvatarURL === "function") {
    try {
      return user.displayAvatarURL();
    } catch {
      /* fall through */
    }
  }
  // Default avatar index: (user id >> 22) % 6 (Discord's formula).
  let idx = 0;
  try {
    idx = Number((BigInt(userId) >> 22n) % 6n);
  } catch {
    idx = 0;
  }
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

export const buttonHandlers: Record<string, (...args: never[]) => Promise<void>> = {};
export const modalHandlers: Record<string, (...args: never[]) => Promise<void>> = {};

export const commands: Command[] = [
  {
    name: "userinfo",
    description: "Show info about a user",
    aliases: ["ui", "whois", "user"],
    args: [{ name: "user", type: "user" }],
    async execute(inv, ctx) {
      const target = inv.options.getUser("user") ?? inv.user;
      const { xp, level } = await getUserXp(ctx.db, ctx.guildId, target.id);
      const afk = await getAfk(ctx.db, ctx.guildId, target.id);
      await inv.reply({
        content:
          `User info — ${target.username}\nID: \`${target.id}\`\n` +
          `Level: ${level} · XP: ${fmt(xp)} · AFK: ${afk.reason ? afk.reason : "No"}`,
      });
    },
  },
  {
    name: "avatar",
    description: "Show a user's avatar",
    aliases: ["av", "pfp"],
    args: [{ name: "user", type: "user" }],
    async execute(inv, ctx) {
      const target = inv.options.getUser("user") ?? inv.user;
      const url = avatarUrlFor(inv, target.id);
      // Plain text with the URL (Discord still shows a preview) — no
      // embed box, no attached image.
      await inv.reply({ content: `Avatar — ${target.username}\n${url}` });
    },
  },
  {
    name: "serverstats",
    description: "Show server stats and top members",
    aliases: ["serverinfo", "stats", "server"],
    async execute(inv, ctx) {
      const guild = (inv as unknown as { guild?: { memberCount?: number; channels?: { cache?: { size?: number } } } }).guild;
      const memberCount =
        guild?.memberCount ??
        Number((await ctx.db.prepare("SELECT COUNT(*) AS c FROM users WHERE guild_id = ?").get(ctx.guildId))?.c ?? 0);
      const channelCount = guild?.channels?.cache?.size;
      const topXp = await topByXp(ctx.db, ctx.guildId, 5);
      const topPoints = await ctx.db
        .prepare("SELECT user_id, points FROM users WHERE guild_id = ? ORDER BY points DESC, user_id ASC LIMIT 5")
        .all(ctx.guildId) as { user_id: string; points: number }[];
      const topXpText = topXp.length
        ? topXp.map((u, i) => `${i + 1}. <@${u.user_id}> — ${fmt(u.xp)} XP`).join("\n")
        : "No XP yet.";
      const topGoldText = topPoints.length
        ? topPoints.map((u, i) => `${i + 1}. <@${u.user_id}> — ${fmt(u.points)} gold`).join("\n")
        : "No gold yet.";
      await inv.reply({
        content:
          `Server stats\nMembers: ${fmt(memberCount)} · Channels: ${channelCount !== undefined ? fmt(channelCount) : "Unknown"}\n` +
          `Top XP:\n${topXpText}\nTop gold:\n${topGoldText}`,
      });
    },
  },
  {
    name: "afk",
    description: "Set yourself AFK, or clear AFK by running it with no reason",
    aliases: ["away"],
    args: [{ name: "reason", type: "string", rest: true }],
    async execute(inv, ctx) {
      const reason = inv.options.getString("reason");
      await setAfk(ctx.db, ctx.guildId, inv.user.id, reason);
      if (reason) {
        await inv.reply({
          content: `You're now AFK\nReason: ${reason}`,
          ephemeral: true,
        });
      } else {
        await inv.reply({
          content: "Welcome back\nYour AFK status has been cleared.",
          ephemeral: true,
        });
      }
    },
  },
  {
    name: "remind",
    description: "Remind yourself of something in a number of minutes",
    aliases: ["reminder", "remindme"],
    args: [{ name: "minutes", type: "integer", required: true }, { name: "text", type: "string", required: true, rest: true }],
    async execute(inv, ctx) {
      const minutes = inv.options.getInteger("minutes");
      const text = inv.options.getString("text");
      if (minutes === null || !text) {
        await inv.reply({ embeds: [errorEmbed("Minutes and reminder text are required.").toJSON()], ephemeral: true });
        return;
      }
      const channelId = (inv as unknown as { channelId?: string }).channelId ?? "";
      const { id, dueAt } = await createReminder(ctx.db, ctx.guildId, inv.user.id, channelId, text, minutes);
      await inv.reply({
        content: `Reminder set\nI'll remind you in ${minutes} minute(s) (<t:${Math.floor(dueAt / 1000)}:R>): ${text}\nReminder #${id}`,
        ephemeral: true,
      });
    },
  },
  {
    name: "rank",
    description: "Show your rank card (level + XP progress)",
    aliases: ["level", "xp"],
    args: [{ name: "user", type: "user" }],
    async execute(inv, ctx) {
      const target = inv.options.getUser("user") ?? inv.user;
      const { xp } = await getUserXp(ctx.db, ctx.guildId, target.id);
      const card = rankCard(xp);
      await inv.reply({
        content:
          `Rank — ${target.username}\nLevel: ${card.level} · XP: ${fmt(card.xp)} / ${fmt(card.xpForNext)}\n` +
          `Progress: ${progressBar(card.progress)}\n${fmt(card.xpIntoLevel)} XP into this level — ${fmt(card.xpNeeded)} to go`,
      });
    },
  },
  {
    name: "leaderboard-xp",
    description: "Top 10 members by XP",
    aliases: ["lbxp", "xplb", "top-xp"],
    async execute(inv, ctx) {
      const top = await topByXp(ctx.db, ctx.guildId, 10);
      if (top.length === 0) {
        await inv.reply({
          content: "XP leaderboard\nNo XP earned yet — say something in chat to start earning.",
        });
        return;
      }
      const lines = top.map((u, i) => `${i + 1}. <@${u.user_id}> — Level ${rankCard(u.xp).level} · ${fmt(u.xp)} XP`);
      await inv.reply({ content: `XP leaderboard (top 10)\n${lines.join("\n")}` });
    },
  },
];
