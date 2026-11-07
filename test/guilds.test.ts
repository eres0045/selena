import { describe, it, expect, beforeEach } from "vitest";
import { type SelenaDb } from "../src/lib/db.js";
import { getTestDb } from "./testDb.js";
import { FakeChatInput } from "../src/lib/testkit.js";
import { addPoints, getBalance } from "../src/lib/economy.js";
import { powerBudget, MONSTER_BY_ID } from "../src/lib/hunt.js";
import {
  GUILD_CREATE_COST,
  GUILD_MAX_LEVEL,
  GUILD_MAX_MEMBERS,
  addGuildXp,
  createGuild,
  disbandGuild,
  getGuildByName,
  getGuildCatchBonus,
  getGuildRank,
  getGuildSellBonus,
  getGuildXpBonus,
  getUserGuild,
  guildLevelForXp,
  inviteMember,
  joinGuild,
  kickMember,
  leaveGuild,
  promoteMember,
} from "../src/lib/guilds.js";
import { commands as guildCommands } from "../src/commands/guilds.js";
import type { CommandContext } from "../src/lib/command.js";

let db: SelenaDb;
let ctx: CommandContext;
const GUILD = "guild-1";
const NOW = 1_790_000_000_000;

function findCommand(name: string) {
  const cmd = guildCommands.find((c) => c.name === name);
  if (!cmd) throw new Error(`command not found: ${name}`);
  return cmd;
}

async function run(
  options: Record<string, unknown>,
  userId = "user-1",
  username = "tester",
): Promise<FakeChatInput> {
  const cmd = findCommand("guild");
  const fake = new FakeChatInput({ commandName: "guild", options, userId, username, guildId: GUILD });
  await cmd.execute(fake as never, ctx);
  return fake;
}

async function seedGold(userId: string, amount: number): Promise<void> {
  await addPoints(db, GUILD, userId, amount, "seed");
}

/** Give a user one copy of a monster (power comes from the roster). */
async function seedMonster(userId: string, monsterId: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO user_monsters (guild_id, user_id, monster_id, count, source, caught_at) VALUES (?, ?, ?, 1, 'hunt', ?)",
    )
    .run(GUILD, userId, monsterId, NOW);
}

/** Create a guild via the lib and top its XP up to the given total. */
async function makeGuild(leaderId: string, name: string, xp = 0) {
  const guild = await createGuild(db, leaderId, name, NOW);
  if (xp > 0) await addGuildXp(db, leaderId, xp);
  return guild;
}

beforeEach(async () => {
  db = getTestDb();
  ctx = { db, guildId: GUILD };
});

// ---------------------------------------------------------------------------
// Level thresholds (doc §3.2)
// ---------------------------------------------------------------------------

describe("guildLevelForXp", () => {
  it("maps every threshold boundary", () => {
    expect(guildLevelForXp(0)).toBe(1);
    expect(guildLevelForXp(999)).toBe(1);
    expect(guildLevelForXp(1000)).toBe(2);
    expect(guildLevelForXp(2999)).toBe(2);
    expect(guildLevelForXp(3000)).toBe(3);
    expect(guildLevelForXp(5999)).toBe(3);
    expect(guildLevelForXp(6000)).toBe(4);
    expect(guildLevelForXp(9999)).toBe(4);
    expect(guildLevelForXp(10000)).toBe(5);
    expect(guildLevelForXp(14999)).toBe(5);
    expect(guildLevelForXp(15000)).toBe(6);
    expect(guildLevelForXp(20000)).toBe(7);
    expect(guildLevelForXp(25000)).toBe(8);
    expect(guildLevelForXp(30000)).toBe(9);
    expect(guildLevelForXp(35000)).toBe(10);
    expect(guildLevelForXp(999999)).toBe(10);
  });

  it("caps at GUILD_MAX_LEVEL 10", () => {
    expect(GUILD_MAX_LEVEL).toBe(10);
    expect(guildLevelForXp(Number.MAX_SAFE_INTEGER)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Lib: create / names
// ---------------------------------------------------------------------------

describe("createGuild", () => {
  it("creates the guild and makes the creator the leader", async () => {
    const guild = await createGuild(db, "user-1", "Fortec", NOW);
    expect(guild.name).toBe("Fortec");
    expect(guild.leader_id).toBe("user-1");
    expect(guild.level).toBe(1);
    expect(guild.xp).toBe(0);
    const mine = await getUserGuild(db, "user-1");
    expect(mine?.id).toBe(guild.id);
  });

  it("refuses a duplicate name (case-insensitive)", async () => {
    await createGuild(db, "user-1", "Fortec", NOW);
    await expect(createGuild(db, "user-2", "Fortec", NOW)).rejects.toThrow(/already exists/);
    await expect(createGuild(db, "user-2", "fortec", NOW)).rejects.toThrow(/already exists/);
    await expect(createGuild(db, "user-2", "  FORTEC  ", NOW)).rejects.toThrow(/already exists/);
  });

  it("refuses creating a second guild while already in one", async () => {
    await createGuild(db, "user-1", "Fortec", NOW);
    await expect(createGuild(db, "user-1", "Other", NOW)).rejects.toThrow(/already in/);
  });

  it("validates names: 2–24 chars, letters/numbers/spaces only", async () => {
    await expect(createGuild(db, "user-1", "A", NOW)).rejects.toThrow(/2–24/);
    await expect(createGuild(db, "user-1", "x".repeat(25), NOW)).rejects.toThrow(/2–24/);
    await expect(createGuild(db, "user-1", "Bad!Name", NOW)).rejects.toThrow(/letters, numbers, and spaces/);
    await expect(createGuild(db, "user-1", "   ", NOW)).rejects.toThrow(/2–24/);
    const ok = await createGuild(db, "user-1", "  My Guild 2 ", NOW);
    expect(ok.name).toBe("My Guild 2");
  });

  it("getGuildByName matches case-insensitively, getUserGuild is null when guildless", async () => {
    await expect(getUserGuild(db, "user-1")).resolves.toBeNull();
    await expect(getGuildByName(db, "Fortec")).resolves.toBeNull();
    await createGuild(db, "user-1", "Fortec", NOW);
    expect((await getGuildByName(db, "fOrTeC"))?.name).toBe("Fortec");
  });
});

// ---------------------------------------------------------------------------
// Lib: join / leave / member cap
// ---------------------------------------------------------------------------

describe("joinGuild / leaveGuild", () => {
  it("joins an open guild and leaves again", async () => {
    await createGuild(db, "user-1", "Fortec", NOW);
    const joined = await joinGuild(db, "user-2", "fortec", NOW);
    expect(joined.name).toBe("Fortec");
    expect((await getUserGuild(db, "user-2"))?.id).toBe(joined.id);
    const left = await leaveGuild(db, "user-2");
    expect(left.name).toBe("Fortec");
    await expect(getUserGuild(db, "user-2")).resolves.toBeNull();
  });

  it("refuses joining a guild that does not exist", async () => {
    await expect(joinGuild(db, "user-1", "Nope", NOW)).rejects.toThrow(/No guild called/);
  });

  it("refuses joining while already in a guild", async () => {
    await createGuild(db, "user-1", "Fortec", NOW);
    await createGuild(db, "user-2", "Other", NOW);
    await expect(joinGuild(db, "user-1", "Other", NOW)).rejects.toThrow(/already in/);
  });

  it("refuses the 21st member (cap 20)", async () => {
    expect(GUILD_MAX_MEMBERS).toBe(20);
    await createGuild(db, "user-0", "Fortec", NOW);
    for (let i = 1; i <= 19; i++) {
      await joinGuild(db, `user-${i}`, "Fortec", NOW);
    }
    await expect(joinGuild(db, "user-20", "Fortec", NOW)).rejects.toThrow(/full/);
    // A seat frees up when someone leaves.
    await leaveGuild(db, "user-19");
    await joinGuild(db, "user-20", "Fortec", NOW);
    expect((await getUserGuild(db, "user-20"))?.name).toBe("Fortec");
  });

  it("the leader cannot leave", async () => {
    await createGuild(db, "user-1", "Fortec", NOW);
    await expect(leaveGuild(db, "user-1")).rejects.toThrow(/leader/);
    expect((await getUserGuild(db, "user-1"))?.name).toBe("Fortec");
  });

  it("leaving with no guild is refused", async () => {
    await expect(leaveGuild(db, "user-1")).rejects.toThrow(/not in a guild/);
  });
});

// ---------------------------------------------------------------------------
// Lib: invite / kick / promote / disband guards
// ---------------------------------------------------------------------------

describe("inviteMember / kickMember / promoteMember / disbandGuild", () => {
  it("a plain member cannot invite; an officer can", async () => {
    const guild = await createGuild(db, "leader", "Fortec", NOW);
    await joinGuild(db, "member", "Fortec", NOW);
    await joinGuild(db, "officer", "Fortec", NOW);
    await promoteMember(db, guild.id, "leader", "officer");
    await expect(inviteMember(db, guild.id, "member", "newbie")).rejects.toThrow(/leader or an officer/);
    await inviteMember(db, guild.id, "officer", "newbie");
    expect((await getUserGuild(db, "newbie"))?.id).toBe(guild.id);
  });

  it("inviting someone already in a guild (or the same guild) is refused", async () => {
    const guild = await createGuild(db, "leader", "Fortec", NOW);
    await createGuild(db, "other-leader", "Other", NOW);
    await expect(inviteMember(db, guild.id, "leader", "other-leader")).rejects.toThrow(/already in another guild/);
    await joinGuild(db, "member", "Fortec", NOW);
    await expect(inviteMember(db, guild.id, "leader", "member")).rejects.toThrow(/already in this guild/);
  });

  it("inviting into a full guild is refused", async () => {
    const guild = await createGuild(db, "user-0", "Fortec", NOW);
    for (let i = 1; i <= 19; i++) await joinGuild(db, `user-${i}`, "Fortec", NOW);
    await expect(inviteMember(db, guild.id, "user-0", "user-20")).rejects.toThrow(/full/);
  });

  it("only the leader can kick; kicking removes the member", async () => {
    const guild = await createGuild(db, "leader", "Fortec", NOW);
    await joinGuild(db, "member", "Fortec", NOW);
    await joinGuild(db, "officer", "Fortec", NOW);
    await promoteMember(db, guild.id, "leader", "officer");
    await expect(kickMember(db, guild.id, "officer", "member")).rejects.toThrow(/Only the guild leader/);
    await expect(kickMember(db, guild.id, "member", "officer")).rejects.toThrow(/Only the guild leader/);
    await expect(kickMember(db, guild.id, "leader", "leader")).rejects.toThrow(/kick yourself/);
    await expect(kickMember(db, guild.id, "leader", "ghost")).rejects.toThrow(/not in this guild/);
    await kickMember(db, guild.id, "leader", "member");
    await expect(getUserGuild(db, "member")).resolves.toBeNull();
  });

  it("promote: member -> officer, officer -> leader transfers leadership", async () => {
    const guild = await createGuild(db, "leader", "Fortec", NOW);
    await joinGuild(db, "member", "Fortec", NOW);
    const first = await promoteMember(db, guild.id, "leader", "member");
    expect(first.newRole).toBe("officer");
    const second = await promoteMember(db, guild.id, "leader", "member");
    expect(second.newRole).toBe("leader");
    expect(second.guild.leader_id).toBe("member");
    // The old leader is now an officer and can no longer promote.
    await expect(promoteMember(db, guild.id, "leader", "member")).rejects.toThrow(/Only the guild leader/);
    expect((await getGuildByName(db, "Fortec"))?.leader_id).toBe("member");
  });

  it("only the leader can promote or disband", async () => {
    const guild = await createGuild(db, "leader", "Fortec", NOW);
    await joinGuild(db, "member", "Fortec", NOW);
    await expect(promoteMember(db, guild.id, "member", "leader")).rejects.toThrow(/Only the guild leader/);
    await expect(disbandGuild(db, guild.id, "member")).rejects.toThrow(/Only the guild leader/);
  });

  it("disband deletes the guild and all its memberships", async () => {
    const guild = await createGuild(db, "leader", "Fortec", NOW);
    await joinGuild(db, "member", "Fortec", NOW);
    const gone = await disbandGuild(db, guild.id, "leader");
    expect(gone.name).toBe("Fortec");
    await expect(getGuildByName(db, "Fortec")).resolves.toBeNull();
    await expect(getUserGuild(db, "leader")).resolves.toBeNull();
    await expect(getUserGuild(db, "member")).resolves.toBeNull();
    // The name is free again afterwards.
    await createGuild(db, "member", "Fortec", NOW);
  });
});

// ---------------------------------------------------------------------------
// Lib: guild XP + perks
// ---------------------------------------------------------------------------

describe("addGuildXp and perk getters", () => {
  it("returns null when the user has no guild", async () => {
    await expect(addGuildXp(db, "user-1", 100)).resolves.toBeNull();
    expect(await getGuildCatchBonus(db, "user-1")).toBe(0);
    expect(await getGuildSellBonus(db, "user-1")).toBe(0);
    expect(await getGuildXpBonus(db, "user-1")).toBe(0);
  });

  it("adds XP and reports level-ups", async () => {
    await createGuild(db, "user-1", "Fortec", NOW);
    expect(await addGuildXp(db, "user-1", 500)).toEqual({ leveledUp: false, newLevel: 1 });
    expect(await addGuildXp(db, "user-1", 500)).toEqual({ leveledUp: true, newLevel: 2 });
    expect((await getUserGuild(db, "user-1"))?.level).toBe(2);
    expect((await getUserGuild(db, "user-1"))?.xp).toBe(1000);
    // Level caps at 10 even with huge XP.
    expect(await addGuildXp(db, "user-1", 1_000_000)).toEqual({ leveledUp: true, newLevel: 10 });
  });

  it("perk getters follow the level table (L1/2/4/6/8/10)", async () => {
    await createGuild(db, "user-1", "Fortec", NOW);
    const perks = async () => ({
      catch: await getGuildCatchBonus(db, "user-1"),
      sell: await getGuildSellBonus(db, "user-1"),
      xp: await getGuildXpBonus(db, "user-1"),
    });
    expect(await perks()).toEqual({ catch: 0, sell: 0, xp: 0 }); // L1
    await addGuildXp(db, "user-1", 1000); // L2
    expect(await perks()).toEqual({ catch: 2, sell: 0, xp: 0 });
    await addGuildXp(db, "user-1", 2000); // L3: catch still +2
    expect(await perks()).toEqual({ catch: 2, sell: 0, xp: 0 });
    await addGuildXp(db, "user-1", 3000); // L4
    expect(await perks()).toEqual({ catch: 2, sell: 5, xp: 0 });
    await addGuildXp(db, "user-1", 9000); // L6
    expect(await perks()).toEqual({ catch: 7, sell: 5, xp: 0 });
    await addGuildXp(db, "user-1", 10000); // L8
    expect(await perks()).toEqual({ catch: 7, sell: 15, xp: 0 });
    await addGuildXp(db, "user-1", 10000); // L10
    expect(await perks()).toEqual({ catch: 17, sell: 15, xp: 5 });
  });
});

// ---------------------------------------------------------------------------
// Lib: ranking
// ---------------------------------------------------------------------------

describe("getGuildRank", () => {
  it("is empty with no guilds", async () => {
    expect(await getGuildRank(db)).toEqual([]);
  });

  it("orders by level, then XP, then total power", async () => {
    // Alpha and Beta both reach L5 at 10,000 XP; Beta has the stronger zoo.
    await makeGuild("alpha-leader", "Alpha", 10000);
    await makeGuild("beta-leader", "Beta", 10000);
    // Gamma is only L2 but owns the strongest monster in the game.
    await makeGuild("gamma-leader", "Gamma", 1000);
    await seedMonster("alpha-leader", 1); // Pebble Pup, weak
    await seedMonster("beta-leader", 100); // The UwU Sovereign
    await seedMonster("beta-leader", 97); // Void Dragon
    await seedMonster("gamma-leader", 100); // UwU, but L2 loses to L5

    const rank = await getGuildRank(db);
    expect(rank.map((g) => g.name)).toEqual(["Beta", "Alpha", "Gamma"]);
    expect(rank[0]?.memberCount).toBe(1);
    const uwu = MONSTER_BY_ID.get(100)!;
    const voidDragon = MONSTER_BY_ID.get(97)!;
    expect(rank[0]?.power).toBe(powerBudget(uwu) + powerBudget(voidDragon));
    expect(rank[1]?.power).toBe(powerBudget(MONSTER_BY_ID.get(1)!));
    // Level beats power: Gamma's UwU cannot outrank L5 guilds.
    expect(rank[2]?.level).toBe(2);
  });

  it("uses only each member's top-3 monsters for power", async () => {
    await makeGuild("leader", "Fortec", 0);
    // Four monsters: only the top 3 count.
    await seedMonster("leader", 1); // Pebble Pup
    await seedMonster("leader", 2); // Sproutling
    await seedMonster("leader", 100); // UwU Sovereign
    await seedMonster("leader", 97); // Void Dragon
    const rank = await getGuildRank(db);
    const budgets = [1, 2, 100, 97]
      .map((id) => powerBudget(MONSTER_BY_ID.get(id)!))
      .sort((a, b) => b - a);
    expect(rank[0]?.power).toBe(budgets[0]! + budgets[1]! + budgets[2]!);
  });

  it("respects the limit", async () => {
    await makeGuild("a", "Guild A", 0);
    await makeGuild("b", "Guild B", 0);
    await makeGuild("c", "Guild C", 0);
    expect((await getGuildRank(db, 2)).map((g) => g.name)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Command: `uwu guild ...`
// ---------------------------------------------------------------------------

describe("guild command", () => {
  it("create charges 5,000 gold and makes the creator leader", async () => {
    expect(GUILD_CREATE_COST).toBe(5000);
    await seedGold("user-1", 10000);
    const fake = await run({ action: "create", name: "Fortec" }, "user-1");
    expect(fake.allText()).toMatch(/Guild "Fortec" created/);
    expect(fake.allText()).toMatch(/5,000 gold/);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(5000);
    expect((await getUserGuild(db, "user-1"))?.leader_id).toBe("user-1");
  });

  it("create refuses when broke — no gold taken, no guild made", async () => {
    await seedGold("user-1", 4999);
    const fake = await run({ action: "create", name: "Fortec" }, "user-1");
    expect(fake.allText()).toMatch(/5,000 gold/);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(4999);
    await expect(getGuildByName(db, "Fortec")).resolves.toBeNull();
  });

  it("create refuses a taken name and a second guild", async () => {
    await seedGold("user-1", 20000);
    await seedGold("user-2", 20000);
    await run({ action: "create", name: "Fortec" }, "user-1");
    const dup = await run({ action: "create", name: "fortec" }, "user-2");
    expect(dup.allText()).toMatch(/already exists/);
    expect((await getBalance(db, GUILD, "user-2")).points).toBe(20000);
    const second = await run({ action: "create", name: "Other" }, "user-1");
    expect(second.allText()).toMatch(/already in/);
  });

  it("join / info / leave flow, with plain-text replies and no pings", async () => {
    await makeGuild("leader", "Fortec", 1000); // L2
    const joined = await run({ action: "join", name: "Fortec" }, "member-1", "member-one");
    expect(joined.allText()).toMatch(/joined.*"Fortec"/);
    const info = await run({ action: "info" }, "member-1", "member-one");
    const text = info.allText();
    expect(text).toMatch(/Fortec — Level 2/);
    expect(text).toMatch(/1,000 XP/);
    expect(text).toMatch(/Members: 2\/20/);
    expect(text).toMatch(/\+2% catch chance/);
    expect(text).toContain("member-1");
    expect(text).not.toContain("<@");
    const left = await run({ action: "leave" }, "member-1", "member-one");
    expect(left.allText()).toMatch(/left "Fortec"/);
    await expect(getUserGuild(db, "member-1")).resolves.toBeNull();
  });

  it("info by name shows another guild; unknown name errors", async () => {
    await makeGuild("leader", "Fortec", 0);
    const info = await run({ action: "info", name: "Fortec" }, "outsider", "outsider");
    expect(info.allText()).toMatch(/Fortec — Level 1/);
    expect(info.allText()).toMatch(/Perks: none yet/);
    const missing = await run({ action: "info", name: "Nope" }, "outsider", "outsider");
    expect(missing.allText()).toMatch(/No guild called/);
  });

  it("leave refuses the leader", async () => {
    await makeGuild("leader", "Fortec", 0);
    const fake = await run({ action: "leave" }, "leader", "leader");
    expect(fake.allText()).toMatch(/leader/);
    expect((await getUserGuild(db, "leader"))?.name).toBe("Fortec");
  });

  it("invite / kick / promote / disband through the command", async () => {
    await makeGuild("leader", "Fortec", 0);
    await joinGuild(db, "member", "Fortec", NOW);
    // Member cannot invite or kick.
    const noInvite = await run(
      { action: "invite", target: { id: "newbie", username: "newbie" } },
      "member",
      "member",
    );
    expect(noInvite.allText()).toMatch(/leader or an officer/);
    // Leader invites, promotes, and the new officer invites too.
    const invited = await run(
      { action: "invite", target: { id: "newbie", username: "newbie" } },
      "leader",
      "leader",
    );
    expect(invited.allText()).toMatch(/Invited newbie to "Fortec"/);
    const promoted = await run(
      { action: "promote", target: { id: "member", username: "member" } },
      "leader",
      "leader",
    );
    expect(promoted.allText()).toMatch(/now an Officer/);
    // Leader kicks the newbie.
    const kicked = await run(
      { action: "kick", target: { id: "newbie", username: "newbie" } },
      "leader",
      "leader",
    );
    expect(kicked.allText()).toMatch(/Kicked newbie/);
    await expect(getUserGuild(db, "newbie")).resolves.toBeNull();
    // Officer cannot disband; leader can.
    const noDisband = await run({ action: "disband" }, "member", "member");
    expect(noDisband.allText()).toMatch(/Only the guild leader/);
    const disbanded = await run({ action: "disband" }, "leader", "leader");
    expect(disbanded.allText()).toMatch(/has been disbanded/);
    await expect(getGuildByName(db, "Fortec")).resolves.toBeNull();
  });

  it("rank lists guilds in order; empty board says so", async () => {
    const empty = await run({ action: "rank" }, "user-1");
    expect(empty.allText()).toMatch(/No guilds exist yet/);
    await makeGuild("a-leader", "Alpha", 10000);
    await makeGuild("b-leader", "Beta", 1000);
    const ranked = await run({ action: "rank" }, "user-1");
    const text = ranked.allText();
    expect(text).toMatch(/Guild Rankings/);
    expect(text.indexOf("Alpha")).toBeLessThan(text.indexOf("Beta"));
    expect(text).toMatch(/#1 Alpha — Level 5/);
  });

  it("unknown action and bare guild show usage, not a crash", async () => {
    const unknown = await run({ action: "frobnicate" }, "user-1");
    expect(unknown.allText()).toMatch(/Unknown guild action/);
    const bare = await run({}, "user-1");
    expect(bare.allText()).toMatch(/Usage: `uwu guild/);
  });

  it("promote to leader transfers leadership through the command", async () => {
    await makeGuild("leader", "Fortec", 0);
    await joinGuild(db, "member", "Fortec", NOW);
    await run({ action: "promote", target: { id: "member", username: "member" } }, "leader", "leader");
    const transferred = await run(
      { action: "promote", target: { id: "member", username: "member" } },
      "leader",
      "leader",
    );
    expect(transferred.allText()).toMatch(/now the Leader/);
    expect((await getGuildByName(db, "Fortec"))?.leader_id).toBe("member");
  });
});
