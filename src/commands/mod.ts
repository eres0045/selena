import { SlashCommandBuilder } from "discord.js";
import type { Command, CommandContext } from "../lib/command.js";
import { errorEmbed, selenaEmbed } from "../lib/command.js";
import type { SelenaDb } from "../lib/db.js";

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

export function recordModAction(
  db: SelenaDb,
  guildId: string,
  userId: string,
  moderatorId: string,
  action: string,
  reason: string | null,
  nowMs = Date.now(),
): number {
  const r = db
    .prepare(
      "INSERT INTO mod_actions (guild_id, user_id, moderator_id, action, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(guildId, userId, moderatorId, action, reason, nowMs);
  return Number(r.lastInsertRowid);
}

export function warnUser(
  db: SelenaDb,
  guildId: string,
  userId: string,
  moderatorId: string,
  reason: string,
  nowMs = Date.now(),
): number {
  const r = db
    .prepare("INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(guildId, userId, moderatorId, reason, nowMs);
  recordModAction(db, guildId, userId, moderatorId, "warn", reason, nowMs);
  return Number(r.lastInsertRowid);
}

export interface WarningRow {
  id: number;
  user_id: string;
  moderator_id: string;
  reason: string;
  created_at: number;
}

export function listWarnings(db: SelenaDb, guildId: string, userId: string): WarningRow[] {
  return db
    .prepare("SELECT id, user_id, moderator_id, reason, created_at FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC")
    .all(guildId, userId) as unknown as WarningRow[];
}

export interface ModActionRow {
  id: number;
  user_id: string;
  moderator_id: string;
  action: string;
  reason: string | null;
  created_at: number;
}

export function listModActions(db: SelenaDb, guildId: string, limit = 10): ModActionRow[] {
  return db
    .prepare("SELECT id, user_id, moderator_id, action, reason, created_at FROM mod_actions WHERE guild_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(guildId, limit) as unknown as ModActionRow[];
}

export interface TicketRow {
  id: number;
  channel_id: string;
  user_id: string;
  reason: string | null;
  status: string;
  created_at: number;
  closed_at: number | null;
}

export function openTicket(db: SelenaDb, guildId: string, userId: string, reason: string | null, nowMs = Date.now()): TicketRow {
  const existing = db
    .prepare("SELECT id, channel_id, user_id, reason, status, created_at, closed_at FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1")
    .get(guildId, userId) as unknown as TicketRow | undefined;
  if (existing) return existing;
  const channelId = `ticket-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const r = db
    .prepare("INSERT INTO tickets (guild_id, channel_id, user_id, reason, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)")
    .run(guildId, channelId, userId, reason, nowMs);
  return {
    id: Number(r.lastInsertRowid),
    channel_id: channelId,
    user_id: userId,
    reason,
    status: "open",
    created_at: nowMs,
    closed_at: null,
  };
}

export function closeTicket(db: SelenaDb, guildId: string, userId: string, nowMs = Date.now()): TicketRow | null {
  const open = db
    .prepare("SELECT id, channel_id, user_id, reason, status, created_at, closed_at FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1")
    .get(guildId, userId) as unknown as TicketRow | undefined;
  if (!open) return null;
  db.prepare("UPDATE tickets SET status = 'closed', closed_at = ? WHERE id = ?").run(nowMs, open.id);
  return { ...open, status: "closed", closed_at: nowMs };
}

export function setReactionRole(
  db: SelenaDb,
  guildId: string,
  channelId: string,
  messageId: string,
  emoji: string,
  roleId: string,
): void {
  db.prepare(
    `INSERT INTO reaction_roles (guild_id, channel_id, message_id, emoji, role_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, message_id, emoji) DO UPDATE SET role_id = excluded.role_id, channel_id = excluded.channel_id`,
  ).run(guildId, channelId, messageId, emoji, roleId);
}

export function getReactionRole(db: SelenaDb, guildId: string, messageId: string, emoji: string): string | null {
  const row = db
    .prepare("SELECT role_id FROM reaction_roles WHERE guild_id = ? AND message_id = ? AND emoji = ?")
    .get(guildId, messageId, emoji) as { role_id: string } | undefined;
  return row?.role_id ?? null;
}

// ---------------------------------------------------------------------------
// Command plumbing
// ---------------------------------------------------------------------------

type AnyInteraction = Parameters<Command["execute"]>[0];

function hasPerm(interaction: AnyInteraction, perm: string): boolean {
  return interaction.memberPermissions?.has(perm as never) ?? false;
}

async function deny(interaction: AnyInteraction, perm: string): Promise<void> {
  await interaction.reply({
    embeds: [errorEmbed(`You need the \`${perm}\` permission to use this command.`).toJSON()],
    ephemeral: true,
  });
}

/** Best-effort runtime Discord action (timeout/kick/ban). Returns a note. */
async function tryGuildAction(
  interaction: AnyInteraction,
  fn: (guild: never) => Promise<void>,
): Promise<string> {
  const guild = (interaction as unknown as { guild?: unknown }).guild;
  if (!guild) return "Discord action skipped — no guild access in this context.";
  try {
    await fn(guild as never);
    return "Discord action applied.";
  } catch (e) {
    return `Discord action failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function targetUser(interaction: AnyInteraction): { id: string; username: string } | null {
  return interaction.options.getUser("user");
}

export const buttonHandlers: Record<string, (...args: never[]) => Promise<void>> = {};
export const modalHandlers: Record<string, (...args: never[]) => Promise<void>> = {};

export const commands: Command[] = [
  {
    data: build("warn", "Warn a user and record it", (b) => {
      b.addUserOption((o) => o.setName("user").setDescription("User to warn").setRequired(true));
      b.addStringOption((o) => o.setName("reason").setDescription("Reason for the warning").setRequired(true));
    }),
    async execute(interaction, ctx) {
      if (!hasPerm(interaction, "ModerateMembers")) return deny(interaction, "ModerateMembers");
      const target = targetUser(interaction);
      const reason = interaction.options.getString("reason");
      if (!target || !reason) {
        await interaction.reply({ embeds: [errorEmbed("A user and a reason are required.").toJSON()], ephemeral: true });
        return;
      }
      const id = warnUser(ctx.db, ctx.guildId, target.id, interaction.user.id, reason);
      await interaction.reply({
        embeds: [selenaEmbed("User warned", `**${target.username}** warned (#${id}).\nReason: ${reason}`).toJSON()],
        ephemeral: true,
      });
    },
  },
  {
    data: build("mute", "Timeout a user for a number of minutes", (b) => {
      b.addUserOption((o) => o.setName("user").setDescription("User to mute").setRequired(true));
      b.addIntegerOption((o) => o.setName("duration-minutes").setDescription("Timeout length in minutes (1-40320)").setRequired(true).setMinValue(1).setMaxValue(40320));
      b.addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true));
    }),
    async execute(interaction, ctx) {
      if (!hasPerm(interaction, "ModerateMembers")) return deny(interaction, "ModerateMembers");
      const target = targetUser(interaction);
      const minutes = interaction.options.getInteger("duration-minutes");
      const reason = interaction.options.getString("reason");
      if (!target || minutes === null || !reason) {
        await interaction.reply({ embeds: [errorEmbed("A user, a duration and a reason are required.").toJSON()], ephemeral: true });
        return;
      }
      recordModAction(ctx.db, ctx.guildId, target.id, interaction.user.id, "mute", `${reason} (${minutes}m)`);
      const note = await tryGuildAction(interaction, async (guild) => {
        const g = guild as unknown as {
          members: { fetch: (id: string) => Promise<{ timeout: (ms: number, reason: string) => Promise<void> }> };
        };
        const member = await g.members.fetch(target.id);
        await member.timeout(minutes * 60_000, reason);
      });
      await interaction.reply({
        embeds: [selenaEmbed("User muted", `**${target.username}** muted for ${minutes} minute(s).\nReason: ${reason}\n${note}`).toJSON()],
        ephemeral: true,
      });
    },
  },
  {
    data: build("timeout", "Timeout a user for a number of minutes (alias of /mute)", (b) => {
      b.addUserOption((o) => o.setName("user").setDescription("User to timeout").setRequired(true));
      b.addIntegerOption((o) => o.setName("duration-minutes").setDescription("Timeout length in minutes (1-40320)").setRequired(true).setMinValue(1).setMaxValue(40320));
      b.addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true));
    }),
    async execute(interaction, ctx) {
      if (!hasPerm(interaction, "ModerateMembers")) return deny(interaction, "ModerateMembers");
      const target = targetUser(interaction);
      const minutes = interaction.options.getInteger("duration-minutes");
      const reason = interaction.options.getString("reason");
      if (!target || minutes === null || !reason) {
        await interaction.reply({ embeds: [errorEmbed("A user, a duration and a reason are required.").toJSON()], ephemeral: true });
        return;
      }
      recordModAction(ctx.db, ctx.guildId, target.id, interaction.user.id, "timeout", `${reason} (${minutes}m)`);
      const note = await tryGuildAction(interaction, async (guild) => {
        const g = guild as unknown as {
          members: { fetch: (id: string) => Promise<{ timeout: (ms: number, reason: string) => Promise<void> }> };
        };
        const member = await g.members.fetch(target.id);
        await member.timeout(minutes * 60_000, reason);
      });
      await interaction.reply({
        embeds: [selenaEmbed("User timed out", `**${target.username}** timed out for ${minutes} minute(s).\nReason: ${reason}\n${note}`).toJSON()],
        ephemeral: true,
      });
    },
  },
  {
    data: build("kick", "Kick a user from the server", (b) => {
      b.addUserOption((o) => o.setName("user").setDescription("User to kick").setRequired(true));
      b.addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true));
    }),
    async execute(interaction, ctx) {
      if (!hasPerm(interaction, "KickMembers")) return deny(interaction, "KickMembers");
      const target = targetUser(interaction);
      const reason = interaction.options.getString("reason");
      if (!target || !reason) {
        await interaction.reply({ embeds: [errorEmbed("A user and a reason are required.").toJSON()], ephemeral: true });
        return;
      }
      recordModAction(ctx.db, ctx.guildId, target.id, interaction.user.id, "kick", reason);
      const note = await tryGuildAction(interaction, async (guild) => {
        const g = guild as unknown as {
          members: { fetch: (id: string) => Promise<{ kick: (reason: string) => Promise<void> }> };
        };
        const member = await g.members.fetch(target.id);
        await member.kick(reason);
      });
      await interaction.reply({
        embeds: [selenaEmbed("User kicked", `**${target.username}** was kicked.\nReason: ${reason}\n${note}`).toJSON()],
        ephemeral: true,
      });
    },
  },
  {
    data: build("ban", "Ban a user from the server", (b) => {
      b.addUserOption((o) => o.setName("user").setDescription("User to ban").setRequired(true));
      b.addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true));
      b.addIntegerOption((o) => o.setName("delete-days").setDescription("Days of messages to delete (0-7)").setMinValue(0).setMaxValue(7));
    }),
    async execute(interaction, ctx) {
      if (!hasPerm(interaction, "BanMembers")) return deny(interaction, "BanMembers");
      const target = targetUser(interaction);
      const reason = interaction.options.getString("reason");
      const deleteDays = interaction.options.getInteger("delete-days") ?? 0;
      if (!target || !reason) {
        await interaction.reply({ embeds: [errorEmbed("A user and a reason are required.").toJSON()], ephemeral: true });
        return;
      }
      recordModAction(ctx.db, ctx.guildId, target.id, interaction.user.id, "ban", `${reason} (delete ${deleteDays}d)`);
      const note = await tryGuildAction(interaction, async (guild) => {
        const g = guild as unknown as {
          members: { ban: (id: string, opts: { reason: string; deleteMessageDays: number }) => Promise<void> };
        };
        await g.members.ban(target.id, { reason, deleteMessageDays: deleteDays });
      });
      await interaction.reply({
        embeds: [selenaEmbed("User banned", `**${target.username}** was banned.\nReason: ${reason}\n${note}`).toJSON()],
        ephemeral: true,
      });
    },
  },
  {
    data: build("unban", "Unban a user by their Discord user ID", (b) => {
      b.addStringOption((o) => o.setName("user-id").setDescription("Discord user ID to unban").setRequired(true));
      b.addStringOption((o) => o.setName("reason").setDescription("Reason"));
    }),
    async execute(interaction, ctx) {
      if (!hasPerm(interaction, "BanMembers")) return deny(interaction, "BanMembers");
      const userId = interaction.options.getString("user-id");
      const reason = interaction.options.getString("reason") ?? "No reason given";
      if (!userId) {
        await interaction.reply({ embeds: [errorEmbed("A user ID is required.").toJSON()], ephemeral: true });
        return;
      }
      recordModAction(ctx.db, ctx.guildId, userId, interaction.user.id, "unban", reason);
      const note = await tryGuildAction(interaction, async (guild) => {
        const g = guild as unknown as {
          members: { unban: (id: string, reason: string) => Promise<void> };
        };
        await g.members.unban(userId, reason);
      });
      await interaction.reply({
        embeds: [selenaEmbed("User unbanned", `<@${userId}> was unbanned.\nReason: ${reason}\n${note}`).toJSON()],
        ephemeral: true,
      });
    },
  },
  {
    data: build("warnings", "List a user's warnings", (b) => {
      b.addUserOption((o) => o.setName("user").setDescription("User to check").setRequired(true));
    }),
    async execute(interaction, ctx) {
      if (!hasPerm(interaction, "ModerateMembers")) return deny(interaction, "ModerateMembers");
      const target = targetUser(interaction);
      if (!target) {
        await interaction.reply({ embeds: [errorEmbed("A user is required.").toJSON()], ephemeral: true });
        return;
      }
      const rows = listWarnings(ctx.db, ctx.guildId, target.id);
      if (rows.length === 0) {
        await interaction.reply({
          embeds: [selenaEmbed("Warnings", `**${target.username}** has no warnings.`).toJSON()],
          ephemeral: true,
        });
        return;
      }
      const lines = rows.map(
        (w) => `#${w.id} — ${w.reason} (by <@${w.moderator_id}>, <t:${Math.floor(w.created_at / 1000)}:d>)`,
      );
      await interaction.reply({
        embeds: [selenaEmbed(`Warnings for ${target.username} (${rows.length})`, lines.join("\n")).toJSON()],
        ephemeral: true,
      });
    },
  },
  {
    data: build("modlog", "Show recent moderation actions", (b) => {
      b.addIntegerOption((o) => o.setName("limit").setDescription("How many entries (default 10)").setMinValue(1).setMaxValue(25));
    }),
    async execute(interaction, ctx) {
      if (!hasPerm(interaction, "ModerateMembers")) return deny(interaction, "ModerateMembers");
      const limit = interaction.options.getInteger("limit") ?? 10;
      const rows = listModActions(ctx.db, ctx.guildId, limit);
      if (rows.length === 0) {
        await interaction.reply({
          embeds: [selenaEmbed("Mod log", "No moderation actions recorded yet.").toJSON()],
          ephemeral: true,
        });
        return;
      }
      const lines = rows.map(
        (a) => `#${a.id} **${a.action}** <@${a.user_id}> — ${a.reason ?? "no reason"} (by <@${a.moderator_id}>)`,
      );
      await interaction.reply({
        embeds: [selenaEmbed(`Mod log (latest ${rows.length})`, lines.join("\n")).toJSON()],
        ephemeral: true,
      });
    },
  },
  {
    data: build("ticket", "Open or close a support ticket", (b) => {
      b.addStringOption((o) =>
        o.setName("action").setDescription("open or close").setRequired(true).addChoices(
          { name: "open", value: "open" },
          { name: "close", value: "close" },
        ),
      );
      b.addStringOption((o) => o.setName("reason").setDescription("What do you need help with? (for open)"));
    }),
    async execute(interaction, ctx) {
      const action = interaction.options.getString("action");
      const reason = interaction.options.getString("reason");
      if (action === "open") {
        if (!reason) {
          await interaction.reply({ embeds: [errorEmbed("A reason is required to open a ticket.").toJSON()], ephemeral: true });
          return;
        }
        const ticket = openTicket(ctx.db, ctx.guildId, interaction.user.id, reason);
        // Runtime channel creation is best-effort; the ticket row is the
        // source of truth and exists either way.
        let channelNote = "Ticket recorded — a staff channel will be created when run on a live server.";
        try {
          const guild = (interaction as unknown as { guild?: { channels?: { create: (o: unknown) => Promise<{ id: string }> } } }).guild;
          if (guild?.channels) {
            const ch = await guild.channels.create({ name: `ticket-${ticket.id}`, reason });
            channelNote = `Ticket channel: <#${ch.id}>`;
            ctx.db.prepare("UPDATE tickets SET channel_id = ? WHERE id = ?").run(ch.id, ticket.id);
          }
        } catch (e) {
          channelNote = `Ticket recorded, but channel creation failed: ${e instanceof Error ? e.message : String(e)}`;
        }
        await interaction.reply({
          embeds: [selenaEmbed(`Ticket #${ticket.id} opened`, `${reason}\n${channelNote}`).toJSON()],
          ephemeral: true,
        });
        return;
      }
      if (action === "close") {
        const closed = closeTicket(ctx.db, ctx.guildId, interaction.user.id);
        if (!closed) {
          await interaction.reply({ embeds: [errorEmbed("You have no open ticket to close.").toJSON()], ephemeral: true });
          return;
        }
        await interaction.reply({
          embeds: [selenaEmbed(`Ticket #${closed.id} closed`, "Thanks — staff have been notified.").toJSON()],
          ephemeral: true,
        });
        return;
      }
      await interaction.reply({ embeds: [errorEmbed('Action must be "open" or "close".').toJSON()], ephemeral: true });
    },
  },
  {
    data: build("reactionrole", "Map a reaction emoji on a message to a role", (b) => {
      b.addStringOption((o) => o.setName("message-id").setDescription("ID of the message to watch").setRequired(true));
      b.addStringOption((o) => o.setName("emoji").setDescription("Emoji (unicode or custom name)").setRequired(true));
      b.addRoleOption((o) => o.setName("role").setDescription("Role to grant").setRequired(true));
    }),
    async execute(interaction, ctx) {
      if (!hasPerm(interaction, "ManageRoles")) return deny(interaction, "ManageRoles");
      const messageId = interaction.options.getString("message-id");
      const emoji = interaction.options.getString("emoji");
      const role = interaction.options.getRole("role");
      if (!messageId || !emoji || !role) {
        await interaction.reply({ embeds: [errorEmbed("A message ID, an emoji and a role are required.").toJSON()], ephemeral: true });
        return;
      }
      const channelId = (interaction as unknown as { channelId?: string }).channelId ?? "";
      setReactionRole(ctx.db, ctx.guildId, channelId, messageId, emoji, role.id);
      await interaction.reply({
        embeds: [selenaEmbed("Reaction role saved", `Reacting ${emoji} on message \`${messageId}\` grants **${role.name}**.`).toJSON()],
        ephemeral: true,
      });
    },
  },
];
