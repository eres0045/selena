import { describe, it, expect, beforeEach } from "vitest";
import { type SelenaDb } from "../src/lib/db.js";
import { getTestDb } from "./testDb.js";
import { FakeChatInput } from "../src/lib/testkit.js";
import {
  addPoints,
  claimDaily,
  getBalance,
  getLeaderboard,
  transferPoints,
} from "../src/lib/economy.js";
import { commands as economyCommands } from "../src/commands/economy.js";
import type { CommandContext } from "../src/lib/command.js";

let db: SelenaDb;
let ctx: CommandContext;
const GUILD = "guild-1";

async function seed(userId: string, points: number): Promise<void> {
  await addPoints(db, GUILD, userId, points, "seed");
}

function findCommand(name: string) {
  const cmd = economyCommands.find((c) => c.name === name);
  if (!cmd) throw new Error(`command not found: ${name}`);
  return cmd;
}

async function run(name: string, options: Record<string, unknown>, userId = "user-1", username = "tester") {
  const cmd = findCommand(name);
  const fake = new FakeChatInput({ commandName: name, options, userId, username, guildId: GUILD });
  await cmd.execute(fake as never, ctx);
  return fake;
}

beforeEach(async () => {
  db = getTestDb();
  ctx = { db, guildId: GUILD };
});

// ---------------------------------------------------------------------------
// Lib: daily
// ---------------------------------------------------------------------------

describe("claimDaily", () => {
  it("pays 100 points on first claim", async () => {
    const r = await claimDaily(db, GUILD, "user-1", 1_000_000);
    expect(r.ok).toBe(true);
    expect(r.amount).toBe(100);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(100);
  });

  it("rejects a second claim inside 24h with nextAvailableAt", async () => {
    const now = 1_000_000;
    expect((await claimDaily(db, GUILD, "user-1", now)).ok).toBe(true);
    const second = await claimDaily(db, GUILD, "user-1", now + 60_000);
    expect(second.ok).toBe(false);
    expect(second.nextAvailableAt).toBe(now + 24 * 60 * 60 * 1000);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(100); // no double pay
  });

  it("allows a claim after the cooldown has passed", async () => {
    const now = 1_000_000;
    await claimDaily(db, GUILD, "user-1", now);
    const later = await claimDaily(db, GUILD, "user-1", now + 24 * 60 * 60 * 1000);
    expect(later.ok).toBe(true);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(200);
  });

  it("cooldowns are per user and per guild", async () => {
    await claimDaily(db, GUILD, "user-1", 1_000_000);
    expect((await claimDaily(db, GUILD, "user-2", 1_000_000)).ok).toBe(true);
    expect((await claimDaily(db, "guild-2", "user-1", 1_000_000)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lib: transfers + negative-balance prevention
// ---------------------------------------------------------------------------

describe("transferPoints", () => {
  it("moves points and logs both sides of the ledger", async () => {
    await seed("user-1", 500);
    await seed("user-2", 50);
    const r = await transferPoints(db, GUILD, "user-1", "user-2", 200);
    expect(r.ok).toBe(true);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(300);
    expect((await getBalance(db, GUILD, "user-2")).points).toBe(250);
    const ledger = await db
      .prepare("SELECT user_id, delta FROM point_ledger WHERE guild_id = ? ORDER BY id")
      .all(GUILD);
    // seed entries + the two transfer entries
    expect(ledger.filter((l) => Number(l.delta) === -200).length).toBe(1);
    expect(ledger.filter((l) => Number(l.delta) === 200).length).toBe(1);
  });

  it("rejects insufficient funds and changes nothing", async () => {
    await seed("user-1", 100);
    const r = await transferPoints(db, GUILD, "user-1", "user-2", 101);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/insufficient/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(100);
    expect((await getBalance(db, GUILD, "user-2")).points).toBe(0);
  });

  it("allows transferring the exact balance", async () => {
    await seed("user-1", 100);
    expect((await transferPoints(db, GUILD, "user-1", "user-2", 100)).ok).toBe(true);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(0);
  });

  it("rejects self-giving", async () => {
    await seed("user-1", 100);
    const r = await transferPoints(db, GUILD, "user-1", "user-1", 10);
    expect(r.ok).toBe(false);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(100);
  });

  it("rejects zero and negative amounts", async () => {
    await seed("user-1", 100);
    expect((await transferPoints(db, GUILD, "user-1", "user-2", 0)).ok).toBe(false);
    expect((await transferPoints(db, GUILD, "user-1", "user-2", -50)).ok).toBe(false);
    expect((await transferPoints(db, GUILD, "user-1", "user-2", 1.5)).ok).toBe(false);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(100);
  });
});

describe("negative-balance prevention", () => {
  it("addPoints with a negative delta larger than the balance throws and changes nothing", async () => {
    await seed("user-1", 30);
    await expect(addPoints(db, GUILD, "user-1", -31, "test")).rejects.toThrow(/insufficient/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(30);
  });

  it("addPoints can drain to exactly zero but never below", async () => {
    await seed("user-1", 30);
    expect(await addPoints(db, GUILD, "user-1", -30, "test")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Lib: leaderboard
// ---------------------------------------------------------------------------

describe("getLeaderboard", () => {
  it("orders by points descending and caps at the limit", async () => {
    await seed("user-a", 50);
    await seed("user-b", 500);
    await seed("user-c", 200);
    const top = await getLeaderboard(db, GUILD, 2);
    expect(top.map((e) => e.userId)).toEqual(["user-b", "user-c"]);
    expect(top[0]?.points).toBe(500);
    const all = await getLeaderboard(db, GUILD, 10);
    expect(all.map((e) => e.userId)).toEqual(["user-b", "user-c", "user-a"]);
  });

  it("is scoped to the guild", async () => {
    await seed("user-a", 500);
    await addPoints(db, "guild-2", "user-b", 999, "seed");
    expect((await getLeaderboard(db, GUILD, 10)).map((e) => e.userId)).toEqual(["user-a"]);
  });
});

// ---------------------------------------------------------------------------
// Commands (mocked client)
// ---------------------------------------------------------------------------

describe("/balance command", () => {
  it("happy path: one plain-text line, no embed, no attachment", async () => {
    await seed("user-1", 250);
    const fake = await run("balance", {});
    const payload = fake.firstReplyPayload() as Record<string, unknown>;
    expect(typeof payload.content).toBe("string");
    expect(payload.embeds).toBeUndefined();
    expect(payload.files).toBeUndefined();
    // Coin sits immediately before the amount (like a currency symbol),
    // never at the start of the line; currency is "gold", not "points".
    expect(payload.content).toMatch(/Hey <@user-1>, you currently have <a:coin:\d+> 250 gold!/);
    expect(payload.content).not.toMatch(/points/);
    expect(payload.content).toMatch(/0 XP · Level 0/);
  });

  it("happy path: shows another user's balance", async () => {
    await seed("user-2", 42);
    const fake = await run("balance", { user: { id: "user-2", username: "friend" } });
    const payload = fake.firstReplyPayload() as Record<string, unknown>;
    expect(payload.content).toMatch(/Hey <@user-2>, you currently have <a:coin:\d+> 42 gold!/);
    expect(payload.content).toMatch(/0 XP · Level 0/);
  });

  it("error path: a brand-new user shows 0, not a crash", async () => {
    const fake = await run("balance", {});
    expect(fake.allText()).toMatch(/0/);
  });
});

describe("/daily command", () => {
  it("happy path: first claim replies with the reward", async () => {
    const fake = await run("daily", {});
    expect(fake.allText()).toMatch(/100/);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(100);
  });

  it("error path: second claim in the same day is rejected", async () => {
    await run("daily", {});
    const fake = await run("daily", {});
    expect(fake.allText()).toMatch(/already claimed/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(100);
  });
});

describe("/give command", () => {
  it("happy path: transfers points and reports both balances", async () => {
    await seed("user-1", 300);
    const fake = await run("give", { user: { id: "user-2", username: "friend" }, amount: 120 });
    expect(fake.allText()).toMatch(/120/);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(180);
    expect((await getBalance(db, GUILD, "user-2")).points).toBe(120);
  });

  it("error path: insufficient funds", async () => {
    await seed("user-1", 10);
    const fake = await run("give", { user: { id: "user-2", username: "friend" }, amount: 999 });
    expect(fake.allText()).toMatch(/insufficient/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(10);
  });

  it("error path: self-give", async () => {
    await seed("user-1", 100);
    const fake = await run("give", { user: { id: "user-1", username: "tester" }, amount: 10 });
    expect(fake.allText()).toMatch(/yourself/i);
  });

  it("error path: zero / negative amount", async () => {
    await seed("user-1", 100);
    const zero = await run("give", { user: { id: "user-2", username: "friend" }, amount: 0 });
    expect(zero.allText()).toMatch(/positive/i);
    const neg = await run("give", { user: { id: "user-2", username: "friend" }, amount: -5 });
    expect(neg.allText()).toMatch(/positive/i);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(100);
  });
});

describe("/leaderboard command", () => {
  it("happy path: lists holders in order", async () => {
    await seed("user-a", 10);
    await seed("user-b", 90);
    const fake = await run("leaderboard", {});
    const text = fake.allText();
    expect(text).toMatch(/90/);
    expect(text.indexOf("**90**")).toBeLessThan(text.indexOf("**10**"));
  });

  it("error path: empty guild explains nobody has gold yet", async () => {
    const fake = await run("leaderboard", {});
    expect(fake.allText()).toMatch(/nobody has any gold/i);
  });
});
