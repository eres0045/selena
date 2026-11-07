import { describe, expect, it, vi } from "vitest";
import { getTestDb } from "./testDb.js";
import { FakeChatInput } from "../src/lib/testkit.js";
import type { Command } from "../src/lib/command.js";
import type { SelenaDb } from "../src/lib/db.js";
import {
  formatRareLog,
  getAnnouncements,
  getRareLogs,
  logRareCatch,
  postAnnouncement,
  rareLogSweep,
  type RareLogRow,
} from "../src/lib/feeds.js";
import {
  commands,
  getLogChannel,
  parseChannelToken,
  setLogChannel,
  splitAnnouncement,
} from "../src/commands/feeds.js";

const GUILD = "guild-1";
const OTHER_GUILD = "guild-2";
const ADMIN = "admin-1";
const USER = "user-9";

function run(name: string, opts: Record<string, unknown> = {}, permissions: string[] = []) {
  const cmd = commands.find((c) => c.name === name);
  if (!cmd) throw new Error(`command not found: ${name}`);
  const fake = new FakeChatInput({ commandName: name, options: opts, userId: ADMIN, username: "admin", permissions });
  return { cmd: cmd as Command, fake };
}

async function exec(name: string, opts: Record<string, unknown> = {}, permissions?: string[]) {
  const db = getTestDb();
  const { cmd, fake } = run(name, opts, permissions);
  await (cmd.execute as (i: unknown, ctx: unknown) => Promise<void>)(fake, { db, guildId: GUILD });
  return { db, fake };
}

async function countRareLogs(db: SelenaDb): Promise<number> {
  const row = (await db.prepare("SELECT COUNT(*) AS c FROM rare_logs").get()) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

async function listRareLogs(db: SelenaDb): Promise<RareLogRow[]> {
  return (await db
    .prepare("SELECT id, user_id, guild_id, item_type, item_ref, tier, source, caught_at FROM rare_logs ORDER BY id ASC")
    .all()) as unknown as RareLogRow[];
}

describe("logRareCatch", () => {
  it("logs Epic, Legendary, Mythic and UwU — and ignores Common/Uncommon/Rare", async () => {
    const db = getTestDb();
    const base = { userId: USER, guildId: GUILD, itemType: "monster" as const, source: "hunt" as const, nowMs: 1000 };
    await logRareCatch(db, { ...base, itemRef: "Stone Beetle", tier: "Common", nowMs: 1000 });
    await logRareCatch(db, { ...base, itemRef: "Ember Fox", tier: "Uncommon", nowMs: 2000 });
    await logRareCatch(db, { ...base, itemRef: "Frost Wolf", tier: "Rare", nowMs: 3000 });
    await logRareCatch(db, { ...base, itemRef: "Shadow Dragon", tier: "Epic", nowMs: 4000 });
    await logRareCatch(db, { ...base, itemRef: "Inferno Phoenix", tier: "Legendary", nowMs: 5000 });
    await logRareCatch(db, { ...base, itemRef: "Void Dragon", tier: "Mythic", nowMs: 6000 });
    await logRareCatch(db, { ...base, itemRef: "Dream UwU", tier: "UwU", nowMs: 7000 });
    await logRareCatch(db, { ...base, itemRef: "Dragon Slayer", itemType: "weapon", tier: "Epic", source: "roll", nowMs: 8000 });

    const rows = await listRareLogs(db);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.item_ref)).toEqual([
      "Shadow Dragon",
      "Inferno Phoenix",
      "Void Dragon",
      "Dream UwU",
      "Dragon Slayer",
    ]);
    expect(rows[4]).toMatchObject({ item_type: "weapon", tier: "Epic", source: "roll" });
    // posted defaults to 0 in the DB (column not selected above — check directly)
    const posted = (await db.prepare("SELECT posted FROM rare_logs WHERE item_ref = ?").get("Shadow Dragon")) as {
      posted: number;
    };
    expect(posted.posted).toBe(0);
  });

  it("never throws on a logging failure", async () => {
    const broken = { prepare: () => { throw new Error("db down"); } } as unknown as SelenaDb;
    await expect(
      logRareCatch(broken, {
        userId: USER,
        guildId: GUILD,
        itemType: "monster",
        itemRef: "Shadow Dragon",
        tier: "Epic",
        source: "hunt",
        nowMs: 1000,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("postAnnouncement / getAnnouncements", () => {
  it("validates title and body lengths", async () => {
    const db = getTestDb();
    await expect(postAnnouncement(db, "ab", "ok body", ADMIN, 1000)).rejects.toThrow("3–80");
    await expect(postAnnouncement(db, "x".repeat(81), "ok body", ADMIN, 1000)).rejects.toThrow("3–80");
    await expect(postAnnouncement(db, "  ", "ok body", ADMIN, 1000)).rejects.toThrow("3–80");
    await expect(postAnnouncement(db, "ok title", "", ADMIN, 1000)).rejects.toThrow("1–500");
    await expect(postAnnouncement(db, "ok title", "x".repeat(501), ADMIN, 1000)).rejects.toThrow("1–500");
    expect(await countRareLogs(db)).toBe(0);
    const rows = await getAnnouncements(db);
    expect(rows).toHaveLength(0);
  });

  it("inserts and returns newest first", async () => {
    const db = getTestDb();
    const id1 = await postAnnouncement(db, "First update", "hello", ADMIN, 1000);
    const id2 = await postAnnouncement(db, "Second update", "more news", ADMIN, 2000);
    const id3 = await postAnnouncement(db, "Third update", "even more", ADMIN, 1500);
    expect(id1).toBeGreaterThan(0);
    expect(id2).toBeGreaterThan(id1);
    expect(id3).toBeGreaterThan(id2);
    const rows = await getAnnouncements(db, 10);
    expect(rows.map((r) => r.title)).toEqual(["Second update", "Third update", "First update"]);
    expect(rows[0]).toMatchObject({ body: "more news", posted_by: ADMIN, posted_at: 2000 });
    expect((await getAnnouncements(db, 2)).map((r) => r.title)).toEqual(["Second update", "Third update"]);
  });
});

describe("getRareLogs scoping", () => {
  it("server scope returns only that server; global returns all, newest first", async () => {
    const db = getTestDb();
    await logRareCatch(db, { userId: "u1", guildId: GUILD, itemType: "monster", itemRef: "A", tier: "Epic", source: "hunt", nowMs: 1000 });
    await logRareCatch(db, { userId: "u2", guildId: OTHER_GUILD, itemType: "monster", itemRef: "B", tier: "Legendary", source: "roll", nowMs: 3000 });
    await logRareCatch(db, { userId: "u3", guildId: GUILD, itemType: "weapon", itemRef: "C", tier: "Mythic", source: "shop", nowMs: 2000 });

    const server = await getRareLogs(db, GUILD, 10);
    expect(server.map((r) => r.item_ref)).toEqual(["C", "A"]);
    const other = await getRareLogs(db, OTHER_GUILD, 10);
    expect(other.map((r) => r.item_ref)).toEqual(["B"]);
    const global = await getRareLogs(db, null, 10);
    expect(global.map((r) => r.item_ref)).toEqual(["B", "C", "A"]);
    expect((await getRareLogs(db, null, 2)).map((r) => r.item_ref)).toEqual(["B", "C"]);
  });
});

describe("formatRareLog", () => {
  it("is one plain-text line with name, item, tier, source and date — no mentions", () => {
    const line = formatRareLog(
      { id: 1, user_id: USER, guild_id: GUILD, item_type: "monster", item_ref: "Shadow Dragon", tier: "Epic", source: "roll", caught_at: Date.UTC(2026, 10, 7, 12, 0, 0) },
      "Alice",
    );
    expect(line).toContain("Shadow Dragon");
    expect(line).toContain("Alice");
    expect(line).toContain("Epic");
    expect(line).toContain("roll");
    expect(line).toContain("2026-11-07");
    expect(line).not.toContain("<@");
    expect(line.split("\n")).toHaveLength(1);
  });
});

describe("announcements command", () => {
  it("shows latest 10 newest first, and an empty feed message", async () => {
    const empty = await exec("announcements");
    expect(empty.fake.allText()).toContain("No announcements yet");

    const db = getTestDb();
    const day = Date.UTC(2026, 10, 7);
    await postAnnouncement(db, "Old news", "old", ADMIN, day);
    await postAnnouncement(db, "New news", "new", ADMIN, day + 1000);
    const { fake } = run("announcements");
    const cmd = commands.find((c) => c.name === "announcements")!;
    await (cmd.execute as (i: unknown, ctx: unknown) => Promise<void>)(fake, { db, guildId: GUILD });
    const text = fake.allText();
    expect(text.indexOf("New news")).toBeLessThan(text.indexOf("Old news"));
    expect(text).toContain("2026-11-07");
  });

  it("alias news resolves to the same command", () => {
    const cmd = commands.find((c) => c.name === "announcements")!;
    expect(cmd.aliases).toContain("news");
  });
});

describe("announce command", () => {
  it("refuses a non-admin and writes nothing", async () => {
    const { db, fake } = await exec("announce", { text: "Big update | We added monsters" }, []);
    expect(fake.allText()).toContain("Administrator");
    expect(await getAnnouncements(db)).toHaveLength(0);
  });

  it("refuses text without a | separator or with an empty side", async () => {
    const noPipe = await exec("announce", { text: "no separator here" }, ["Administrator"]);
    expect(noPipe.fake.allText()).toContain("Usage:");
    expect(await getAnnouncements(noPipe.db)).toHaveLength(0);

    const emptyTitle = await exec("announce", { text: " | body only" }, ["Administrator"]);
    expect(emptyTitle.fake.allText()).toContain("Usage:");
    expect(await getAnnouncements(emptyTitle.db)).toHaveLength(0);
  });

  it("splits on the FIRST | and confirms with the posted title", async () => {
    const { db, fake } = await exec("announce", { text: "New monsters | 12 added | plus balance tweaks" }, ["Administrator"]);
    expect(fake.allText()).toContain("Announcement posted");
    expect(fake.allText()).toContain("New monsters");
    const rows = await getAnnouncements(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("New monsters");
    expect(rows[0]!.body).toBe("12 added | plus balance tweaks");
  });

  it("rejects a too-short title from the command path", async () => {
    const { db, fake } = await exec("announce", { text: "Hi | body text" }, ["Administrator"]);
    expect(fake.allText()).toContain("3–80");
    expect(await getAnnouncements(db)).toHaveLength(0);
  });
});

describe("logs command", () => {
  it("empty feed message, server default, global scope, no mentions", async () => {
    const empty = await exec("logs");
    expect(empty.fake.allText()).toBe("No Epic+ catches logged yet — go `uwu hunt` or `uwu roll`!");

    const db = getTestDb();
    await logRareCatch(db, { userId: USER, guildId: GUILD, itemType: "monster", itemRef: "Shadow Dragon", tier: "Epic", source: "hunt", nowMs: 1000 });
    await logRareCatch(db, { userId: "u2", guildId: OTHER_GUILD, itemType: "monster", itemRef: "Void Dragon", tier: "Mythic", source: "roll", nowMs: 2000 });

    const serverRun = run("logs");
    const cmd = commands.find((c) => c.name === "logs")!;
    await (cmd.execute as (i: unknown, ctx: unknown) => Promise<void>)(serverRun.fake, { db, guildId: GUILD });
    const serverText = serverRun.fake.allText();
    expect(serverText).toContain("Shadow Dragon");
    expect(serverText).not.toContain("Void Dragon");
    expect(serverText).not.toContain("<@");

    const globalRun = run("logs", { scope: "global" });
    await (cmd.execute as (i: unknown, ctx: unknown) => Promise<void>)(globalRun.fake, { db, guildId: GUILD });
    const globalText = globalRun.fake.allText();
    expect(globalText).toContain("Shadow Dragon");
    expect(globalText).toContain("Void Dragon");
    expect(globalText).toContain("all of Discord");
  });
});

describe("setlogchannel command", () => {
  it("parses channel mentions and bare ids, rejects anything else", () => {
    expect(parseChannelToken("<#123456789012345678>")).toBe("123456789012345678");
    expect(parseChannelToken("123456789012345678")).toBe("123456789012345678");
    expect(parseChannelToken("#general")).toBeNull();
    expect(parseChannelToken("general")).toBeNull();
    expect(parseChannelToken("123")).toBeNull();
    expect(parseChannelToken(null)).toBeNull();
    expect(splitAnnouncement("Title | body")).toEqual(["Title", "body"]);
    expect(splitAnnouncement("no pipe")).toBeNull();
    expect(splitAnnouncement(" | ")).toBeNull();
  });

  it("admin stores the setting and confirms the channel; re-set overwrites", async () => {
    const { db, fake } = await exec("setlogchannel", { channel: "<#123456789012345678>" }, ["Administrator"]);
    expect(fake.allText()).toContain("<#123456789012345678>");
    expect(await getLogChannel(db, GUILD)).toBe("123456789012345678");

    const again = run("setlogchannel", { channel: "987654321098765432" }, ["Administrator"]);
    const cmd = commands.find((c) => c.name === "setlogchannel")!;
    await (cmd.execute as (i: unknown, ctx: unknown) => Promise<void>)(again.fake, { db, guildId: GUILD });
    expect(await getLogChannel(db, GUILD)).toBe("987654321098765432");
    expect(await getLogChannel(db, OTHER_GUILD)).toBeNull();
  });

  it("refuses a non-admin and writes nothing; refuses a bad channel token", async () => {
    const denied = await exec("setlogchannel", { channel: "<#123456789012345678>" }, []);
    expect(denied.fake.allText()).toContain("Administrator");
    expect(await getLogChannel(denied.db, GUILD)).toBeNull();

    const bad = await exec("setlogchannel", { channel: "not-a-channel" }, ["Administrator"]);
    expect(bad.fake.allText()).toContain("Give me a channel");
    expect(await getLogChannel(bad.db, GUILD)).toBeNull();
  });

  it("setLogChannel helper upserts directly", async () => {
    const db = getTestDb();
    await setLogChannel(db, GUILD, "111111111111111111");
    await setLogChannel(db, GUILD, "222222222222222222");
    expect(await getLogChannel(db, GUILD)).toBe("222222222222222222");
  });
});

describe("rareLogSweep", () => {
  function fakeClient(sent: string[], failFetch = false) {
    return {
      channels: {
        fetch: async (id: string) => {
          if (failFetch) throw new Error("discord down");
          if (id === "missing-channel") return null;
          return { send: async (msg: unknown) => { sent.push((msg as { content: string }).content); } };
        },
      },
    };
  }

  it("posts fresh unposted rows to the guild log channel and marks them posted", async () => {
    const db = getTestDb();
    await setLogChannel(db, GUILD, "123456789012345678");
    const now = Date.now();
    await logRareCatch(db, { userId: USER, guildId: GUILD, itemType: "monster", itemRef: "Shadow Dragon", tier: "Epic", source: "hunt", nowMs: now - 60_000 });
    const sent: string[] = [];
    await rareLogSweep(db, fakeClient(sent));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Shadow Dragon");
    expect(sent[0]).not.toContain("<@");
    const rows = await listRareLogs(db);
    expect((await db.prepare("SELECT posted FROM rare_logs WHERE id = ?").get(rows[0]!.id)) as { posted: number }).toMatchObject({ posted: 1 });
    // second sweep sends nothing (already posted)
    await rareLogSweep(db, fakeClient(sent));
    expect(sent).toHaveLength(1);
  });

  it("leaves rows unposted when no log channel is set, then ages them out without sending", async () => {
    const db = getTestDb();
    const now = Date.now();
    await logRareCatch(db, { userId: USER, guildId: GUILD, itemType: "monster", itemRef: "Shadow Dragon", tier: "Epic", source: "hunt", nowMs: now - 60_000 });
    const sent: string[] = [];
    await rareLogSweep(db, fakeClient(sent));
    expect(sent).toHaveLength(0);
    let posted = (await db.prepare("SELECT posted FROM rare_logs").get()) as { posted: number };
    expect(posted.posted).toBe(0); // still fresh — a later setlogchannel can catch it

    // same row, now older than the 10-minute window: marked posted, never sent
    await db.prepare("UPDATE rare_logs SET caught_at = ?").run(now - 11 * 60_000);
    await rareLogSweep(db, fakeClient(sent));
    expect(sent).toHaveLength(0);
    posted = (await db.prepare("SELECT posted FROM rare_logs").get()) as { posted: number };
    expect(posted.posted).toBe(1);
  });

  it("only posts to the owning guild's channel and never throws on fetch failure", async () => {
    const db = getTestDb();
    await setLogChannel(db, GUILD, "123456789012345678");
    const now = Date.now();
    await logRareCatch(db, { userId: "u2", guildId: OTHER_GUILD, itemType: "monster", itemRef: "Void Dragon", tier: "Mythic", source: "roll", nowMs: now - 60_000 });
    const sent: string[] = [];
    await rareLogSweep(db, fakeClient(sent));
    expect(sent).toHaveLength(0); // other guild has no log channel
    await expect(rareLogSweep(db, fakeClient(sent, true))).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await rareLogSweep(db, fakeClient(sent, true));
    errSpy.mockRestore();
  });
});
