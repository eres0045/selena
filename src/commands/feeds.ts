import type { Command, CommandContext, CommandInvocation } from "../lib/command.js";
import { resolveDisplayNames } from "../lib/command.js";
import type { SelenaDb } from "../lib/db.js";
import {
  formatAnnouncement,
  formatRareLog,
  getAnnouncements,
  getRareLogs,
  postAnnouncement,
} from "../lib/feeds.js";

// ---------------------------------------------------------------------------
// Feeds commands (Phase 2 design §11): `uwu announcements`, `uwu announce`,
// `uwu logs`, `uwu setlogchannel`. All replies are plain text, OwO-style;
// feed output never contains `<@id>` mentions (names are resolved display
// names). This module is NOT registered in src/commands/index.ts — the
// coordinator wires it (module key "feeds").
// ---------------------------------------------------------------------------

type AnyInv = CommandInvocation;

function hasPerm(inv: AnyInv, perm: string): boolean {
  return inv.memberPermissions?.has(perm as never) ?? false;
}

async function denyAdmin(inv: AnyInv): Promise<void> {
  await inv.reply({ content: "You need the `Administrator` permission to use this command." });
}

/**
 * Parse a channel argument: `<#123456789012345678>` (channel mention)
 * or a bare channel id. Returns the id, or null when the token does
 * not look like a Discord channel reference. A snowflake is 17–20
 * digits (Discord ids are 17–19 digits today; 20 leaves headroom).
 */
export function parseChannelToken(token: string | null): string | null {
  if (!token) return null;
  const trimmed = token.trim();
  const mention = /^<#(\d+)>$/.exec(trimmed);
  const id = mention ? mention[1]! : trimmed;
  return /^\d{17,20}$/.test(id) ? id : null;
}

/** Store (upsert) a guild's rare-log channel. */
export async function setLogChannel(db: SelenaDb, guildId: string, channelId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO guild_settings (guild_id, log_channel_id) VALUES (?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET log_channel_id = excluded.log_channel_id`,
    )
    .run(guildId, channelId);
}

/** Read a guild's rare-log channel, or null when none is set. */
export async function getLogChannel(db: SelenaDb, guildId: string): Promise<string | null> {
  const row = (await db
    .prepare("SELECT log_channel_id FROM guild_settings WHERE guild_id = ?")
    .get(guildId)) as { log_channel_id: string | null } | undefined;
  return row?.log_channel_id ?? null;
}

/**
 * Split `uwu announce` text on the FIRST `|` into [title, body].
 * Returns null when there is no `|` or either side is empty.
 */
export function splitAnnouncement(text: string | null): [string, string] | null {
  if (!text) return null;
  const pipe = text.indexOf("|");
  if (pipe === -1) return null;
  const title = text.slice(0, pipe).trim();
  const body = text.slice(pipe + 1).trim();
  if (!title || !body) return null;
  return [title, body];
}

export const buttonHandlers: Record<string, (...args: never[]) => Promise<void>> = {};
export const modalHandlers: Record<string, (...args: never[]) => Promise<void>> = {};

export const commands: Command[] = [
  {
    name: "announcements",
    description: "See the latest updates — new monsters, features, events",
    aliases: ["news"],
    async execute(inv, ctx: CommandContext) {
      let rows;
      try {
        rows = await getAnnouncements(ctx.db, 10);
      } catch {
        await inv.reply({ content: "Couldn't load announcements — try again in a bit." });
        return;
      }
      if (rows.length === 0) {
        await inv.reply({ content: "📣 No announcements yet — check back soon!" });
        return;
      }
      await inv.reply({
        content: `📣 Announcements (latest ${rows.length})\n${rows.map(formatAnnouncement).join("\n")}`,
      });
    },
  },
  {
    name: "announce",
    description: "Post an update to the announcements feed (admin only)",
    aliases: ["broadcast"],
    args: [{ name: "text", type: "string", required: true, rest: true }],
    async execute(inv, ctx: CommandContext) {
      if (!hasPerm(inv, "Administrator")) return denyAdmin(inv);
      const split = splitAnnouncement(inv.options.getString("text"));
      if (!split) {
        await inv.reply({
          content: "Usage: `uwu announce <title> | <text>` — separate the title and text with `|`.",
        });
        return;
      }
      const [title, body] = split;
      try {
        await postAnnouncement(ctx.db, title, body, inv.user.id, Date.now());
      } catch (e) {
        await inv.reply({ content: e instanceof Error ? e.message : "Couldn't post that announcement." });
        return;
      }
      await inv.reply({ content: `📣 Announcement posted: ${title}` });
    },
  },
  {
    name: "logs",
    description: "See who caught the rare stuff — Epic+ catches (add global for all of Discord)",
    aliases: ["rarelogs"],
    args: [{ name: "scope", type: "string" }],
    async execute(inv, ctx: CommandContext) {
      const global = inv.options.getString("scope")?.toLowerCase() === "global";
      let rows;
      try {
        rows = await getRareLogs(ctx.db, global ? null : ctx.guildId, 10);
      } catch {
        await inv.reply({ content: "Couldn't load the logs — try again in a bit." });
        return;
      }
      if (rows.length === 0) {
        await inv.reply({ content: "No Epic+ catches logged yet — go `uwu hunt` or `uwu roll`!" });
        return;
      }
      const names = await resolveDisplayNames(inv, rows.map((r) => r.user_id));
      const lines = rows.map((r, i) => formatRareLog(r, names[i] ?? r.user_id));
      await inv.reply({
        content: `✨ Rare catches — ${global ? "all of Discord" : "this server"} (latest ${rows.length})\n${lines.join("\n")}`,
      });
    },
  },
  {
    name: "setlogchannel",
    description: "Set the channel Epic+ catches are auto-posted to (admin only)",
    aliases: ["setlogs"],
    args: [{ name: "channel", type: "string", required: true }],
    async execute(inv, ctx: CommandContext) {
      if (!hasPerm(inv, "Administrator")) return denyAdmin(inv);
      const channelId = parseChannelToken(inv.options.getString("channel"));
      if (!channelId) {
        await inv.reply({
          content: "Give me a channel like `#general` or a channel ID — `uwu setlogchannel #general`.",
        });
        return;
      }
      try {
        await setLogChannel(ctx.db, ctx.guildId, channelId);
      } catch {
        await inv.reply({ content: "Couldn't save that channel — try again in a bit." });
        return;
      }
      await inv.reply({
        content: `Rare catches from this server will now be posted in <#${channelId}>.`,
      });
    },
  },
];
