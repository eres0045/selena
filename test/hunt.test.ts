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
import {
  awardMonster,
  countMonsterInGuild,
  getOwnedCount,
  getRollState,
  getUserMonsters,
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

  it("pity fires at 50 rolls without Epic+ and only yields Epic+", () => {
    expect(shouldUsePity(49)).toBe(false);
    expect(shouldUsePity(50)).toBe(true);
    expect(shouldUsePity(120)).toBe(true);
    const rand = mulberry32(7);
    for (let i = 0; i < 200; i++) {
      const t = pityTier(rand);
      expect(["Epic", "Legendary", "Mythic", "UwU"]).toContain(t);
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
    for (let i = 0; i < 3; i++) {
      const r = await awardMonster(db, GUILD, `user-${i}`, "Mythic", "roll", pick, Date.now());
      expect(r.monster.id).toBe(97);
      expect(r.downgradedFrom).toBeNull();
    }
    expect(await countMonsterInGuild(db, GUILD, 97)).toBe(3);
    const fourth = await awardMonster(db, GUILD, "user-9", "Mythic", "roll", pick, Date.now());
    expect(fourth.downgradedFrom).toBe("Mythic");
    expect(fourth.monster.tier).toBe("Legendary");
    expect(await countMonsterInGuild(db, GUILD, 97)).toBe(3);
  });

  it("UwU downgrades once 1 copy exists in the guild, but not in another guild", async () => {
    const sovereign = MONSTER_BY_ID.get(100)!;
    const fixedMythic = MONSTER_BY_ID.get(98)!;
    const pick = (t: Tier) => (t === "UwU" ? sovereign : t === "Mythic" ? fixedMythic : drawMonsterOfTier(t, mulberry32(1)));
    const first = await awardMonster(db, GUILD, "user-1", "UwU", "roll", pick, Date.now());
    expect(first.monster.id).toBe(100);
    const second = await awardMonster(db, GUILD, "user-2", "UwU", "roll", pick, Date.now());
    expect(second.downgradedFrom).toBe("UwU");
    expect(second.monster.tier).toBe("Mythic");
    // Another guild still has its own copy available.
    const other = await awardMonster(db, "guild-2", "user-3", "UwU", "roll", pick, Date.now());
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
    expect(hunt!.commands.map((c) => c.name).sort()).toEqual(["hunt", "inv", "roll", "sell", "zoo"]);
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
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(0);
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
    expect((await getBalance(db, GUILD, "user-1")).points).toBe(500);
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
