import type { Command, CommandContext, CommandInvocation } from "../lib/command.js";
import { errorEmbed } from "../lib/command.js";
import type { SelenaDb } from "../lib/db.js";

// ---------------------------------------------------------------------------
// Pure DB helpers (exported so tests can exercise them without Discord).
// ---------------------------------------------------------------------------

export async function recordModAction(
  db: SelenaDb,
  guildId: string,
  userId: string,
  moderatorId: string,
  action: string,
  reason: string | null,
  nowMs = Date.now(),
): Promise<number> {
  const r = await db
    .prepare(
      "INSERT INTO mod_actions (guild_id, user_id, moderator_id, action, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(guildId, userId, moderatorId, action, reason, nowMs);
  return Number(r.lastInsertRowid);
}

export async function warnUser(
  db: SelenaDb,
  guildId: string,
  userId: string,
  moderatorId: string,
  reason: string,
  nowMs = Date.now(),
): Promise<number> {
  const r = await db
    .prepare("INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(guildId, userId, moderatorId, reason, nowMs);
  await recordModAction(db, guildId, userId, moderatorId, "warn", reason, nowMs);
  return Number(r.lastInsertRowid);
}

export interface WarningRow {
  id: number;
  user_id: string;
  moderator_id: string;
  reason: string;
  created_at: number;
}

export async function listWarnings(db: SelenaDb, guildId: string, userId: string): Promise<WarningRow[]> {
  return await db
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

export async function listModActions(db: SelenaDb, guildId: string, limit = 10): Promise<ModActionRow[]> {
  return await db
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

export async function openTicket(db: SelenaDb, guildId: string, userId: string, reason: string | null, nowMs = Date.now()): Promise<TicketRow> {
  const existing = await db
    .prepare("SELECT id, channel_id, user_id, reason, status, created_at, closed_at FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1")
    .get(guildId, userId) as unknown as TicketRow | undefined;
  if (existing) return existing;
  const channelId = `ticket-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const r = await db
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

export async function closeTicket(db: SelenaDb, guildId: string, userId: string, nowMs = Date.now()): Promise<TicketRow | null> {
  const open = await db
    .prepare("SELECT id, channel_id, user_id, reason, status, created_at, closed_at FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1")
    .get(guildId, userId) as unknown as TicketRow | undefined;
  if (!open) return null;
  await db.prepare("UPDATE tickets SET status = 'closed', closed_at = ? WHERE id = ?").run(nowMs, open.id);
  return { ...open, status: "closed", closed_at: nowMs };
}

export async function setReactionRole(
  db: SelenaDb,
  guildId: string,
  channelId: string,
  messageId: string,
  emoji: string,
  roleId: string,
): Promise<void> {
  await db.prepare(
    `INSERT INTO reaction_roles (guild_id, channel_id, message_id, emoji, role_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, message_id, emoji) DO UPDATE SET role_id = excluded.role_id, channel_id = excluded.channel_id`,
  ).run(guildId, channelId, messageId, emoji, roleId);
}

export async function getReactionRole(db: SelenaDb, guildId: string, messageId: string, emoji: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT role_id FROM reaction_roles WHERE guild_id = ? AND message_id = ? AND emoji = ?")
    .get(guildId, messageId, emoji) as { role_id: string } | undefined;
  return row?.role_id ?? null;
}

// ---------------------------------------------------------------------------
// Command plumbing
// ---------------------------------------------------------------------------

type AnyInv = CommandInvocation;

function hasPerm(inv: AnyInv, perm: string): boolean {
  return inv.memberPermissions?.has(perm as never) ?? false;
}

async function deny(inv: AnyInv, perm: string): Promise<void> {
  await inv.reply({
    embeds: [errorEmbed(`You need the \`${perm}\` permission to use this command.`).toJSON()],
    ephemeral: true,
  });
}

/** Best-effort runtime Discord action (timeout/kick/ban). Returns a note. */
async function tryGuildAction(
  inv: AnyInv,
  fn: (guild: never) => Promise<void>,
): Promise<string> {
  const guild = (inv as unknown as { guild?: unknown }).guild;
  if (!guild) return "Discord action skipped — no guild access in this context.";
  try {
    await fn(guild as never);
    return "Discord action applied.";
  } catch (e) {
    return `Discord action failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function targetUser(inv: AnyInv): { id: string; username: string } | null {
  return inv.options.getUser("user");
}

export const buttonHandlers: Record<string, (...args: never[]) => Promise<void>> = {};
export const modalHandlers: Record<string, (...args: never[]) => Promise<void>> = {};

export const commands: Command[] = [
  {
    name: "warn",
    description: "Warn a user and record it",
    aliases: ["warning"],
    args: [{ name: "user", type: "user", required: true }, { name: "reason", type: "string", required: true, rest: true }],
    async execute(inv, ctx) {
      if (!hasPerm(inv, "ModerateMembers")) return deny(inv, "ModerateMembers");
      const target = targetUser(inv);
      const reason = inv.options.getString("reason");
      if (!target || !reason) {
        await inv.reply({ embeds: [errorEmbed("A user and a reason are required.").toJSON()], ephemeral: true });
        return;
      }
      const id = await warnUser(ctx.db, ctx.guildId, target.id, inv.user.id, reason);
      await inv.reply({
        content: `User warned\n${target.username} warned (#${id}).\nReason: ${reason}`,
        ephemeral: true,
      });
    },
  },
  {
    name: "mute",
    description: "Timeout a user for a number of minutes",
    aliases: ["silence"],
    args: [{ name: "user", type: "user", required: true }, { name: "duration-minutes", type: "integer", required: true }, { name: "reason", type: "string", required: true, rest: true }],
    async execute(inv, ctx) {
      if (!hasPerm(inv, "ModerateMembers")) return deny(inv, "ModerateMembers");
      const target = targetUser(inv);
      const minutes = inv.options.getInteger("duration-minutes");
      const reason = inv.options.getString("reason");
      if (!target || minutes === null || !reason) {
        await inv.reply({ embeds: [errorEmbed("A user, a duration and a reason are required.").toJSON()], ephemeral: true });
        return;
      }
      await recordModAction(ctx.db, ctx.guildId, target.id, inv.user.id, "mute", `${reason} (${minutes}m)`);
      const note = await tryGuildAction(inv, async (guild) => {
        const g = guild as unknown as {
          members: { fetch: (id: string) => Promise<{ timeout: (ms: number, reason: string) => Promise<void> }> };
        };
        const member = await g.members.fetch(target.id);
        await member.timeout(minutes * 60_000, reason);
      });
      await inv.reply({
        content: `User muted\n${target.username} muted for ${minutes} minute(s).\nReason: ${reason}\n${note}`,
        ephemeral: true,
      });
    },
  },
  {
    name: "timeout",
    description: "Timeout a user for a number of minutes (alias of /mute)",
    aliases: ["to"],
    args: [{ name: "user", type: "user", required: true }, { name: "duration-minutes", type: "integer", required: true }, { name: "reason", type: "string", required: true, rest: true }],
    async execute(inv, ctx) {
      if (!hasPerm(inv, "ModerateMembers")) return deny(inv, "ModerateMembers");
      const target = targetUser(inv);
      const minutes = inv.options.getInteger("duration-minutes");
      const reason = inv.options.getString("reason");
      if (!target || minutes === null || !reason) {
        await inv.reply({ embeds: [errorEmbed("A user, a duration and a reason are required.").toJSON()], ephemeral: true });
        return;
      }
      await recordModAction(ctx.db, ctx.guildId, target.id, inv.user.id, "timeout", `${reason} (${minutes}m)`);
      const note = await tryGuildAction(inv, async (guild) => {
        const g = guild as unknown as {
          members: { fetch: (id: string) => Promise<{ timeout: (ms: number, reason: string) => Promise<void> }> };
        };
        const member = await g.members.fetch(target.id);
        await member.timeout(minutes * 60_000, reason);
      });
      await inv.reply({
        content: `User timed out\n${target.username} timed out for ${minutes} minute(s).\nReason: ${reason}\n${note}`,
        ephemeral: true,
      });
    },
  },
  {
    name: "kick",
    description: "Kick a user from the server",
    aliases: ["boot"],
    args: [{ name: "user", type: "user", required: true }, { name: "reason", type: "string", required: true, rest: true }],
    async execute(inv, ctx) {
      if (!hasPerm(inv, "KickMembers")) return deny(inv, "KickMembers");
      const target = targetUser(inv);
      const reason = inv.options.getString("reason");
      if (!target || !reason) {
        await inv.reply({ embeds: [errorEmbed("A user and a reason are required.").toJSON()], ephemeral: true });
        return;
      }
      await recordModAction(ctx.db, ctx.guildId, target.id, inv.user.id, "kick", reason);
      const note = await tryGuildAction(inv, async (guild) => {
        const g = guild as unknown as {
          members: { fetch: (id: string) => Promise<{ kick: (reason: string) => Promise<void> }> };
        };
        const member = await g.members.fetch(target.id);
        await member.kick(reason);
      });
      await inv.reply({
        content: `User kicked\n${target.username} was kicked.\nReason: ${reason}\n${note}`,
        ephemeral: true,
      });
    },
  },
  {
    name: "ban",
    description: "Ban a user from the server",
    aliases: ["hammer"],
    args: [{ name: "user", type: "user", required: true }, { name: "delete-days", type: "integer" }, { name: "reason", type: "string", required: true, rest: true }],
    async execute(inv, ctx) {
      if (!hasPerm(inv, "BanMembers")) return deny(inv, "BanMembers");
      const target = targetUser(inv);
      const reason = inv.options.getString("reason");
      const deleteDays = inv.options.getInteger("delete-days") ?? 0;
      if (!target || !reason) {
        await inv.reply({ embeds: [errorEmbed("A user and a reason are required.").toJSON()], ephemeral: true });
        return;
      }
      await recordModAction(ctx.db, ctx.guildId, target.id, inv.user.id, "ban", `${reason} (delete ${deleteDays}d)`);
      const note = await tryGuildAction(inv, async (guild) => {
        const g = guild as unknown as {
          members: { ban: (id: string, opts: { reason: string; deleteMessageDays: number }) => Promise<void> };
        };
        await g.members.ban(target.id, { reason, deleteMessageDays: deleteDays });
      });
      await inv.reply({
        content: `User banned\n${target.username} was banned.\nReason: ${reason}\n${note}`,
        ephemeral: true,
      });
    },
  },
  {
    name: "unban",
    description: "Unban a user by their Discord user ID",
    aliases: ["pardon"],
    args: [{ name: "user-id", type: "string", required: true }, { name: "reason", type: "string", rest: true }],
    async execute(inv, ctx) {
      if (!hasPerm(inv, "BanMembers")) return deny(inv, "BanMembers");
      const userId = inv.options.getString("user-id");
      const reason = inv.options.getString("reason") ?? "No reason given";
      if (!userId) {
        await inv.reply({ embeds: [errorEmbed("A user ID is required.").toJSON()], ephemeral: true });
        return;
      }
      await recordModAction(ctx.db, ctx.guildId, userId, inv.user.id, "unban", reason);
      const note = await tryGuildAction(inv, async (guild) => {
        const g = guild as unknown as {
          members: { unban: (id: string, reason: string) => Promise<void> };
        };
        await g.members.unban(userId, reason);
      });
      await inv.reply({
        content: `User unbanned\n<@${userId}> was unbanned.\nReason: ${reason}\n${note}`,
        ephemeral: true,
      });
    },
  },
  {
    name: "warnings",
    description: "List a user's warnings",
    aliases: ["warns", "infractions"],
    args: [{ name: "user", type: "user", required: true }],
    async execute(inv, ctx) {
      if (!hasPerm(inv, "ModerateMembers")) return deny(inv, "ModerateMembers");
      const target = targetUser(inv);
      if (!target) {
        await inv.reply({ embeds: [errorEmbed("A user is required.").toJSON()], ephemeral: true });
        return;
      }
      const rows = await listWarnings(ctx.db, ctx.guildId, target.id);
      if (rows.length === 0) {
        await inv.reply({
          content: `Warnings\n${target.username} has no warnings.`,
          ephemeral: true,
        });
        return;
      }
      const lines = rows.map(
        (w) => `#${w.id} — ${w.reason} (by <@${w.moderator_id}>, <t:${Math.floor(w.created_at / 1000)}:d>)`,
      );
      await inv.reply({
        content: `Warnings for ${target.username} (${rows.length})\n${lines.join("\n")}`,
        ephemeral: true,
      });
    },
  },
  {
    name: "modlog",
    description: "Show recent moderation actions",
    aliases: ["mlog", "modlogs"],
    args: [{ name: "limit", type: "integer" }],
    async execute(inv, ctx) {
      if (!hasPerm(inv, "ModerateMembers")) return deny(inv, "ModerateMembers");
      const limit = inv.options.getInteger("limit") ?? 10;
      const rows = await listModActions(ctx.db, ctx.guildId, limit);
      if (rows.length === 0) {
        await inv.reply({
          content: "Mod log\nNo moderation actions recorded yet.",
          ephemeral: true,
        });
        return;
      }
      const lines = rows.map(
        (a) => `#${a.id} **${a.action}** <@${a.user_id}> — ${a.reason ?? "no reason"} (by <@${a.moderator_id}>)`,
      );
      await inv.reply({
        content: `Mod log (latest ${rows.length})\n${lines.join("\n")}`,
        ephemeral: true,
      });
    },
  },
  {
    name: "ticket",
    description: "Open or close a support ticket",
    aliases: ["support"],
    args: [{ name: "action", type: "string", required: true }, { name: "reason", type: "string", rest: true }],
    async execute(inv, ctx) {
      const action = inv.options.getString("action");
      const reason = inv.options.getString("reason");
      if (action === "open") {
        if (!reason) {
          await inv.reply({ embeds: [errorEmbed("A reason is required to open a ticket.").toJSON()], ephemeral: true });
          return;
        }
        const ticket = await openTicket(ctx.db, ctx.guildId, inv.user.id, reason);
        // Runtime channel creation is best-effort; the ticket row is the
        // source of truth and exists either way.
        let channelNote = "Ticket recorded — a staff channel will be created when run on a live server.";
        try {
          const guild = (inv as unknown as { guild?: { channels?: { create: (o: unknown) => Promise<{ id: string }> } } }).guild;
          if (guild?.channels) {
            const ch = await guild.channels.create({ name: `ticket-${ticket.id}`, reason });
            channelNote = `Ticket channel: <#${ch.id}>`;
            await ctx.db.prepare("UPDATE tickets SET channel_id = ? WHERE id = ?").run(ch.id, ticket.id);
          }
        } catch (e) {
          channelNote = `Ticket recorded, but channel creation failed: ${e instanceof Error ? e.message : String(e)}`;
        }
        await inv.reply({
          content: `Ticket #${ticket.id} opened\n${reason}\n${channelNote}`,
          ephemeral: true,
        });
        return;
      }
      if (action === "close") {
        const closed = await closeTicket(ctx.db, ctx.guildId, inv.user.id);
        if (!closed) {
          await inv.reply({ embeds: [errorEmbed("You have no open ticket to close.").toJSON()], ephemeral: true });
          return;
        }
        await inv.reply({
          content: `Ticket #${closed.id} closed\nThanks — staff have been notified.`,
          ephemeral: true,
        });
        return;
      }
      await inv.reply({ embeds: [errorEmbed('Action must be "open" or "close".').toJSON()], ephemeral: true });
    },
  },
  {
    name: "reactionrole",
    description: "Map a reaction emoji on a message to a role",
    aliases: ["rr", "reactrole"],
    args: [{ name: "message-id", type: "string", required: true }, { name: "emoji", type: "string", required: true }, { name: "role", type: "role", required: true }],
    async execute(inv, ctx) {
      if (!hasPerm(inv, "ManageRoles")) return deny(inv, "ManageRoles");
      const messageId = inv.options.getString("message-id");
      const emoji = inv.options.getString("emoji");
      const role = inv.options.getRole("role");
      if (!messageId || !emoji || !role) {
        await inv.reply({ embeds: [errorEmbed("A message ID, an emoji and a role are required.").toJSON()], ephemeral: true });
        return;
      }
      const channelId = (inv as unknown as { channelId?: string }).channelId ?? "";
      await setReactionRole(ctx.db, ctx.guildId, channelId, messageId, emoji, role.id);
      await inv.reply({
        content: `Reaction role saved\nReacting ${emoji} on message \`${messageId}\` grants ${role.name}.`,
        ephemeral: true,
      });
    },
  },
];
