import { describe, expect, it, beforeEach } from "vitest";
import type { SelenaDb } from "../src/lib/db.js";
import { getTestDb } from "./testDb.js";
import {
  EXPLORE_CONSOLATION_GOLD_MAX,
  EXPLORE_CONSOLATION_GOLD_MIN,
  EXPLORE_COOLDOWN_MS,
  EXPLORE_DISCOVERY_CHANCE,
  TRAVEL_ARRIVAL_DISCOVERY_CHANCE,
  discoverTower,
  exploreCooldownRemainingMs,
  floorGold,
  floorReveal,
  floorXp,
  getDiscoveredTowerIds,
  isTowerDiscovered,
  listUndiscoveredTowersInArea,
  maybeDiscoverOnArrival,
  setExploreCooldown,
  type TowerRow,
} from "../src/lib/towers.js";

const ALICE = "user-alice";
const BOB = "user-bob";
const NOW = 1_790_000_000_000;

let db: SelenaDb;

function meadowSmallTower(id = "test-small", name = "Test Meadow Spire"): TowerRow {
  return {
    towerId: id,
    name,
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

function meadowMainTower(): TowerRow {
  return {
    towerId: "tower-main",
    name: "Test Hidden Spire",
    type: "main",
    region: "starting-lands",
    area: "meadow",
    floors: 50,
    hidden: true,
    levelReq: 60,
  };
}

function woodsSmallTower(): TowerRow {
  return {
    towerId: "test-woods",
    name: "Test Woods Spire",
    type: "small",
    region: "starting-lands",
    area: "woods",
    floors: 10,
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

beforeEach(() => {
  db = getTestDb();
});

describe("discovery constants (Ron's spec, recorded in code)", () => {
  it("explore is 40% per explore, 60s cooldown; arrival is 25%; consolation gold is 5–15", () => {
    expect(EXPLORE_DISCOVERY_CHANCE).toBe(0.4);
    expect(EXPLORE_COOLDOWN_MS).toBe(60_000);
    expect(TRAVEL_ARRIVAL_DISCOVERY_CHANCE).toBe(0.25);
    expect(EXPLORE_CONSOLATION_GOLD_MIN).toBe(5);
    expect(EXPLORE_CONSOLATION_GOLD_MAX).toBe(15);
  });
});

describe("discoverTower / isTowerDiscovered / getDiscoveredTowerIds", () => {
  it("new discovery returns true, second call returns false, lookups agree", async () => {
    const tower = meadowSmallTower();
    await insertTower(tower);
    expect(await isTowerDiscovered(db, ALICE, tower.towerId)).toBe(false);
    expect(await getDiscoveredTowerIds(db, ALICE)).toEqual(new Set());

    expect(await discoverTower(db, ALICE, tower.towerId, NOW)).toBe(true);
    expect(await isTowerDiscovered(db, ALICE, tower.towerId)).toBe(true);
    expect(await getDiscoveredTowerIds(db, ALICE)).toEqual(new Set([tower.towerId]));

    expect(await discoverTower(db, ALICE, tower.towerId, NOW + 1000)).toBe(false);
    expect(await isTowerDiscovered(db, ALICE, tower.towerId)).toBe(true);
  });

  it("discovery is per-user: another user has not discovered it", async () => {
    const tower = meadowSmallTower();
    await insertTower(tower);
    expect(await discoverTower(db, ALICE, tower.towerId, NOW)).toBe(true);
    expect(await isTowerDiscovered(db, BOB, tower.towerId)).toBe(false);
    expect(await getDiscoveredTowerIds(db, BOB)).toEqual(new Set());
    expect(await discoverTower(db, BOB, tower.towerId, NOW)).toBe(true);
  });

  it("hidden (Main) tower discovery returns false and stays undiscovered", async () => {
    const main = meadowMainTower();
    await insertTower(main);
    expect(await discoverTower(db, ALICE, main.towerId, NOW)).toBe(false);
    expect(await isTowerDiscovered(db, ALICE, main.towerId)).toBe(false);
    expect(await getDiscoveredTowerIds(db, ALICE)).toEqual(new Set());
    // Repeating the attempt still returns false — the Main tower is
    // never discoverable.
    expect(await discoverTower(db, ALICE, main.towerId, NOW + 1000)).toBe(false);
  });

  it("unknown tower id returns false", async () => {
    expect(await discoverTower(db, ALICE, "tower-nope", NOW)).toBe(false);
    expect(await isTowerDiscovered(db, ALICE, "tower-nope")).toBe(false);
  });
});

describe("listUndiscoveredTowersInArea", () => {
  it("returns only non-hidden undiscovered towers in that area, ordered by tower_id", async () => {
    const small = meadowSmallTower("test-small-a", "Test Meadow Spire A");
    const big = meadowBigTower();
    const main = meadowMainTower();
    const woods = woodsSmallTower();
    await insertTower(small);
    await insertTower(big);
    await insertTower(main);
    await insertTower(woods);

    const listed = await listUndiscoveredTowersInArea(db, ALICE, "meadow");
    expect(listed.map((t) => t.towerId)).toEqual(["test-big", "test-small-a"]);
    // The Main tower is never listed, and the woods tower is another area.
    expect(listed.some((t) => t.towerId === "tower-main")).toBe(false);
    expect(listed.some((t) => t.towerId === "test-woods")).toBe(false);

    const woodsListed = await listUndiscoveredTowersInArea(db, ALICE, "woods");
    expect(woodsListed.map((t) => t.towerId)).toEqual(["test-woods"]);
  });

  it("shrinks as towers are discovered and is empty when all are discovered", async () => {
    const small = meadowSmallTower("test-small-a", "Test Meadow Spire A");
    const big = meadowBigTower();
    const main = meadowMainTower();
    await insertTower(small);
    await insertTower(big);
    await insertTower(main);

    expect((await listUndiscoveredTowersInArea(db, ALICE, "meadow")).map((t) => t.towerId)).toEqual([
      "test-big",
      "test-small-a",
    ]);
    expect(await discoverTower(db, ALICE, "test-big", NOW)).toBe(true);
    expect((await listUndiscoveredTowersInArea(db, ALICE, "meadow")).map((t) => t.towerId)).toEqual([
      "test-small-a",
    ]);
    expect(await discoverTower(db, ALICE, "test-small-a", NOW)).toBe(true);
    // All non-hidden towers discovered — the Main tower never appears.
    expect(await listUndiscoveredTowersInArea(db, ALICE, "meadow")).toEqual([]);
  });

  it("is per-user: one user's discovery does not shrink another's list", async () => {
    const small = meadowSmallTower();
    await insertTower(small);
    expect(await discoverTower(db, ALICE, small.towerId, NOW)).toBe(true);
    expect((await listUndiscoveredTowersInArea(db, BOB, "meadow")).map((t) => t.towerId)).toEqual([
      "test-small",
    ]);
  });

  it("empty area returns an empty list", async () => {
    expect(await listUndiscoveredTowersInArea(db, ALICE, "meadow")).toEqual([]);
  });
});

describe("explore cooldown", () => {
  it("0 when fresh, full cooldown right after set, counts down", async () => {
    expect(await exploreCooldownRemainingMs(db, ALICE, NOW)).toBe(0);
    await setExploreCooldown(db, ALICE, NOW);
    expect(await exploreCooldownRemainingMs(db, ALICE, NOW)).toBe(EXPLORE_COOLDOWN_MS);
    expect(await exploreCooldownRemainingMs(db, ALICE, NOW + 30_000)).toBe(30_000);
    expect(await exploreCooldownRemainingMs(db, ALICE, NOW + 59_999)).toBe(1);
    expect(await exploreCooldownRemainingMs(db, ALICE, NOW + 60_000)).toBe(0);
    expect(await exploreCooldownRemainingMs(db, ALICE, NOW + 120_000)).toBe(0);
  });

  it("setting the cooldown again restarts it from the new timestamp", async () => {
    await setExploreCooldown(db, ALICE, NOW);
    await setExploreCooldown(db, ALICE, NOW + 45_000);
    expect(await exploreCooldownRemainingMs(db, ALICE, NOW + 45_000)).toBe(EXPLORE_COOLDOWN_MS);
    expect(await exploreCooldownRemainingMs(db, ALICE, NOW + 90_000)).toBe(15_000);
  });

  it("cooldown is per-user", async () => {
    await setExploreCooldown(db, ALICE, NOW);
    expect(await exploreCooldownRemainingMs(db, BOB, NOW)).toBe(0);
  });
});

describe("floorReveal", () => {
  it("fresh tower (floorReached 0) reveals ONLY floor 1", () => {
    const tower = meadowSmallTower();
    const revealed = floorReveal(tower, 0);
    expect(revealed).toHaveLength(10);
    expect(revealed[0]).toEqual({
      floor: 1,
      revealed: true,
      kind: "normal",
      gold: floorGold(tower, 1),
      xp: floorXp(1),
      crateTier: null,
      crateChance: true,
    });
    for (let i = 1; i < 10; i++) {
      expect(revealed[i]!.floor).toBe(i + 1);
      expect(revealed[i]!.revealed).toBe(false);
    }
    // The final floor is never revealed on a fresh tower.
    expect(revealed[9]!.kind).toBe("final-boss");
    expect(revealed[9]!.revealed).toBe(false);
  });

  it("floorReached 4 reveals floors 1..5, incl. mini-boss floor 5 with its Golden crate", () => {
    const tower = meadowSmallTower();
    const revealed = floorReveal(tower, 4);
    for (let i = 0; i < 5; i++) expect(revealed[i]!.revealed).toBe(true);
    for (let i = 5; i < 10; i++) expect(revealed[i]!.revealed).toBe(false);
    expect(revealed[4]).toEqual({
      floor: 5,
      revealed: true,
      kind: "mini-boss",
      gold: floorGold(tower, 5),
      xp: floorXp(5),
      crateTier: "Golden",
      crateChance: false,
    });
    // Normal floors carry no guaranteed crate, only the 10% roll.
    expect(revealed[0]!.crateTier).toBeNull();
    expect(revealed[0]!.crateChance).toBe(true);
    expect(revealed[1]!.kind).toBe("normal");
  });

  it("floorReached 9 on a 10-floor tower reveals floor 10 as final-boss with correct tier/crate", () => {
    const tower = meadowSmallTower();
    const revealed = floorReveal(tower, 9);
    expect(revealed.every((r) => r.revealed)).toBe(true);
    expect(revealed[9]).toEqual({
      floor: 10,
      revealed: true,
      kind: "final-boss",
      gold: floorGold(tower, 10),
      xp: floorXp(10),
      crateTier: "Silver",
      crateChance: false,
    });
    // Final floor pays double gold.
    expect(revealed[9]!.gold).toBe(floorGold(tower, 10));
    expect(revealed[9]!.gold).toBeGreaterThan(floorGold(tower, 9));
  });

  it("floorReached 0 never reveals the final floor; floorReached floors-1 is the only way", () => {
    const tower = meadowSmallTower();
    expect(floorReveal(tower, 0)[9]!.revealed).toBe(false);
    expect(floorReveal(tower, 8)[9]!.revealed).toBe(false);
    expect(floorReveal(tower, 9)[9]!.revealed).toBe(true);
  });

  it("big tower: mini-boss floor 5 grants Golden, final floor 20 grants Crystal", () => {
    const tower = meadowBigTower();
    const revealed = floorReveal(tower, 19);
    expect(revealed).toHaveLength(20);
    expect(revealed.every((r) => r.revealed)).toBe(true);
    expect(revealed[4]!.kind).toBe("mini-boss");
    expect(revealed[4]!.crateTier).toBe("Golden");
    expect(revealed[4]!.crateChance).toBe(false);
    expect(revealed[19]!.kind).toBe("final-boss");
    expect(revealed[19]!.crateTier).toBe("Crystal");
    expect(revealed[19]!.crateChance).toBe(false);
    // Unrevealed floors still carry kind/gold/xp for convenience.
    const hidden = floorReveal(tower, 0);
    expect(hidden[19]!.revealed).toBe(false);
    expect(hidden[19]!.kind).toBe("final-boss");
    expect(hidden[19]!.gold).toBe(floorGold(tower, 20));
    expect(hidden[19]!.xp).toBe(floorXp(20));
  });
});

describe("maybeDiscoverOnArrival", () => {
  it("rand 0.0 (roll succeeds) discovers one tower and returns a line containing its name", async () => {
    const small = meadowSmallTower();
    const big = meadowBigTower();
    await insertTower(small);
    await insertTower(big);
    const line = await maybeDiscoverOnArrival(db, ALICE, "meadow", NOW, () => 0.0);
    expect(line).not.toBeNull();
    // rand 0.0 picks index 0 of the tower_id-ordered undiscovered list.
    expect(line).toContain("Test Meadow Keep");
    expect(line).toContain("🗼");
    expect(line).toContain("Big tower");
    expect(line).toContain("20 floors");
    expect(line).toContain("Meadow of Beginnings");
    expect(line).toContain("enter at level 5+");
    expect(line).toContain("`uwu tower Test Meadow Keep`");
    expect(await isTowerDiscovered(db, ALICE, "test-big")).toBe(true);
    expect(await isTowerDiscovered(db, ALICE, "test-small")).toBe(false);
  });

  it("rand 0.99 (roll fails) returns null and discovers nothing", async () => {
    const small = meadowSmallTower();
    await insertTower(small);
    const line = await maybeDiscoverOnArrival(db, ALICE, "meadow", NOW, () => 0.99);
    expect(line).toBeNull();
    expect(await getDiscoveredTowerIds(db, ALICE)).toEqual(new Set());
  });

  it("with all towers discovered returns null", async () => {
    const small = meadowSmallTower();
    await insertTower(small);
    expect(await discoverTower(db, ALICE, small.towerId, NOW)).toBe(true);
    const line = await maybeDiscoverOnArrival(db, ALICE, "meadow", NOW, () => 0.0);
    expect(line).toBeNull();
  });

  it("Main tower in the area is never the one discovered", async () => {
    const main = meadowMainTower();
    await insertTower(main);
    // Only the Main tower exists in the area: nothing to discover.
    const line = await maybeDiscoverOnArrival(db, ALICE, "meadow", NOW, () => 0.0);
    expect(line).toBeNull();
    expect(await isTowerDiscovered(db, ALICE, main.towerId)).toBe(false);

    // With a real tower alongside it, the Main tower is skipped.
    const small = meadowSmallTower();
    await insertTower(small);
    const line2 = await maybeDiscoverOnArrival(db, ALICE, "meadow", NOW, () => 0.0);
    expect(line2).not.toBeNull();
    expect(line2).toContain("Test Meadow Spire");
    expect(await isTowerDiscovered(db, ALICE, small.towerId)).toBe(true);
    expect(await isTowerDiscovered(db, ALICE, main.towerId)).toBe(false);
  });

  it("unknown area returns null and discovers nothing", async () => {
    const small = meadowSmallTower();
    await insertTower(small);
    const line = await maybeDiscoverOnArrival(db, ALICE, "nowhere-land", NOW, () => 0.0);
    expect(line).toBeNull();
    expect(await getDiscoveredTowerIds(db, ALICE)).toEqual(new Set());
  });
});
