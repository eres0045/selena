import { allCommands } from "../commands/index.js";
import {
  errorEmbed,
  type Command,
  type CommandInvocation,
  type CommandOptions,
  type CommandRole,
  type CommandUser,
  type CommandContext,
  type ReplyPayload,
} from "./command.js";

/**
 * OwO-style text prefix routing: `uwu <command> [args...]`.
 *
 * This module owns everything slash commands used to do at the edge:
 * parsing the prefix, resolving names/aliases, turning positional text
 * tokens into the getString/getInteger/getUser/getRole accessors the
 * commands already use, and adapting a plain message into a
 * CommandInvocation (reply/editReply/deferReply). It also owns the
 * empty slash-command registration: on every startup the bot clears ALL
 * application commands (global + guild) so the "/" picker stays empty.
 */

export const PREFIX = "uwu";

/** Reply for a bare `uwu` with no command. */
export const HELP_POINTER = "Not sure what to do? Type `uwu help` to see all commands.";

/** Reply for `uwu <something-that-isnt-a-command>`. */
export const UNKNOWN_COMMAND = "Unknown command — try `uwu help`.";

/**
 * The registration payload for slash commands: always empty. There are
 * no slash commands anymore — nothing is ever registered, and the
 * clear-on-ready step sets exactly this (empty) set.
 */
export const SLASH_COMMAND_REGISTRATION_BODY: readonly unknown[] = [];

// ---------------------------------------------------------------------------
// Prefix parsing
// ---------------------------------------------------------------------------

export interface ParsedPrefix {
  /** Lowercased command word, or null for a bare `uwu`. */
  name: string | null;
  /** Tokens after the command word. */
  args: string[];
}

/**
 * Split text into tokens, keeping double-quoted spans together as one
 * token (quotes stripped): `poll "Best game?" slots bj` ->
 * ["poll", "Best game?", "slots", "bj"].
 */
export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let inQuotes = false;
  let hasToken = false;
  for (const ch of input) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      hasToken = true;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (hasToken || cur.length > 0) tokens.push(cur);
      cur = "";
      hasToken = false;
      continue;
    }
    cur += ch;
    hasToken = true;
  }
  if (hasToken || cur.length > 0) tokens.push(cur);
  return tokens;
}

/**
 * Parse a message's content as a prefix invocation. Returns null when
 * the content does not start with the `uwu` prefix (case-insensitive,
 * `uwu` + space or end of message — `uwubal` is not a command).
 */
export function parsePrefix(content: string): ParsedPrefix | null {
  const trimmed = content.trimStart();
  if (!/^uwu(?=\s|$)/i.test(trimmed)) return null;
  const rest = trimmed.slice(PREFIX.length).trim();
  if (!rest) return { name: null, args: [] };
  const tokens = tokenizeArgs(rest);
  if (tokens.length === 0) return { name: null, args: [] };
  return { name: tokens[0]!.toLowerCase(), args: tokens.slice(1) };
}

/** Resolve a command word (name or alias, case-insensitive) to its command. */
export function resolveCommand(name: string): Command | undefined {
  const lower = name.toLowerCase();
  return allCommands.find((c) => c.name === lower || c.aliases.includes(lower));
}

// ---------------------------------------------------------------------------
// Argument parsing (positional text -> slash-style accessors)
// ---------------------------------------------------------------------------

/** `<@123>`, `<@!123>` or a bare numeric id -> the id, else null. */
export function parseUserToken(token: string): string | null {
  const m = /^<@!?(\d+)>$/.exec(token) ?? /^(\d+)$/.exec(token);
  return m ? m[1]! : null;
}

/** `<@&123>` or a bare numeric id -> the id, else null. */
export function parseRoleToken(token: string): string | null {
  const m = /^<@&(\d+)>$/.exec(token) ?? /^(\d+)$/.exec(token);
  return m ? m[1]! : null;
}

function mentionedUser(message: PrefixMessageLike, id: string): CommandUser | null {
  const users = (message as unknown as { mentions?: { users?: { get: (id: string) => unknown } } }).mentions?.users;
  const u = users?.get(id) as { id: string; username: string } | undefined;
  return u ? { id: u.id, username: u.username } : null;
}

function guildMembersCache(
  message: PrefixMessageLike,
): { get: (id: string) => unknown; find?: (fn: (m: unknown) => boolean) => unknown } | undefined {
  return (message as unknown as { guild?: { members?: { cache?: unknown } } }).guild?.members?.cache as
    | { get: (id: string) => unknown; find?: (fn: (m: unknown) => boolean) => unknown }
    | undefined;
}

function guildRolesCache(
  message: PrefixMessageLike,
): { get: (id: string) => unknown; find?: (fn: (m: unknown) => boolean) => unknown } | undefined {
  return (message as unknown as { guild?: { roles?: { cache?: unknown } } }).guild?.roles?.cache as
    | { get: (id: string) => unknown; find?: (fn: (m: unknown) => boolean) => unknown }
    | undefined;
}

function cachedMemberUser(message: PrefixMessageLike, id: string): CommandUser | null {
  const m = guildMembersCache(message)?.get(id) as { user?: { id: string; username: string } } | undefined;
  return m?.user ? { id: m.user.id, username: m.user.username } : null;
}

function cachedMemberByUsername(message: PrefixMessageLike, name: string): CommandUser | null {
  const cache = guildMembersCache(message);
  const m = cache?.find?.(
    (v) => (v as { user?: { username?: string } }).user?.username?.toLowerCase() === name.toLowerCase(),
  ) as { user?: { id: string; username: string } } | undefined;
  return m?.user ? { id: m.user.id, username: m.user.username } : null;
}

/**
 * Resolve one user token. Mention/ID tokens always resolve (falling back
 * to the id itself as the display name when the user isn't in the
 * mentions or member cache); a bare username resolves from the member
 * cache; anything else is null (the command falls back to its default,
 * e.g. the invoker, or replies with its usual "pick a member" error).
 */
export function resolveUserToken(message: PrefixMessageLike, token: string): CommandUser | null {
  const id = parseUserToken(token);
  if (id) {
    return mentionedUser(message, id) ?? cachedMemberUser(message, id) ?? { id, username: id };
  }
  return cachedMemberByUsername(message, token);
}

function resolveRoleToken(message: PrefixMessageLike, token: string): CommandRole | null {
  const id = parseRoleToken(token);
  const cache = guildRolesCache(message);
  if (id) {
    const r = cache?.get(id) as { id: string; name: string } | undefined;
    return r ? { id: r.id, name: r.name } : { id, name: id };
  }
  const r = cache?.find?.(
    (v) => (v as { name?: string }).name?.toLowerCase() === token.toLowerCase(),
  ) as { id: string; name: string } | undefined;
  return r ? { id: r.id, name: r.name } : null;
}

class TextOptions implements CommandOptions {
  constructor(private values: Map<string, unknown>) {}

  getString(name: string): string | null {
    const v = this.values.get(name);
    return typeof v === "string" ? v : null;
  }

  getInteger(name: string): number | null {
    const v = this.values.get(name);
    return typeof v === "number" ? Math.trunc(v) : null;
  }

  getNumber(name: string): number | null {
    const v = this.values.get(name);
    return typeof v === "number" ? v : null;
  }

  getBoolean(name: string): boolean | null {
    const v = this.values.get(name);
    return typeof v === "boolean" ? v : null;
  }

  getUser(name: string): CommandUser | null {
    const v = this.values.get(name);
    return v && typeof v === "object" ? (v as CommandUser) : null;
  }

  getRole(name: string): CommandRole | null {
    const v = this.values.get(name);
    return v && typeof v === "object" ? (v as CommandRole) : null;
  }
}

/**
 * Build the slash-style accessors for a command from its positional
 * tokens, following the command's arg spec in order. A `rest` arg eats
 * all remaining tokens. An optional integer that doesn't parse as an
 * integer is left null WITHOUT consuming its token (so e.g.
 * `uwu ban @user spamming` still sees the reason); a required integer
 * consumes its token and reads back null on bad input, so the command's
 * usual validation error fires.
 */
export function buildOptions(command: Command, tokens: string[], message: PrefixMessageLike): CommandOptions {
  const values = new Map<string, unknown>();
  let cursor = 0;
  for (const spec of command.args ?? []) {
    if (spec.rest) {
      const rest = tokens.slice(cursor).join(" ").trim();
      values.set(spec.name, rest ? rest : null);
      cursor = tokens.length;
      continue;
    }
    const token = tokens[cursor];
    if (token === undefined) {
      values.set(spec.name, null);
      continue;
    }
    switch (spec.type) {
      case "string":
        values.set(spec.name, token);
        cursor++;
        break;
      case "integer": {
        const n = /^-?\d+$/.test(token) ? Number(token) : null;
        if (n !== null || spec.required) cursor++;
        values.set(spec.name, n);
        break;
      }
      case "user": {
        const user = resolveUserToken(message, token);
        if (user !== null || spec.required || parseUserToken(token) !== null) cursor++;
        values.set(spec.name, user);
        break;
      }
      case "role": {
        const role = resolveRoleToken(message, token);
        if (role !== null || spec.required || parseRoleToken(token) !== null) cursor++;
        values.set(spec.name, role);
        break;
      }
    }
  }
  return new TextOptions(values);
}

// ---------------------------------------------------------------------------
// Message adapter (CommandInvocation over a plain message)
// ---------------------------------------------------------------------------

/** Minimal shape of a discord.js Message the router needs. */
export interface SentMessageLike {
  id: string;
  edit(payload: ReplyPayload): Promise<unknown>;
}

export interface PrefixMessageLike {
  content: string;
  author: { id: string; username: string; bot?: boolean; displayName?: string; displayAvatarURL?: () => string };
  webhookId?: string | null;
  guildId?: string | null;
  channelId?: string;
  guild?: unknown;
  member?: { permissions?: { has: (perm: never) => boolean } } | null;
  reply(payload: ReplyPayload): Promise<SentMessageLike>;
  channel: { send(payload: ReplyPayload): Promise<SentMessageLike> };
}

/** Drop interaction-only keys (messages can't be ephemeral). */
function stripInteractionOnly(payload: ReplyPayload): ReplyPayload {
  const { ephemeral: _ephemeral, ...rest } = payload;
  return rest;
}

export class MessageInvocation implements CommandInvocation {
  readonly user: CommandUser;
  readonly guildId: string;
  readonly guild?: unknown;
  readonly channelId?: string;
  readonly memberPermissions?: { has: (perm: never) => boolean };
  readonly options: CommandOptions;
  private sent: SentMessageLike | null = null;

  constructor(
    private message: PrefixMessageLike,
    command: Command,
    args: string[],
  ) {
    this.user = message.author as CommandUser;
    this.guildId = message.guildId ?? "";
    this.guild = message.guild;
    this.channelId = message.channelId;
    this.memberPermissions = message.member?.permissions ?? undefined;
    this.options = buildOptions(command, args, message);
  }

  async reply(payload: ReplyPayload): Promise<void> {
    if (this.sent) {
      await this.editReply(payload);
      return;
    }
    this.sent = await this.message.reply(stripInteractionOnly(payload));
  }

  /** No-op on the text path: messages have no 3s ack window to beat. */
  async deferReply(): Promise<void> {
    return;
  }

  async editReply(payload: ReplyPayload): Promise<{ id: string }> {
    const clean = stripInteractionOnly(payload);
    if (this.sent) {
      await this.sent.edit(clean);
      return this.sent;
    }
    // Deferred but nothing sent yet (the common casino flow): send the
    // message now. Later edits target this same message, so the
    // single-GIF games still animate in place.
    this.sent = await this.message.channel.send(clean);
    return this.sent;
  }

  async followUp(payload: ReplyPayload): Promise<void> {
    await this.message.channel.send(stripInteractionOnly(payload));
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Handle one message as a possible prefix command. Returns true when the
 * message was a prefix invocation (handled — the caller should skip XP /
 * auto-mod for it), false otherwise (bots, webhooks, non-prefixed
 * messages, DMs). Never throws for unknown commands or bad args: those
 * get a short reply instead.
 */
export async function handlePrefixMessage(
  message: PrefixMessageLike,
  ctx: CommandContext,
): Promise<boolean> {
  if (message.author?.bot) return false;
  if (message.webhookId) return false;
  const parsed = parsePrefix(message.content);
  if (!parsed) return false;
  if (!message.guildId) return false;
  if (parsed.name === null) {
    await message.reply({ content: HELP_POINTER });
    return true;
  }
  const command = resolveCommand(parsed.name);
  if (!command) {
    await message.reply({ content: UNKNOWN_COMMAND });
    return true;
  }
  const inv = new MessageInvocation(message, command, parsed.args);
  try {
    await command.execute(inv, { ...ctx, guildId: message.guildId });
  } catch (e) {
    console.error("uwu: prefix command error:", e instanceof Error ? e.message : e);
    try {
      await inv.reply({ embeds: [errorEmbed("Couldn't run that — try again in a bit.")] });
    } catch {
      /* already replied / no channel — nothing to do */
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Slash-command removal (clear-on-ready)
// ---------------------------------------------------------------------------

export interface ApplicationCommandManagerLike {
  set(commands: readonly unknown[]): Promise<{ size: number } | unknown>;
}

export interface ClearableClient {
  application?: { commands?: ApplicationCommandManagerLike } | null;
  guilds?: { fetch: (id: string) => Promise<{ commands?: ApplicationCommandManagerLike } | null> };
}

/**
 * Clear ALL application (slash) commands — global AND the guild's —
 * leaving zero registered. Runs on every startup (idempotent). Returns
 * how many commands remained afterwards (0 / 0 when fully clear;
 * null when that scope wasn't reachable).
 */
export async function clearApplicationCommands(
  client: ClearableClient,
  guildId?: string | null,
): Promise<{ global: number | null; guild: number | null }> {
  let global: number | null = null;
  let guild: number | null = null;
  const appCommands = client.application?.commands;
  if (appCommands) {
    const result = (await appCommands.set(SLASH_COMMAND_REGISTRATION_BODY)) as { size?: number } | undefined;
    global = typeof result?.size === "number" ? result.size : 0;
  }
  if (guildId) {
    try {
      const guildObj = await client.guilds?.fetch(guildId);
      const guildCommands = guildObj?.commands;
      if (guildCommands) {
        const result = (await guildCommands.set([])) as { size?: number } | undefined;
        guild = typeof result?.size === "number" ? result.size : 0;
      }
    } catch (e) {
      console.error("uwu: failed to clear guild slash commands:", e instanceof Error ? e.message : e);
    }
  }
  return { global, guild };
}
