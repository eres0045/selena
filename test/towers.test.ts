import { describe, expect, it, beforeEach } from "vitest";
import { mulberry32 } from "../src/lib/rng.js";
import type { SelenaDb } from "../src/lib/db.js";
import { getTestDb } from "./testDb.js";
import { addMonster } from "../src/lib/huntDb.js";
import { MONSTER_BY_ID } from "../src/lib/hunt.js";
import { createGuild, getUserGuild } from "../src/lib/guilds.js";
import { addPoints, getBalance } from "../src/lib/economy.js";
import { FakeChatInput } from "../src/lib/testkit.js";
import {
  CLEAR_COOLDOWN_MS,
  FINAL_BOSS_TIER,
  RECOMMENDED_PARTY,
  TOWER_SEED,
  climbFloor,
  crateForFloor,
  discoverTower,
  enterTower,
  exploreCooldownRemainingMs,
  findTower,
  floorGold,
  floorMonsterLevel,
  floorScale,
  floorTeam,
  getPlayerLevel,
  getProgress,
  getTowerCooldown,
  isTowerDiscovered,
  isFinalFloor,
  isMiniBossFloor,
  leaveTower,
  listUndiscoveredTowersInArea,
  listVisibleTowers,
  plannedTowers,
  seedTowers,
  setProgress,
  setTowerClearCooldown,
  towerCooldownRemainingMs,
  type TowerRow,
} from "../src/lib/towers.js";
import { commands as towerCommands, buttonHandlers as towerButtonHandlers } from "../src/commands/towers.js";

const GUILD = "guild-1";
const ALICE = "user-alice";
const BOB = "user-bob";
const NOW = 1_790_000_000_000;

let db: SelenaDb;

function meadowSmallTower(): TowerRow {
  return {
    towerId: "test-small",
    name: "Test Meadow Spire",
    type: "small",
    region: "starting-lands",
    area: "meadow",
    floors: 10,
    hidden: false,
    levelReq: 0,
  };
}

function meadowBigTower(): TowerRow {
  return {
    towerId: "test-big",
    name: "Test Meadow Keep",
    type: "big",
    region: "starting-lands",
    area: "meadow",
    floors: 20,
    hidden: false,
    levelReq: 5,
  };
}

async function insertTower(t: TowerRow): Promise<void> {
  await db
    .prepare(
      "INSERT INTO towers (tower_id, name, type, region, area, floors, hidden, level_req) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(t.towerId, t.name, t.type, t.region, t.area, t.floors, t.hidden ? 1 : 0, t.levelReq);
}

/** Strong team: UwU + Legendary + Mythic, level 1 — crushes meadow floors. */
async function seedStrongTeam(userId: string): Promise<void> {
  for (const id of [100, 91, 97]) await addMonster(db, GUILD, userId, id, "hunt", NOW);
}

async function setPlayerLevel(userId: string, level: number): Promise<void> {
  await db
    .prepare("INSERT INTO users (guild_id, user_id, xp, level) VALUES (?, ?, ?, ?) ON CONFLICT (guild_id, user_id) DO UPDATE SET level = EXCLUDED.level")
    .run(GUILD, userId, 0, level);
}

function findCommand() {
  const cmd = towerCommands.find((c) => c.name === "tower");
  if (!cmd) throw new Error("tower command not found");
  return cmd;
}

function findExploreCommand() {
  const cmd = towerCommands.find((c) => c.name === "explore");
  if (!cmd) throw new Error("explore command not found");
  return cmd;
}

async function runCommand(
  options: Record<string, unknown>,
  userId = ALICE,
  username = "alice",
): Promise<FakeChatInput> {
  const fake = new FakeChatInput({ commandName: "tower", options, userId, username, guildId: GUILD });
  await findCommand().execute(fake as never, { db, guildId: GUILD });
  return fake;
}

async function runExplore(userId = ALICE, username = "alice"): Promise<FakeChatInput> {
  const fake = new FakeChatInput({ commandName: "explore", options: {}, userId, username, guildId: GUILD });
  await findExploreCommand().execute(fake as never, { db, guildId: GUILD });
  return fake;
}

/** Clear the explore cooldown so the next explore rolls immediately. */
async function resetExploreCooldown(userId: string): Promise<void> {
  await db.prepare("DELETE FROM user_explore WHERE user_id = ?").run(userId);
}

beforeEach(() => {
  db = getTestDb();
});

describe("seeding determinism", () => {
  it("same seed → same 30 towers, same split, same names and areas", () => {
    const a = plannedTowers(TOWER_SEED);
    const b = plannedTowers(TOWER_SEED);
    expect(a).toEqual(b);
    expect(a).toHaveLength(30);
    expect(a.filter((t) => t.type === "small")).toHaveLength(18);
    expect(a.filter((t) => t.type === "big")).toHaveLength(11);
    expect(a.filter((t) => t.type === "main")).toHaveLength(1);
    const main = a.find((t) => t.type === "main")!;
    expect(main.floors).toBe(50);
    expect(main.hidden).toBe(true);
    expect(main.levelReq).toBe(60);
    expect(new Set(a.map((t) => t.name)).size).toBe(30);
    expect(new Set(a.map((t) => t.towerId)).size).toBe(30);
  });

  it("a different seed lays out a different map", () => {
    const a = plannedTowers(TOWER_SEED);
    const b = plannedTowers(12345);
    expect(b.map((t) => t.name)).not.toEqual(a.map((t) => t.name));
  });

  it("seedTowers is idempotent — a second seed never moves a tower", async () => {
    const first = await seedTowers(db);
    expect(first).toHaveLength(30);
    const second = await seedTowers(db);
    expect(second).toHaveLength(30);
    expect(second).toEqual(first);
    const count = (await db.prepare("SELECT COUNT(*) AS n FROM towers").get()) as { n: number };
    expect(Number(count.n)).toBe(30);
  });

  it("small towers have 10 floors, big 20, main 50", async () => {
    const towers = await seedTowers(db);
    expect(towers.filter((t) => t.type === "small").every((t) => t.floors === 10)).toBe(true);
    expect(towers.filter((t) => t.type === "big").every((t) => t.floors === 20)).toBe(true);
    expect(towers.find((t) => t.type === "main")!.floors).toBe(50);
  });
});

describe("floor scaling", () => {
  it("floor scale grows 5% per floor: 1.00 at floor 1, 1.45 at floor 10", () => {
    expect(floorScale(1)).toBeCloseTo(1);
    expect(floorScale(2)).toBeCloseTo(1.05);
    expect(floorScale(10)).toBeCloseTo(1.45);
    expect(floorScale(50)).toBeCloseTo(3.45);
  });

  it("floor monster level is area unlock + floor, capped at 100", () => {
    const small = meadowSmallTower();
    expect(floorMonsterLevel(small, 1)).toBe(1);
    expect(floorMonsterLevel(small, 10)).toBe(10);
    const main = { ...small, towerId: "test-main", type: "main" as const, floors: 50, area: "void-rift", levelReq: 60 };
    expect(floorMonsterLevel(main, 50)).toBe(100);
  });

  it("normal floors field 3 monsters; mini-boss floors a single boss; final floor a single final boss", () => {
    const tower = meadowSmallTower();
    const rand = mulberry32(7);
    const normal = floorTeam(tower, 1, rand);
    expect(normal.kind).toBe("normal");
    expect(normal.team).toHaveLength(3);
    expect(isMiniBossFloor(5, 10)).toBe(true);
    expect(isMiniBossFloor(10, 10)).toBe(false);
    expect(isFinalFloor(10, 10)).toBe(true);
    const mini = floorTeam(tower, 5, rand);
    expect(mini.kind).toBe("mini-boss");
    expect(mini.team).toHaveLength(1);
    // Meadow's top tier is Uncommon — the mini-boss is one tier up (Rare).
    expect(mini.team[0]!.monster.tier).toBe("Rare");
    expect(mini.bossName).toBe(mini.team[0]!.monster.name);
    const final = floorTeam(tower, 10, rand);
    expect(final.kind).toBe("final-boss");
    expect(final.team).toHaveLength(1);
    expect(final.team[0]!.monster.tier).toBe(FINAL_BOSS_TIER.small);
  });

  it("final boss tier is fixed by tower size: Epic / Legendary / Mythic", () => {
    expect(FINAL_BOSS_TIER).toEqual({ small: "Epic", big: "Legendary", main: "Mythic" });
  });

  it("boss monsters are stronger than their base roster stats", () => {
    const tower = meadowSmallTower();
    const mini = floorTeam(tower, 5, mulberry32(7));
    const base = MONSTER_BY_ID.get(mini.team[0]!.monster.id)!;
    // Mini-boss: base HP × floor scale (1.20) × 3, ATK/DEF × floor scale × 1.5.
    expect(mini.team[0]!.monster.hp).toBe(Math.round(base.hp * floorScale(5) * 3));
    expect(mini.team[0]!.monster.atk).toBe(Math.round(base.atk * floorScale(5) * 1.5));
    const final = floorTeam(tower, 10, mulberry32(7));
    const finalBase = MONSTER_BY_ID.get(final.team[0]!.monster.id)!;
    expect(final.team[0]!.monster.hp).toBe(Math.round(finalBase.hp * floorScale(10) * 2));
  });

  it("floor gold grows with floor and doubles on the final floor", () => {
    const tower = meadowSmallTower();
    expect(floorGold(tower, 1)).toBe(30);
    expect(floorGold(tower, 5)).toBe(70);
    expect(floorGold(tower, 10)).toBe(2 * (20 + 10 * 10));
    expect(floorGold(tower, 9)).toBe(20 + 9 * 10);
  });

  it("crate tiers: mini-boss Golden, final Silver (small); normal floors roll Wooden 10% of the time", () => {
    const tower = meadowSmallTower();
    expect(crateForFloor(tower, 5, () => 0.99)).toBe("Golden");
    expect(crateForFloor(tower, 10, () => 0.99)).toBe("Silver");
    expect(crateForFloor(tower, 1, () => 0.05)).toBe("Wooden");
    expect(crateForFloor(tower, 1, () => 0.5)).toBeNull();
  });
});

describe("enter / checkpoint resume / party", () => {
  beforeEach(async () => {
    await insertTower(meadowSmallTower());
    await seedStrongTeam(ALICE);
    await seedStrongTeam(BOB);
    // Mystery rules: entering needs discovery first.
    await discoverTower(db, ALICE, "test-small", NOW);
    await discoverTower(db, BOB, "test-small", NOW);
  });

  it("entering starts a solo party and warns the recommended minimum is 2", async () => {
    const fake = await runCommand({ action: "enter", target: "Test Meadow Spire" });
    expect(fake.allText()).toContain("Test Meadow Spire");
    expect(fake.allText()).toContain("Recommended party is 2+");
    expect(fake.allText()).toContain("solo");
    const progress = await getProgress(db, ALICE, "test-small");
    expect(progress?.floorReached).toBe(0);
    expect(progress?.partyId).not.toBeNull();
  });

  it("a second player entering the same tower joins the active party", async () => {
    await runCommand({ action: "enter", target: "Test Meadow Spire" }, ALICE);
    const fake = await runCommand({ action: "enter", target: "Test Meadow Spire" }, BOB, "bob");
    expect(fake.allText()).toContain("Party: 2 members");
    const party = await getProgress(db, BOB, "test-small");
    const aliceParty = await getProgress(db, ALICE, "test-small");
    expect(party?.partyId).toBe(aliceParty?.partyId);
  });

  it("climbing advances the checkpoint, and leaving + re-entering resumes from it", async () => {
    await runCommand({ action: "enter", target: "Test Meadow Spire" });
    const climbed = await runCommand({ action: "climb" });
    expect(climbed.allText()).toContain("cleared floor 1");
    expect(climbed.allText()).toContain("Checkpoint saved at floor 1");
    expect((await getProgress(db, ALICE, "test-small"))?.floorReached).toBe(1);
    const left = await runCommand({ action: "leave" });
    expect(left.allText()).toContain("checkpoint is saved at floor 1");
    const resumed = await runCommand({ action: "enter", target: "Test Meadow Spire" });
    expect(resumed.allText()).toContain("Resuming from your checkpoint at floor 1/10");
    const climbed2 = await runCommand({ action: "climb" });
    expect(climbed2.allText()).toContain("cleared floor 2");
  });

  it("clearing a floor grants 100 guild XP", async () => {
    await createGuild(db, ALICE, "Alice Guild", Date.now());
    await runCommand({ action: "enter", target: "Test Meadow Spire" });
    const climbed = await runCommand({ action: "climb" });
    expect(climbed.allText()).toContain("cleared floor 1");
    expect((await getUserGuild(db, ALICE))?.xp).toBe(100);
  });

  it("climbing without entering is refused", async () => {
    const fake = await runCommand({ action: "climb" });
    expect(fake.allText()).toContain("not inside any tower");
  });

  it("level requirement blocks entry below the tower's level", async () => {
    await insertTower(meadowBigTower());
    await discoverTower(db, ALICE, "test-big", NOW);
    const fake = await runCommand({ action: "enter", target: "Test Meadow Keep" });
    expect(fake.allText()).toContain("need to be level 5");
  });

  it("party members who entered advance together on a win", async () => {
    await runCommand({ action: "enter", target: "Test Meadow Spire" }, ALICE);
    await runCommand({ action: "enter", target: "Test Meadow Spire" }, BOB, "bob");
    const result = await climbFloor(db, {
      guildId: GUILD,
      userId: ALICE,
      username: "alice",
      towerId: "test-small",
      nowMs: NOW,
      rand: mulberry32(42),
    });
    expect(result.outcome).toBe("win");
    expect((await getProgress(db, BOB, "test-small"))?.floorReached).toBe(1);
  });
});

describe("mini-boss, final boss, cooldowns", () => {
  beforeEach(async () => {
    await insertTower(meadowSmallTower());
    await seedStrongTeam(ALICE);
    await enterTower(db, { userId: ALICE, tower: meadowSmallTower(), playerLevel: 0, nowMs: NOW });
  });

  it("mini-boss floor 5 grants a Golden crate and is never catchable", async () => {
    await setProgress(db, ALICE, "test-small", 4, (await getProgress(db, ALICE, "test-small"))!.partyId, NOW);
    const result = await climbFloor(db, {
      guildId: GUILD,
      userId: ALICE,
      username: "alice",
      towerId: "test-small",
      nowMs: NOW,
      rand: mulberry32(42),
    });
    expect(result.outcome).toBe("win");
    expect(result.kind).toBe("mini-boss");
    expect(result.crateTier).toBe("Golden");
    expect(result.text).toContain("Mini-boss");
    const crates = (await db
      .prepare("SELECT * FROM user_crates WHERE user_id = ? AND crate_tier = ?")
      .get(ALICE, "Golden")) as { qty: number } | undefined;
    expect(Number(crates?.qty ?? 0)).toBe(1);
    // No monster is ever awarded by a tower climb: the zoo is untouched.
    const zoo = (await db
      .prepare("SELECT COUNT(*) AS n FROM user_monsters WHERE guild_id = ? AND user_id = ?")
      .get(GUILD, ALICE)) as { n: number };
    expect(Number(zoo.n)).toBe(3);
  });

  it("final floor clear grants gems, materials, a badge and sets the 6h cooldown", async () => {
    await addPoints(db, GUILD, ALICE, 0, "seed");
    await setProgress(db, ALICE, "test-small", 9, (await getProgress(db, ALICE, "test-small"))!.partyId, NOW);
    const result = await climbFloor(db, {
      guildId: GUILD,
      userId: ALICE,
      username: "alice",
      towerId: "test-small",
      nowMs: NOW,
      rand: mulberry32(42),
    });
    expect(result.outcome).toBe("win");
    expect(result.kind).toBe("final-boss");
    expect(result.cleared).toBe(true);
    expect(result.crateTier).toBe("Silver");
    const wallet = (await db.prepare("SELECT gems FROM user_wallet WHERE user_id = ?").get(ALICE)) as
      | { gems: number }
      | undefined;
    expect(Number(wallet?.gems ?? 0)).toBe(5);
    const shards = (await db
      .prepare("SELECT qty FROM user_materials WHERE user_id = ? AND material = ?")
      .get(ALICE, "shard")) as { qty: number } | undefined;
    expect(Number(shards?.qty ?? 0)).toBe(10);
    const badge = (await db
      .prepare("SELECT * FROM user_badges WHERE user_id = ? AND badge = ?")
      .get(ALICE, "tower-clear-test-small")) as Record<string, unknown> | undefined;
    expect(badge).toBeDefined();
    const cd = await getTowerCooldown(db, "test-small");
    expect(cd).not.toBeNull();
    expect(cd!.resetsAt - cd!.clearedAt).toBe(CLEAR_COOLDOWN_MS.small);
    expect(await towerCooldownRemainingMs(db, "test-small", NOW)).toBe(CLEAR_COOLDOWN_MS.small);
    // Entering while on cooldown is refused.
    await expect(
      enterTower(db, { userId: ALICE, tower: meadowSmallTower(), playerLevel: 0, nowMs: NOW + 1000 }),
    ).rejects.toThrow("resets in");
    // After the cooldown, the checkpoint resets for a fresh run.
    const again = await enterTower(db, {
      userId: ALICE,
      tower: meadowSmallTower(),
      playerLevel: 0,
      nowMs: NOW + CLEAR_COOLDOWN_MS.small + 1000,
    });
    expect(again.floorReached).toBe(0);
  });

  it("clear cooldowns are 6h (small), 12h (big), 7d (main)", async () => {
    const big = await setTowerClearCooldown(db, "test-big", "big", NOW);
    expect(big.resetsAt - big.clearedAt).toBe(12 * 60 * 60 * 1000);
    const main = await setTowerClearCooldown(db, "tower-main", "main", NOW);
    expect(main.resetsAt - main.clearedAt).toBe(7 * 24 * 60 * 60 * 1000);
    expect(await towerCooldownRemainingMs(db, "test-big", NOW + 11 * 60 * 60 * 1000)).toBeGreaterThan(0);
    expect(await towerCooldownRemainingMs(db, "test-big", NOW + 13 * 60 * 60 * 1000)).toBe(0);
  });
});

describe("Main tower secrecy", () => {
  it("the Main tower never appears in the list, and fuzzy guesses never match it", async () => {
    const towers = await seedTowers(db);
    const main = towers.find((t) => t.type === "main")!;
    const visible = await listVisibleTowers(db);
    expect(visible).toHaveLength(29);
    expect(visible.some((t) => t.towerId === main.towerId)).toBe(false);
    expect(visible.some((t) => t.hidden)).toBe(false);
    // A fuzzy guess (first 4 letters of its name) must not resolve to it.
    const guess = await findTower(db, main.name.slice(0, 4));
    expect(guess?.towerId).not.toBe(main.towerId);
    expect(await findTower(db, "zzz-no-such-tower")).toBeNull();
    // The list reply itself contains neither its name nor its area name.
    const fake = await runCommand({});
    const text = fake.allText();
    expect(text).not.toContain(main.name);
    const areaName = main.area;
    expect(text).not.toContain(areaName);
    // Exact-name entry is the discovery path — but its area still shows as ???.
    const detail = await runCommand({ action: main.name });
    expect(detail.allText()).toContain("???");
    expect(detail.allText()).not.toContain(areaName);
  });
});

describe("recommended party sizes", () => {
  it("Small 2, Big 4, Main 6", () => {
    expect(RECOMMENDED_PARTY).toEqual({ small: 2, big: 4, main: 6 });
  });
});

describe("tower list pagination — mystery rules (undiscovered towers are ???)", () => {
  /** Tower names listed on one page's content (compact rows only — the header also starts with 🗼). */
  function namesOnPage(content: string): string[] {
    return content
      .split("\n")
      .filter((l) => l.startsWith("🗼 ") && (l.includes(" · S · ") || l.includes(" · B · ")))
      .map((l) => l.slice(3).split(" · ")[0]!);
  }

  function nextButtonId(payload: unknown): string | null {
    const comps = (payload as { components?: { toJSON: () => { components: { custom_id: string; label: string; disabled?: boolean }[] } }[] }).components;
    if (!comps) return null;
    for (const row of comps) {
      for (const b of row.toJSON().components) {
        if (b.label === "Next ▶" && !b.disabled) return b.custom_id;
      }
    }
    return null;
  }

  /** Flip through every region page starting from a bare-list reply. */
  async function collectPages(first: FakeChatInput): Promise<string[]> {
    const firstPayload = first.firstReplyPayload() as { content: string; components?: unknown };
    const contents = [String(firstPayload.content)];
    let customId = nextButtonId(firstPayload);
    let guard = 0;
    while (customId && guard < 10) {
      guard++;
      const updates: { content: string; components?: unknown }[] = [];
      const handler = towerButtonHandlers["selena:tower"]!;
      await handler(
        {
          customId,
          user: { id: ALICE },
          update: async (p: { content: string; components?: unknown }) => {
            updates.push(p);
          },
          reply: async () => {},
        } as never,
        { db, guildId: GUILD } as never,
      );
      expect(updates).toHaveLength(1);
      contents.push(String(updates[0]!.content));
      customId = nextButtonId(updates[0]);
    }
    return contents;
  }

  it("a fresh user sees ZERO tower names (all ???), the header counts discovered only, and every page fits under 2,000 chars — after discovering all 29, every name appears and Main never does", async () => {
    const seeded = await seedTowers(db);
    const main = seeded.find((t) => t.type === "main")!;
    const visible = await listVisibleTowers(db);
    expect(visible).toHaveLength(29);

    // Fresh user: flip through every page.
    const freshPages = await collectPages(await runCommand({}));
    expect(freshPages.length).toBeGreaterThan(1);
    for (const c of freshPages) {
      expect(c.length).toBeLessThan(2000);
      expect(c).toContain("discovered");
      expect(c).not.toContain("29 known towers");
      expect(c).not.toContain(main.name);
      expect(c).not.toContain("tower-main");
      for (const t of visible) expect(c).not.toContain(t.name);
      expect(namesOnPage(c)).toHaveLength(0);
      expect(c).toContain("??? · undiscovered tower — explore the area to find it");
      expect(c).toContain("uwu explore");
    }
    // The first page's header counts discovered towers on that page: 0.
    expect(freshPages[0]).toContain("· 0 discovered):");

    // Discover every visible tower, then flip again: all 29 names appear.
    for (const t of visible) {
      await discoverTower(db, ALICE, t.towerId, NOW);
    }
    const knownPages = await collectPages(await runCommand({}));
    expect(knownPages.length).toBe(freshPages.length);
    const seen = new Set<string>();
    for (const c of knownPages) {
      expect(c.length).toBeLessThan(2000);
      expect(c).not.toContain("29 known towers");
      expect(c).not.toContain(main.name);
      expect(c).not.toContain("tower-main");
      expect(c).not.toContain("??? · undiscovered tower");
      for (const n of namesOnPage(c)) seen.add(n);
    }
    expect(seen.size).toBe(29);
    for (const t of visible) expect(seen.has(t.name)).toBe(true);
  });
});

describe("discovery gates + progressive floor reveal", () => {
  beforeEach(async () => {
    await insertTower(meadowSmallTower());
  });

  it("guessing an undiscovered tower's name in detail or enter gets 'not known to you' — never a confirmation it exists", async () => {
    const detail = await runCommand({ action: "Test Meadow Spire" });
    expect(detail.allText()).toContain("No tower by that name is known to you");
    expect(detail.allText()).not.toContain("Test Meadow Spire");
    const entered = await runCommand({ action: "enter", target: "Test Meadow Spire" });
    expect(entered.allText()).toContain("No tower by that name is known to you");
    expect(entered.allText()).not.toContain("Test Meadow Spire");
    expect(await getProgress(db, ALICE, "test-small")).toBeNull();
  });

  it("after discovering, detail shows floor 1 revealed and floors 2–10 as ???; at floor 4 it shows floors 1–5 (floor 5 mini-boss) and floors 6–10 as ???", async () => {
    await discoverTower(db, ALICE, "test-small", NOW);
    const fresh = await runCommand({ action: "Test Meadow Spire" });
    const freshText = fresh.allText();
    expect(freshText).toContain("Test Meadow Spire");
    expect(freshText).toContain("F1 · 3 wild monsters · +30g · +55 XP · 10% Wooden Crate");
    expect(freshText).toContain("Floors 2–10 — ??? (clear floor 1 to reveal more)");
    expect(freshText).not.toContain("F2");
    expect(freshText).not.toContain("F10");
    expect(freshText).not.toContain("Final boss");
    expect(freshText).not.toContain("Mini-boss every 5th floor");

    await setProgress(db, ALICE, "test-small", 4, null, NOW);
    const mid = await runCommand({ action: "Test Meadow Spire" });
    const midText = mid.allText();
    expect(midText).toContain("F1 · 3 wild monsters · +30g · +55 XP · 10% Wooden Crate");
    expect(midText).toContain("F5 · 💪 Mini-boss · +70g · +75 XP · 🎁 Golden Crate");
    expect(midText).toContain("Floors 6–10 — ??? (clear floor 5 to reveal more)");
    expect(midText).not.toContain("F6");
    expect(midText).not.toContain("F10");
    expect(midText).not.toContain("Final boss");
  });

  it("a user with progress on a tower (pre-mystery knowledge) passes the gate and the discovery is backfilled", async () => {
    await setProgress(db, ALICE, "test-small", 2, null, NOW);
    expect(await isTowerDiscovered(db, ALICE, "test-small")).toBe(false);
    const detail = await runCommand({ action: "Test Meadow Spire" });
    expect(detail.allText()).toContain("Test Meadow Spire");
    expect(detail.allText()).toContain("F3 · 3 wild monsters");
    expect(await isTowerDiscovered(db, ALICE, "test-small")).toBe(true);
  });
});

describe("uwu explore", () => {
  beforeEach(async () => {
    // Seed FIRST: seedTowers is idempotent and no-ops once any tower
    // row exists, so the manual test tower goes in after.
    await seedTowers(db);
    await insertTower(meadowSmallTower());
  });

  /** Discover every undiscovered meadow tower except the target, so explores can only find the target. */
  async function leaveOnlyTargetUndiscovered(targetId: string): Promise<void> {
    const undiscovered = await listUndiscoveredTowersInArea(db, ALICE, "meadow");
    for (const t of undiscovered) {
      if (t.towerId !== targetId) await discoverTower(db, ALICE, t.towerId, NOW);
    }
  }

  it("a level-0 user in the meadow discovers the Meadow tower (eventually) and the success reply names it", async () => {
    await leaveOnlyTargetUndiscovered("test-small");
    expect(await getPlayerLevel(db, GUILD, ALICE)).toBe(0);
    let successText: string | null = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      const fake = await runExplore();
      if (await isTowerDiscovered(db, ALICE, "test-small")) {
        successText = fake.allText();
        break;
      }
      await resetExploreCooldown(ALICE);
    }
    expect(await isTowerDiscovered(db, ALICE, "test-small")).toBe(true);
    expect(successText).not.toBeNull();
    expect(successText!).toContain("Test Meadow Spire");
    expect(successText!).toContain("Small tower");
    expect(successText!).toContain("10 floors");
  });

  it("a second explore immediately after returns the cooldown message and does not roll", async () => {
    await leaveOnlyTargetUndiscovered("test-small");
    await runExplore();
    const again = await runExplore();
    expect(again.allText()).toMatch(/⏳ You need a breather — explore again in \d+s\./);
    expect(await exploreCooldownRemainingMs(db, ALICE, Date.now())).toBeGreaterThan(0);
  });

  it("exploring an area with all towers discovered grants 5–15 consolation gold and says so", async () => {
    const undiscovered = await listUndiscoveredTowersInArea(db, ALICE, "meadow");
    for (const t of undiscovered) await discoverTower(db, ALICE, t.towerId, NOW);
    const before = (await getBalance(db, GUILD, ALICE)).points;
    const fake = await runExplore();
    const text = fake.allText();
    expect(text).toContain("You already know every tower in Meadow");
    const match = text.match(/\+(\d+) gold/);
    expect(match).not.toBeNull();
    const gold = Number(match![1]);
    expect(gold).toBeGreaterThanOrEqual(5);
    expect(gold).toBeLessThanOrEqual(15);
    expect((await getBalance(db, GUILD, ALICE)).points).toBe(before + gold);
  });

  it("exploring mid-travel is refused and does not start a cooldown", async () => {
    await db
      .prepare("INSERT INTO user_location (user_id, current_area, travelling_to, travel_ends_at) VALUES (?, ?, ?, ?)")
      .run(ALICE, "meadow", "woods", Date.now() + 600_000);
    const fake = await runExplore();
    expect(fake.allText()).toContain("You're on the road — explore when you arrive.");
    expect(await exploreCooldownRemainingMs(db, ALICE, Date.now())).toBe(0);
  });
});
