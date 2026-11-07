import { describe, expect, it, beforeEach } from "vitest";
import type { SelenaDb } from "../src/lib/db.js";
import { getTestDb } from "./testDb.js";
import { addPoints } from "../src/lib/economy.js";
import { allCommands, HELP_GROUPS } from "../src/commands/index.js";
import {
  HELP_POINTER,
  MessageInvocation,
  SLASH_COMMAND_REGISTRATION_BODY,
  UNKNOWN_COMMAND_FALLBACK,
  UNKNOWN_COMMAND_LINES,
  buildOptions,
  clearApplicationCommands,
  handlePrefixMessage,
  parsePrefix,
  resolveCommand,
  tokenizeArgs,
  unknownCommandReply,
  type PrefixMessageLike,
} from "../src/lib/router.js";
import type { Command } from "../src/lib/command.js";

const GUILD = "guild-1";

// ---------------------------------------------------------------------------
// Fake prefix message (minimal PrefixMessageLike).
// ---------------------------------------------------------------------------

class FakePrefixMessage implements PrefixMessageLike {
  content: string;
  author: { id: string; username: string; bot?: boolean };
  webhookId: string | null = null;
  guildId: string | null = GUILD;
  channelId = "chan-1";
  guild: unknown = null;
  member: null = null;
  mentions = { users: new Map<string, { id: string; username: string }>() };
  replies: Record<string, unknown>[] = [];
  channelSends: Record<string, unknown>[] = [];
  sentEdits: Record<string, unknown>[] = [];
  channel: { send: (payload: Record<string, unknown>) => Promise<{ id: string; edit: (p: Record<string, unknown>) => Promise<unknown> }> };

  constructor(content: string, opts: { userId?: string; username?: string; bot?: boolean; webhookId?: string | null; guildId?: string | null } = {}) {
    this.content = content;
    this.author = { id: opts.userId ?? "user-1", username: opts.username ?? "tester", bot: opts.bot ?? false };
    if (opts.webhookId !== undefined) this.webhookId = opts.webhookId;
    if (opts.guildId !== undefined) this.guildId = opts.guildId;
    this.channel = {
      send: async (payload) => {
        this.channelSends.push(payload);
        return {
          id: "msg-2",
          edit: async (p: Record<string, unknown>) => {
            this.sentEdits.push(p);
          },
        };
      },
    };
  }

  async reply(payload: Record<string, unknown>): Promise<{ id: string; edit: (p: Record<string, unknown>) => Promise<unknown> }> {
    this.replies.push(payload);
    return {
      id: "msg-1",
      edit: async (p: Record<string, unknown>) => {
        this.sentEdits.push(p);
      },
    };
  }

  /** Concatenated text of everything the bot sent for this message. */
  allText(): string {
    const parts: string[] = [];
    for (const p of [...this.replies, ...this.channelSends, ...this.sentEdits]) {
      if (typeof p.content === "string") parts.push(p.content);
      for (const e of (p.embeds as Array<{ title?: string; description?: string; fields?: Array<{ name: string; value: string }> }> | undefined) ?? []) {
        if (e.title) parts.push(e.title);
        if (e.description) parts.push(e.description);
        for (const f of e.fields ?? []) parts.push(`${f.name}: ${f.value}`);
      }
    }
    return parts.join("\n");
  }
}

let db: SelenaDb;

beforeEach(() => {
  db = getTestDb();
});

// ---------------------------------------------------------------------------
// Prefix parsing
// ---------------------------------------------------------------------------

describe("parsePrefix", () => {
  it("parses `uwu <command> <args>`", () => {
    expect(parsePrefix("uwu bal")).toEqual({ name: "bal", args: [] });
    expect(parsePrefix("uwu cf 10 heads")).toEqual({ name: "cf", args: ["10", "heads"] });
  });

  it("is case-insensitive and tolerates extra spaces", () => {
    expect(parsePrefix("UWU BAL")).toEqual({ name: "bal", args: [] });
    expect(parsePrefix("UwU   help")).toEqual({ name: "help", args: [] });
    expect(parsePrefix("  uwu daily")).toEqual({ name: "daily", args: [] });
  });

  it("treats a bare `uwu` (even with trailing spaces) as no command", () => {
    expect(parsePrefix("uwu")).toEqual({ name: null, args: [] });
    expect(parsePrefix("uwu   ")).toEqual({ name: null, args: [] });
  });

  it("rejects non-prefixed messages and `uwu` glued to another word", () => {
    expect(parsePrefix("hello uwu bal")).toBeNull();
    expect(parsePrefix("uwubal")).toBeNull();
    expect(parsePrefix("uwu-bot bal")).toBeNull();
    expect(parsePrefix("")).toBeNull();
  });
});

describe("tokenizeArgs", () => {
  it("keeps double-quoted spans together as one token", () => {
    expect(tokenizeArgs('poll "Best game?" slots blackjack')).toEqual(["poll", "Best game?", "slots", "blackjack"]);
    expect(tokenizeArgs('giveaway "Big prize night" 60 2')).toEqual(["giveaway", "Big prize night", "60", "2"]);
    expect(tokenizeArgs("rate pizza is great")).toEqual(["rate", "pizza", "is", "great"]);
  });
});

// ---------------------------------------------------------------------------
// Command resolution / alias table
// ---------------------------------------------------------------------------

describe("resolveCommand / alias table", () => {
  it("resolves every command by name", () => {
    expect(allCommands.length).toBe(42);
    for (const cmd of allCommands) {
      expect(resolveCommand(cmd.name)).toBe(cmd);
    }
  });

  it("resolves natural short aliases for a sample of commands", () => {
    expect(resolveCommand("bal")?.name).toBe("balance");
    expect(resolveCommand("cf")?.name).toBe("coinflip");
    expect(resolveCommand("lb")?.name).toBe("leaderboard");
    expect(resolveCommand("bj")?.name).toBe("blackjack");
    expect(resolveCommand("ttt")?.name).toBe("tictactoe");
    expect(resolveCommand("c4")?.name).toBe("connect4");
    expect(resolveCommand("h")?.name).toBe("help");
    expect(resolveCommand("lbxp")?.name).toBe("leaderboard-xp");
    expect(resolveCommand("rr")?.name).toBe("reactionrole");
  });

  it("has no alias collisions and every command has a name, description and aliases", () => {
    const names = new Set(allCommands.map((c) => c.name));
    const seenAliases = new Set<string>();
    for (const cmd of allCommands) {
      expect(cmd.name.length).toBeGreaterThan(0);
      expect(cmd.description.length).toBeGreaterThan(0);
      expect(cmd.aliases.length).toBeGreaterThan(0);
      // No slash-command builder data survives on any command.
      expect("data" in cmd).toBe(false);
      for (const a of cmd.aliases) {
        expect(names.has(a)).toBe(false);
        expect(seenAliases.has(a)).toBe(false);
        seenAliases.add(a);
      }
    }
  });

  it("returns undefined for unknown words", () => {
    expect(resolveCommand("frobnicate")).toBeUndefined();
  });

  it("the removed Fun commands (and every alias) resolve to nothing", () => {
    // 2026-11-07: Ronit removed the whole Fun category — 8ball, meme,
    // ship, rate, joke, roast, compliment, wouldyourather, truthordare,
    // uwu, profile. None of them (nor any alias) may resolve anymore,
    // and the help box must not list a Fun group.
    for (const name of [
      "8ball", "8b", "eightball", "ask",
      "meme", "memes",
      "ship", "love",
      "rate", "rating",
      "joke", "jokes",
      "roast", "burn",
      "compliment", "comp", "praise",
      "wouldyourather", "wyr", "rather",
      "truthordare", "tod",
      "uwu", "uwuify", "owo",
      "profile", "prof", "me",
    ]) {
      expect(resolveCommand(name)).toBeUndefined();
    }
    expect(HELP_GROUPS.some((g) => g.category === "Fun")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Arg parsing / validation
// ---------------------------------------------------------------------------

describe("buildOptions", () => {
  function optsFor(commandName: string, tokens: string[], msg = new FakePrefixMessage("uwu")) {
    const cmd = allCommands.find((c) => c.name === commandName)!;
    return buildOptions(cmd, tokens, msg);
  }

  it("parses integer amounts and rejects non-integers as null", () => {
    expect(optsFor("coinflip", ["10", "heads"]).getInteger("bet")).toBe(10);
    expect(optsFor("coinflip", ["abc", "heads"]).getInteger("bet")).toBeNull();
    expect(optsFor("coinflip", ["10.5", "heads"]).getInteger("bet")).toBeNull();
    expect(optsFor("coinflip", ["-5", "heads"]).getInteger("bet")).toBe(-5);
  });

  it("parses user mentions and bare IDs, resolving the username from mentions", () => {
    const msg = new FakePrefixMessage("uwu give <@222> 10");
    msg.mentions.users.set("222", { id: "222", username: "friend" });
    const opts = optsFor("give", ["<@222>", "10"], msg);
    expect(opts.getUser("user")).toEqual({ id: "222", username: "friend" });
    expect(opts.getInteger("amount")).toBe(10);

    const byId = optsFor("give", ["333", "5"], msg);
    expect(byId.getUser("user")?.id).toBe("333");
  });

  it("joins rest args (free text) and leaves them null when absent", () => {
    expect(optsFor("ban", ["<@222>", "spamming", "the", "chat"]).getString("reason")).toBe(
      "spamming the chat",
    );
    expect(optsFor("ban", ["<@222>"]).getString("reason")).toBeNull();
  });

  it("skips an optional integer that does not parse, so a later rest arg still works", () => {
    // `uwu ban @user spamming` — delete-days is not consumed, reason is.
    const msg = new FakePrefixMessage("uwu ban <@222> spamming");
    const opts = optsFor("ban", ["<@222>", "spamming"], msg);
    expect(opts.getInteger("delete-days")).toBeNull();
    expect(opts.getString("reason")).toBe("spamming");
    // `uwu ban @user 3 spamming` — delete-days is consumed.
    const opts2 = optsFor("ban", ["<@222>", "3", "spamming"], msg);
    expect(opts2.getInteger("delete-days")).toBe(3);
    expect(opts2.getString("reason")).toBe("spamming");
  });

  it("parses role mentions for reactionrole", () => {
    const opts = optsFor("reactionrole", ["123", "👍", "<@&789>"]);
    expect(opts.getString("message-id")).toBe("123");
    expect(opts.getString("emoji")).toBe("👍");
    expect(opts.getRole("role")?.id).toBe("789");
  });
});

// ---------------------------------------------------------------------------
// Message adapter (reply / defer / edit semantics)
// ---------------------------------------------------------------------------

describe("MessageInvocation", () => {
  it("sends one message on first editReply (casino defer flow) and edits it after", async () => {
    const msg = new FakePrefixMessage("uwu slots 10");
    const cmd = allCommands.find((c) => c.name === "slots")!;
    const inv = new MessageInvocation(msg, cmd, ["10"]);
    await inv.deferReply();
    await inv.editReply({ content: "Spinning…" });
    await inv.editReply({ content: "Settled" });
    expect(msg.channelSends.length).toBe(1);
    expect(msg.replies.length).toBe(0);
    expect(msg.sentEdits.length).toBe(1);
    expect(msg.sentEdits[0]!.content).toBe("Settled");
  });

  it("a plain reply goes out once, and a later editReply edits that same message", async () => {
    const msg = new FakePrefixMessage("uwu daily");
    const cmd = allCommands.find((c) => c.name === "daily")!;
    const inv = new MessageInvocation(msg, cmd, []);
    await inv.reply({ content: "hi", ephemeral: true });
    await inv.editReply({ content: "edited" });
    expect(msg.replies.length).toBe(1);
    expect(msg.replies[0]).not.toHaveProperty("ephemeral");
    expect(msg.sentEdits.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// End-to-end routing through handlePrefixMessage
// ---------------------------------------------------------------------------

describe("handlePrefixMessage", () => {
  it("ignores bot messages, webhook messages, DMs and non-prefixed chat", async () => {
    const ctx = { db, guildId: GUILD };
    const bot = new FakePrefixMessage("uwu bal", { bot: true });
    expect(await handlePrefixMessage(bot, ctx)).toBe(false);
    expect(bot.replies.length).toBe(0);

    const hook = new FakePrefixMessage("uwu bal", { webhookId: "hook-1" });
    expect(await handlePrefixMessage(hook, ctx)).toBe(false);

    const dm = new FakePrefixMessage("uwu bal", { guildId: null });
    expect(await handlePrefixMessage(dm, ctx)).toBe(false);

    const chat = new FakePrefixMessage("hello everyone");
    expect(await handlePrefixMessage(chat, ctx)).toBe(false);
    expect(chat.replies.length).toBe(0);
  });

  it("replies with a help pointer for a bare `uwu`", async () => {
    const msg = new FakePrefixMessage("uwu");
    expect(await handlePrefixMessage(msg, { db, guildId: GUILD })).toBe(true);
    expect(msg.replies[0]!.content).toBe(HELP_POINTER);
  });

  it("replies like a human for an unknown command and never crashes", async () => {
    const msg = new FakePrefixMessage("uwu frobnicate 1 2 3");
    expect(await handlePrefixMessage(msg, { db, guildId: GUILD })).toBe(true);
    const reply = msg.replies[0]!.content as string;
    // One of the casual pool lines, not the old robotic "Unknown command".
    expect(reply).not.toContain("Unknown command");
    expect(reply).toContain("frobnicate");
    expect(reply).toContain("`uwu help`");
    expect(
      UNKNOWN_COMMAND_LINES.map((line) => line.replace("{name}", "frobnicate")),
    ).toContain(reply);
  });

  it("falls back to a generic line for an absurdly long unknown name", async () => {
    const longName = "a".repeat(40);
    const msg = new FakePrefixMessage(`uwu ${longName}`);
    expect(await handlePrefixMessage(msg, { db, guildId: GUILD })).toBe(true);
    const reply = msg.replies[0]!.content as string;
    expect(reply).toBe(UNKNOWN_COMMAND_FALLBACK);
    expect(reply).not.toContain(longName);
    expect(reply).toContain("`uwu help`");
  });

  it("unknownCommandReply echoes short names and falls back on empty/over-long ones", () => {
    // Every pool line echoes the name and points at uwu help.
    for (const line of UNKNOWN_COMMAND_LINES) {
      const rendered = line.replace("{name}", "frobnicate");
      expect(rendered).toContain("frobnicate");
      expect(rendered).toContain("`uwu help`");
    }
    expect(unknownCommandReply("")).toBe(UNKNOWN_COMMAND_FALLBACK);
    expect(unknownCommandReply("   ")).toBe(UNKNOWN_COMMAND_FALLBACK);
    expect(unknownCommandReply("a".repeat(32))).toContain("a".repeat(32));
    expect(unknownCommandReply("a".repeat(33))).toBe(UNKNOWN_COMMAND_FALLBACK);
    expect(unknownCommandReply("  joke  ")).toContain("joke");
  });

  it("runs `uwu bal` and keeps the plain-text balance line", async () => {
    await addPoints(db, GUILD, "user-1", 500, "seed");
    const msg = new FakePrefixMessage("uwu bal");
    expect(await handlePrefixMessage(msg, { db, guildId: GUILD })).toBe(true);
    expect(msg.allText()).toContain("Hey <@user-1>, you currently have");
    expect(msg.allText()).toContain("500 gold!");
    expect(msg.allText()).toContain("XP · Level");
  });

  it("runs an alias (`UWU CF`) and validates the amount the same way", async () => {
    await addPoints(db, GUILD, "user-1", 1000, "seed");
    const bad = new FakePrefixMessage("UWU CF abc heads");
    await handlePrefixMessage(bad, { db, guildId: GUILD });
    expect(bad.allText()).toContain("Bet must be a positive whole number of gold.");

    const good = new FakePrefixMessage("uwu cf 10 heads");
    await handlePrefixMessage(good, { db, guildId: GUILD });
    expect(good.allText()).toContain("Coinflip");
    expect(good.allText()).toContain("Balance");
  });

  it("parses a mention + amount for `uwu give` and rejects a bad amount", async () => {
    await addPoints(db, GUILD, "user-1", 100, "seed");
    const msg = new FakePrefixMessage("uwu give <@222> abc");
    msg.mentions.users.set("222", { id: "222", username: "friend" });
    await handlePrefixMessage(msg, { db, guildId: GUILD });
    expect(msg.allText()).toContain("Amount must be a positive whole number.");
  });

  it("runs `uwu help` as ONE compact embed box listing every command name, grouped", async () => {
    const msg = new FakePrefixMessage("uwu help");
    await handlePrefixMessage(msg, { db, guildId: GUILD });
    // OwO-style box, not the old 3-message plain-text list: exactly one
    // reply carrying one embed, title "Command List", one field per
    // category holding ONLY the command names as `code` chips — no
    // descriptions, no aliases in the list.
    const replies = [...msg.replies, ...msg.channelSends];
    expect(replies.length).toBe(1);
    // FakePrefixMessage stores the payload itself (no { kind, payload }
    // wrapper like FakeChatInput's replies).
    const payload = replies[0]! as Record<string, unknown>;
    expect(payload.content).toBeUndefined();
    const embeds = payload.embeds as Array<Record<string, unknown>>;
    expect(embeds.length).toBe(1);
    expect(embeds[0]!.title).toBe("Command List");
    // The box is headed by the requesting user, OwO-style: the fake
    // author has no display name or avatar, so the author falls back
    // to the username with no icon.
    expect(embeds[0]!.author).toEqual({ name: "tester" });
    const text = msg.allText();
    expect(text).toContain("Here is the list of commands!");
    for (const cmd of allCommands) {
      expect(text).toContain(`\`${cmd.name}\``);
    }
    expect(text).not.toContain("(bal, money, wallet)");
    for (const group of HELP_GROUPS) {
      expect(text).toContain(group.category);
    }
    // Regression 2026-11-07: the full list must stay under Discord's
    // 6000-char embed cap in a single embed (the plain-text version was
    // 3,837 chars, over the 2000-char message cap, and `uwu help` failed
    // every time until it was split).
    const fields = embeds[0]!.fields as Array<{ name: string; value: string }>;
    const total =
      String(embeds[0]!.title ?? "").length +
      String(embeds[0]!.description ?? "").length +
      fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(6000);
  });
});

// ---------------------------------------------------------------------------
// Slash-command removal
// ---------------------------------------------------------------------------

describe("slash command removal", () => {
  it("the registration payload is empty", () => {
    expect(SLASH_COMMAND_REGISTRATION_BODY).toEqual([]);
  });

  it("clearApplicationCommands sets an empty set globally and for the guild", async () => {
    const calls: Array<[string, unknown]> = [];
    const fakeClient = {
      application: {
        commands: {
          set: async (body: readonly unknown[]) => {
            calls.push(["global", body]);
            return { size: 0 };
          },
        },
      },
      guilds: {
        fetch: async (_id: string) => ({
          commands: {
            set: async (body: readonly unknown[]) => {
              calls.push(["guild", body]);
              return { size: 0 };
            },
          },
        }),
      },
    };
    const remaining = await clearApplicationCommands(fakeClient, "1568300887326331030");
    expect(remaining).toEqual({ global: 0, guild: 0 });
    expect(calls).toEqual([
      ["global", []],
      ["guild", []],
    ]);
  });

  it("clearApplicationCommands tolerates a client with no application scope", async () => {
    const remaining = await clearApplicationCommands({}, "1568300887326331030");
    expect(remaining).toEqual({ global: null, guild: null });
  });
});
