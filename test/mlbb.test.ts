import { describe, it, expect, beforeEach } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import { getTestDb, type SelenaDb } from "../src/lib/db.js";
import { FakeChatInput } from "../src/lib/testkit.js";
import { GACHA_CARDS, HEROES, findHero } from "../src/data/heroes.js";
import {
  MLBB_RANKS,
  confirmVerification,
  counterLookup,
  getProfile,
  getTopHeroCards,
  heroLookup,
  registerProfile,
  setRank,
  startVerification,
} from "../src/lib/mlbb.js";
import { commands } from "../src/commands/mlbb.js";

const GUILD = "guild-1";
const USER = "user-1";

let db: SelenaDb;

beforeEach(() => {
  db = getTestDb();
});

function getCmd(name: string) {
  const cmd = commands.find((c) => c.data.name === name);
  if (!cmd) throw new Error(`missing command: ${name}`);
  return cmd;
}

interface RunExtra {
  userId?: string;
  username?: string;
  permissions?: string[];
  /** Attach fake guild/member objects (for /rankrole role assignment). */
  attach?: Record<string, unknown>;
}

async function run(
  name: string,
  options: Record<string, unknown> = {},
  extra: RunExtra = {},
): Promise<FakeChatInput> {
  const ix = new FakeChatInput({
    commandName: name,
    options,
    userId: extra.userId ?? USER,
    username: extra.username ?? "tester",
    guildId: GUILD,
    permissions: extra.permissions ?? [],
  });
  if (extra.attach) {
    Object.assign(ix as unknown as Record<string, unknown>, extra.attach);
  }
  await getCmd(name).execute(ix as unknown as ChatInputCommandInteraction, {
    db,
    guildId: GUILD,
  });
  return ix;
}

function storedCode(userId = USER): string {
  const row = db
    .prepare("SELECT verify_code FROM mlbb_profiles WHERE guild_id = ? AND user_id = ?")
    .get(GUILD, userId) as Record<string, unknown> | undefined;
  if (!row || typeof row.verify_code !== "string") throw new Error("no code stored");
  return row.verify_code;
}

/** Fake guild/member pair that lets /rankrole exercise the assign path. */
function fakeGuildWithRoles(roleNames: string[]) {
  const roles = roleNames.map((name, i) => ({ id: `role-${i}`, name }));
  const assigned: unknown[] = [];
  const guild = {
    roles: {
      cache: {
        find: (pred: (r: { id: string; name: string }) => boolean) => roles.find(pred),
      },
    },
  };
  const member = {
    roles: {
      add: async (role: unknown) => {
        assigned.push(role);
      },
    },
  };
  return { guild, member, assigned, roles };
}

// ---------- findHero / dataset ----------

describe("findHero", () => {
  it("finds an exact name", () => {
    expect(findHero("Miya")?.id).toBe("miya");
    expect(findHero("Yu Zhong")?.id).toBe("yu-zhong");
  });

  it("is case-insensitive", () => {
    expect(findHero("mIyA")?.id).toBe("miya");
    expect(findHero("LANCELOT")?.id).toBe("lancelot");
  });

  it("matches ids and partial names", () => {
    expect(findHero("yu-zhong")?.id).toBe("yu-zhong");
    expect(findHero("yuzhong")?.id).toBe("yu-zhong");
    expect(findHero("gusi")?.id).toBe("gusion");
    expect(findHero("sel")?.id).toBe("selena");
    expect(findHero("zhong")?.id).toBe("yu-zhong");
  });

  it("returns undefined for unknown heroes and empty queries", () => {
    expect(findHero("Zzzzx")).toBeUndefined();
    expect(findHero("")).toBeUndefined();
    expect(findHero("   ")).toBeUndefined();
  });
});

describe("dataset integrity", () => {
  it("has at least 25 heroes across all six roles", () => {
    expect(HEROES.length).toBeGreaterThanOrEqual(25);
    const roles = new Set(HEROES.map((h) => h.role));
    expect(roles).toEqual(
      new Set(["Tank", "Fighter", "Assassin", "Mage", "Marksman", "Support"]),
    );
  });

  it("every hero has name/role/lane/description/snapshot:true and no duplicate ids", () => {
    const ids = new Set<string>();
    for (const hero of HEROES) {
      expect(hero.name.trim().length).toBeGreaterThan(0);
      expect(hero.role).toBeTruthy();
      expect(hero.lane.trim().length).toBeGreaterThan(0);
      expect(hero.description.trim().length).toBeGreaterThan(0);
      expect(hero.snapshot).toBe(true);
      expect(ids.has(hero.id)).toBe(false);
      ids.add(hero.id);
    }
  });

  it("rates, when present, are within 0-100 (none are invented)", () => {
    for (const hero of HEROES) {
      for (const rate of [hero.winRate, hero.pickRate, hero.banRate]) {
        if (rate !== undefined) {
          expect(rate).toBeGreaterThanOrEqual(0);
          expect(rate).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  it("counter names resolve to real heroes", () => {
    for (const hero of HEROES) {
      for (const name of [...(hero.counters ?? []), ...(hero.counteredBy ?? [])]) {
        expect(findHero(name), `${hero.name} references unknown hero "${name}"`).toBeDefined();
      }
    }
  });

  it("gacha cards map 1:1 onto heroes with valid rarities", () => {
    expect(GACHA_CARDS.length).toBe(HEROES.length);
    const ids = new Set<string>();
    for (const card of GACHA_CARDS) {
      expect(ids.has(card.id)).toBe(false);
      ids.add(card.id);
      expect(["Common", "Rare", "Epic", "Legendary"]).toContain(card.rarity);
      expect(findHero(card.heroId), `card ${card.id} has unknown heroId`).toBeDefined();
    }
  });
});

// ---------- lib: lookups ----------

describe("heroLookup / counterLookup", () => {
  it("heroLookup finds heroes and returns undefined for unknown", () => {
    expect(heroLookup("Khufra")?.role).toBe("Tank");
    expect(heroLookup("nope")).toBeUndefined();
  });

  it("counterLookup returns known counters for a dash assassin", () => {
    const result = counterLookup("Fanny");
    expect(result).toBeDefined();
    expect(result!.counteredBy.map((h) => h.name)).toContain("Khufra");
    expect(result!.counters.map((h) => h.name)).toContain("Layla");
  });

  it("counterLookup returns undefined for unknown heroes", () => {
    expect(counterLookup("NotAHero")).toBeUndefined();
  });
});

// ---------- lib: register + verify flow ----------

describe("register + verify flow", () => {
  it("registers a profile unverified, then verifies with the correct code", () => {
    registerProfile(db, GUILD, USER, "12345678", "TestPlayer");
    expect(getProfile(db, GUILD, USER)?.verified).toBe(false);

    const { code, expiresAt } = startVerification(db, GUILD, USER);
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt).toBeGreaterThan(Date.now());

    const result = confirmVerification(db, GUILD, USER, code, Date.now());
    expect(result.ok).toBe(true);
    expect(getProfile(db, GUILD, USER)?.verified).toBe(true);
  });

  it("rejects a wrong code", () => {
    registerProfile(db, GUILD, USER, "12345678", "TestPlayer");
    const { code } = startVerification(db, GUILD, USER);
    const wrong = code === "000000" ? "000001" : "000000";
    expect(confirmVerification(db, GUILD, USER, wrong, Date.now()).ok).toBe(false);
    expect(getProfile(db, GUILD, USER)?.verified).toBe(false);
  });

  it("rejects an expired code", () => {
    registerProfile(db, GUILD, USER, "12345678", "TestPlayer");
    const { code, expiresAt } = startVerification(db, GUILD, USER);
    const result = confirmVerification(db, GUILD, USER, code, expiresAt + 1000);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/expired/i);
  });

  it("rejects verification with no profile and with no code issued", () => {
    expect(confirmVerification(db, GUILD, USER, "123456", Date.now()).ok).toBe(false);
    registerProfile(db, GUILD, USER, "12345678", "TestPlayer");
    expect(confirmVerification(db, GUILD, USER, "123456", Date.now()).ok).toBe(false);
  });

  it("a used code cannot be reused", () => {
    registerProfile(db, GUILD, USER, "12345678", "TestPlayer");
    const { code } = startVerification(db, GUILD, USER);
    expect(confirmVerification(db, GUILD, USER, code, Date.now()).ok).toBe(true);
    expect(confirmVerification(db, GUILD, USER, code, Date.now()).ok).toBe(false);
  });

  it("re-registering resets verification but keeps rank", () => {
    registerProfile(db, GUILD, USER, "12345678", "TestPlayer");
    setRank(db, GUILD, USER, "Epic");
    const { code } = startVerification(db, GUILD, USER);
    confirmVerification(db, GUILD, USER, code, Date.now());
    expect(getProfile(db, GUILD, USER)?.verified).toBe(true);

    registerProfile(db, GUILD, USER, "87654321", "TestPlayer2");
    const profile = getProfile(db, GUILD, USER);
    expect(profile?.verified).toBe(false);
    expect(profile?.rankName).toBe("Epic");
    expect(profile?.mlbbId).toBe("87654321");
  });

  it("startVerification throws without a profile", () => {
    expect(() => startVerification(db, GUILD, USER)).toThrow(/No MLBB profile/);
  });
});

describe("profile read and rank validation", () => {
  it("getProfile returns undefined when no profile exists", () => {
    expect(getProfile(db, GUILD, USER)).toBeUndefined();
  });

  it("accepts every valid rank (case-insensitive) and stores the canonical form", () => {
    registerProfile(db, GUILD, USER, "12345678", "TestPlayer");
    for (const rank of MLBB_RANKS) {
      expect(setRank(db, GUILD, USER, rank.toLowerCase()).ok).toBe(true);
      expect(getProfile(db, GUILD, USER)?.rankName).toBe(rank);
    }
  });

  it("rejects invalid ranks", () => {
    registerProfile(db, GUILD, USER, "12345678", "TestPlayer");
    for (const bad of ["Diamond", "Challenger", "Platinum", ""]) {
      const result = setRank(db, GUILD, USER, bad);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Unknown rank/);
    }
    expect(getProfile(db, GUILD, USER)?.rankName).toBeNull();
  });

  it("setRank fails without a profile", () => {
    expect(setRank(db, GUILD, USER, "Mythic").ok).toBe(false);
  });

  it("getTopHeroCards is empty with no cards and lists collected cards", () => {
    registerProfile(db, GUILD, USER, "12345678", "TestPlayer");
    expect(getTopHeroCards(db, GUILD, USER)).toEqual([]);
    db.prepare(
      "INSERT INTO gacha_cards (guild_id, user_id, card_id, count) VALUES (?, ?, ?, ?)",
    ).run(GUILD, USER, "card-miya", 3);
    db.prepare(
      "INSERT INTO gacha_cards (guild_id, user_id, card_id, count) VALUES (?, ?, ?, ?)",
    ).run(GUILD, USER, "card-lancelot", 1);
    const top = getTopHeroCards(db, GUILD, USER);
    expect(top.map((t) => t.card.name)).toEqual(["Miya", "Lancelot"]);
    expect(top[0]?.count).toBe(3);
  });
});

// ---------- command integration (FakeChatInput) ----------

describe("/hero", () => {
  it("replies with the hero embed, snapshot label and dashes for rates", async () => {
    const ix = await run("hero", { name: "Miya" });
    const text = ix.allText();
    expect(text).toContain("Miya");
    expect(text).toContain("Marksman");
    expect(text).toContain("—");
    // Footer text is not part of FakeChatInput.allText(); read it off the
    // embed payload directly.
    const payload = ix.firstReplyPayload() as {
      embeds?: Array<{ footer?: { text?: string } }>;
    };
    expect(payload.embeds?.[0]?.footer?.text).toContain(
      "Static snapshot — may be stale after patches, not live data.",
    );
  });

  it("rejects an unknown hero", async () => {
    const ix = await run("hero", { name: "NotAHero" });
    expect(ix.allText()).toMatch(/Unknown hero/i);
  });
});

describe("/counter", () => {
  it("replies with who counters the hero and who they counter", async () => {
    const ix = await run("counter", { hero: "Fanny" });
    const text = ix.allText();
    expect(text).toContain("Fanny");
    expect(text).toContain("Khufra");
    expect(text).toContain("Layla");
  });

  it("rejects an unknown hero", async () => {
    const ix = await run("counter", { hero: "NotAHero" });
    expect(ix.allText()).toMatch(/Unknown hero/i);
  });
});

describe("/register-mlbb", () => {
  it("stores an unverified profile and issues a 6-digit code", async () => {
    const ix = await run("register-mlbb", { "mlbb-id": "12345678", ign: "TestPlayer" });
    const text = ix.allText();
    expect(text).toContain("TestPlayer");
    expect(text).toContain("12345678");
    expect(text).toMatch(/\d{6}/);
    expect(text).toMatch(/not.*Moonton|local code check/i);
    const profile = getProfile(db, GUILD, USER);
    expect(profile?.verified).toBe(false);
    expect(profile?.mlbbId).toBe("12345678");
  });

  it("rejects missing id or ign", async () => {
    const ix = await run("register-mlbb", { "mlbb-id": "", ign: "TestPlayer" });
    expect(ix.allText()).toMatch(/required/i);
    expect(getProfile(db, GUILD, USER)).toBeUndefined();
  });
});

describe("/verify-mlbb", () => {
  it("verifies with the code issued by /register-mlbb", async () => {
    await run("register-mlbb", { "mlbb-id": "12345678", ign: "TestPlayer" });
    const ix = await run("verify-mlbb", { code: storedCode() });
    expect(ix.allText()).toMatch(/Verified/i);
    expect(getProfile(db, GUILD, USER)?.verified).toBe(true);
  });

  it("rejects a wrong code", async () => {
    await run("register-mlbb", { "mlbb-id": "12345678", ign: "TestPlayer" });
    const code = storedCode();
    const wrong = code === "000000" ? "000001" : "000000";
    const ix = await run("verify-mlbb", { code: wrong });
    expect(ix.allText()).toMatch(/Incorrect/i);
    expect(getProfile(db, GUILD, USER)?.verified).toBe(false);
  });

  it("rejects verification with no profile", async () => {
    const ix = await run("verify-mlbb", { code: "123456" });
    expect(ix.allText()).toMatch(/No MLBB profile/i);
  });
});

describe("/mlbbprofile", () => {
  it("shows IGN, MLBB ID, not-verified status, rank, and top gacha heroes", async () => {
    registerProfile(db, GUILD, USER, "12345678", "TestPlayer");
    setRank(db, GUILD, USER, "Epic");
    db.prepare(
      "INSERT INTO gacha_cards (guild_id, user_id, card_id, count) VALUES (?, ?, ?, ?)",
    ).run(GUILD, USER, "card-miya", 2);
    const ix = await run("mlbbprofile", {});
    const text = ix.allText();
    expect(text).toContain("TestPlayer");
    expect(text).toContain("12345678");
    expect(text).toContain("Not verified");
    expect(text).toContain("Epic");
    expect(text).toContain("Miya");
    // Win rate is never invented: no win-rate field appears.
    expect(text).not.toMatch(/win rate/i);
  });

  it("shows a verified badge after verification", async () => {
    registerProfile(db, GUILD, USER, "12345678", "TestPlayer");
    const { code } = startVerification(db, GUILD, USER);
    confirmVerification(db, GUILD, USER, code, Date.now());
    const ix = await run("mlbbprofile", {});
    expect(ix.allText()).toContain("Verified");
  });

  it("errors when the user has no profile", async () => {
    const ix = await run("mlbbprofile", {});
    expect(ix.allText()).toMatch(/no MLBB profile/i);
  });
});

describe("/rankrole", () => {
  it("assigns the role matching the registered rank when it exists", async () => {
    registerProfile(db, GUILD, USER, "12345678", "TestPlayer");
    setRank(db, GUILD, USER, "Epic");
    const fake = fakeGuildWithRoles(["Epic", "Mythic"]);
    const ix = await run(
      "rankrole",
      {},
      { permissions: ["ManageRoles"], attach: { guild: fake.guild, member: fake.member } },
    );
    expect(fake.assigned).toHaveLength(1);
    expect((fake.assigned[0] as { name: string }).name).toBe("Epic");
    expect(ix.allText()).toMatch(/Rank role assigned/i);
  });

  it("tells the user to create the role when it does not exist", async () => {
    registerProfile(db, GUILD, USER, "12345678", "TestPlayer");
    setRank(db, GUILD, USER, "Mythic");
    const fake = fakeGuildWithRoles(["Epic"]);
    const ix = await run(
      "rankrole",
      {},
      { permissions: ["ManageRoles"], attach: { guild: fake.guild, member: fake.member } },
    );
    expect(fake.assigned).toHaveLength(0);
    expect(ix.allText()).toMatch(/create a role named exactly "Mythic"/i);
  });

  it("requires ManageRoles permission", async () => {
    registerProfile(db, GUILD, USER, "12345678", "TestPlayer");
    setRank(db, GUILD, USER, "Epic");
    const ix = await run("rankrole", {}, { permissions: [] });
    expect(ix.allText()).toMatch(/Manage Roles/i);
  });

  it("requires a registered profile", async () => {
    const ix = await run("rankrole", {}, { permissions: ["ManageRoles"] });
    expect(ix.allText()).toMatch(/no MLBB profile/i);
  });

  it("requires a rank on the profile", async () => {
    registerProfile(db, GUILD, USER, "12345678", "TestPlayer");
    const ix = await run("rankrole", {}, { permissions: ["ManageRoles"] });
    expect(ix.allText()).toMatch(/no rank set/i);
  });
});
