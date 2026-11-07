import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Quest progress hooks (Worker B). Every hook is verified end-to-end
// through the REAL recordQuestProgress + REAL DB writes — no quest
// mocking. The trick: only 3 quests are live per UTC day, so each
// describe fakes the clock (Date only — timers stay real, so the
// casino suspense sleeps still fire) to a date whose 3 quests cover
// the kinds under test:
//
//   2026-11-07  catch_legendary, daily_1, fuse_1
//   2026-11-08  roll_10, catch_5, casino_win_3
//   2026-11-09  coinflip_win_1, bg_buy_1, tower_floor_2
//   2026-11-11  hunt_3, hunt_10, about_1
//   2026-11-23  catch_5, catch_rare, casino_win_3
//   2027-01-10  casino_win_3, coinflip_win_1, bg_buy_1
//   2027-01-20  catch_rare, battle_win_1, explore_1
//
// Random draws are forced with a scripted secureFloat queue (values
// are consumed in call order, then fall back to real randomness) and
// the casino's own CASINO_RAND test hook. A fresh DB per test means
// every progress assertion starts at 0.
// ---------------------------------------------------------------------------

const rngQueue = vi.hoisted(() => ({ values: [] as number[] }));

vi.mock("../src/lib/rng.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/rng.js")>();
  return {
    ...actual,
    secureFloat: () => {
      const v = rngQueue.values.shift();
      return v !== undefined ? v : actual.secureFloat();
    },
  };
});

import type { SelenaDb } from "../src/lib/db.js";
import type { CommandContext } from "../src/lib/command.js";
import { getTestDb } from "./testDb.js";
import { FakeButton, FakeChatInput } from "../src/lib/testkit.js";
import { addPoints, getBalance, claimDaily } from "../src/lib/economy.js";
import { mulberry32 } from "../src/lib/rng.js";
import { handlePrefixMessage, type PrefixMessageLike } from "../src/lib/router.js";
import { allButtonHandlers } from "../src/commands/index.js";
import { questKindsForCatch } from "../src/commands/hunt.js";
import {
  getQuestLog,
  questsForDate,
  recordQuestProgress,
} from "../src/lib/quests.js";
import { MONSTER_BY_ID, type Tier } from "../src/lib/hunt.js";
import {
  addMonster,
  awardMonster,
  getOwnedCount,
  getUserMonsters,
  grantPlayerXp,
  utcDayString,
} from "../src/lib/huntDb.js";
import { settleBattle, type TeamMemberInput } from "../src/lib/battle.js";
import { buyBackground, setAbout } from "../src/lib/profile.js";
import {
  CASINO_RAND,
  blackjackGames,
  createBlackjackGame,
  createHighlowGame,
  createMinesGame,
  highlowGames,
  minesGames,
  placeBet,
} from "../src/lib/casino.js";
import { buttonHandlers as casinoButtonHandlers } from "../src/commands/casino.js";
import { SLOT_SPIN, VISUAL_SUSPENSE } from "../src/lib/visualgames.js";
import {
  climbFloor,
  discoverTower,
  enterTower,
  listUndiscoveredTowersInArea,
  seedTowers,
  type TowerRow,
} from "../src/lib/towers.js";
import { commands as towerCommands } from "../src/commands/towers.js";

const GUILD = "guild-1";
const ALICE = "user-alice";
const BOB = "user-bob";
const NOW = Date.parse("2026-11-07T12:00:00Z");

let db: SelenaDb;
let ctx: CommandContext;

beforeEach(async () => {
  db = getTestDb();
  ctx = { db, guildId: GUILD };
  blackjackGames.clear();
  highlowGames.clear();
  minesGames.clear();
  CASINO_RAND.fn = null;
  rngQueue.values.length = 0;
  // The visual games wait ~2.4s between the spin and the reveal edit;
  // tests exercise the flow, not the wait.
  VISUAL_SUSPENSE.ms = 0;
  SLOT_SPIN.frameMs = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

/** Fake the clock (Date only) to noon UTC on `iso` and sanity-check the live quests. */
function useQuestDate(iso: string, expectedQuestIds: string[]): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
  expect(questsForDate(new Date()).map((q) => q.id).sort()).toEqual([...expectedQuestIds].sort());
}

/** Today's progress on one quest (0 when the user has no row yet). */
async function questProgress(db: SelenaDb, userId: string, questId: string, date = new Date()): Promise<number> {
  const log = await getQuestLog(db, userId, date);
  return log.quests.find((q) => q.def.id === questId)?.progress ?? -1;
}

// --- Fake prefix message (copied from test/hunt.test.ts) --------------------

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

  allText(): string {
    const parts: string[] = [];
    for (const p of [...this.replies, ...this.channelSends, ...this.sentEdits]) {
      if (typeof p.content === "string") parts.push(p.content);
      for (const e of (p.embeds as Array<{ title?: string; description?: string }> | undefined) ?? []) {
        if (e.title) parts.push(e.title);
        if (e.description) parts.push(e.description);
      }
    }
    return parts.join("\n");
  }
}

async function run(content: string, userId = "user-1"): Promise<FakePrefixMessage> {
  const msg = new FakePrefixMessage(content, { userId });
  await handlePrefixMessage(msg, { db, guildId: GUILD });
  return msg;
}

/** Press a hunt Catch/Run button and return the editReply payloads. */
async function pressHuntButton(customId: string, userId: string): Promise<Record<string, unknown>[]> {
  const edits: Record<string, unknown>[] = [];
  const handler = allButtonHandlers["selena:hunt"]!;
  await handler(
    {
      customId,
      user: { id: userId },
      deferUpdate: async () => {},
      editReply: async (p: Record<string, unknown>) => {
        edits.push(p);
      },
      reply: async () => {},
      followUp: async () => {},
    } as never,
    { db, guildId: GUILD } as never,
  );
  return edits;
}

function huntButtonId(msg: FakePrefixMessage, index = 0): string {
  return (msg.replies[0]!.components as any)[0].toJSON().components[index].custom_id as string;
}

/** Click a casino button (selena:bj / selena:hl / selena:mines). */
async function clickCasino(customId: string, userId = "user-1"): Promise<FakeButton> {
  const btn = new FakeButton({ customId, userId, guildId: GUILD });
  const key = customId.split(":").slice(0, 2).join(":");
  await casinoButtonHandlers[key]!(btn, ctx);
  return btn;
}

function casinoEditText(btn: FakeButton): string {
  const edit = btn.replies.find((r) => r.kind === "editReply");
  const p = edit?.payload as { content?: string } | undefined;
  return p?.content ?? "";
}

function team(ids: number[]): TeamMemberInput[] {
  return ids.map((id) => ({ monster: MONSTER_BY_ID.get(id)!, level: 1 }));
}

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

// ---------------------------------------------------------------------------
// recordQuestProgress itself (the API the hooks rely on)
// ---------------------------------------------------------------------------

describe("recordQuestProgress (library sanity)", () => {
  it("records only the kinds live that day and caps at the target", async () => {
    const date = new Date("2026-11-08T12:00:00Z");
    expect(questsForDate(date).map((q) => q.id).sort()).toEqual(["casino_win_3", "catch_5", "roll_10"]);
    await recordQuestProgress(db, "user-1", ["roll"], 12, date);
    expect(await questProgress(db, "user-1", "roll_10", date)).toBe(10); // capped
    await recordQuestProgress(db, "user-1", ["catch"], 2, date);
    expect(await questProgress(db, "user-1", "catch_5", date)).toBe(2);
    // A kind with no live quest that day writes nothing.
    await recordQuestProgress(db, "user-1", ["daily"], 1, date);
    const rows = (await db
      .prepare("SELECT quest_id FROM user_quest_progress WHERE user_id = ? AND date = ?")
      .all("user-1", "2026-11-08")) as { quest_id: string }[];
    expect(rows.map((r) => r.quest_id).sort()).toEqual(["catch_5", "roll_10"]);
  });
});

describe("catch tier → quest kinds", () => {
  it("maps every tier exactly as the quest pool defines it", () => {
    const cases: [Tier, string[]][] = [
      ["Common", ["catch"]],
      ["Uncommon", ["catch"]],
      ["Rare", ["catch", "catch_rare"]],
      ["Epic", ["catch", "catch_rare"]],
      ["Legendary", ["catch", "catch_rare", "catch_legendary"]],
      ["Mythic", ["catch", "catch_rare", "catch_legendary"]],
      ["UwU", ["catch", "catch_rare", "catch_legendary"]],
    ];
    for (const [tier, kinds] of cases) expect(questKindsForCatch(tier)).toEqual(kinds);
  });
});

// ---------------------------------------------------------------------------
// 2026-11-07: daily_1, fuse_1, catch_legendary
// ---------------------------------------------------------------------------

describe("daily / fuse / legendary hooks (2026-11-07)", () => {
  beforeEach(() => {
    useQuestDate("2026-11-07T12:00:00Z", ["catch_legendary", "daily_1", "fuse_1"]);
  });

  it("claimDaily records daily progress; a second claim the same day records nothing", async () => {
    expect((await claimDaily(db, GUILD, "user-1", Date.now())).ok).toBe(true);
    expect(await questProgress(db, "user-1", "daily_1")).toBe(1);
    expect((await claimDaily(db, GUILD, "user-1", Date.now())).ok).toBe(false);
    expect(await questProgress(db, "user-1", "daily_1")).toBe(1);
  });

  it("uwu daily records daily progress", async () => {
    const msg = await run("uwu daily");
    expect(msg.allText()).toMatch(/100/);
    expect(await questProgress(db, "user-1", "daily_1")).toBe(1);
  });

  it("uwu fuse records fuse progress", async () => {
    const beetle = MONSTER_BY_ID.get(26)!;
    await awardMonster(db, GUILD, "user-1", "Common", "hunt", () => beetle, Date.now());
    await awardMonster(db, GUILD, "user-1", "Common", "hunt", () => beetle, Date.now());
    await addPoints(db, GUILD, "user-1", 500, "seed");
    const msg = await run("uwu fuse stone beetle");
    expect(msg.allText()).toContain("Fused!");
    expect(await getOwnedCount(db, GUILD, "user-1", 26)).toBe(1);
    expect(await questProgress(db, "user-1", "fuse_1")).toBe(1);
  });

  it("a Legendary hunt catch records catch_legendary", async () => {
    // Level 15 unlocks the Hollow. Scripted draws: Hollow tier roll
    // 0.8 → Legendary (weights Rare 5 / Epic 65 / Legendary 25 /
    // Mythic 4.5 / UwU 0.5), pool pick, wild level, encounter id,
    // then a catch roll of 0.05 → 5 < 30% Legendary catch rate.
    await grantPlayerXp(db, GUILD, "user-1", 2000);
    expect((await getBalance(db, GUILD, "user-1")).level).toBe(15);
    rngQueue.values.push(0.8, 0.5, 0.5, 0.5, 0.05);
    const msg = await run("uwu hunt hollow");
    expect(msg.allText()).toContain("appeared!");
    const edits = await pressHuntButton(huntButtonId(msg, 0), "user-1");
    expect((edits[0]?.content as string) ?? "").toContain("Caught it!");
    const owned = await getUserMonsters(db, GUILD, "user-1");
    expect(owned).toHaveLength(1);
    expect(owned[0]!.monster.tier).toBe("Legendary");
    expect(await questProgress(db, "user-1", "catch_legendary")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2026-11-08: roll_10, catch_5, casino_win_3
// ---------------------------------------------------------------------------

describe("roll / catch / casino hooks (2026-11-08)", () => {
  beforeEach(() => {
    useQuestDate("2026-11-08T12:00:00Z", ["roll_10", "catch_5", "casino_win_3"]);
  });

  it("uwu roll records roll + catch progress", async () => {
    await addPoints(db, GUILD, "user-1", 500, "seed");
    const msg = await run("uwu roll");
    expect(msg.allText()).toContain("Roll ×1");
    expect(await questProgress(db, "user-1", "roll_10")).toBe(1);
    expect(await questProgress(db, "user-1", "catch_5")).toBe(1);
  });

  it("uwu roll 10 records 10 roll progress and caps catch at 5", async () => {
    await addPoints(db, GUILD, "user-1", 5000, "seed");
    const msg = await run("uwu roll 10");
    expect(msg.allText()).toContain("Roll ×10");
    expect(await questProgress(db, "user-1", "roll_10")).toBe(10);
    expect(await questProgress(db, "user-1", "catch_5")).toBe(5);
  });

  it("a Common hunt catch records catch progress", async () => {
    // Meadow encounters are always Common (90% catch) — loop fresh
    // hunters until one catches.
    for (let i = 0; i < 15; i++) {
      const uid = `hunter-${i}`;
      const msg = await run("uwu hunt", uid);
      const edits = await pressHuntButton(huntButtonId(msg, 0), uid);
      if (((edits[0]?.content as string) ?? "").includes("Caught it!")) {
        expect(await questProgress(db, uid, "catch_5")).toBe(1);
        return;
      }
    }
    throw new Error("no hunter caught a monster in 15 tries");
  });

  it("a failed catch records nothing", async () => {
    // Scripted draws: tier / pool / level / id (any), then a catch
    // roll of 0.99 → 99 >= 90% Common catch rate, so it slips away.
    rngQueue.values.push(0.5, 0.5, 0.5, 0.5, 0.99);
    const msg = await run("uwu hunt");
    expect(msg.allText()).toContain("appeared!");
    const edits = await pressHuntButton(huntButtonId(msg, 0), "user-1");
    expect((edits[0]?.content as string) ?? "").toContain("slipped away");
    expect(await questProgress(db, "user-1", "catch_5")).toBe(0);
  });

  it("uwu slots win records casino_win", async () => {
    // Scripted reels: 0.05 × 3 → 🍒🍒🍒 (10x). The spin animation
    // draws fall back to real randomness once the queue is empty.
    await addPoints(db, GUILD, "user-1", 1000, "seed");
    rngQueue.values.push(0.05, 0.05, 0.05);
    const msg = await run("uwu slots 100");
    expect(msg.allText()).toMatch(/won .*1,000 gold/);
    expect(await questProgress(db, "user-1", "casino_win_3")).toBe(1);
  });

  it("blackjack stand win records casino_win", async () => {
    await addPoints(db, GUILD, "user-1", 1000, "seed");
    await placeBet(db, GUILD, "user-1", 100, "blackjack");
    const game = createBlackjackGame(GUILD, "user-1", 100);
    game.playerHand = ["10", "7"]; // 17
    game.dealerHand = ["10", "6"]; // 16, draws K and busts
    game.deck = ["K"];
    const btn = await clickCasino(`selena:bj:${game.id}:stand`);
    expect(casinoEditText(btn)).toMatch(/won 200 gold/);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(1100);
    expect(await questProgress(db, "user-1", "casino_win_3")).toBe(1);
  });

  it("blackjack push records nothing (stake back is not a win)", async () => {
    await addPoints(db, GUILD, "user-1", 1000, "seed");
    await placeBet(db, GUILD, "user-1", 100, "blackjack");
    const game = createBlackjackGame(GUILD, "user-1", 100);
    game.playerHand = ["10", "7"]; // 17
    game.dealerHand = ["10", "7"]; // 17 — dealer stands, push
    game.deck = ["2"];
    const btn = await clickCasino(`selena:bj:${game.id}:stand`);
    expect(casinoEditText(btn)).toMatch(/Push/);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(1000);
    expect(await questProgress(db, "user-1", "casino_win_3")).toBe(0);
  });

  it("roulette win records casino_win", async () => {
    await addPoints(db, GUILD, "user-1", 1000, "seed");
    let won = false;
    for (let i = 0; i < 15 && !won; i++) {
      const msg = await run("uwu roulette 10 red");
      won = msg.allText().includes("won");
    }
    expect(won).toBe(true);
    expect(await questProgress(db, "user-1", "casino_win_3")).toBe(1);
  });

  it("mines cashout records casino_win", async () => {
    // CASINO_RAND 0.999 → the shuffle never swaps, so the mines are
    // tiles 0, 1, 2 and tile 3 is safe. Cash out after one safe pick:
    // 10 × 1.40x = 14 gold.
    await addPoints(db, GUILD, "user-1", 1000, "seed");
    await placeBet(db, GUILD, "user-1", 10, "mines");
    CASINO_RAND.fn = () => 0.999;
    const game = createMinesGame(GUILD, "user-1", 10, 3);
    expect(game.mineTiles).toEqual([0, 1, 2]);
    await clickCasino(`selena:mines:${game.id}:tile:3`);
    const btn = await clickCasino(`selena:mines:${game.id}:cashout`);
    expect(casinoEditText(btn)).toMatch(/cashed out 14 gold/);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(1004);
    expect(await questProgress(db, "user-1", "casino_win_3")).toBe(1);
  });

  it("highlow cashout after a correct Same records casino_win", async () => {
    // CASINO_RAND 0.99 → every card drawn is rank 13, so the opening
    // card is 13 and guessing Same is always right (multiplier ≥ 10x).
    await addPoints(db, GUILD, "user-1", 1000, "seed");
    await placeBet(db, GUILD, "user-1", 10, "highlow");
    CASINO_RAND.fn = () => 0.99;
    const game = createHighlowGame(GUILD, "user-1", 10);
    expect(game.currentRank).toBe(13);
    await clickCasino(`selena:hl:${game.id}:same`);
    const btn = await clickCasino(`selena:hl:${game.id}:cashout`);
    expect(casinoEditText(btn)).toMatch(/cashed out 100 gold/);
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(1090);
    expect(await questProgress(db, "user-1", "casino_win_3")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2026-11-09: coinflip_win_1, bg_buy_1, tower_floor_2
// ---------------------------------------------------------------------------

describe("bg / tower hooks (2026-11-09)", () => {
  beforeEach(() => {
    useQuestDate("2026-11-09T12:00:00Z", ["coinflip_win_1", "bg_buy_1", "tower_floor_2"]);
  });

  it("buyBackground records bg_buy; buying it again records nothing", async () => {
    await addPoints(db, GUILD, "user-1", 12000, "seed");
    const res = await buyBackground(db, GUILD, "user-1", "autumn-leaves", Date.now());
    expect(res.ok).toBe(true);
    expect(await questProgress(db, "user-1", "bg_buy_1")).toBe(1);
    const again = await buyBackground(db, GUILD, "user-1", "autumn-leaves", Date.now());
    expect(again.ok).toBe(false);
    expect(await questProgress(db, "user-1", "bg_buy_1")).toBe(1);
  });

  it("uwu shop buy bg records bg_buy", async () => {
    await addPoints(db, GUILD, "user-1", 12000, "seed");
    const msg = await run("uwu shop buy bg autumn-leaves");
    expect(msg.allText()).toContain("Bought **Autumn Leaves** for 12,000 gold");
    expect(await questProgress(db, "user-1", "bg_buy_1")).toBe(1);
  });

  it("clearing two tower floors records tower_floor twice (target 2)", async () => {
    await insertTower(meadowSmallTower());
    await seedStrongTeam(ALICE);
    await enterTower(db, { userId: ALICE, tower: meadowSmallTower(), playerLevel: 0, nowMs: NOW });
    const first = await climbFloor(db, {
      guildId: GUILD, userId: ALICE, username: "alice", towerId: "test-small",
      nowMs: NOW, rand: mulberry32(42),
    });
    expect(first.outcome).toBe("win");
    expect(await questProgress(db, ALICE, "tower_floor_2")).toBe(1);
    const second = await climbFloor(db, {
      guildId: GUILD, userId: ALICE, username: "alice", towerId: "test-small",
      nowMs: NOW, rand: mulberry32(42),
    });
    expect(second.outcome).toBe("win");
    expect(await questProgress(db, ALICE, "tower_floor_2")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2026-11-11: hunt_3, hunt_10, about_1
// ---------------------------------------------------------------------------

describe("hunt / about hooks (2026-11-11)", () => {
  beforeEach(() => {
    useQuestDate("2026-11-11T12:00:00Z", ["hunt_3", "hunt_10", "about_1"]);
  });

  it("uwu hunt records hunt progress on both live hunt quests", async () => {
    const msg = await run("uwu hunt");
    expect(msg.allText()).toContain("appeared!");
    expect(await questProgress(db, "user-1", "hunt_3")).toBe(1);
    expect(await questProgress(db, "user-1", "hunt_10")).toBe(1);
  });

  it("uwu about records about progress", async () => {
    const msg = await run("uwu about hello world");
    expect(msg.allText()).toContain("hello world");
    expect(await questProgress(db, "user-1", "about_1")).toBe(1);
  });

  it("setAbout records about progress; an over-long about records nothing", async () => {
    expect((await setAbout(db, "user-1", "short and sweet")).ok).toBe(true);
    expect(await questProgress(db, "user-1", "about_1")).toBe(1);
    expect((await setAbout(db, "user-1", "x".repeat(101))).ok).toBe(false);
    expect(await questProgress(db, "user-1", "about_1")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2026-11-23: catch_5, catch_rare, casino_win_3
// ---------------------------------------------------------------------------

describe("rare catch hook (2026-11-23)", () => {
  beforeEach(() => {
    useQuestDate("2026-11-23T12:00:00Z", ["catch_5", "catch_rare", "casino_win_3"]);
  });

  it("a pity roll (Epic) records catch + catch_rare", async () => {
    await addPoints(db, GUILD, "user-1", 500, "seed");
    await db
      .prepare("INSERT INTO user_roll (guild_id, user_id, rolls_since_epic, rolls_today, roll_day) VALUES (?, ?, ?, ?, ?)")
      .run(GUILD, "user-1", 50, 0, utcDayString(Date.now()));
    const msg = await run("uwu roll");
    expect(msg.allText()).toContain("(pity!)");
    expect(msg.allText()).toContain("(Epic)");
    expect(await questProgress(db, "user-1", "catch_5")).toBe(1);
    expect(await questProgress(db, "user-1", "catch_rare")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2027-01-10: casino_win_3, coinflip_win_1, bg_buy_1
// ---------------------------------------------------------------------------

describe("coinflip hook (2027-01-10)", () => {
  beforeEach(() => {
    useQuestDate("2027-01-10T12:00:00Z", ["casino_win_3", "coinflip_win_1", "bg_buy_1"]);
  });

  it("a coinflip win records casino_win AND coinflip_win in one call", async () => {
    // Scripted flip: 0.1 < 0.5 → heads, and the call is heads.
    await addPoints(db, GUILD, "user-1", 1000, "seed");
    rngQueue.values.push(0.1);
    const msg = await run("uwu cf 10 heads");
    expect(msg.allText()).toMatch(/won .*19 gold/);
    expect(await questProgress(db, "user-1", "casino_win_3")).toBe(1);
    expect(await questProgress(db, "user-1", "coinflip_win_1")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2027-01-20: catch_rare, battle_win_1, explore_1
// ---------------------------------------------------------------------------

describe("battle / explore hooks (2027-01-20)", () => {
  beforeEach(() => {
    useQuestDate("2027-01-20T12:00:00Z", ["catch_rare", "battle_win_1", "explore_1"]);
  });

  it("settleBattle records battle_win for the winner only", async () => {
    await addPoints(db, GUILD, ALICE, 1000, "seed");
    await addPoints(db, GUILD, BOB, 1000, "seed");
    await settleBattle(db, {
      guildId: GUILD, aId: ALICE, bId: BOB, winner: "A", wager: 0,
      aTeam: team([91]), bTeam: team([1]),
    });
    expect(await questProgress(db, ALICE, "battle_win_1")).toBe(1);
    expect(await questProgress(db, BOB, "battle_win_1")).toBe(0);
  });

  it("settleBattle draw records nothing for either side", async () => {
    await addPoints(db, GUILD, ALICE, 1000, "seed");
    await addPoints(db, GUILD, BOB, 1000, "seed");
    await settleBattle(db, {
      guildId: GUILD, aId: ALICE, bId: BOB, winner: "draw", wager: 0,
      aTeam: team([1]), bTeam: team([1]),
    });
    expect(await questProgress(db, ALICE, "battle_win_1")).toBe(0);
    expect(await questProgress(db, BOB, "battle_win_1")).toBe(0);
  });

  it("uwu explore discovery records explore_discover", async () => {
    await seedTowers(db);
    await insertTower(meadowSmallTower());
    // Only the target stays undiscovered, so the discovery can only
    // find it. Scripted draws: 0.1 < 40% discovery chance, then the
    // pick among the one undiscovered tower.
    const undiscovered = await listUndiscoveredTowersInArea(db, ALICE, "meadow");
    for (const t of undiscovered) {
      if (t.towerId !== "test-small") await discoverTower(db, ALICE, t.towerId, NOW);
    }
    rngQueue.values.push(0.1, 0.0);
    const exploreCmd = towerCommands.find((c) => c.name === "explore")!;
    const fake = new FakeChatInput({ commandName: "explore", options: {}, userId: ALICE, username: "alice", guildId: GUILD });
    await exploreCmd.execute(fake as never, { db, guildId: GUILD });
    expect(fake.allText()).toContain("Test Meadow Spire");
    expect(await questProgress(db, ALICE, "explore_1")).toBe(1);
  });
});
