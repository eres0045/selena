import { describe, expect, it } from "vitest";
import { getTestDb } from "./testDb.js";
import { FakeChatInput } from "../src/lib/testkit.js";
import { awardXp, levelFromXp, rankCard, resetXpCooldowns, xpForLevel } from "../src/lib/levels.js";
import { checkStarboard, containsBannedWord, containsLink, isSpam } from "../src/lib/automod.js";
import { commands as utilityCommands, createReminder, getAfk, setAfk, topByXp } from "../src/commands/utility.js";
import { commands as helpCommands, buildHelpEmbed, commandDetail, helpEmbedLength, HELP_EMBED_LIMIT } from "../src/commands/help.js";
import { allCommands, HELP_GROUPS } from "../src/commands/index.js";
import type { Command } from "../src/lib/command.js";

const GUILD = "guild-1";

function execCmd(cmds: Command[], name: string, opts: Record<string, unknown> = {}, userId = "user-1", permissions: string[] = []) {
  const db = getTestDb();
  const cmd = cmds.find((c) => c.name === name);
  if (!cmd) throw new Error(`command not found: ${name}`);
  const fake = new FakeChatInput({ commandName: name, options: opts, userId, username: "tester", permissions });
  return { db, fake, promise: (cmd.execute as (i: unknown, ctx: unknown) => Promise<void>)(fake, { db, guildId: GUILD }) };
}

describe("levels math", () => {
  it("xpForLevel follows 5L^2 + 50L + 100 (level 0 = 0)", async () => {
    expect(xpForLevel(0)).toBe(0);
    expect(xpForLevel(1)).toBe(155);
    expect(xpForLevel(2)).toBe(220);
    expect(xpForLevel(3)).toBe(295);
    expect(xpForLevel(5)).toBe(475);
    expect(xpForLevel(10)).toBe(1100);
  });

  it("levelFromXp inverts the curve at exact thresholds", async () => {
    expect(levelFromXp(0)).toBe(0);
    expect(levelFromXp(154)).toBe(0);
    expect(levelFromXp(155)).toBe(1);
    expect(levelFromXp(219)).toBe(1);
    expect(levelFromXp(220)).toBe(2);
    expect(levelFromXp(475)).toBe(5);
    expect(levelFromXp(10000)).toBe(levelFromXp(10000)); // sanity, no throw
    expect(levelFromXp(-5)).toBe(0);
  });

  it("rankCard reports level, next threshold and progress", async () => {
    const fresh = rankCard(0);
    expect(fresh).toMatchObject({ level: 0, xp: 0, xpForNext: 155, progress: 0 });
    const mid = rankCard(155 + 32); // halfway-ish through level 1 (span 65)
    expect(mid.level).toBe(1);
    expect(mid.xpForNext).toBe(220);
    expect(mid.progress).toBeCloseTo(32 / 65, 5);
    expect(rankCard(220).progress).toBe(0);
  });
});

describe("awardXp + cooldown", () => {
  it("awards XP, levels up at the threshold, then enforces the 60s cooldown", async () => {
    const db = getTestDb();
    resetXpCooldowns();
    const first = await awardXp(db, GUILD, "user-1", 200, 1_000);
    expect(first).toMatchObject({ leveledUp: true, newLevel: 1, xp: 200, awarded: 200 });
    const during = await awardXp(db, GUILD, "user-1", 50, 1_000 + 30_000);
    expect(during).toMatchObject({ leveledUp: false, awarded: 0, xp: 200 });
    const after = await awardXp(db, GUILD, "user-1", 50, 1_000 + 60_000);
    expect(after).toMatchObject({ awarded: 50, xp: 250 });
    // different user / guild is not affected by the first user's cooldown
    const other = await awardXp(db, GUILD, "user-2", 10, 1_000 + 30_000);
    expect(other.awarded).toBe(10);
    resetXpCooldowns();
  });
});

describe("automod pure functions", () => {
  it("containsBannedWord matches whole words, case-insensitively", async () => {
    expect(containsBannedWord("this has badword1 in it", ["badword1"])).toBe(true);
    expect(containsBannedWord("BADWORD1!", ["badword1"])).toBe(true);
    expect(containsBannedWord("badword12 is not a match", ["badword1"])).toBe(false);
    expect(containsBannedWord("clean message", ["badword1"])).toBe(false);
  });

  it("isSpam counts messages inside the window", async () => {
    expect(isSpam([1000, 2000, 3000, 4000, 5000], 5000, 5)).toBe(true);
    expect(isSpam([1000, 2000, 3000, 4000], 5000, 5)).toBe(false);
    expect(isSpam([0, 100_000], 5000, 2)).toBe(false);
  });

  it("containsLink flags URLs except allow-listed hosts", async () => {
    expect(containsLink("see https://example.com/x")).toBe(true);
    expect(containsLink("see www.example.com")).toBe(true);
    expect(containsLink("no links here")).toBe(false);
    expect(containsLink("see https://discord.gg/abc", ["discord.gg"])).toBe(false);
    expect(containsLink("see https://sub.discord.gg/abc", ["discord.gg"])).toBe(false);
    expect(containsLink("see https://evil.com and https://discord.gg/abc", ["discord.gg"])).toBe(true);
  });

  it("checkStarboard posts once at threshold and records stars", async () => {
    const db = getTestDb();
    const below = await checkStarboard(db, GUILD, "msg-1", 2);
    expect(below).toMatchObject({ shouldPost: false, threshold: 3 });
    const at = await checkStarboard(db, GUILD, "msg-1", 3);
    expect(at.shouldPost).toBe(true);
    // simulate the entrypoint recording the post, then a 4th star arrives
    await db.prepare("UPDATE starboard_posts SET starboard_message_id = 'sb-1' WHERE guild_id = ? AND message_id = ?").run(GUILD, "msg-1");
    const again = await checkStarboard(db, GUILD, "msg-1", 4);
    expect(again).toMatchObject({ shouldPost: false, alreadyPosted: true, stars: 4 });
  });
});

describe("utility commands", () => {
  it("/rank shows level + progress from stored XP", async () => {
    const db = getTestDb();
    resetXpCooldowns();
    await awardXp(db, GUILD, "user-1", 200, 1000);
    const fake = new FakeChatInput({ commandName: "rank", options: {} });
    const cmd = utilityCommands.find((c) => c.name === "rank")!;
    await (cmd.execute as (i: unknown, ctx: unknown) => Promise<void>)(fake, { db, guildId: GUILD });
    expect(fake.allText()).toContain("Level");
    expect(fake.allText()).toContain("1");
    resetXpCooldowns();
  });

  it("/leaderboard-xp orders by XP and handles the empty case", async () => {
    const empty = execCmd(utilityCommands, "leaderboard-xp");
    await empty.promise;
    expect(empty.fake.allText()).toContain("No XP");

    const db = getTestDb();
    resetXpCooldowns();
    await awardXp(db, GUILD, "user-a", 500, 1000);
    await awardXp(db, GUILD, "user-b", 200, 1000);
    expect((await topByXp(db, GUILD, 10)).map((u) => u.user_id)).toEqual(["user-a", "user-b"]);
    const fake = new FakeChatInput({ commandName: "leaderboard-xp", options: {} });
    const cmd = utilityCommands.find((c) => c.name === "leaderboard-xp")!;
    await (cmd.execute as (i: unknown, ctx: unknown) => Promise<void>)(fake, { db, guildId: GUILD });
    expect(fake.allText().indexOf("user-a")).toBeLessThan(fake.allText().indexOf("user-b"));
    resetXpCooldowns();
  });

  it("afk set then clear (command + helpers)", async () => {
    const set = execCmd(utilityCommands, "afk", { reason: "lunch" });
    await set.promise;
    expect(set.fake.allText()).toContain("AFK");
    expect((await getAfk(set.db, GUILD, "user-1")).reason).toBe("lunch");

    const db = set.db;
    await setAfk(db, GUILD, "user-1", null);
    expect((await getAfk(db, GUILD, "user-1")).reason).toBeNull();

    const clear = execCmd(utilityCommands, "afk", {});
    await clear.promise;
    expect(clear.fake.allText()).toContain("Welcome back");
  });

  it("/remind stores a row with due_at = now + minutes", async () => {
    const db = getTestDb();
    const now = 1_700_000_000_000;
    const { id, dueAt } = await createReminder(db, GUILD, "user-1", "chan-1", "drink water", 30, now);
    expect(dueAt).toBe(now + 30 * 60_000);
    const row = await db.prepare("SELECT * FROM reminders WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row.text).toBe("drink water");
    expect(row.delivered).toBe(0);

    const via = execCmd(utilityCommands, "remind", { minutes: 5, text: "stand up" });
    await via.promise;
    expect(via.fake.allText()).toContain("Reminder set");
    expect(via.fake.allText()).toContain("stand up");

    const missing = execCmd(utilityCommands, "remind", { minutes: 5 });
    await missing.promise;
    expect(missing.fake.allText()).toContain("required");
  });

  it("/serverstats reads seeded users and leaderboards", async () => {
    const db = getTestDb();
    resetXpCooldowns();
    await awardXp(db, GUILD, "user-a", 300, 1000);
    await db.prepare("UPDATE users SET points = 42 WHERE guild_id = ? AND user_id = ?").run(GUILD, "user-a");
    const fake = new FakeChatInput({ commandName: "serverstats", options: {} });
    const cmd = utilityCommands.find((c) => c.name === "serverstats")!;
    await (cmd.execute as (i: unknown, ctx: unknown) => Promise<void>)(fake, { db, guildId: GUILD });
    expect(fake.allText()).toContain("user-a");
    expect(fake.allText()).toContain("42");
    resetXpCooldowns();
  });

  it("/userinfo and /avatar reply without crashing", async () => {
    const info = execCmd(utilityCommands, "userinfo", { user: { id: "user-7", username: "someone" } });
    await info.promise;
    expect(info.fake.allText()).toContain("someone");

    const self = execCmd(utilityCommands, "userinfo", {});
    await self.promise;
    expect(self.fake.allText()).toContain("tester");

    const av = execCmd(utilityCommands, "avatar", { user: { id: "123456789", username: "someone" } });
    await av.promise;
    expect(av.fake.allText()).toContain("Avatar");
  });
});

describe("/help", () => {
  it("lists every command in the registry, grouped — HELP_GROUPS covers allCommands", async () => {
    const grouped = HELP_GROUPS.flatMap((g) => g.commands.map((c) => c.name));
    // Coverage: every registered command appears in HELP_GROUPS. (Exact
    // uniqueness is asserted by boot.test.ts — two cross-worker commands
    // currently collide, see the report.)
    for (const cmd of allCommands) {
      expect(grouped).toContain(cmd.name);
    }
    expect(allCommands.length).toBeGreaterThan(0);

    const fake = new FakeChatInput({ commandName: "help", options: {} });
    const cmd = helpCommands.find((c) => c.name === "help")!;
    const db = getTestDb();
    await (cmd.execute as (i: unknown, ctx: unknown) => Promise<void>)(fake, { db, guildId: GUILD });
    // One compact embed box: every command appears as a `name` chip.
    for (const c of allCommands) {
      expect(fake.allText()).toContain(`\`${c.name}\``);
    }
  });

  it("errors on an unknown topic, filters on a known category, details a known command", async () => {
    const db = getTestDb();
    const bad = new FakeChatInput({ commandName: "help", options: { category: "Nope" } });
    const cmd = helpCommands.find((c) => c.name === "help")!;
    await (cmd.execute as (i: unknown, ctx: unknown) => Promise<void>)(bad, { db, guildId: GUILD });
    expect(bad.allText()).toContain("Unknown command or category");

    const good = new FakeChatInput({ commandName: "help", options: { category: "Utility" } });
    await (cmd.execute as (i: unknown, ctx: unknown) => Promise<void>)(good, { db, guildId: GUILD });
    expect(good.allText()).toContain("`rank`");
    expect(good.allText()).not.toContain("`warn`");

    const detail = new FakeChatInput({ commandName: "help", options: { category: "mines" } });
    await (cmd.execute as (i: unknown, ctx: unknown) => Promise<void>)(detail, { db, guildId: GUILD });
    const payload = detail.firstReplyPayload() as Record<string, unknown>;
    expect(payload.embeds).toBeUndefined();
    expect(payload.content as string).toContain("`uwu mines <bet> [mines]`");
    expect(payload.content as string).toContain("`mine`");

    const byAlias = new FakeChatInput({ commandName: "help", options: { category: "cf" } });
    await (cmd.execute as (i: unknown, ctx: unknown) => Promise<void>)(byAlias, { db, guildId: GUILD });
    expect(byAlias.allText()).toContain("`uwu coinflip");

    // Regression: the "Help" category collides with the `help` command
    // name — `uwu help help` must show the Help category box, not the
    // command detail (category match wins over command match).
    const helpCat = new FakeChatInput({ commandName: "help", options: { category: "help" } });
    await (cmd.execute as (i: unknown, ctx: unknown) => Promise<void>)(helpCat, { db, guildId: GUILD });
    const helpPayload = helpCat.firstReplyPayload() as Record<string, unknown>;
    const helpEmbeds = helpPayload.embeds as Array<Record<string, unknown>>;
    expect(helpEmbeds?.length).toBe(1);
    expect(helpEmbeds[0]!.title).toBe("Command List");
    expect(helpCat.allText()).toContain("`help`");
  });

  it("regression: the full list is ONE embed under Discord's 6000-char embed cap", async () => {
    // 2026-11-07: the plain-text full list renders at ~3.8k chars, over
    // Discord's 2000-char message cap, so `uwu help` failed every time
    // until it was split across 3 messages — then Ronit asked for the
    // OwO one-box list instead. Names only, no descriptions/aliases, so
    // all 36 commands fit in a single embed.
    const cmd = helpCommands.find((c) => c.name === "help")!;
    const run = async (options: Record<string, unknown>) => {
      const db = getTestDb();
      const fake = new FakeChatInput({ commandName: "help", options });
      await (cmd.execute as (i: unknown, ctx: unknown) => Promise<void>)(fake, { db, guildId: GUILD });
      return fake;
    };
    const variants: Record<string, unknown>[] = [{}];
    for (const g of HELP_GROUPS) variants.push({ category: g.category });
    for (const options of variants) {
      const fake = await run(options);
      expect(fake.allText()).not.toContain("Couldn't run that");
      const payload = fake.firstReplyPayload() as Record<string, unknown>;
      const embeds = payload.embeds as Array<Record<string, unknown>>;
      expect(embeds?.length).toBe(1);
      expect(embeds[0]!.title).toBe("Command List");
      expect(fake.replies.length).toBe(1);
    }
    // Full (unfiltered) help: one embed, under the cap, listing every
    // command name as a chip.
    const full = await run({});
    const embed = buildHelpEmbed(HELP_GROUPS);
    expect(helpEmbedLength(embed)).toBeLessThanOrEqual(HELP_EMBED_LIMIT);
    for (const c of allCommands) {
      expect(full.allText()).toContain(`\`${c.name}\``);
    }
  });

  it("buildHelpEmbed is names-only and commandDetail shows usage + aliases", () => {
    const embed = buildHelpEmbed(HELP_GROUPS).toJSON();
    expect(embed.title).toBe("Command List");
    expect(embed.description).toContain("Here is the list of commands!");
    expect(embed.description).toContain("`uwu help {command}`");
    const values = (embed.fields ?? []).map((f) => f.value).join(" ");
    expect(values).toContain("`mines`");
    expect(values).not.toContain("reveal safe tiles");
    expect(values).not.toContain("(mine)");
    expect(helpEmbedLength(buildHelpEmbed(HELP_GROUPS))).toBeLessThanOrEqual(HELP_EMBED_LIMIT);

    const mines = allCommands.find((c) => c.name === "mines")!;
    const detail = commandDetail(mines);
    expect(detail).toContain("`uwu mines <bet> [mines]`");
    expect(detail).toContain(mines.description);
    expect(detail).toContain("`mine`");
  });
});
