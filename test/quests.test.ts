import { describe, expect, it, beforeEach } from "vitest";
import type { SelenaDb } from "../src/lib/db.js";
import { getTestDb } from "./testDb.js";
import { getBalance } from "../src/lib/economy.js";
import { getGems } from "../src/lib/market.js";
import { allButtonHandlers, HELP_GROUPS } from "../src/commands/index.js";
import { handlePrefixMessage, type PrefixMessageLike } from "../src/lib/router.js";
import {
  buildQuestLogEmbed,
  claimQuests,
  getQuestLog,
  progressBar,
  questsForDate,
  questDateKey,
  recordQuestProgress,
  rewardText,
} from "../src/lib/quests.js";

const GUILD = "guild-1";
const DAY = new Date("2026-11-07T12:00:00Z");
const DAY_KEY = questDateKey(DAY);

/**
 * Set a user's progress row directly (bypasses recordQuestProgress).
 * Used to set up claim/command tests deterministically; the lib tests
 * below cover recordQuestProgress itself.
 */
async function setProgress(
  db: SelenaDb,
  userId: string,
  questId: string,
  progress: number,
  dateKey: string = DAY_KEY,
): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO user_quest_progress (user_id, date, quest_id, progress) VALUES (?, ?, ?, ?)")
    .run(userId, dateKey, questId, progress);
  await db
    .prepare("UPDATE user_quest_progress SET progress = ? WHERE user_id = ? AND date = ? AND quest_id = ?")
    .run(progress, userId, dateKey, questId);
}

async function completeAllToday(db: SelenaDb, userId: string, date: Date = DAY): Promise<void> {
  for (const q of questsForDate(date)) {
    await setProgress(db, userId, q.id, q.target, questDateKey(date));
  }
}

// ---------------------------------------------------------------------------
// Lib: deterministic daily sets
// ---------------------------------------------------------------------------

describe("quests lib — daily sets", () => {
  let db: SelenaDb;

  beforeEach(async () => {
    db = getTestDb();
  });

  it("gives the same 3 quests to two different users on the same date", async () => {
    const a = await getQuestLog(db, "user-a", DAY);
    const b = await getQuestLog(db, "user-b", DAY);
    expect(a.quests.map((q) => q.def.id)).toEqual(b.quests.map((q) => q.def.id));
    expect(a.quests).toHaveLength(3);
    expect(a.date).toBe(DAY_KEY);
    // Independent progress: advancing one user does not move the other.
    await setProgress(db, "user-a", a.quests[0]!.def.id, 1);
    const a2 = await getQuestLog(db, "user-a", DAY);
    const b2 = await getQuestLog(db, "user-b", DAY);
    expect(a2.quests[0]!.progress).toBe(1);
    expect(b2.quests[0]!.progress).toBe(0);
  });

  it("is deterministic for the same date and varies across dates", () => {
    expect(questsForDate(DAY).map((q) => q.id)).toEqual(questsForDate(DAY).map((q) => q.id));
    const sets = new Set<string>();
    for (let d = 7; d <= 13; d++) {
      const date = new Date(`2026-11-${String(d).padStart(2, "0")}T12:00:00Z`);
      sets.add(questsForDate(date).map((q) => q.id).join(","));
    }
    expect(sets.size).toBeGreaterThanOrEqual(2);
  });

  it("a fresh user starts with zero progress and nothing claimed", async () => {
    const log = await getQuestLog(db, "brand-new", DAY);
    expect(log.quests).toHaveLength(3);
    for (const q of log.quests) {
      expect(q.progress).toBe(0);
      expect(q.claimed).toBe(false);
      expect(q.completed).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Lib: progress + claims
// ---------------------------------------------------------------------------

describe("quests lib — progress and claims", () => {
  let db: SelenaDb;

  beforeEach(async () => {
    db = getTestDb();
  });

  // NOTE (2026-11-07, Worker C): these two tests FAILED against the
  // coordinator's src/lib/quests.ts as first written — recordQuestProgress
  // used `MIN(progress + ?, ?)` in its UPDATE, and MIN is an aggregate
  // in Postgres (pg-mem: "aggregate functions are not allowed in
  // WHERE"; real Postgres: function min(integer, integer) does not
  // exist). The scalar form is LEAST — fixed by the coordinator, both
  // tests green. (The increment test below uses 2026-11-08, whose set
  // includes roll_10 with target 10: on DAY all three quests have
  // target 1, so an n=2 increment is correctly capped to 1.)
  it("recordQuestProgress increments progress for today's matching kinds", async () => {
    const day = new Date("2026-11-08T12:00:00Z");
    const today = questsForDate(day);
    const quest = today.find((q) => q.target >= 2)!;
    await recordQuestProgress(db, "user-1", [quest.kind], 2, day);
    const log = await getQuestLog(db, "user-1", day);
    const entry = log.quests.find((q) => q.def.kind === quest.kind)!;
    expect(entry.progress).toBe(2);
  });

  it("recordQuestProgress caps progress at the quest target", async () => {
    const today = questsForDate(DAY);
    const kind = today[0]!.kind;
    const target = today[0]!.target;
    await recordQuestProgress(db, "user-1", [kind], 999, DAY);
    const log = await getQuestLog(db, "user-1", DAY);
    const entry = log.quests.find((q) => q.def.kind === kind)!;
    expect(entry.progress).toBe(target);
    expect(entry.completed).toBe(true);
  });

  it("recordQuestProgress ignores kinds that are not in today's set", async () => {
    const todayKinds = new Set(questsForDate(DAY).map((q) => q.kind));
    const absent = ["hunt", "roll", "daily", "fuse", "about"].find((k) => !todayKinds.has(k as never));
    if (!absent) return; // all five kinds happen to be live today — nothing to prove
    await recordQuestProgress(db, "user-1", [absent as never], 5, DAY);
    const log = await getQuestLog(db, "user-1", DAY);
    expect(log.quests.every((q) => q.progress === 0)).toBe(true);
  });

  it("claim pays exactly once with exact gold + gem math", async () => {
    const today = questsForDate(DAY);
    const expectedGold = today.reduce((s, q) => s + q.gold, 0);
    const expectedGems = today.reduce((s, q) => s + q.gems, 0);
    await completeAllToday(db, "user-1");
    const beforeGold = (await getBalance(db, GUILD, "user-1")).points;
    const beforeGems = await getGems(db, "user-1");
    const res = await claimQuests(db, GUILD, "user-1", DAY);
    expect(res.claimed).toHaveLength(3);
    expect(res.totalGold).toBe(expectedGold);
    expect(res.totalGems).toBe(expectedGems);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(beforeGold + expectedGold);
    expect(await getGems(db, "user-1")).toBe(beforeGems + expectedGems);
    // Second claim pays nothing.
    const res2 = await claimQuests(db, GUILD, "user-1", DAY);
    expect(res2.claimed).toHaveLength(0);
    expect(res2.totalGold).toBe(0);
    expect(res2.totalGems).toBe(0);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(beforeGold + expectedGold);
  });

  it("claim pays only completed quests, not in-progress ones", async () => {
    // 2026-11-07's set is all target-1, so use 2026-11-08 (all targets > 1).
    const day2 = new Date("2026-11-08T12:00:00Z");
    const key2 = questDateKey(day2);
    const today = questsForDate(day2);
    const inProgress = today.find((q) => q.target > 1)!;
    const done = today.find((q) => q.id !== inProgress.id)!;
    await setProgress(db, "user-1", done.id, done.target, key2);
    await setProgress(db, "user-1", inProgress.id, 1, key2); // 1 < target, still in progress
    const res = await claimQuests(db, GUILD, "user-1", day2);
    expect(res.claimed.map((q) => q.def.id)).toEqual([done.id]);
    expect(res.totalGold).toBe(done.gold);
  });

  it("a new date starts fresh with no progress or claims", async () => {
    await completeAllToday(db, "user-1", DAY);
    await claimQuests(db, GUILD, "user-1", DAY);
    const next = new Date("2026-11-08T12:00:00Z");
    const log = await getQuestLog(db, "user-1", next);
    expect(log.quests.every((q) => q.progress === 0 && !q.claimed)).toBe(true);
    const res = await claimQuests(db, GUILD, "user-1", next);
    expect(res.claimed).toHaveLength(0);
    expect(res.totalGold).toBe(0);
  });

  it("claim with nothing completed pays nothing", async () => {
    const res = await claimQuests(db, GUILD, "user-1", DAY);
    expect(res.claimed).toHaveLength(0);
    expect(res.totalGold).toBe(0);
    expect(res.totalGems).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Lib: formatting + embed
// ---------------------------------------------------------------------------

describe("quests lib — formatting", () => {
  it("progressBar fills proportionally", () => {
    expect(progressBar(0, 3)).toBe("░".repeat(10));
    expect(progressBar(3, 3)).toBe("▓".repeat(10));
    expect(progressBar(1, 2)).toBe("▓".repeat(5) + "░".repeat(5));
    expect(progressBar(1, 4, 4)).toBe("▓░░░");
  });

  it("rewardText formats gold-only and gold+gems", () => {
    expect(rewardText({ gold: 500, gems: 0 } as never)).toBe("500 gold");
    expect(rewardText({ gold: 2000, gems: 1 } as never)).toBe("2,000 gold + 1 gem");
    expect(rewardText({ gold: 5000, gems: 5 } as never)).toBe("5,000 gold + 5 gems");
  });

  it("buildQuestLogEmbed has 3 fields, progress bars, and the reset countdown", async () => {
    const db = getTestDb();
    const log = await getQuestLog(db, "user-1", DAY);
    const embed = buildQuestLogEmbed(log, "Tester", DAY).toJSON();
    expect(embed.title).toContain("Tester");
    expect(embed.title).toContain("Quest Log");
    expect(embed.fields).toHaveLength(3);
    expect(embed.description).toContain("Next quests in");
    for (const [i, field] of embed.fields!.entries()) {
      expect(field.name).toContain(log.quests[i]!.def.title);
      expect(field.value).toContain("0/");
      expect(field.value).toContain("In progress");
    }
  });

  it("embed marks a completed quest claimable and a claimed quest claimed", async () => {
    const db = getTestDb();
    const today = questsForDate(DAY);
    await setProgress(db, "user-1", today[0]!.id, today[0]!.target);
    await setProgress(db, "user-1", today[1]!.id, today[1]!.target);
    await claimQuests(db, GUILD, "user-1", DAY);
    const log = await getQuestLog(db, "user-1", DAY);
    const embed = buildQuestLogEmbed(log, "Tester", DAY).toJSON();
    expect(embed.fields![0]!.value).toContain("✅ Claimed");
    expect(embed.fields![1]!.value).toContain("✅ Claimed");
    expect(embed.fields![2]!.value).toContain("In progress");
  });
});

// ---------------------------------------------------------------------------
// Commands (fake prefix messages, pg-mem DB)
// ---------------------------------------------------------------------------

class FakePrefixMessage implements PrefixMessageLike {
  content: string;
  author: { id: string; username: string; bot?: boolean };
  webhookId: string | null = null;
  guildId: string | null = GUILD;
  channelId = "chan-1";
  guild: unknown = null;
  member: null = null;
  replies: Record<string, unknown>[] = [];
  channelSends: Record<string, unknown>[] = [];
  sentEdits: Record<string, unknown>[] = [];
  channel: { send: (payload: Record<string, unknown>) => Promise<{ id: string; edit: (p: Record<string, unknown>) => Promise<unknown> }> };

  constructor(content: string, opts: { userId?: string; username?: string } = {}) {
    this.content = content;
    this.author = { id: opts.userId ?? "user-1", username: opts.username ?? "tester" };
    this.channel = {
      send: async (payload) => {
        this.channelSends.push(payload);
        return { id: "msg-2", edit: async (p: Record<string, unknown>) => { this.sentEdits.push(p); } };
      },
    };
  }

  async reply(payload: Record<string, unknown>): Promise<{ id: string; edit: (p: Record<string, unknown>) => Promise<unknown> }> {
    this.replies.push(payload);
    return { id: "msg-1", edit: async (p: Record<string, unknown>) => { this.sentEdits.push(p); } };
  }
}

describe("quests commands", () => {
  let db: SelenaDb;

  beforeEach(async () => {
    db = getTestDb();
  });

  async function run(content: string, userId = "user-1"): Promise<FakePrefixMessage> {
    const msg = new FakePrefixMessage(content, { userId });
    await handlePrefixMessage(msg, { db, guildId: GUILD });
    return msg;
  }

  /** Today's live quests (commands always run on the real current date). */
  function todayDefs() {
    return questsForDate(new Date());
  }

  function embedOf(msg: FakePrefixMessage): { title?: string; description?: string; fields?: { name: string; value: string }[] } {
    return (msg.replies[0] as { embeds: unknown[] }).embeds[0] as never;
  }

  it("registers in a Quests help category", () => {
    const group = HELP_GROUPS.find((g) => g.category === "Quests");
    expect(group).toBeDefined();
    expect(group!.commands.map((c) => c.name)).toEqual(["quests"]);
    expect(group!.commands[0]!.aliases).toContain("q");
  });

  it("uwu quests renders the embed with 3 quests + a Claim button", async () => {
    const msg = await run("uwu quests");
    expect(msg.replies).toHaveLength(1);
    const embed = embedOf(msg);
    expect(embed.title).toContain("Quest Log");
    expect(embed.fields).toHaveLength(3);
    const components = (msg.replies[0] as { components: { toJSON: () => { components: { custom_id: string; label: string }[] } }[] }).components;
    expect(components).toHaveLength(1);
    const button = components[0]!.toJSON().components[0]!;
    expect(button.custom_id).toBe("selena:quests:claim");
    expect(button.label).toContain("Claim");
  });

  it("uwu q alias resolves to the same log", async () => {
    const msg = await run("uwu q");
    expect(msg.replies).toHaveLength(1);
    expect(embedOf(msg).fields).toHaveLength(3);
  });

  it("uwu quests claim with nothing completed says so", async () => {
    const msg = await run("uwu quests claim");
    expect(msg.replies).toHaveLength(1);
    const content = (msg.replies[0] as { content: string }).content;
    expect(content).toContain("Nothing to claim");
  });

  it("uwu quests claim pays the exact gold, and a second claim pays nothing", async () => {
    const today = todayDefs();
    const target = today[0]!;
    await setProgress(db, "user-1", target.id, target.target, questDateKey(new Date()));
    const before = (await getBalance(db, GUILD, "user-1")).points;
    const msg = await run("uwu quests claim");
    const content = (msg.replies[0] as { content: string }).content;
    expect(content).toContain("Claimed 1 quest");
    expect(content).toContain(target.title);
    expect(content).toContain(target.gold.toLocaleString("en-US"));
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(before + target.gold);
    const msg2 = await run("uwu quests claim");
    const content2 = (msg2.replies[0] as { content: string }).content;
    expect(content2).toContain("already claimed");
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(before + target.gold);
  });

  it("an unknown first arg shows the log instead of erroring", async () => {
    const msg = await run("uwu quests banana");
    expect(msg.replies).toHaveLength(1);
    expect(embedOf(msg).fields).toHaveLength(3);
  });

  it("Claim button claims and updates the quest message in place", async () => {
    const today = todayDefs();
    const target = today[0]!;
    await setProgress(db, "user-1", target.id, target.target, questDateKey(new Date()));
    const handler = allButtonHandlers["selena:quests"] as unknown as (
      inv: Record<string, unknown>,
      ctx: { db: SelenaDb; guildId: string },
    ) => Promise<void>;
    expect(handler).toBeDefined();
    const updates: Record<string, unknown>[] = [];
    const replies: Record<string, unknown>[] = [];
    await handler(
      {
        customId: "selena:quests:claim",
        user: { id: "user-1", username: "tester" },
        update: async (p: Record<string, unknown>) => { updates.push(p); },
        reply: async (p: Record<string, unknown>) => { replies.push(p); },
      },
      { db, guildId: GUILD },
    );
    expect(updates).toHaveLength(1);
    expect((updates[0]!.content as string)).toContain("Claimed 1 quest");
    const embed = (updates[0]!.embeds as { fields: { value: string }[] }[])[0]!;
    expect(embed.fields[0]!.value).toContain("✅ Claimed");
    expect(replies).toHaveLength(0);
  });

  it("Claim button with nothing completed updates with the plain notice", async () => {
    const handler = allButtonHandlers["selena:quests"] as unknown as (
      inv: Record<string, unknown>,
      ctx: { db: SelenaDb; guildId: string },
    ) => Promise<void>;
    const updates: Record<string, unknown>[] = [];
    await handler(
      {
        customId: "selena:quests:claim",
        user: { id: "user-1", username: "tester" },
        update: async (p: Record<string, unknown>) => { updates.push(p); },
        reply: async () => {},
      },
      { db, guildId: GUILD },
    );
    expect(updates).toHaveLength(1);
    expect((updates[0]!.content as string)).toContain("Nothing to claim");
  });
});
