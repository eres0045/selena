import { describe, expect, it, beforeEach } from "vitest";
import type { SelenaDb } from "../src/lib/db.js";
import { getTestDb } from "./testDb.js";
import { addPoints, getBalance } from "../src/lib/economy.js";
import { mulberry32 } from "../src/lib/rng.js";
import { allButtonHandlers, allCommands, HELP_GROUPS } from "../src/commands/index.js";
import { handlePrefixMessage, MessageInvocation, type PrefixMessageLike } from "../src/lib/router.js";
import {
  AREAS,
  MONSTERS,
  MONSTER_BY_ID,
  PETS,
  ROLL10_COST,
  ROLL_COST,
  TIERS,
  WEAPONS,
  attemptCatch,
  catchRate,
  drawMonsterOfTier,
  encounterMonster,
  encounterTier,
  findMonsterByName,
  huntEmoji,
  monsterEmoji,
  monstersInArea,
  petEmoji,
  pityTier,
  powerBudget,
  rollTier,
  sellPriceFor,
  shouldUsePity,
  slugifyName,
  tierDown,
  type Tier,
  weaponEmoji,
} from "../src/lib/hunt.js";
import { HUNT_EMOJI_IDS } from "../src/lib/hunt-emoji-ids.js";
import { getUserXp } from "../src/lib/levels.js";
import {
  FUSION_COSTS,
  FUSE_LADDER,
  applyMonsterXp,
  battleWinXp,
  fusedEffects,
  fuseMultiplier,
  fuseTriggerBonus,
  fuseUnlockText,
  huntReward,
  leveledStats,
  monsterXpForLevel,
  powerBudgetOf,
  towerFloorXp,
} from "../src/lib/monsterLevels.js";
import {
  SPAWN_COOLDOWN_MS,
  addMonsterXp,
  applyFuse,
  awardMonster,
  countMonsterInGuild,
  getFusePlan,
  getOwnedCount,
  getRollState,
  getSpawnCooldown,
  getUserInstances,
  getUserMonsters,
  grantPlayerXp,
  isSpawnCoolingDown,
  removeOneMonster,
  setSpawnCooldown,
  spawnCooldownMs,
  utcDayString,
} from "../src/lib/huntDb.js";

const GUILD = "guild-1";

// ---------------------------------------------------------------------------
// Roster integrity (design §5/§6 transcribed verbatim)
// ---------------------------------------------------------------------------

const STAT_BANDS: Record<Tier, { hp: [number, number]; atk: [number, number]; def: [number, number]; budget: [number, number] }> = {
  Common: { hp: [40, 70], atk: [8, 14], def: [4, 8], budget: [84, 150] },
  Uncommon: { hp: [70, 110], atk: [13, 20], def: [7, 12], budget: [143, 226] },
  Rare: { hp: [110, 160], atk: [19, 28], def: [11, 17], budget: [219, 323] },
  Epic: { hp: [160, 230], atk: [27, 38], def: [16, 24], budget: [316, 454] },
  Legendary: { hp: [230, 320], atk: [37, 50], def: [23, 32], budget: [447, 616] },
  Mythic: { hp: [320, 450], atk: [49, 65], def: [31, 42], budget: [609, 836] },
  UwU: { hp: [450, 550], atk: [64, 78], def: [41, 50], budget: [829, 1012] },
};

describe("hunt roster", () => {
  it("has 100 monsters / 50 weapons / 20 pets with the design tier splits", () => {
    expect(MONSTERS.length).toBe(100);
    expect(WEAPONS.length).toBe(50);
    expect(PETS.length).toBe(20);
    const countByTier = (list: { tier: Tier }[]) => {
      const out: Record<string, number> = {};
      for (const e of list) out[e.tier] = (out[e.tier] ?? 0) + 1;
      return out;
    };
    expect(countByTier(MONSTERS)).toEqual({
      Common: 40,
      Uncommon: 25,
      Rare: 15,
      Epic: 10,
      Legendary: 6,
      Mythic: 3,
      UwU: 1,
    });
    expect(countByTier(WEAPONS)).toEqual({
      Common: 20,
      Uncommon: 12,
      Rare: 8,
      Epic: 5,
      Legendary: 3,
      Mythic: 1,
      UwU: 1,
    });
    expect(countByTier(PETS)).toEqual({ Common: 6, Uncommon: 5, Rare: 4, Epic: 2, Legendary: 2, Mythic: 1 });
  });

  it("every monster sits inside its tier stat band and power budget", () => {
    for (const m of MONSTERS) {
      const b = STAT_BANDS[m.tier];
      expect(m.hp).toBeGreaterThanOrEqual(b.hp[0]);
      expect(m.hp).toBeLessThanOrEqual(b.hp[1]);
      expect(m.atk).toBeGreaterThanOrEqual(b.atk[0]);
      expect(m.atk).toBeLessThanOrEqual(b.atk[1]);
      expect(m.def).toBeGreaterThanOrEqual(b.def[0]);
      expect(m.def).toBeLessThanOrEqual(b.def[1]);
      const budget = powerBudget(m);
      expect(budget).toBeGreaterThanOrEqual(b.budget[0]);
      expect(budget).toBeLessThanOrEqual(b.budget[1]);
    }
  });

  it("area pools cover the whole roster", () => {
    expect(monstersInArea("meadow").length).toBe(26);
    expect(monstersInArea("woods").length).toBe(29);
    expect(monstersInArea("peaks").length).toBe(21);
    expect(monstersInArea("hollow").length).toBe(24);
    expect(
      monstersInArea("meadow").length +
        monstersInArea("woods").length +
        monstersInArea("peaks").length +
        monstersInArea("hollow").length,
    ).toBe(100);
  });

  it("weapon ATK bonuses sit inside their tier bands", () => {
    const bands: Record<Tier, [number, number]> = {
      Common: [2, 5],
      Uncommon: [5, 9],
      Rare: [9, 14],
      Epic: [14, 20],
      Legendary: [20, 28],
      Mythic: [28, 38],
      UwU: [38, 50],
    };
    for (const w of WEAPONS) {
      expect(w.atk).toBeGreaterThanOrEqual(bands[w.tier][0]);
      expect(w.atk).toBeLessThanOrEqual(bands[w.tier][1]);
    }
  });

  it("pet buffs never exceed the +25% cap", () => {
    for (const p of PETS) expect(p.buffValue).toBeLessThanOrEqual(25);
  });
});

// ---------------------------------------------------------------------------
// Animated application emoji (uploaded to the bot; Unicode fallback)
// ---------------------------------------------------------------------------

describe("hunt emoji", () => {
  it("slugifies roster names exactly like the upload script", () => {
    expect(slugifyName("Storm King's Axe")).toBe("storm_king_s_axe");
    expect(slugifyName("The UwU Sovereign")).toBe("the_uwu_sovereign");
    expect(slugifyName("Spike Puffer")).toBe("spike_puffer");
  });

  it("emits animated application-emoji markup for a monster with an id", () => {
    expect(huntEmoji("Stone Beetle", "🪲")).toBe(
      `<a:stone_beetle:${HUNT_EMOJI_IDS["stone_beetle"]}>`,
    );
    expect(huntEmoji("Spike Puffer", "🐡")).toBe(
      `<a:spike_puffer:${HUNT_EMOJI_IDS["spike_puffer"]}>`,
    );
  });

  it("falls back to Unicode when the name has no uploaded id", () => {
    expect(huntEmoji("No Such Monster", "🔥")).toBe("🔥");
    expect(huntEmoji("No Such Monster", "🐾")).toBe("🐾");
  });

  it("every roster monster, weapon and pet renders animated emoji (no fallback)", () => {
    for (const m of MONSTERS) expect(monsterEmoji(m)).toMatch(/^<a:[a-z0-9_]+:\d+>$/);
    for (const w of WEAPONS) expect(weaponEmoji(w)).toMatch(/^<a:[a-z0-9_]+:\d+>$/);
    for (const p of PETS) expect(petEmoji(p)).toMatch(/^<a:[a-z0-9_]+:\d+>$/);
  });

  it("Thorn Hedgehog is gone and Spike Puffer is in the roster", () => {
    expect(findMonsterByName("Thorn Hedgehog")).toBeUndefined();
    const puffer = findMonsterByName("Spike Puffer");
    expect(puffer).toBeDefined();
    expect(puffer!.tier).toBe("Common");
    expect(monsterEmoji(puffer!)).toMatch(/^<a:spike_puffer:\d+>$/);
  });
});

// ---------------------------------------------------------------------------
// Pure draw math
// ---------------------------------------------------------------------------

describe("hunt draw math", () => {
  it("roll rates sum to 100", () => {
    const total = Object.values(TIERS).reduce((s, t) => s + t.rollRate, 0);
    expect(total).toBeCloseTo(100, 6);
  });

  it("rollTier follows the rates (10k draws, mulberry32)", () => {
    const rand = mulberry32(42);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 10_000; i++) {
      const t = rollTier(rand);
      counts[t] = (counts[t] ?? 0) + 1;
    }
    // Generous tolerance (5 sigma-ish for the common tiers, absolute floor for the rare ones).
    expect(counts.Common).toBeGreaterThan(5500);
    expect(counts.Common).toBeLessThan(6500);
    expect(counts.Uncommon).toBeGreaterThan(2100);
    expect(counts.Uncommon).toBeLessThan(2900);
    expect(counts.Rare).toBeGreaterThan(800);
    expect(counts.Rare).toBeLessThan(1200);
    expect(counts.Epic).toBeGreaterThan(300);
    expect(counts.Epic).toBeLessThan(500);
    expect(counts.Legendary).toBeGreaterThan(50);
    expect(counts.Legendary).toBeLessThan(140);
    expect(counts.Mythic).toBeGreaterThan(2);
    expect(counts.Mythic).toBeLessThan(20);
    expect(counts.UwU ?? 0).toBeLessThan(5);
  });

  it("pity fires at 50 rolls without Epic+ and yields Epic EXACTLY, never above", () => {
    expect(shouldUsePity(49)).toBe(false);
    expect(shouldUsePity(50)).toBe(true);
    expect(shouldUsePity(120)).toBe(true);
    // PITY = EPIC EXACTLY (Phase 1 §1.2 / §9 rule 9, Phase 2 §7.1):
    // Legendary+ stays pure luck. Across many seeds pity never yields
    // anything above Epic.
    const rand = mulberry32(7);
    for (let i = 0; i < 500; i++) {
      expect(pityTier(rand)).toBe("Epic");
    }
  });

  it("catch rates match the design table", () => {
    expect(catchRate("Common")).toBe(90);
    expect(catchRate("Uncommon")).toBe(75);
    expect(catchRate("Rare")).toBe(60);
    expect(catchRate("Epic")).toBe(45);
    expect(catchRate("Legendary")).toBe(30);
    expect(catchRate("Mythic")).toBe(15);
    expect(catchRate("UwU")).toBe(10);
  });

  it("attemptCatch respects the tier rate (mulberry32)", () => {
    const rand = mulberry32(99);
    let wins = 0;
    for (let i = 0; i < 1000; i++) if (attemptCatch("Common", rand)) wins++;
    expect(wins).toBeGreaterThan(850);
    expect(wins).toBeLessThan(950);
  });

  it("encounter tiers follow the area pools", () => {
    const rand = mulberry32(3);
    const meadow = AREAS.find((a) => a.id === "meadow")!;
    // Meadow only holds Commons in practice (no Uncommon lives there).
    for (let i = 0; i < 50; i++) expect(encounterTier(meadow, rand)).toBe("Common");
    const hollow = AREAS.find((a) => a.id === "hollow")!;
    const seen = new Set<Tier>();
    for (let i = 0; i < 500; i++) seen.add(encounterTier(hollow, rand));
    expect(seen.has("Epic")).toBe(true);
    expect(seen.has("Legendary")).toBe(true);
    // Mythic/UwU are rare encounters even in the Hollow — just check the
    // distribution helper doesn't crash on them over a bigger sample.
    const big = new Set<Tier>();
    const rand2 = mulberry32(11);
    for (let i = 0; i < 5000; i++) big.add(encounterTier(hollow, rand2));
    expect(big.has("Mythic")).toBe(true);
  });

  it("encounterMonster only returns monsters from the area", () => {
    const rand = mulberry32(5);
    for (const area of AREAS) {
      for (let i = 0; i < 20; i++) {
        const m = encounterMonster(area, rand);
        expect(monstersInArea(area.id).map((x) => x.id)).toContain(m.id);
      }
    }
  });

  it("sell prices match the design table", () => {
    expect(sellPriceFor("Common")).toBe(25);
    expect(sellPriceFor("Rare")).toBe(150);
    expect(sellPriceFor("Epic")).toBe(400);
    expect(sellPriceFor("Legendary")).toBe(1500);
    expect(sellPriceFor("Mythic")).toBe(5000);
    expect(sellPriceFor("UwU")).toBe(25000);
  });

  it("tierDown walks down one tier and stops at Common", () => {
    expect(tierDown("UwU")).toBe("Mythic");
    expect(tierDown("Mythic")).toBe("Legendary");
    expect(tierDown("Common")).toBe("Common");
  });

  it("findMonsterByName is case-insensitive and trims", () => {
    expect(findMonsterByName("thorn wolf")?.id).toBe(41);
    expect(findMonsterByName("  The UwU Sovereign " )?.id).toBe(100);
    expect(findMonsterByName("no such monster")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cap enforcement (pg-mem)
// ---------------------------------------------------------------------------

describe("hunt caps", () => {
  let db: SelenaDb;

  beforeEach(() => {
    db = getTestDb();
  });

  it("Mythic downgrades to Legendary once 3 copies exist in the guild", async () => {
    const voidDragon = MONSTER_BY_ID.get(97)!;
    // The pick must respect the tier it is asked for (the production
    // pick does); a pick that always returns the same monster would
    // re-award it at the downgraded tier.
    const pick = (t: Tier) => (t === "Mythic" ? voidDragon : drawMonsterOfTier(t, mulberry32(2)));
    // Phase 2 §7.1: each Mythic catch starts a 3-day GLOBAL spawn
    // cooldown, so the 3 cap copies can only be caught 3 days apart —
    // the clock advances past each cooldown between awards.
    const day = 3 * 24 * 60 * 60 * 1000;
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) {
      const r = await awardMonster(db, GUILD, `user-${i}`, "Mythic", "roll", pick, t0 + i * (day + 1));
      expect(r.monster.id).toBe(97);
      expect(r.downgradedFrom).toBeNull();
    }
    expect(await countMonsterInGuild(db, GUILD, 97)).toBe(3);
    // Past the third cooldown too, so the downgrade is the CAP, not the cooldown.
    const fourth = await awardMonster(db, GUILD, "user-9", "Mythic", "roll", pick, t0 + 3 * (day + 1));
    expect(fourth.downgradedFrom).toBe("Mythic");
    expect(fourth.downgradedReason).toBe("cap");
    expect(fourth.monster.tier).toBe("Legendary");
    expect(await countMonsterInGuild(db, GUILD, 97)).toBe(3);
  });

  it("UwU downgrades once 1 copy exists in the guild, but not in another guild", async () => {
    const sovereign = MONSTER_BY_ID.get(100)!;
    const fixedMythic = MONSTER_BY_ID.get(98)!;
    const pick = (t: Tier) => (t === "UwU" ? sovereign : t === "Mythic" ? fixedMythic : drawMonsterOfTier(t, mulberry32(1)));
    const t0 = Date.now();
    const first = await awardMonster(db, GUILD, "user-1", "UwU", "roll", pick, t0);
    expect(first.monster.id).toBe(100);
    const second = await awardMonster(db, GUILD, "user-2", "UwU", "roll", pick, t0);
    expect(second.downgradedFrom).toBe("UwU");
    expect(second.monster.tier).toBe("Mythic");
    // Another guild still has its own copy available — but the UwU
    // spawn cooldown is GLOBAL (Phase 2 §7.1, 14 days), so the other
    // guild's copy only spawns once the cooldown has passed.
    const twoWeeks = 14 * 24 * 60 * 60 * 1000;
    const other = await awardMonster(db, "guild-2", "user-3", "UwU", "roll", pick, t0 + twoWeeks + 1);
    expect(other.monster.id).toBe(100);
    expect(other.downgradedFrom).toBeNull();
  });

  it("awardMonster fails closed when the cap count query errors", async () => {
    const throwing = {
      prepare: () => ({
        all: async () => {
          throw new Error("boom");
        },
        get: async () => {
          throw new Error("boom");
        },
        run: async () => {
          throw new Error("boom");
        },
      }),
    } as unknown as SelenaDb;
    await expect(
      awardMonster(throwing, GUILD, "user-1", "Mythic", "roll", () => MONSTER_BY_ID.get(97)!, Date.now()),
    ).rejects.toThrow("boom");
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

function errorText(msg: FakePrefixMessage): string {
  return msg.allText();
}

describe("hunt commands", () => {
  let db: SelenaDb;

  beforeEach(() => {
    db = getTestDb();
  });

  async function run(content: string, userId = "user-1"): Promise<FakePrefixMessage> {
    const msg = new FakePrefixMessage(content, { userId });
    await handlePrefixMessage(msg, { db, guildId: GUILD });
    return msg;
  }

  it("registers hunt commands in a Hunt help category", () => {
    const hunt = HELP_GROUPS.find((g) => g.category === "Hunt");
    expect(hunt).toBeDefined();
    expect(hunt!.commands.map((c) => c.name).sort()).toEqual(["fuse", "hunt", "inv", "roll", "sell", "zoo"]);
    expect(allCommands.find((c) => c.name === "roll")?.aliases).toContain("gacha");
  });

  it("uwu map is now the world map and lists the four starting areas", async () => {
    // Phase 2: the old hunt-only map was replaced by the world map
    // (Starting Lands region). The four starting areas are still here.
    const msg = await run("uwu map");
    expect(msg.allText()).toContain("World Map");
    expect(msg.allText()).toContain("Meadow of Beginnings");
    expect(msg.allText()).toContain("The Hollow Deep");
    expect(msg.allText()).toContain("Whispering Woods");
    expect(msg.allText()).toContain("Ember Peaks");
  });

  it("uwu zoo is empty at first, uwu inv is empty at first", async () => {
    expect((await run("uwu zoo")).allText()).toContain("zoo is empty");
    expect((await run("uwu inv")).allText()).toContain("No weapons yet");
  });

  it("uwu hunt shows an encounter, then the 30s cooldown blocks a second hunt", async () => {
    const first = await run("uwu hunt");
    expect(first.allText()).toContain("appeared!");
    expect(first.replies[0]?.components).toBeDefined();
    const second = await run("uwu hunt");
    expect(errorText(second)).toContain("That didn't work");
    expect(errorText(second)).toMatch(/catching your breath|try again in \d+s/);
  });

  it("uwu hunt rejects a locked area", async () => {
    const msg = await run("uwu hunt peaks");
    expect(errorText(msg)).toContain("unlocks at level 10");
  });

  it("uwu hunt rejects an unknown area", async () => {
    const msg = await run("uwu hunt nowhere");
    expect(errorText(msg)).toContain('No area called "nowhere"');
  });

  it("uwu roll refuses without enough gold", async () => {
    const msg = await run("uwu roll");
    expect(errorText(msg)).toContain("That didn't work");
    expect(errorText(msg)).toContain(`${ROLL_COST}`);
  });

  it("uwu roll deducts gold, awards a monster, and shows it in the zoo", async () => {
    await addPoints(db, GUILD, "user-1", 500, "test grant");
    const msg = await run("uwu roll");
    expect(msg.allText()).toContain("Roll ×1");
    // Roll costs 500; the pull pays back its level-1 hunt reward
    // (Phase 2 §6.3: coins = 5 + 1×3, ±20% → 6–10 gold).
    const bal = (await getBalance(db, GUILD, "user-1")).points;
    expect(bal).toBeGreaterThanOrEqual(6);
    expect(bal).toBeLessThanOrEqual(10);
    const owned = await getUserMonsters(db, GUILD, "user-1");
    expect(owned.length).toBe(1);
    expect(owned[0]!.count).toBe(1);
    const zoo = await run("uwu zoo");
    expect(zoo.allText()).toContain(owned[0]!.monster.name);
  });

  it("uwu roll 10 costs 4,500 and awards 10 monsters", async () => {
    await addPoints(db, GUILD, "user-1", 5000, "test grant");
    const msg = await run("uwu roll 10");
    expect(msg.allText()).toContain("Roll ×10");
    // 5000 − 4500 + 10 pulls × 6–10 gold back each = 560–600.
    const bal = (await getBalance(db, GUILD, "user-1")).points;
    expect(bal).toBeGreaterThanOrEqual(560);
    expect(bal).toBeLessThanOrEqual(600);
    const owned = await getUserMonsters(db, GUILD, "user-1");
    expect(owned.reduce((s, o) => s + o.count, 0)).toBe(10);
  });

  it("uwu roll rejects counts other than 1 or 10", async () => {
    await addPoints(db, GUILD, "user-1", 5000, "test grant");
    const msg = await run("uwu roll 5");
    expect(errorText(msg)).toContain("Use `uwu roll` for one pull or `uwu roll 10`");
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(5000);
  });

  it("daily roll cap of 20 blocks the 21st roll", async () => {
    await addPoints(db, GUILD, "user-1", 20000, "test grant");
    await db
      .prepare("INSERT INTO user_roll (guild_id, user_id, rolls_since_epic, rolls_today, roll_day) VALUES (?, ?, ?, ?, ?)")
      .run(GUILD, "user-1", 0, 20, utcDayString(Date.now()));
    const msg = await run("uwu roll");
    expect(errorText(msg)).toContain("Daily roll cap");
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(20000);
  });

  it("uwu sell sells a duplicate and credits the tier price", async () => {
    await addPoints(db, GUILD, "user-1", 10000, "test grant");
    await run("uwu roll 10");
    const owned = await getUserMonsters(db, GUILD, "user-1");
    const dup = owned.find((o) => o.count >= 2);
    if (!dup) {
      // 10 random pulls usually contain a duplicate; if not, buy more.
      await run("uwu roll 10");
    }
    const owned2 = await getUserMonsters(db, GUILD, "user-1");
    const target = owned2.find((o) => o.count >= 2) ?? owned2[0]!;
    const before = (await getBalance(db, GUILD, "user-1")).points;
    const price = { Common: 25, Uncommon: 60, Rare: 150, Epic: 400, Legendary: 1500, Mythic: 5000, UwU: 25000 }[
      target.monster.tier
    ]!;
    const msg = await run(`uwu sell ${target.monster.name}`);
    expect(msg.allText()).toContain("Sold");
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(before + price);
    expect(await getOwnedCount(db, GUILD, "user-1", target.monster.id)).toBe(target.count - 1);
  });

  it("uwu sell asks to confirm before selling the only copy", async () => {
    await addPoints(db, GUILD, "user-1", 500, "test grant");
    await run("uwu roll");
    const owned = await getUserMonsters(db, GUILD, "user-1");
    const only = owned.find((o) => o.count === 1)!;
    const msg = await run(`uwu sell ${only.monster.name}`);
    expect(msg.allText()).toContain("your only");
    expect(msg.replies[0]?.components).toBeDefined();
    // Confirm via the sell-confirm button.
    const customId = (msg.replies[0]!.components as any)[0].toJSON().components[0].custom_id as string;
    expect(customId).toContain(`selena:hunt:sell-confirm:user-1:${only.monster.id}`);
    const edits: Record<string, unknown>[] = [];
    const handler = allButtonHandlers["selena:hunt"]!;
    await handler(
      {
        customId,
        user: { id: "user-1" },
        deferUpdate: async () => {},
        editReply: async (p: Record<string, unknown>) => {
          edits.push(p);
        },
        reply: async () => {},
        followUp: async () => {},
      } as never,
      { db, guildId: GUILD } as never,
    );
    expect((edits[0]?.content as string) ?? "").toContain("Sold your only");
    expect(await getOwnedCount(db, GUILD, "user-1", only.monster.id)).toBe(0);
  });

  it("uwu zoo <name> shows detail for an owned monster", async () => {
    await addPoints(db, GUILD, "user-1", 500, "test grant");
    await run("uwu roll");
    const owned = await getUserMonsters(db, GUILD, "user-1");
    const msg = await run(`uwu zoo ${owned[0]!.monster.name}`);
    expect(msg.allText()).toContain(owned[0]!.monster.name);
    expect(msg.allText()).toContain("HP");
  });

  it("catch button: Run ends the encounter", async () => {
    const msg = await run("uwu hunt");
    const customId = (msg.replies[0]!.components as any)[0].toJSON().components[1].custom_id as string;
    expect(customId).toContain("selena:hunt:run:");
    const edits: Record<string, unknown>[] = [];
    const handler = allButtonHandlers["selena:hunt"]!;
    await handler(
      {
        customId,
        user: { id: "user-1" },
        deferUpdate: async () => {},
        editReply: async (p: Record<string, unknown>) => {
          edits.push(p);
        },
        reply: async () => {},
        followUp: async () => {},
      } as never,
      { db, guildId: GUILD } as never,
    );
    expect((edits[0]?.content as string) ?? "").toContain("ran away");
    // A second press on the same encounter now says it expired.
    const replies: Record<string, unknown>[] = [];
    await handler(
      {
        customId,
        user: { id: "user-1" },
        deferUpdate: async () => {},
        editReply: async () => {},
        reply: async (p: Record<string, unknown>) => {
          replies.push(p);
        },
        followUp: async () => {},
      } as never,
      { db, guildId: GUILD } as never,
    );
    expect((replies[0]?.content as string) ?? "").toContain("expired");
  });

  it("catch button: someone else cannot press it", async () => {
    const msg = await run("uwu hunt");
    const customId = (msg.replies[0]!.components as any)[0].toJSON().components[0].custom_id as string;
    const replies: Record<string, unknown>[] = [];
    const handler = allButtonHandlers["selena:hunt"]!;
    await handler(
      {
        customId,
        user: { id: "user-2" },
        deferUpdate: async () => {},
        editReply: async () => {},
        reply: async (p: Record<string, unknown>) => {
          replies.push(p);
        },
        followUp: async () => {},
      } as never,
      { db, guildId: GUILD } as never,
    );
    expect((replies[0]?.content as string) ?? "").toContain("Only the hunter");
  });

  it("catch button: a Common is caught most of the time across many hunters", async () => {
    // Meadow encounters are always Common (90% catch rate): 15 fresh
    // hunters pressing Catch should see at least one success.
    let successes = 0;
    const handler = allButtonHandlers["selena:hunt"]!;
    for (let i = 0; i < 15; i++) {
      const uid = `hunter-${i}`;
      const msg = await run("uwu hunt", uid);
      const customId = (msg.replies[0]!.components as any)[0].toJSON().components[0].custom_id as string;
      const edits: Record<string, unknown>[] = [];
      await handler(
        {
          customId,
          user: { id: uid },
          deferUpdate: async () => {},
          editReply: async (p: Record<string, unknown>) => {
            edits.push(p);
          },
          reply: async () => {},
          followUp: async () => {},
        } as never,
        { db, guildId: GUILD } as never,
      );
      if (((edits[0]?.content as string) ?? "").includes("Caught it!")) successes++;
    }
    expect(successes).toBeGreaterThan(0);
    // And at least one hunter's zoo is non-empty.
    const zoos = await Promise.all(
      Array.from({ length: 15 }, (_, i) => getUserMonsters(db, GUILD, `hunter-${i}`)),
    );
    expect(zoos.some((z) => z.length > 0)).toBe(true);
  });

  it("roll state tracks pity: rolls_since_epic increments on sub-Epic pulls", async () => {
    await addPoints(db, GUILD, "user-1", 500, "test grant");
    await run("uwu roll");
    const st = await getRollState(db, GUILD, "user-1");
    // One pull: either it was Epic+ (counter reset to 0) or it wasn't (1).
    expect(st.rollsSinceEpic === 0 || st.rollsSinceEpic === 1).toBe(true);
    expect(st.rollsToday).toBe(1);
    expect(st.rollDay).toBe(utcDayString(Date.now()));
  });
});

// ---------------------------------------------------------------------------
// Phase 2 HUNT-CORE: monster levels, fusion, spawn cooldowns, pity fix,
// XP/coin scaling (design docs/hunt-world-phase2-design.md §6–§7)
// ---------------------------------------------------------------------------

describe("monster levels (Phase 2 §6)", () => {
  it("XP threshold is 100 × current level and XP carries over on level-up", () => {
    expect(monsterXpForLevel(1)).toBe(100);
    expect(monsterXpForLevel(5)).toBe(500);
    expect(monsterXpForLevel(100)).toBe(10000);
    expect(applyMonsterXp(1, 0, 250)).toEqual({ level: 2, xp: 150, levelsGained: 1 });
    expect(applyMonsterXp(2, 150, 250)).toEqual({ level: 3, xp: 200, levelsGained: 1 });
    expect(applyMonsterXp(1, 0, 99)).toEqual({ level: 1, xp: 99, levelsGained: 0 });
    expect(applyMonsterXp(1, 0, 100)).toEqual({ level: 2, xp: 0, levelsGained: 1 });
  });

  it("monster XP caps at level 100", () => {
    expect(applyMonsterXp(99, 0, 1_000_000)).toEqual({ level: 100, xp: 0, levelsGained: 1 });
    expect(applyMonsterXp(100, 0, 99999)).toEqual({ level: 100, xp: 0, levelsGained: 0 });
  });

  it("stats scale +2% per level above 1, multiplicative on base stats", () => {
    const beetle = MONSTER_BY_ID.get(26)!; // Stone Beetle 68/8/8
    expect(leveledStats(beetle, 1)).toEqual({ hp: 68, atk: 8, def: 8 });
    expect(leveledStats(beetle, 20)).toEqual({ hp: 94, atk: 11, def: 11 }); // ×1.38
    expect(leveledStats(beetle, 100)).toEqual({ hp: 203, atk: 24, def: 24 }); // ×2.98 (68×2.98=202.64→203)
    expect(powerBudgetOf(beetle, 20)).toBe(94 + 4 * 11 + 3 * 11);
  });

  it("fusion multiplier is +10% per step, +20% on the +5 step", () => {
    expect(fuseMultiplier(0)).toBeCloseTo(1, 9);
    expect(fuseMultiplier(1)).toBeCloseTo(1.1, 9);
    expect(fuseMultiplier(4)).toBeCloseTo(1.1 ** 4, 9);
    expect(fuseMultiplier(5)).toBeCloseTo(1.1 ** 4 * 1.2, 9);
    expect(fuseMultiplier(6)).toBeCloseTo(1.1 ** 5 * 1.2, 9);
    const beetle = MONSTER_BY_ID.get(26)!;
    expect(leveledStats(beetle, 1, 6).hp).toBe(Math.round(68 * 1.1 ** 5 * 1.2));
  });

  it("fusion costs scale by tier", () => {
    expect(FUSION_COSTS.Common).toBe(100);
    expect(FUSION_COSTS.Uncommon).toBe(250);
    expect(FUSION_COSTS.Rare).toBe(500);
    expect(FUSION_COSTS.Epic).toBe(1000);
    expect(FUSION_COSTS.Legendary).toBe(2500);
    expect(FUSION_COSTS.Mythic).toBe(5000);
    expect(FUSION_COSTS.UwU).toBe(25000);
  });

  it("fuse ladder unlocks match the design, one per rung", () => {
    expect(FUSE_LADDER).toHaveLength(6);
    expect(fuseUnlockText(1)).toContain("extra effect slot");
    expect(fuseUnlockText(2)).toContain("+10");
    expect(fuseUnlockText(3)).toContain("second signature effect");
    expect(fuseUnlockText(4)).toContain("+10");
    expect(fuseUnlockText(5)).toContain("+20%");
    expect(fuseUnlockText(6)).toContain("third signature effect");
    expect(fuseTriggerBonus(1)).toBe(0);
    expect(fuseTriggerBonus(2)).toBe(10);
    expect(fuseTriggerBonus(3)).toBe(10);
    expect(fuseTriggerBonus(4)).toBe(20);
    expect(fuseTriggerBonus(6)).toBe(20);
  });

  it("fused effects add a second effect at +3 and a third at +6, never duplicating", () => {
    const beetle = MONSTER_BY_ID.get(26)!; // Earth, no effects
    expect(fusedEffects(beetle, 0)).toEqual([]);
    expect(fusedEffects(beetle, 2)).toEqual([]);
    expect(fusedEffects(beetle, 3)).toEqual(["Stun"]);
    expect(fusedEffects(beetle, 6)).toEqual(["Stun", "Defense Down"]);
    const ant = MONSTER_BY_ID.get(12)!; // Fire, Burn
    expect(fusedEffects(ant, 3)).toEqual(["Burn", "Attack Down"]);
    expect(fusedEffects(ant, 6)).toEqual(["Burn", "Attack Down", "Crit Up"]);
    const reaper = MONSTER_BY_ID.get(71)!; // Shadow, Bleed
    expect(fusedEffects(reaper, 6)).toEqual(["Bleed", "Confuse", "Lifesteal"]);
    // Control-effect budget: a monster that already has Freeze never
    // gains a second control effect from fusion.
    const wolf = MONSTER_BY_ID.get(66)!; // Ice, Freeze
    expect(fusedEffects(wolf, 3)).toEqual(["Freeze", "Attack Down"]);
    expect(fusedEffects(wolf, 6)).toEqual(["Freeze", "Attack Down", "Shield"]);
  });

  it("battle and tower XP formulas match the design", () => {
    expect(battleWinXp(20)).toBe(80);
    expect(battleWinXp(0)).toBe(40);
    expect(towerFloorXp(10)).toBe(100);
    expect(towerFloorXp(1)).toBe(55);
  });
});

describe("monster instances + count sync", () => {
  let db: SelenaDb;

  beforeEach(() => {
    db = getTestDb();
  });

  it("awardMonster creates one instance per award, at the given level, in sync with the count row", async () => {
    const beetle = MONSTER_BY_ID.get(26)!;
    const pick = () => beetle;
    const first = await awardMonster(db, GUILD, "user-1", "Common", "hunt", pick, Date.now(), 7);
    expect(first.instanceId).toBeGreaterThan(0);
    expect(first.level).toBe(7);
    expect(await getOwnedCount(db, GUILD, "user-1", 26)).toBe(1);
    let insts = await getUserInstances(db, GUILD, "user-1", 26);
    expect(insts).toHaveLength(1);
    expect(insts[0]!.level).toBe(7);
    expect(insts[0]!.fuseLevel).toBe(0);
    expect(insts[0]!.source).toBe("hunt");
    await awardMonster(db, GUILD, "user-1", "Common", "roll", pick, Date.now(), 3);
    expect(await getOwnedCount(db, GUILD, "user-1", 26)).toBe(2);
    insts = await getUserInstances(db, GUILD, "user-1", 26);
    expect(insts).toHaveLength(2);
    expect(insts.map((i) => i.level).sort()).toEqual([3, 7]);
  });

  it("removeOneMonster deletes the weakest instance too, keeping counts in sync", async () => {
    const beetle = MONSTER_BY_ID.get(26)!;
    await awardMonster(db, GUILD, "user-1", "Common", "hunt", () => beetle, Date.now(), 7);
    await awardMonster(db, GUILD, "user-1", "Common", "hunt", () => beetle, Date.now(), 3);
    expect(await removeOneMonster(db, GUILD, "user-1", 26)).toBe(1);
    expect(await getOwnedCount(db, GUILD, "user-1", 26)).toBe(1);
    const insts = await getUserInstances(db, GUILD, "user-1", 26);
    expect(insts).toHaveLength(1);
    expect(insts[0]!.level).toBe(7); // the Lv 3 copy was sold, Lv 7 kept
    expect(await removeOneMonster(db, GUILD, "user-1", 26)).toBe(0);
    expect(await getUserInstances(db, GUILD, "user-1", 26)).toHaveLength(0);
    expect(await removeOneMonster(db, GUILD, "user-1", 26)).toBeNull();
  });

  it("addMonsterXp levels an instance up through the DB", async () => {
    const beetle = MONSTER_BY_ID.get(26)!;
    const awarded = await awardMonster(db, GUILD, "user-1", "Common", "hunt", () => beetle, Date.now(), 1);
    expect(await addMonsterXp(db, awarded.instanceId, 250)).toEqual({ level: 2, xp: 150, levelsGained: 1 });
    expect(await addMonsterXp(db, awarded.instanceId, 250)).toEqual({ level: 3, xp: 200, levelsGained: 1 });
    const inst = await getUserInstances(db, GUILD, "user-1", 26);
    expect(inst[0]!.level).toBe(3);
    expect(inst[0]!.xp).toBe(200);
    await expect(addMonsterXp(db, 999999, 10)).rejects.toThrow();
  });

  it("legacy count rows without instances are backfilled so fusion can see them", async () => {
    // A zoo row from before instances existed: 2 copies, 0 instance rows.
    await db
      .prepare("INSERT INTO user_monsters (guild_id, user_id, monster_id, count, source, caught_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(GUILD, "user-1", 26, 2, "hunt", Date.now());
    expect(await getUserInstances(db, GUILD, "user-1", 26)).toHaveLength(0);
    const plan = await getFusePlan(db, GUILD, "user-1", 26, Date.now());
    expect(plan.ok).toBe(true);
    expect(await getUserInstances(db, GUILD, "user-1", 26)).toHaveLength(2);
  });

  it("grantPlayerXp has no chat-XP cooldown and tracks level-ups", async () => {
    const first = await grantPlayerXp(db, GUILD, "user-1", 50);
    expect(first).toEqual({ xp: 50, level: 0, leveledUp: false });
    const second = await grantPlayerXp(db, GUILD, "user-1", 200);
    expect(second.xp).toBe(250);
    expect(second.level).toBe(2);
    expect(second.leveledUp).toBe(true);
    expect((await getUserXp(db, GUILD, "user-1")).xp).toBe(250);
  });
});

describe("fusion ladder (Phase 2 §6.4)", () => {
  let db: SelenaDb;

  beforeEach(() => {
    db = getTestDb();
  });

  async function awardCopies(userId: string, monsterId: number, count: number, level = 1): Promise<void> {
    const m = MONSTER_BY_ID.get(monsterId)!;
    for (let i = 0; i < count; i++) {
      await awardMonster(db, GUILD, userId, m.tier, "hunt", () => m, Date.now(), level);
    }
  }

  it("one fuse: 2 copies → 1 stronger copy, gold cost by tier, survivor keeps the higher level", async () => {
    await awardCopies("user-1", 26, 2);
    // Set one copy to level 12 so the survivor-level rule is visible.
    const insts = await getUserInstances(db, GUILD, "user-1", 26);
    await db.prepare("UPDATE user_monster_instances SET level = ? WHERE id = ?").run(12, insts[1]!.id);
    const plan = await getFusePlan(db, GUILD, "user-1", 26, Date.now());
    expect(plan.ok).toBe(true);
    expect(plan.cost).toBe(100); // Common
    expect(plan.newFuseLevel).toBe(1);
    expect(plan.newLevel).toBe(12);
    const out = await applyFuse(db, GUILD, "user-1", 26, Date.now());
    expect(out.newFuseLevel).toBe(1);
    expect(out.newLevel).toBe(12);
    expect(await getOwnedCount(db, GUILD, "user-1", 26)).toBe(1);
    const after = await getUserInstances(db, GUILD, "user-1", 26);
    expect(after).toHaveLength(1);
    expect(after[0]!.fuseLevel).toBe(1);
    expect(after[0]!.level).toBe(12);
  });

  it("each rung unlocks its design effect (ladder +1..+6)", async () => {
    // Climb 64 base copies to one +6 (63 fuses). Fusion always fuses
    // the highest paired level first, so rungs cascade upward as soon
    // as a pair forms — record every rung the climb passes through.
    const beetle = MONSTER_BY_ID.get(26)!;
    await awardCopies("user-1", 26, 64);
    const rungsSeen = new Set<number>();
    for (let i = 0; i < 63; i++) {
      const out = await applyFuse(db, GUILD, "user-1", 26, Date.now());
      rungsSeen.add(out.newFuseLevel);
    }
    expect([...rungsSeen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await getOwnedCount(db, GUILD, "user-1", 26)).toBe(1);
    const inst = (await getUserInstances(db, GUILD, "user-1", 26))[0]!;
    expect(inst.fuseLevel).toBe(6);
    // +1: extra effect slot · +2: trigger +10pp · +3: second effect ·
    // +4: trigger +10pp again · +5: +20% stats step · +6: third effect.
    expect(fuseTriggerBonus(2)).toBe(10);
    expect(fuseTriggerBonus(4)).toBe(20);
    expect(fusedEffects(beetle, 3)).toEqual(["Stun"]);
    expect(fusedEffects(beetle, 6)).toEqual(["Stun", "Defense Down"]);
    expect(leveledStats(beetle, 1, 5).hp).toBe(Math.round(68 * 1.1 ** 4 * 1.2));
    expect(leveledStats(beetle, 1, 6).hp).toBe(Math.round(68 * 1.1 ** 5 * 1.2));
  });

  it("reaching +6 takes exactly 64 base copies (63 fuses)", async () => {
    await awardCopies("user-1", 26, 64);
    let fuses = 0;
    while ((await getOwnedCount(db, GUILD, "user-1", 26)) > 1) {
      await applyFuse(db, GUILD, "user-1", 26, Date.now());
      fuses++;
    }
    expect(fuses).toBe(63);
    expect(await getOwnedCount(db, GUILD, "user-1", 26)).toBe(1);
    const insts = await getUserInstances(db, GUILD, "user-1", 26);
    expect(insts).toHaveLength(1);
    expect(insts[0]!.fuseLevel).toBe(6);
  });

  it("mixed fuse levels refuse: a +1 and a +0 are not a pair", async () => {
    await awardCopies("user-1", 26, 3);
    await applyFuse(db, GUILD, "user-1", 26, Date.now()); // 1× +1, 1× +0 left
    const plan = await getFusePlan(db, GUILD, "user-1", 26, Date.now());
    expect(plan.ok).toBe(false);
    expect(plan.error).toMatch(/same fusion level/);
    await expect(applyFuse(db, GUILD, "user-1", 26, Date.now())).rejects.toThrow(/same fusion level/);
    expect(await getOwnedCount(db, GUILD, "user-1", 26)).toBe(2); // nothing consumed
    // One more +0 copy completes a pair again.
    await awardCopies("user-1", 26, 1);
    expect((await getFusePlan(db, GUILD, "user-1", 26, Date.now())).ok).toBe(true);
  });

  it("a +6 monster refuses to fuse further and nothing is consumed", async () => {
    await awardCopies("user-1", 26, 64);
    while ((await getOwnedCount(db, GUILD, "user-1", 26)) > 1) {
      await applyFuse(db, GUILD, "user-1", 26, Date.now());
    }
    expect((await getUserInstances(db, GUILD, "user-1", 26))[0]!.fuseLevel).toBe(6);
    // Build a second +6 from 64 fresh copies; the two +6s then refuse.
    await awardCopies("user-1", 26, 64);
    while ((await getOwnedCount(db, GUILD, "user-1", 26)) > 2) {
      await applyFuse(db, GUILD, "user-1", 26, Date.now());
    }
    expect(await getOwnedCount(db, GUILD, "user-1", 26)).toBe(2);
    expect((await getUserInstances(db, GUILD, "user-1", 26)).every((i) => i.fuseLevel === 6)).toBe(true);
    const plan = await getFusePlan(db, GUILD, "user-1", 26, Date.now());
    expect(plan.ok).toBe(false);
    expect(plan.error).toMatch(/already \+6/);
    await expect(applyFuse(db, GUILD, "user-1", 26, Date.now())).rejects.toThrow(/already \+6/);
    expect(await getOwnedCount(db, GUILD, "user-1", 26)).toBe(2);
  });

  it("fewer than 2 copies refuses and consumes nothing", async () => {
    await awardCopies("user-1", 26, 1);
    const plan = await getFusePlan(db, GUILD, "user-1", 26, Date.now());
    expect(plan.ok).toBe(false);
    expect(plan.error).toMatch(/need 2 copies/);
    await expect(applyFuse(db, GUILD, "user-1", 26, Date.now())).rejects.toThrow(/need 2 copies/);
    expect(await getOwnedCount(db, GUILD, "user-1", 26)).toBe(1);
  });
});

describe("spawn cooldowns (Phase 2 §7.1)", () => {
  let db: SelenaDb;

  beforeEach(() => {
    db = getTestDb();
  });

  it("cooldown durations are 12h / 3 days / 14 days, and Common–Epic have none", () => {
    expect(SPAWN_COOLDOWN_MS.Legendary).toBe(12 * 60 * 60 * 1000);
    expect(SPAWN_COOLDOWN_MS.Mythic).toBe(3 * 24 * 60 * 60 * 1000);
    expect(SPAWN_COOLDOWN_MS.UwU).toBe(14 * 24 * 60 * 60 * 1000);
    expect(spawnCooldownMs("Legendary")).toBe(12 * 60 * 60 * 1000);
    expect(spawnCooldownMs("Mythic")).toBe(3 * 24 * 60 * 60 * 1000);
    expect(spawnCooldownMs("UwU")).toBe(14 * 24 * 60 * 60 * 1000);
    expect(spawnCooldownMs("Epic")).toBeNull();
    expect(spawnCooldownMs("Common")).toBeNull();
  });

  it("set/get/isSpawnCoolingDown round-trip and expiry", async () => {
    const t0 = Date.now();
    expect(await isSpawnCoolingDown(db, 91, t0)).toBe(false);
    expect(await getSpawnCooldown(db, 91)).toBeNull();
    const availableAt = await setSpawnCooldown(db, 91, t0);
    expect(availableAt).toBe(t0 + 12 * 60 * 60 * 1000);
    expect(await isSpawnCoolingDown(db, 91, t0)).toBe(true);
    expect(await isSpawnCoolingDown(db, 91, t0 + 12 * 60 * 60 * 1000 + 1)).toBe(false);
    expect((await getSpawnCooldown(db, 91))!.availableAt).toBe(availableAt);
    expect(await setSpawnCooldown(db, 26, t0)).toBe(0); // Common: no cooldown
  });

  it("a Legendary on cooldown downgrades to Epic (hunt path) and returns after 12h", async () => {
    const solar = MONSTER_BY_ID.get(91)!;
    const lunar = MONSTER_BY_ID.get(92)!;
    // Picks must respect the tier they are asked for (the production
    // picks do); a fixed pick would re-award the same monster at the
    // downgraded tier.
    const pickSolar = (t: Tier) => (t === "Legendary" ? solar : drawMonsterOfTier(t, mulberry32(4)));
    const pickLunar = (t: Tier) => (t === "Legendary" ? lunar : drawMonsterOfTier(t, mulberry32(5)));
    const t0 = Date.now();
    const first = await awardMonster(db, GUILD, "user-1", "Legendary", "hunt", pickSolar, t0);
    expect(first.monster.id).toBe(91);
    expect(first.downgradedFrom).toBeNull();
    const second = await awardMonster(db, GUILD, "user-2", "Legendary", "hunt", pickSolar, t0 + 1000);
    expect(second.downgradedFrom).toBe("Legendary");
    expect(second.downgradedReason).toBe("cooldown");
    expect(second.monster.tier).toBe("Epic");
    expect(second.cooldownAvailableAt).toBe(t0 + 12 * 60 * 60 * 1000);
    expect(await countMonsterInGuild(db, GUILD, 91)).toBe(1);
    // A different Legendary that is NOT cooling down can still spawn.
    const third = await awardMonster(db, GUILD, "user-3", "Legendary", "hunt", pickLunar, t0 + 2000);
    expect(third.monster.id).toBe(92);
    // After the cooldown ends, the same monster spawns again.
    const fourth = await awardMonster(db, GUILD, "user-4", "Legendary", "roll", pickSolar, t0 + 12 * 60 * 60 * 1000 + 1);
    expect(fourth.monster.id).toBe(91);
    expect(fourth.downgradedFrom).toBeNull();
  });

  it("Mythic (3d) and UwU (14d) cooldowns downgrade on the roll path too", async () => {
    const t0 = Date.now();
    const voidDragon = MONSTER_BY_ID.get(97)!;
    const pickVoid = (t: Tier) => (t === "Mythic" ? voidDragon : drawMonsterOfTier(t, mulberry32(6)));
    await awardMonster(db, GUILD, "user-1", "Mythic", "roll", pickVoid, t0);
    const mythicAgain = await awardMonster(db, GUILD, "user-2", "Mythic", "roll", pickVoid, t0 + 1000);
    expect(mythicAgain.downgradedReason).toBe("cooldown");
    expect(mythicAgain.monster.tier).toBe("Legendary");
    expect(mythicAgain.cooldownAvailableAt).toBe(t0 + 3 * 24 * 60 * 60 * 1000);
    const sovereign = MONSTER_BY_ID.get(100)!;
    const celestial = MONSTER_BY_ID.get(98)!;
    const titan = MONSTER_BY_ID.get(99)!;
    const pickSov = (t: Tier) =>
      t === "UwU" ? sovereign : t === "Mythic" ? celestial : drawMonsterOfTier(t, mulberry32(7));
    await awardMonster(db, GUILD, "user-1", "UwU", "roll", pickSov, t0);
    const uwuAgain = await awardMonster(db, GUILD, "user-2", "UwU", "roll", pickSov, t0 + 1000);
    expect(uwuAgain.downgradedReason).toBe("cooldown");
    expect(uwuAgain.monster.tier).toBe("Mythic");
    expect(uwuAgain.cooldownAvailableAt).toBe(t0 + 14 * 24 * 60 * 60 * 1000);
    // The global cooldown blocks other guilds too, until it expires —
    // the other guild's UwU draw downgrades to a Mythic that is not
    // itself cooling down (Titan of the Deep, not Celestial Phoenix).
    const pickSovOther = (t: Tier) =>
      t === "UwU" ? sovereign : t === "Mythic" ? titan : drawMonsterOfTier(t, mulberry32(8));
    const otherGuild = await awardMonster(db, "guild-2", "user-9", "UwU", "roll", pickSovOther, t0 + 1000);
    expect(otherGuild.downgradedFrom).toBe("UwU");
    expect(otherGuild.monster.tier).toBe("Mythic");
    expect(otherGuild.monster.id).toBe(99);
  });

  it("awardMonster fails closed when the cooldown read errors", async () => {
    const throwing = {
      prepare: () => ({
        all: async () => {
          throw new Error("boom");
        },
        get: async () => {
          throw new Error("boom");
        },
        run: async () => {
          throw new Error("boom");
        },
      }),
    } as unknown as SelenaDb;
    await expect(
      awardMonster(throwing, GUILD, "user-1", "Legendary", "roll", () => MONSTER_BY_ID.get(91)!, Date.now()),
    ).rejects.toThrow("boom");
  });
});

describe("hunt/roll rewards scale with monster level (Phase 2 §6.3)", () => {
  let db: SelenaDb;

  beforeEach(() => {
    db = getTestDb();
  });

  async function run(content: string, userId = "user-1"): Promise<FakePrefixMessage> {
    const msg = new FakePrefixMessage(content, { userId });
    await handlePrefixMessage(msg, { db, guildId: GUILD });
    return msg;
  }

  it("huntReward scales with level: XP = 10 + level×2, coins = 5 + level×3 (±20%)", () => {
    const flat = () => 0.5; // jitter exactly 1.0
    expect(huntReward(1, flat)).toEqual({ xp: 12, coins: 8 });
    expect(huntReward(5, flat)).toEqual({ xp: 20, coins: 20 });
    expect(huntReward(40, flat)).toEqual({ xp: 90, coins: 125 });
    // Jitter bounds: a level-40 catch always beats a level-1 catch.
    expect(huntReward(40, () => 0).xp).toBeGreaterThan(huntReward(1, () => 0.999).xp);
    expect(huntReward(40, () => 0).coins).toBeGreaterThan(huntReward(1, () => 0.999).coins);
    expect(huntReward(40, () => 0).xp).toBe(Math.round(90 * 0.8));
    expect(huntReward(40, () => 0.999).coins).toBe(Math.round(125 * 1.2));
  });

  it("a roll grants level-1 XP and gold, and the monster instance gains the same XP", async () => {
    await addPoints(db, GUILD, "user-1", 500, "test grant");
    await run("uwu roll");
    const xp = (await getUserXp(db, GUILD, "user-1")).xp;
    expect(xp).toBeGreaterThanOrEqual(10); // 12 ±20% → 10–14
    expect(xp).toBeLessThanOrEqual(14);
    const bal = (await getBalance(db, GUILD, "user-1")).points;
    expect(bal).toBeGreaterThanOrEqual(6); // 8 ±20% → 6–10
    expect(bal).toBeLessThanOrEqual(10);
    const insts = await getUserInstances(db, GUILD, "user-1");
    expect(insts).toHaveLength(1);
    expect(insts[0]!.xp).toBe(xp);
    expect(insts[0]!.level).toBe(1);
  });

  it("a pity roll at 50 rolls without Epic+ yields Epic exactly, never Legendary+", async () => {
    await addPoints(db, GUILD, "user-1", 500, "test grant");
    await db
      .prepare("INSERT INTO user_roll (guild_id, user_id, rolls_since_epic, rolls_today, roll_day) VALUES (?, ?, ?, ?, ?)")
      .run(GUILD, "user-1", 50, 0, utcDayString(Date.now()));
    const msg = await run("uwu roll");
    const text = msg.allText();
    expect(text).toContain("(pity!)");
    expect(text).toContain("(Epic)");
    expect(text).not.toContain("(Legendary)");
    expect(text).not.toContain("(Mythic)");
    expect(text).not.toContain("(UwU)");
    const st = await getRollState(db, GUILD, "user-1");
    expect(st.rollsSinceEpic).toBe(0);
  });

  it("rolls never yield a Legendary+ that is on its global cooldown", async () => {
    // Rest every Legendary, Mythic and UwU monster, then roll 10 times:
    // any high-tier draw must downgrade, so no Legendary+ tier text
    // can appear in the reply no matter what the RNG draws.
    const now = Date.now();
    for (const m of MONSTERS.filter((x) => ["Legendary", "Mythic", "UwU"].includes(x.tier))) {
      await setSpawnCooldown(db, m.id, now);
    }
    await addPoints(db, GUILD, "user-1", 5000, "test grant");
    const msg = await run("uwu roll 10");
    const text = msg.allText();
    expect(text).not.toContain("(Legendary)");
    expect(text).not.toContain("(Mythic)");
    expect(text).not.toContain("(UwU)");
    const owned = await getUserMonsters(db, GUILD, "user-1");
    expect(owned.reduce((s, o) => s + o.count, 0)).toBe(10);
  });
});

describe("fuse command", () => {
  let db: SelenaDb;

  beforeEach(() => {
    db = getTestDb();
  });

  async function run(content: string, userId = "user-1"): Promise<FakePrefixMessage> {
    const msg = new FakePrefixMessage(content, { userId });
    await handlePrefixMessage(msg, { db, guildId: GUILD });
    return msg;
  }

  async function giveCopies(userId: string, monsterId: number, count: number): Promise<void> {
    const m = MONSTER_BY_ID.get(monsterId)!;
    for (let i = 0; i < count; i++) {
      await awardMonster(db, GUILD, userId, m.tier, "hunt", () => m, Date.now(), 1);
    }
  }

  it("uwu fuse merges 2 copies into a +1, charges the tier cost, and shows the unlock", async () => {
    await giveCopies("user-1", 26, 2);
    await addPoints(db, GUILD, "user-1", 500, "test grant");
    const msg = await run("uwu fuse stone beetle");
    const text = msg.allText();
    expect(text).toContain("Fused!");
    expect(text).toContain("+1");
    expect(text).toContain("extra effect slot");
    expect(text).toContain("100");
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(400);
    expect(await getOwnedCount(db, GUILD, "user-1", 26)).toBe(1);
    const zoo = await run("uwu zoo");
    expect(zoo.allText()).toContain("+1");
    const detail = await run("uwu zoo stone beetle");
    expect(detail.allText()).toContain("Lv 1 +1");
  });

  it("uwu fuse refuses with fewer than 2 copies and charges nothing", async () => {
    await giveCopies("user-1", 26, 1);
    await addPoints(db, GUILD, "user-1", 500, "test grant");
    const msg = await run("uwu fuse stone beetle");
    expect(msg.allText()).toContain("need 2 copies");
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(500);
    expect(await getOwnedCount(db, GUILD, "user-1", 26)).toBe(1);
  });

  it("uwu fuse refuses without enough gold and consumes nothing", async () => {
    await giveCopies("user-1", 26, 2);
    await addPoints(db, GUILD, "user-1", 50, "test grant");
    const msg = await run("uwu fuse stone beetle");
    expect(msg.allText()).toContain("costs");
    expect(msg.allText()).toContain("100");
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(50);
    expect(await getOwnedCount(db, GUILD, "user-1", 26)).toBe(2);
    expect(await getUserInstances(db, GUILD, "user-1", 26)).toHaveLength(2);
  });

  it("uwu fuse refuses an unknown monster", async () => {
    const msg = await run("uwu fuse no such monster");
    expect(msg.allText()).toContain('No monster called "no such monster"');
  });

  it("uwu fuse charges the tier cost (Epic = 1,000 gold)", async () => {
    await giveCopies("user-1", 81, 2); // Inferno Phoenix, Epic
    await addPoints(db, GUILD, "user-1", 1500, "test grant");
    const msg = await run("uwu fuse inferno phoenix");
    expect(msg.allText()).toContain("Fused!");
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(500);
  });
});

describe("zoo shows levels and fusion", () => {
  let db: SelenaDb;

  beforeEach(() => {
    db = getTestDb();
  });

  async function run(content: string, userId = "user-1"): Promise<FakePrefixMessage> {
    const msg = new FakePrefixMessage(content, { userId });
    await handlePrefixMessage(msg, { db, guildId: GUILD });
    return msg;
  }

  it("zoo lines show the best level, detail shows every instance with level/fusion/XP", async () => {
    const beetle = MONSTER_BY_ID.get(26)!;
    await awardMonster(db, GUILD, "user-1", "Common", "hunt", () => beetle, Date.now(), 12);
    await awardMonster(db, GUILD, "user-1", "Common", "hunt", () => beetle, Date.now(), 4);
    const zoo = await run("uwu zoo");
    expect(zoo.allText()).toContain("Stone Beetle ×2 · Lv 12");
    const detail = await run("uwu zoo stone beetle");
    const text = detail.allText();
    expect(text).toContain("Lv 12");
    expect(text).toContain("Lv 4");
    expect(text).toContain("HP");
    expect(text).toContain("0/1200 XP"); // Lv 12 needs 100×12
    expect(text).toContain("0/400 XP"); // Lv 4 needs 100×4
  });

  it("a hunt catch shows its wild level and pays level-scaled XP/gold", async () => {
    // Meadow encounters are Common at wild level 1–5: XP 12–20, gold 8–20.
    const msg = await run("uwu hunt");
    expect(msg.allText()).toContain("appeared!");
    expect(msg.allText()).toMatch(/Lv [1-5]/);
    const customId = (msg.replies[0]!.components as any)[0].toJSON().components[0].custom_id as string;
    const edits: Record<string, unknown>[] = [];
    const handler = allButtonHandlers["selena:hunt"]!;
    await handler(
      {
        customId,
        user: { id: "user-1" },
        deferUpdate: async () => {},
        editReply: async (p: Record<string, unknown>) => {
          edits.push(p);
        },
        reply: async () => {},
        followUp: async () => {},
      } as never,
      { db, guildId: GUILD } as never,
    );
    const text = (edits[0]?.content as string) ?? "";
    if (text.includes("Caught it!")) {
      expect(text).toMatch(/\+\d+ XP, \+\d+ gold/);
      const xp = (await getUserXp(db, GUILD, "user-1")).xp;
      // Meadow wild level 1–5: XP = (10 + Lv×2) ±20% → 10–24.
      expect(xp).toBeGreaterThanOrEqual(10);
      expect(xp).toBeLessThanOrEqual(24);
      const insts = await getUserInstances(db, GUILD, "user-1");
      expect(insts).toHaveLength(1);
      expect(insts[0]!.level).toBeGreaterThanOrEqual(1);
      expect(insts[0]!.level).toBeLessThanOrEqual(5);
    }
  });
});
