import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../lib/command.js";
import { errorEmbed, fmt, selenaEmbed } from "../lib/command.js";
import { getUserXp, progressBar, rankCard } from "../lib/levels.js";

/** Build a slash-command definition without the discord.js chained-builder
 * narrowing (chaining .addXOption() narrows SlashCommandBuilder to
 * SlashCommandOptionsOnlyBuilder, which Command.data rejects). */
function build(name: string, description: string, add: (b: SlashCommandBuilder) => void): SlashCommandBuilder {
  const b = new SlashCommandBuilder().setName(name).setDescription(description);
  add(b);
  return b;
}

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

type AnyInteraction = Parameters<Command["execute"]>[0];

function avatarUrlFor(interaction: AnyInteraction, userId: string): string {
  const user = (interaction as unknown as { user?: { displayAvatarURL?: () => string } }).user;
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
    data: build("userinfo", "Show info about a user", (b) => {
      b.addUserOption((o) => o.setName("user").setDescription("User to look up (defaults to you)"));
    }),
    async execute(interaction, ctx) {
      const target = interaction.options.getUser("user") ?? interaction.user;
      const { xp, level } = await getUserXp(ctx.db, ctx.guildId, target.id);
      const afk = await getAfk(ctx.db, ctx.guildId, target.id);
      const embed = selenaEmbed(`User info — ${target.username}`, `ID: \`${target.id}\``)
        .addFields(
          { name: "Level", value: String(level), inline: true },
          { name: "XP", value: fmt(xp), inline: true },
          { name: "AFK", value: afk.reason ? `${afk.reason}` : "No", inline: true },
        );
      await interaction.reply({ embeds: [embed.toJSON()] });
    },
  },
  {
    data: build("avatar", "Show a user's avatar", (b) => {
      b.addUserOption((o) => o.setName("user").setDescription("User whose avatar to show (defaults to you)"));
    }),
    async execute(interaction, ctx) {
      const target = interaction.options.getUser("user") ?? interaction.user;
      const url = avatarUrlFor(interaction, target.id);
      const embed = selenaEmbed(`Avatar — ${target.username}`).setImage(url);
      await interaction.reply({ embeds: [embed.toJSON()] });
    },
  },
  {
    data: build("serverstats", "Show server stats and top members", (b) => {
    }),
    async execute(interaction, ctx) {
      const guild = (interaction as unknown as { guild?: { memberCount?: number; channels?: { cache?: { size?: number } } } }).guild;
      const memberCount =
        guild?.memberCount ??
        Number((await ctx.db.prepare("SELECT COUNT(*) AS c FROM users WHERE guild_id = ?").get(ctx.guildId))?.c ?? 0);
      const channelCount = guild?.channels?.cache?.size;
      const topXp = await topByXp(ctx.db, ctx.guildId, 5);
      const topPoints = await ctx.db
        .prepare("SELECT user_id, points FROM users WHERE guild_id = ? ORDER BY points DESC, user_id ASC LIMIT 5")
        .all(ctx.guildId) as { user_id: string; points: number }[];
      const embed = selenaEmbed("Server stats")
        .addFields(
          { name: "Members", value: fmt(memberCount), inline: true },
          { name: "Channels", value: channelCount !== undefined ? fmt(channelCount) : "Unknown", inline: true },
          {
            name: "Top XP",
            value: topXp.length ? topXp.map((u, i) => `${i + 1}. <@${u.user_id}> — ${fmt(u.xp)} XP`).join("\n") : "No XP yet.",
            inline: false,
          },
          {
            name: "Top points",
            value: topPoints.length ? topPoints.map((u, i) => `${i + 1}. <@${u.user_id}> — ${fmt(u.points)} pts`).join("\n") : "No points yet.",
            inline: false,
          },
        );
      await interaction.reply({ embeds: [embed.toJSON()] });
    },
  },
  {
    data: build("afk", "Set yourself AFK, or clear AFK by running it with no reason", (b) => {
      b.addStringOption((o) => o.setName("reason").setDescription("Why you're away (omit to clear AFK)"));
    }),
    async execute(interaction, ctx) {
      const reason = interaction.options.getString("reason");
      await setAfk(ctx.db, ctx.guildId, interaction.user.id, reason);
      if (reason) {
        await interaction.reply({
          embeds: [selenaEmbed("You're now AFK", `Reason: ${reason}`).toJSON()],
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          embeds: [selenaEmbed("Welcome back", "Your AFK status has been cleared.").toJSON()],
          ephemeral: true,
        });
      }
    },
  },
  {
    data: build("remind", "Remind yourself of something in a number of minutes", (b) => {
      b.addIntegerOption((o) => o.setName("minutes").setDescription("Minutes from now (1-10080)").setRequired(true).setMinValue(1).setMaxValue(10080));
      b.addStringOption((o) => o.setName("text").setDescription("What to remind you about").setRequired(true));
    }),
    async execute(interaction, ctx) {
      const minutes = interaction.options.getInteger("minutes");
      const text = interaction.options.getString("text");
      if (minutes === null || !text) {
        await interaction.reply({ embeds: [errorEmbed("Minutes and reminder text are required.").toJSON()], ephemeral: true });
        return;
      }
      const channelId = (interaction as unknown as { channelId?: string }).channelId ?? "";
      const { id, dueAt } = await createReminder(ctx.db, ctx.guildId, interaction.user.id, channelId, text, minutes);
      await interaction.reply({
        embeds: [selenaEmbed("Reminder set", `I'll remind you in ${minutes} minute(s) (<t:${Math.floor(dueAt / 1000)}:R>): ${text}\nReminder #${id}`).toJSON()],
        ephemeral: true,
      });
    },
  },
  {
    data: build("rank", "Show your rank card (level + XP progress)", (b) => {
      b.addUserOption((o) => o.setName("user").setDescription("User to check (defaults to you)"));
    }),
    async execute(interaction, ctx) {
      const target = interaction.options.getUser("user") ?? interaction.user;
      const { xp } = await getUserXp(ctx.db, ctx.guildId, target.id);
      const card = rankCard(xp);
      const embed = selenaEmbed(`Rank — ${target.username}`)
        .addFields(
          { name: "Level", value: String(card.level), inline: true },
          { name: "XP", value: `${fmt(card.xp)} / ${fmt(card.xpForNext)}`, inline: true },
          { name: "Progress", value: `${progressBar(card.progress)}\n${fmt(card.xpIntoLevel)} XP into this level — ${fmt(card.xpNeeded)} to go`, inline: false },
        );
      await interaction.reply({ embeds: [embed.toJSON()] });
    },
  },
  {
    data: build("leaderboard-xp", "Top 10 members by XP", (b) => {
    }),
    async execute(interaction, ctx) {
      const top = await topByXp(ctx.db, ctx.guildId, 10);
      if (top.length === 0) {
        await interaction.reply({ embeds: [selenaEmbed("XP leaderboard", "No XP earned yet — say something in chat to start earning.").toJSON()] });
        return;
      }
      const lines = top.map((u, i) => `${i + 1}. <@${u.user_id}> — Level ${rankCard(u.xp).level} · ${fmt(u.xp)} XP`);
      await interaction.reply({ embeds: [selenaEmbed("XP leaderboard (top 10)", lines.join("\n")).toJSON()] });
    },
  },
];
