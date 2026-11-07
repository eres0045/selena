import { describe, expect, it, beforeEach } from "vitest";
import { mulberry32 } from "../src/lib/rng.js";
import type { SelenaDb } from "../src/lib/db.js";
import { getTestDb } from "./testDb.js";
import { addPoints, getBalance } from "../src/lib/economy.js";
import { addMonster } from "../src/lib/huntDb.js";
import { MONSTER_BY_ID, type Monster } from "../src/lib/hunt.js";
import { FakeButton, FakeChatInput } from "../src/lib/testkit.js";
import {
  BATTLE_COOLDOWN_MS,
  DOT_PCT,
  MAX_BATTLE_ROUNDS,
  WAGER_CAP,
  awardBattleXp,
  createChallenge,
  expireBattleChallenges,
  getBattleCooldownRemainingMs,
  getBattleTeam,
  getChallenge,
  grantMonsterXp,
  pickTeam,
  setBattleTimestamp,
  setChallengeStatus,
  settleBattle,
  simulateBattle,
  triggerChanceFor,
  type TeamMemberInput,
} from "../src/lib/battle.js";
import {
  battleReplay,
  buttonHandlers,
  commands,
} from "../src/commands/battle.js";

const GUILD = "guild-1";
const ALICE = "user-alice";
const BOB = "user-bob";
const CAROL = "user-carol";

function mon(id: number): Monster {
  return MONSTER_BY_ID.get(id)!;
}

/** A side's team from roster ids, all level 1. */
function team(ids: number[]): TeamMemberInput[] {
  return ids.map((id) => ({ monster: mon(id), level: 1 }));
}

function battle(
  aIds: number[],
  bIds: number[],
  rand: () => number,
  weaponAtkA = 0,
) {
  return simulateBattle(
    { ownerId: ALICE, ownerName: "Alice", team: team(aIds), weaponAtk: weaponAtkA },
    { ownerId: BOB, ownerName: "Bob", team: team(bIds) },
    rand,
  );
}

/** Constant rand — 0.5 never crits (10%) and never triggers any effect. */
const calm = () => 0.5;
/** Constant rand — 0.1 never crits (0.1 < 0.1 is false) but triggers
 * every effect whose chance is above 10%. */
const triggerHappy = () => 0.1;

describe("pickTeam", () => {
  it("picks the 3 strongest by power budget", () => {
    const members: TeamMemberInput[] = [
      { monster: mon(1), level: 1 }, // Pebble Pup, budget 55+40+18 = 113
      { monster: mon(91), level: 1 }, // Solar Dragon, budget 558
      { monster: mon(26), level: 1 }, // Stone Beetle, budget 68+32+24 = 124
      { monster: mon(66), level: 1 }, // Crystal Wolf, budget 130+96+42 = 268
      { monster: mon(3), level: 1 }, // Cinder Mouse, budget 45+44+15 = 104
    ];
    const picked = pickTeam(members);
    expect(picked.map((m) => m.monster.id)).toEqual([91, 66, 26]);
  });

  it("level scaling can lift a low tier above a higher tier at level 1", () => {
    // Stone Beetle at level 100 (~3x stats) outranks Crystal Wolf at 1.
    const members: TeamMemberInput[] = [
      { monster: mon(66), level: 1 },
      { monster: mon(26), level: 100 },
    ];
    expect(pickTeam(members)[0]!.monster.id).toBe(26);
  });

  it("fusion adds power (same monster, higher fuse ranks first)", () => {
    const members: TeamMemberInput[] = [
      { monster: mon(26), level: 1, fuseLevel: 0 },
      { monster: mon(26), level: 1, fuseLevel: 6 },
    ];
    expect(pickTeam(members)[0]!.fuseLevel).toBe(6);
  });
});

describe("simulateBattle — basics", () => {
  it("is deterministic for a seeded rand", () => {
    const r1 = battle([91, 92, 93], [1, 2, 3], mulberry32(42));
    const r2 = battle([91, 92, 93], [1, 2, 3], mulberry32(42));
    expect(r1).toEqual(r2);
    expect(r1.winner).toBe("A");
  });

  it("highest-ATK monster acts first each round", () => {
    // Pebble Pup (ATK 10) vs Stone Beetle (ATK 8): Pup first.
    const r = battle([1], [26], calm);
    expect(r.rounds[0]!.lines[0]).toContain("Pebble Pup used");
  });

  it("damage follows max(1, ATK − DEF÷2): Pup 6, Beetle 5", () => {
    const r = battle([1], [26], calm);
    expect(r.rounds[0]!.lines[0]).toContain("6 damage");
    expect(r.rounds[0]!.lines[1]).toContain("5 damage");
    // Pup: 55 HP, takes 5/round → faints in round 11. Beetle wins.
    expect(r.winner).toBe("B");
    expect(r.roundsFought).toBe(11);
  });

  it("a tier gap is decisive (3 Legendaries vs 3 Commons)", () => {
    const r = battle([91, 92, 93], [1, 2, 3], mulberry32(7));
    expect(r.winner).toBe("A");
    expect(r.finalBlow).not.toBeNull();
  });

  it("a weapon ATK bonus backs the active monster", () => {
    // Same monster both sides; A has +10 weapon ATK and wins.
    const r = battle([1], [1], calm, 10);
    expect(r.winner).toBe("A");
    expect(r.roundsFought).toBe(4);
  });

  it("a battle that cannot end is a draw on remaining HP", () => {
    // Two walls that out-heal the 1 damage they deal each round: the
    // 100-round cap decides it on remaining HP (a tie here → draw).
    const wall: Monster = {
      id: 998, name: "Test Wall", type: "Earth", tier: "Common",
      hp: 100, atk: 1, def: 100, move: "Nudge", effects: ["Regen", "Shield"], area: "M",
    };
    const r = simulateBattle(
      { ownerId: ALICE, ownerName: "Alice", team: [{ monster: wall, level: 1 }] },
      { ownerId: BOB, ownerName: "Bob", team: [{ monster: wall, level: 1 }] },
      calm,
    );
    expect(r.winner).toBe("draw");
    expect(r.roundsFought).toBe(MAX_BATTLE_ROUNDS);
  });
});

describe("simulateBattle — status effects", () => {
  it("DoT worst case is exactly the 12% cap (Burn 5 + Poison 4 + Bleed 3)", () => {
    expect(DOT_PCT.Burn! + DOT_PCT.Poison! + DOT_PCT.Bleed!).toBe(12);
  });

  it("Burn applies on hit and ticks 5% max HP per turn", () => {
    // Cinder Mouse (Burn 25%) vs Pebble Pup.
    const r = battle([3], [1], triggerHappy);
    expect(r.log.join("\n")).toContain("is Burn!");
    expect(r.log.join("\n")).toMatch(/takes \d+ damage from Burn/);
  });

  it("Poison ticks 4% max HP per turn", () => {
    const r = battle([62], [1], triggerHappy); // Venom Spider
    expect(r.log.join("\n")).toContain("is Poison!");
    expect(r.log.join("\n")).toMatch(/takes \d+ damage from Poison/);
  });

  it("Stun skips the target's turn — then the 1-turn control immunity lets it act", () => {
    const r = battle([70], [1], triggerHappy); // Stone Titan
    const text = r.log.join("\n");
    expect(text).toContain("is Stun!");
    // Round 1: Pup is stunned and never acts. Round 2: Stun ended, so
    // the 1-turn immunity (design §3.3 rule 5) blocks the re-stun and
    // Pup gets its turn back.
    expect(r.rounds[0]!.lines.join("\n")).not.toContain("Pebble Pup used");
    expect(r.rounds[1]!.lines.join("\n")).toContain("Pebble Pup used");
    expect(r.winner).toBe("A");
  });

  it("Freeze skips a turn and lowers DEF", () => {
    const r = battle([66], [1], triggerHappy); // Crystal Wolf
    const text = r.log.join("\n");
    expect(text).toContain("is Freeze!");
    expect(text).not.toContain("Pebble Pup used");
  });

  it("Paralyze can skip the target's turn", () => {
    const r = battle([69], [1], triggerHappy); // Storm Dragonet
    const text = r.log.join("\n");
    expect(text).toContain("is Paralyze!");
    expect(text).not.toContain("Pebble Pup used");
  });

  it("Sleep skips turns but any damage wakes the target", () => {
    const r = battle([92], [1], triggerHappy); // Lunar Wolf
    const text = r.log.join("\n");
    expect(text).toContain("is Sleep!");
    expect(text).toContain("woke up!");
  });

  it("Confuse can make the target hurt itself", () => {
    const r = battle([83], [1], triggerHappy); // Shadow Dragon
    const text = r.log.join("\n");
    expect(text).toContain("is Confuse!");
    expect(text).toContain("hurts itself");
  });

  it("Attack Down weakens the target's hits", () => {
    const r = battle([50], [1], triggerHappy); // Spirit Owl
    const text = r.log.join("\n");
    expect(text).toContain("is Attack Down!");
    // Pup ATK 10 × 0.75 = 7; 7 − 8÷2 = 3 damage vs Owl DEF 8.
    expect(text).toContain("3 damage");
  });

  it("Defense Down raises the damage the target takes", () => {
    // High-HP dummy so the second hit is not capped by remaining HP
    // (the log prints damage actually dealt).
    const dummy: Monster = {
      id: 997, name: "Test Dummy", type: "Earth", tier: "Common",
      hp: 500, atk: 5, def: 6, move: "Wobble", effects: [], area: "M",
    };
    const r = simulateBattle(
      { ownerId: ALICE, ownerName: "Alice", team: [{ monster: mon(89), level: 1 }] },
      { ownerId: BOB, ownerName: "Bob", team: [{ monster: dummy, level: 1 }] },
      triggerHappy,
    );
    const text = r.log.join("\n");
    expect(text).toContain("is Defense Down!");
    // Kraken ATK 33 vs Dummy DEF 6: first hit 33 − 3 = 30. With Defense
    // Down (DEF 6 × 0.7 = 4): 33 − 2 = 31.
    expect(text).toContain("30 damage");
    expect(text).toContain("31 damage");
  });

  it("Shield is used on the monster's own turn", () => {
    const r = battle([75], [1], calm); // Spirit Guardian
    expect(r.log.join("\n")).toContain("uses Shield!");
  });

  it("Regen heals — unless Burn is active (DoT beats healing)", () => {
    // No Burn ever: Phoenix regens (Mouse deals 1/round, Regen heals 11).
    const healed = battle([81], [3], calm); // Inferno Phoenix vs Cinder Mouse
    expect(healed.log.join("\n")).toContain("regenerates");
    // Burn always lands: no regen line appears after the Burn lands.
    const burned = battle([81], [3], triggerHappy);
    const text = burned.log.join("\n");
    const burnAt = text.indexOf("is Burn!");
    expect(burnAt).toBeGreaterThan(-1);
    expect(text.slice(burnAt)).not.toContain("regenerates");
  });

  it("Lifesteal heals a share of the damage dealt", () => {
    const r = battle([87], [1], calm); // Nature Warden
    expect(r.log.join("\n")).toContain("drains");
  });

  it("Crit Up raises crit chance (seeded crit lands)", () => {
    // Solar Dragon (Burn + Crit Up) with rand 0.05: crit chance 35%.
    const r = battle([91], [1], () => 0.05);
    expect(r.log.join("\n")).toContain("CRIT!");
  });

  it("Evasion Up dodges attacks", () => {
    const evader: Monster = {
      id: 999, name: "Test Evader", type: "Wind", tier: "Common",
      hp: 100, atk: 10, def: 5, move: "Dodge Roll", effects: ["Evasion Up"], area: "M",
    };
    const r = simulateBattle(
      { ownerId: ALICE, ownerName: "Alice", team: [{ monster: evader, level: 1 }] },
      { ownerId: BOB, ownerName: "Bob", team: team([1]) },
      triggerHappy,
    );
    expect(r.log.join("\n")).toContain("dodged");
    expect(r.winner).toBe("A");
  });

  it("fusion raises on-hit trigger chances (+10pp at +2, +20pp at +4)", () => {
    expect(triggerChanceFor("Burn", 0)).toBe(25);
    expect(triggerChanceFor("Burn", 2)).toBe(35);
    expect(triggerChanceFor("Burn", 4)).toBe(45);
  });
});

// ---------------------------------------------------------------------------
// Command-level tests (pg-mem DB, fake invocations)
// ---------------------------------------------------------------------------

describe("uwu battle command", () => {
  let db: SelenaDb;
  const ctx = () => ({ db, guildId: GUILD });

  beforeEach(() => {
    db = getTestDb();
    battleReplay.delayMs = 0;
  });

  async function seedZoo(userId: string, monsterIds: number[]): Promise<void> {
    for (const id of monsterIds) await addMonster(db, GUILD, userId, id, "hunt", Date.now());
  }

  async function seedGold(userId: string, amount: number): Promise<void> {
    await addPoints(db, GUILD, userId, amount, "test seed");
  }

  async function balance(userId: string): Promise<number> {
    return (await getBalance(db, GUILD, userId)).points;
  }

  function runBattle(userId: string, opponent: { id: string; username: string }, wager?: number) {
    const cmd = commands.find((c) => c.name === "battle")!;
    const inv = new FakeChatInput({
      commandName: "battle",
      userId,
      username: userId === ALICE ? "Alice" : "Bob",
      guildId: GUILD,
      options: wager === undefined ? { opponent } : { opponent, wager },
    });
    return { cmd, inv };
  }

  async function challenge(
    wager?: number,
  ): Promise<{ inv: FakeChatInput; challengeId: number }> {
    await seedZoo(ALICE, [91, 92, 93]);
    await seedZoo(BOB, [1, 2, 3]);
    const { cmd, inv } = runBattle(ALICE, { id: BOB, username: "Bob" }, wager);
    await cmd.execute(inv as never, ctx());
    const row = (await db
      .prepare("SELECT id FROM battle_challenges WHERE challenger_id = ? AND opponent_id = ? ORDER BY id DESC LIMIT 1")
      .get(ALICE, BOB)) as { id: number } | undefined;
    expect(row, "challenge row created").toBeDefined();
    return { inv, challengeId: Number(row!.id) };
  }

  function lastEditText(btn: FakeButton): string {
    const edits = btn.replies.filter((r) => r.kind === "editReply");
    const last = edits[edits.length - 1];
    return String((last?.payload as { content?: string } | undefined)?.content ?? "");
  }

  it("creates a challenge with Accept/Decline buttons", async () => {
    const { inv, challengeId } = await challenge();
    const text = inv.allText();
    expect(text).toContain("challenges");
    expect(text).toContain("Solar Dragon");
    expect(text).toContain("60 seconds");
    const row = await getChallenge(db, challengeId);
    expect(row?.status).toBe("pending");
    expect(row?.wager).toBe(0);
  });

  it("refuses a challenge against yourself", async () => {
    const { cmd, inv } = runBattle(ALICE, { id: ALICE, username: "Alice" });
    await cmd.execute(inv as never, ctx());
    expect(inv.allText()).toContain("yourself");
  });

  it("refuses when the challenger's zoo is empty", async () => {
    await seedZoo(BOB, [1]);
    const { cmd, inv } = runBattle(ALICE, { id: BOB, username: "Bob" });
    await cmd.execute(inv as never, ctx());
    expect(inv.allText()).toContain("zoo is empty");
  });

  it("refuses a wager above the 1,000 cap", async () => {
    await seedZoo(ALICE, [91]);
    await seedZoo(BOB, [1]);
    const { cmd, inv } = runBattle(ALICE, { id: BOB, username: "Bob" }, WAGER_CAP + 500);
    await cmd.execute(inv as never, ctx());
    expect(inv.allText()).toContain("capped at 1,000");
  });

  it("refuses a wager the challenger cannot afford", async () => {
    await seedZoo(ALICE, [91]);
    await seedZoo(BOB, [1]);
    await seedGold(ALICE, 50);
    const { cmd, inv } = runBattle(ALICE, { id: BOB, username: "Bob" }, 100);
    await cmd.execute(inv as never, ctx());
    expect(inv.allText()).toContain("only have 50 gold");
  });

  it("decline ends the challenge with no gold moved", async () => {
    await seedGold(ALICE, 500);
    await seedGold(BOB, 500);
    const { challengeId } = await challenge();
    const btn = new FakeButton({ customId: `selena:battle:decline:${challengeId}`, userId: BOB, username: "Bob" });
    await buttonHandlers["selena:battle"]!(btn as never, ctx());
    expect((await getChallenge(db, challengeId))?.status).toBe("declined");
    expect(lastEditText(btn)).toContain("declined");
    expect(await balance(ALICE)).toBe(500);
    expect(await balance(BOB)).toBe(500);
  });

  it("only the challenged trainer can answer", async () => {
    const { challengeId } = await challenge();
    const btn = new FakeButton({ customId: `selena:battle:accept:${challengeId}`, userId: CAROL, username: "Carol" });
    await buttonHandlers["selena:battle"]!(btn as never, ctx());
    const reply = btn.replies.find((r) => r.kind === "reply");
    expect(String((reply?.payload as { content?: string })?.content ?? "")).toContain("Only the challenged trainer");
    expect((await getChallenge(db, challengeId))?.status).toBe("pending");
  });

  it("accept runs the battle, settles +125 gold total, and sets cooldowns", async () => {
    await seedGold(ALICE, 1000);
    await seedGold(BOB, 1000);
    const before = (await balance(ALICE)) + (await balance(BOB));
    const { challengeId } = await challenge();
    const btn = new FakeButton({ customId: `selena:battle:accept:${challengeId}`, userId: BOB, username: "Bob" });
    await buttonHandlers["selena:battle"]!(btn as never, ctx());
    expect((await getChallenge(db, challengeId))?.status).toBe("accepted");
    const final = lastEditText(btn);
    expect(final).toMatch(/wins!|draw/);
    // Winner 100 + loser 25 = +125 total, no wager.
    expect((await balance(ALICE)) + (await balance(BOB))).toBe(before + 125);
    const now = Date.now();
    expect(await getBattleCooldownRemainingMs(db, ALICE, now)).toBeGreaterThan(0);
    expect(await getBattleCooldownRemainingMs(db, BOB, now)).toBeGreaterThan(0);
  });

  it("wager is escrowed at accept and the pot goes to the winner (+125 net)", async () => {
    await seedGold(ALICE, 1000);
    await seedGold(BOB, 1000);
    const before = (await balance(ALICE)) + (await balance(BOB));
    const { challengeId } = await challenge(200);
    const btn = new FakeButton({ customId: `selena:battle:accept:${challengeId}`, userId: BOB, username: "Bob" });
    await buttonHandlers["selena:battle"]!(btn as never, ctx());
    const final = lastEditText(btn);
    expect(final).toMatch(/wins!|draw/);
    // Escrow −400, settle +100 +25 +400 = +525 → net +125.
    expect((await balance(ALICE)) + (await balance(BOB))).toBe(before + 125);
    expect(final).toContain("wager pot");
  });

  it("accept fails closed when a side can no longer cover the wager", async () => {
    await seedGold(ALICE, 100);
    await seedGold(BOB, 1000);
    const { challengeId } = await challenge(100);
    // Alice spends down before Bob accepts.
    await addPoints(db, GUILD, ALICE, -95, "test spend");
    const btn = new FakeButton({ customId: `selena:battle:accept:${challengeId}`, userId: BOB, username: "Bob" });
    await buttonHandlers["selena:battle"]!(btn as never, ctx());
    expect(lastEditText(btn)).toContain("can't cover");
    expect((await getChallenge(db, challengeId))?.status).toBe("expired");
    expect(await balance(ALICE)).toBe(5);
    expect(await balance(BOB)).toBe(1000);
  });

  it("accepting an expired challenge reports the expiry", async () => {
    const { challengeId } = await challenge();
    await db
      .prepare("UPDATE battle_challenges SET expires_at = ? WHERE id = ?")
      .run(Date.now() - 1000, challengeId);
    const btn = new FakeButton({ customId: `selena:battle:accept:${challengeId}`, userId: BOB, username: "Bob" });
    await buttonHandlers["selena:battle"]!(btn as never, ctx());
    expect(lastEditText(btn)).toContain("expired");
    expect((await getChallenge(db, challengeId))?.status).toBe("expired");
  });

  it("a fresh challenge blocks the challenger with the 1-minute cooldown", async () => {
    await seedGold(ALICE, 1000);
    await seedGold(BOB, 1000);
    const { challengeId } = await challenge();
    const btn = new FakeButton({ customId: `selena:battle:accept:${challengeId}`, userId: BOB, username: "Bob" });
    await buttonHandlers["selena:battle"]!(btn as never, ctx());
    // Immediate re-challenge: on cooldown.
    const { cmd, inv } = runBattle(ALICE, { id: BOB, username: "Bob" });
    await cmd.execute(inv as never, ctx());
    expect(inv.allText()).toContain("wait");
  });
});

describe("expireBattleChallenges", () => {
  let db: SelenaDb;
  beforeEach(() => {
    db = getTestDb();
  });

  it("expires only pending challenges past their deadline", async () => {
    const now = Date.now();
    const old = await createChallenge(db, {
      challengerId: ALICE, opponentId: BOB, wager: 0,
      channelId: "chan-1", guildId: GUILD, nowMs: now - 120_000,
    });
    const fresh = await createChallenge(db, {
      challengerId: ALICE, opponentId: BOB, wager: 0,
      channelId: "chan-1", guildId: GUILD, nowMs: now,
    });
    const expired = await expireBattleChallenges(db, now);
    expect(expired.map((c) => c.id)).toEqual([old.id]);
    expect((await getChallenge(db, old.id))?.status).toBe("expired");
    expect((await getChallenge(db, fresh.id))?.status).toBe("pending");
    expect(await expireBattleChallenges(db, now)).toEqual([]);
  });
});

describe("battle cooldown storage", () => {
  let db: SelenaDb;
  beforeEach(() => {
    db = getTestDb();
  });

  it("cooldown counts down and clears after a minute", async () => {
    const now = Date.now();
    expect(await getBattleCooldownRemainingMs(db, ALICE, now)).toBe(0);
    await setBattleTimestamp(db, ALICE, now);
    const left = await getBattleCooldownRemainingMs(db, ALICE, now + 30_000);
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(BATTLE_COOLDOWN_MS);
    expect(await getBattleCooldownRemainingMs(db, ALICE, now + BATTLE_COOLDOWN_MS + 1)).toBe(0);
  });
});

describe("settleBattle", () => {
  let db: SelenaDb;
  beforeEach(() => {
    db = getTestDb();
  });

  it("winner 100 gold + XP, loser 25 gold + half XP", async () => {
    await addPoints(db, GUILD, ALICE, 1000, "seed");
    await addPoints(db, GUILD, BOB, 1000, "seed");
    const settled = await settleBattle(db, {
      guildId: GUILD, aId: ALICE, bId: BOB, winner: "A", wager: 0,
      aTeam: team([91]), bTeam: team([1]),
    });
    expect(settled.aGold).toBe(100);
    expect(settled.bGold).toBe(25);
    expect(settled.aXp).toBe(40 + 1 * 2); // avg enemy team level 1
    expect(settled.bXp).toBe(Math.floor(settled.aXp / 2));
    expect(await getBalance(db, GUILD, ALICE)).toMatchObject({ points: 1100 });
    expect(await getBalance(db, GUILD, BOB)).toMatchObject({ points: 1025 });
  });

  it("wager pot (2x) goes to the winner", async () => {
    await addPoints(db, GUILD, ALICE, 1000, "seed");
    await addPoints(db, GUILD, BOB, 1000, "seed");
    const settled = await settleBattle(db, {
      guildId: GUILD, aId: ALICE, bId: BOB, winner: "B", wager: 250,
      aTeam: team([1]), bTeam: team([91]),
    });
    expect(settled.bGold).toBe(100 + 500);
    expect(settled.aGold).toBe(25);
  });

  it("draw refunds wagers and pays 25 gold each", async () => {
    await addPoints(db, GUILD, ALICE, 1000, "seed");
    await addPoints(db, GUILD, BOB, 1000, "seed");
    const settled = await settleBattle(db, {
      guildId: GUILD, aId: ALICE, bId: BOB, winner: "draw", wager: 100,
      aTeam: team([1]), bTeam: team([1]),
    });
    expect(settled.aGold).toBe(25 + 100);
    expect(settled.bGold).toBe(25 + 100);
  });
});

describe("monster XP", () => {
  let db: SelenaDb;
  beforeEach(() => {
    db = getTestDb();
  });

  it("levels up an existing instance row at 100 x level XP", async () => {
    await db
      .prepare(
        "INSERT INTO user_monster_instances (guild_id, user_id, monster_id, level, xp, fuse_level, source, caught_at) VALUES (?, ?, ?, 1, 95, 0, 'hunt', ?)",
      )
      .run(GUILD, ALICE, 26, Date.now());
    const res = await grantMonsterXp(db, GUILD, ALICE, 26, 10);
    expect(res).toEqual({ leveledUp: true, newLevel: 2 });
    const row = (await db
      .prepare("SELECT level, xp FROM user_monster_instances WHERE guild_id = ? AND user_id = ? AND monster_id = ?")
      .get(GUILD, ALICE, 26)) as { level: number; xp: number };
    expect(row.level).toBe(2);
    expect(row.xp).toBe(5);
  });

  it("returns null when the monster has no instance row (never invents one)", async () => {
    const res = await grantMonsterXp(db, GUILD, ALICE, 26, 50);
    expect(res).toBeNull();
    const rows = await db
      .prepare("SELECT * FROM user_monster_instances WHERE guild_id = ? AND user_id = ?")
      .all(GUILD, ALICE);
    expect(rows).toEqual([]);
  });

  it("awardBattleXp grants XP without the chat-XP cooldown", async () => {
    const first = await awardBattleXp(db, GUILD, ALICE, 42);
    expect(first.xp).toBe(42);
    const second = await awardBattleXp(db, GUILD, ALICE, 42);
    expect(second.xp).toBe(84);
  });
});

describe("getBattleTeam (DB)", () => {
  let db: SelenaDb;
  beforeEach(() => {
    db = getTestDb();
  });

  it("returns the top 3 by power budget, using instance levels when present", async () => {
    await addMonster(db, GUILD, ALICE, 1, "hunt", Date.now());
    await addMonster(db, GUILD, ALICE, 26, "hunt", Date.now());
    await addMonster(db, GUILD, ALICE, 66, "hunt", Date.now());
    await addMonster(db, GUILD, ALICE, 91, "hunt", Date.now());
    // Stone Beetle at level 100 outranks Crystal Wolf at level 1.
    await db
      .prepare(
        "INSERT INTO user_monster_instances (guild_id, user_id, monster_id, level, xp, fuse_level, source, caught_at) VALUES (?, ?, ?, 100, 0, 0, 'hunt', ?)",
      )
      .run(GUILD, ALICE, 26, Date.now());
    const team = await getBattleTeam(db, GUILD, ALICE);
    expect(team.map((m) => m.monster.id)).toEqual([91, 26, 66]);
    expect(team[1]!.level).toBe(100);
  });

  it("returns an empty team for a user with no monsters", async () => {
    expect(await getBattleTeam(db, GUILD, ALICE)).toEqual([]);
  });
});
