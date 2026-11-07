import { EmbedBuilder } from "discord.js";
import type { ImageURLOptions } from "discord.js";
import type { SelenaDb } from "./db.js";

export interface CommandContext {
  db: SelenaDb;
  /** Guild the command ran in (always present for guild text commands). */
  guildId: string;
}

/** A user as a command sees them (a real discord.js User also satisfies this). */
export interface CommandUser {
  id: string;
  username: string;
  /** Global display name (discord.js User.displayName); absent in fakes. */
  displayName?: string;
  /**
   * Real discord.js signature (ImageURLOptions): callers pass
   * { extension: "png", size: 256, forceStatic: true } to force a still
   * PNG. NEVER detach this method and call it unbound — it reads
   * `this.avatarURL` and throws (that silent throw was the profile-card
   * avatar bug: every card rendered the "?" placeholder).
   */
  displayAvatarURL?: (options?: ImageURLOptions) => string;
}

/** A role as a command sees it. */
export interface CommandRole {
  id: string;
  name: string;
}

/**
 * Option accessors with the same shape the old slash commands used
 * (getString / getInteger / getUser / getRole), so command logic reads
 * its arguments the same way regardless of how they were supplied.
 * Values come from the positional text tokens after `uwu <command>`.
 */
export interface CommandOptions {
  getString(name: string): string | null;
  getInteger(name: string): number | null;
  getNumber(name: string): number | null;
  getBoolean(name: string): boolean | null;
  getUser(name: string): CommandUser | null;
  getRole(name: string): CommandRole | null;
}

/** Payload a command can reply with (content, embeds, components, files). */
export interface ReplyPayload {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
  files?: unknown[];
  /** Accepted and ignored on the text path (messages can't be ephemeral). */
  ephemeral?: boolean;
}

/**
 * What a command executes against: the message-path adapter. It mirrors
 * the small slice of ChatInputCommandInteraction the commands actually
 * use (options, user, guildId, reply/editReply/deferReply), backed by a
 * plain Discord message instead of an interaction. `reply` after a
 * `deferReply` is delivered by `editReply`, exactly like the old
 * defer-then-edit flow; `editReply` before any reply just sends the
 * message. Buttons (MessageComponent interactions) are NOT routed
 * through this — they keep their real interaction handlers.
 */
export interface CommandInvocation {
  user: CommandUser;
  guildId: string;
  /** Real guild when available (moderation actions, ticket channels). */
  guild?: unknown;
  channelId?: string;
  memberPermissions?: { has: (perm: never) => boolean };
  options: CommandOptions;
  reply(payload: ReplyPayload): Promise<void>;
  editReply(payload: ReplyPayload): Promise<{ id: string }>;
  deferReply(): Promise<void>;
  followUp(payload: ReplyPayload): Promise<void>;
}

/** One positional text argument, in the order it follows the command name. */
export interface ArgSpec {
  name: string;
  type: "string" | "integer" | "user" | "role";
  /**
   * When true the argument is required. A missing required argument
   * reads back as null and the command replies with its usual error.
   */
  required?: boolean;
  /**
   * When true the argument consumes ALL remaining tokens, joined with
   * spaces (free text: questions, reasons, reminder text).
   */
  rest?: boolean;
}

/**
 * A text (prefix) command: `uwu <name> [args...]`. No slash-command
 * builder, no registration payload — the name, description, aliases and
 * positional arg spec are the whole definition, and `execute` runs
 * against a CommandInvocation.
 */
export interface Command {
  name: string;
  description: string;
  /** Short aliases, e.g. `bal` for `balance`, `cf` for `coinflip`. */
  aliases: string[];
  /** Positional args, in order. Omit when the command takes none. */
  args?: ArgSpec[];
  execute: (invocation: CommandInvocation, ctx: CommandContext) => Promise<void>;
}

export const SELENA_COLOR = 0x8b5cf6; // violet, Selena's theme

export function selenaEmbed(title: string, description?: string): EmbedBuilder {
  const e = new EmbedBuilder().setColor(SELENA_COLOR).setTitle(title);
  if (description) e.setDescription(description);
  return e;
}

export function errorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder().setColor(0xef4444).setTitle("That didn't work").setDescription(message);
}

export function pointsEmbed(title: string, description: string): EmbedBuilder {
  return selenaEmbed(title, description).setFooter({ text: "uwu gold is fun-only — no real money." });
}

/** Format an integer with thousands separators. */
export function fmt(n: number): string {
  return Math.trunc(n).toLocaleString("en-US");
}

/**
 * Resolve user IDs to plain display names for list output (leaderboards).
 * Uses the real guild's member list when available; falls back to the raw
 * ID when there is no guild access (tests) or the member cannot be fetched
 * (left the server). Names are PLAIN TEXT — never `<@id>` mentions — so
 * showing a leaderboard never pings anyone on it, no matter how many
 * people view it.
 */
export async function resolveDisplayNames(
  inv: CommandInvocation,
  userIds: string[],
): Promise<string[]> {
  const guild = (inv as unknown as { guild?: { members: { fetch: (id: string) => Promise<{ displayName: string }> } } }).guild;
  if (!guild) return userIds;
  return Promise.all(
    userIds.map(async (id) => {
      try {
        return (await guild.members.fetch(id)).displayName;
      } catch {
        return id;
      }
    }),
  );
}
