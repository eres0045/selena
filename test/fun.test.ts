import { describe, expect, it, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";

// Vite 5 (vitest 2.1) does not recognise `node:sqlite` as a builtin and
// resolves it to the bare specifier `sqlite`, which fails to load. Redirect
// the import to Node's real builtin through the CJS loader instead. (This is
// a test-runner workaround only — src code still imports `node:sqlite`.)
vi.mock("node:sqlite", () => {
  const req = createRequire(import.meta.url);
  return req("node:sqlite");
});

import type { ChatInputCommandInteraction } from "discord.js";
import { FakeChatInput } from "../src/lib/testkit.js";
import { type SelenaDb } from "../src/lib/db.js";
import { getTestDb } from "./testDb.js";
import { mulberry32 } from "../src/lib/rng.js";
import {
  EIGHTBALL_ANSWERS,
  JOKES,
  MEME_EFFECTS,
  eightBall,
  generateMeme,
  getProfileData,
  memeDescription,
  rateThing,
  shipCompatibility,
  uwuify,
} from "../src/lib/fun.js";
import { commands } from "../src/commands/fun.js";

let db: SelenaDb;

beforeEach(async () => {
  db = getTestDb();
});

/** Extract content + embed title/description/fields from a reply payload (EmbedBuilder-aware). */
export function payloadText(payload: unknown): string {
  const p = payload as { content?: string; embeds?: Array<{ toJSON?: () => unknown }> };
  const parts: string[] = [];
  if (typeof p?.content === "string") parts.push(p.content);
  for (const e of p?.embeds ?? []) {
    const j = (typeof e?.toJSON === "function" ? e.toJSON() : e) as {
      title?: string;
      description?: string;
      fields?: Array<{ name: string; value: string }>;
    };
    if (j?.title) parts.push(j.title);
    if (j?.description) parts.push(j.description);
    for (const f of j?.fields ?? []) parts.push(`${f.name}: ${f.value}`);
  }
  return parts.join("\n");
}

async function run(
  name: string,
  options: Record<string, unknown> = {},
  userId = "user-1",
  username = "tester",
): Promise<FakeChatInput> {
  const cmd = commands.find((c) => c.data.name === name);
  if (!cmd) throw new Error(`command ${name} not found`);
  const fake = new FakeChatInput({ commandName: name, options, userId, username });
  await cmd.execute(fake as unknown as ChatInputCommandInteraction, { db, guildId: "guild-1" });
  return fake;
}

function replyText(fake: FakeChatInput): string {
  return payloadText(fake.firstReplyPayload());
}

// ---------------------------------------------------------------------------
// Lib: 8-ball
// ---------------------------------------------------------------------------

describe("eightBall", () => {
  it("returns an answer from the classic list", async () => {
    expect(EIGHTBALL_ANSWERS).toContain(eightBall());
  });

  it("is deterministic with a seeded rand", async () => {
    const a = eightBall(mulberry32(42));
    const b = eightBall(mulberry32(42));
    expect(a).toBe(b);
    expect(EIGHTBALL_ANSWERS).toContain(a);
  });
});

// ---------------------------------------------------------------------------
// Lib: ship / rate determinism
// ---------------------------------------------------------------------------

describe("shipCompatibility", () => {
  it("is deterministic for the same pair", async () => {
    expect(shipCompatibility("u1", "u2")).toEqual(shipCompatibility("u1", "u2"));
  });

  it("is symmetric regardless of order", async () => {
    expect(shipCompatibility("u1", "u2").percent).toBe(shipCompatibility("u2", "u1").percent);
  });

  it("varies across different pairs", async () => {
    const percents = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((x, i) => shipCompatibility(x, `other-${i}`).percent),
    );
    expect(percents.size).toBeGreaterThan(3);
  });

  it("stays within 0-100 with a label", async () => {
    const { percent, label } = shipCompatibility("u1", "u2");
    expect(percent).toBeGreaterThanOrEqual(0);
    expect(percent).toBeLessThanOrEqual(100);
    expect(label.length).toBeGreaterThan(0);
  });
});

describe("rateThing", () => {
  it("is deterministic per (thing, user)", async () => {
    expect(rateThing("Selena", "user-1")).toBe(rateThing("Selena", "user-1"));
  });

  it("is case-insensitive for the thing", async () => {
    expect(rateThing("Selena", "user-1")).toBe(rateThing("selena", "user-1"));
  });

  it("varies across different things and users", async () => {
    const values = new Set(
      ["selena", "pizza", "mondays", "ranked", "turtle", "coffee"].map((t) => rateThing(t, "user-1")),
    );
    expect(values.size).toBeGreaterThan(3);
    expect(rateThing("selena", "user-1")).not.toBe(rateThing("selena", "user-2"));
  });
});

// ---------------------------------------------------------------------------
// Lib: uwu-ify
// ---------------------------------------------------------------------------

describe("uwuify", () => {
  it("turns r/l into w", async () => {
    expect(uwuify("Hello")).toMatch(/^Hewwo/);
    expect(uwuify("Really cool")).toMatch(/^Weawwy coow/);
  });

  it('turns "ove" into "uv"', async () => {
    expect(uwuify("love")).toMatch(/^wuv/);
  });

  it("adds a cute suffix", async () => {
    const out = uwuify("hello");
    expect([" uwu", " owo", " :3", " nya~", " uwu~"].some((s) => out.endsWith(s))).toBe(true);
  });

  it("is deterministic", async () => {
    expect(uwuify("hello there")).toBe(uwuify("hello there"));
  });
});

// ---------------------------------------------------------------------------
// Lib: meme
// ---------------------------------------------------------------------------

describe("generateMeme / memeDescription", () => {
  it("returns a template, caption slots and a known effect", async () => {
    const meme = generateMeme(mulberry32(7));
    expect(meme.template.name.length).toBeGreaterThan(0);
    expect(meme.topText.length).toBeGreaterThan(0);
    expect(meme.bottomText.length).toBeGreaterThan(0);
    expect(Object.keys(MEME_EFFECTS)).toContain(meme.effect);
  });

  it("honours explicit top/bottom/effect overrides", async () => {
    const meme = generateMeme(mulberry32(7), { topText: "TOP", bottomText: "BOTTOM", effect: "wasted" });
    expect(meme.topText).toBe("TOP");
    expect(meme.bottomText).toBe("BOTTOM");
    expect(meme.effect).toBe("wasted");
  });

  it("says honestly that image rendering is unavailable", async () => {
    const text = memeDescription(generateMeme(mulberry32(7)));
    expect(text).toMatch(/image rendering is unavailable/i);
    expect(text).not.toMatch(/https?:\/\//);
  });
});

// ---------------------------------------------------------------------------
// Lib: profile reads the DB
// ---------------------------------------------------------------------------

describe("getProfileData", () => {
  it("returns zeros for an unknown user", async () => {
    const p = await getProfileData(db, "guild-1", "ghost");
    expect(p.points).toBe(0);
    expect(p.xp).toBe(0);
    expect(p.level).toBe(0);
  });

  it("reads points/xp/level and server rank", async () => {
    await db.prepare("INSERT INTO users (guild_id, user_id, points, xp, level) VALUES (?, ?, ?, ?, ?)").run(
      "guild-1",
      "user-1",
      150,
      40,
      2,
    );
    await db.prepare("INSERT INTO users (guild_id, user_id, points, xp, level) VALUES (?, ?, ?, ?, ?)").run(
      "guild-1",
      "user-2",
      300,
      0,
      0,
    );

    const p = await getProfileData(db, "guild-1", "user-1");
    expect(p.points).toBe(150);
    expect(p.xp).toBe(40);
    expect(p.level).toBe(2);
    expect(p.rank).toBe(2); // user-2 has more points
  });
});

// ---------------------------------------------------------------------------
// Commands: mocked-client integration, happy + error paths
// ---------------------------------------------------------------------------

describe("/8ball command", () => {
  it("replies with the question and an answer from the list", async () => {
    const fake = await run("8ball", { question: "Will we win tonight?" });
    const text = replyText(fake);
    expect(text).toContain("Will we win tonight?");
    expect(EIGHTBALL_ANSWERS.some((a) => text.includes(a))).toBe(true);
  });

  it("errors when no question is given", async () => {
    const fake = await run("8ball", {});
    expect(replyText(fake)).toMatch(/Something went wrong|question/i);
  });
});

describe("/meme command", () => {
  it("replies with an embed payload describing a meme", async () => {
    const fake = await run("meme", {});
    const text = replyText(fake);
    expect(text).toMatch(/Template:/);
    expect(text).toMatch(/image rendering is unavailable/i);
  });

  it("accepts custom top/bottom text and a named effect", async () => {
    const fake = await run("meme", { top: "TOP", bottom: "BOTTOM", effect: "jail" });
    const text = replyText(fake);
    expect(text).toContain("TOP");
    expect(text).toContain("BOTTOM");
    expect(text).toMatch(/jail bars/i);
  });

  it("errors on an unknown effect", async () => {
    const fake = await run("meme", { effect: "hologram" });
    expect(replyText(fake)).toMatch(/Unknown effect/i);
  });
});

describe("/ship command", () => {
  it("replies with a deterministic percentage", async () => {
    const opts = { user1: { id: "u1", username: "Alice" }, user2: { id: "u2", username: "Bob" } };
    const a = await run("ship", opts);
    const b = await run("ship", opts);
    expect(replyText(a)).toBe(replyText(b));
    expect(replyText(a)).toMatch(/%/);
  });

  it("errors when a user is missing", async () => {
    const fake = await run("ship", { user1: { id: "u1", username: "Alice" } });
    expect(replyText(fake)).toMatch(/Something went wrong|Pick two/i);
  });
});

describe("/rate command", () => {
  it("replies with a 0-100 rating", async () => {
    const fake = await run("rate", { thing: "Selena" });
    expect(replyText(fake)).toMatch(/Selena.*\d+\/100/);
  });

  it("errors when nothing is given to rate", async () => {
    const fake = await run("rate", {});
    expect(replyText(fake)).toMatch(/Something went wrong|what to rate/i);
  });
});

describe("/joke, /roast, /compliment, /wouldyourather, /truthordare commands", () => {
  it("/joke replies with a joke from the list", async () => {
    const fake = await run("joke", {});
    expect(JOKES.some((j) => replyText(fake).includes(j))).toBe(true);
  });

  it("/roast replies with a friendly roast", async () => {
    const fake = await run("roast", { user: { id: "u2", username: "Bob" } });
    expect(replyText(fake)).toContain("<@u2>");
    expect(replyText(fake).length).toBeGreaterThan(10);
  });

  it("/compliment replies with a compliment", async () => {
    const fake = await run("compliment", {});
    expect(replyText(fake)).toContain("<@user-1>");
  });

  it("/wouldyourather replies with both options", async () => {
    const fake = await run("wouldyourather", {});
    const text = replyText(fake);
    expect(text).toMatch(/\*\*A:\*\*/);
    expect(text).toMatch(/\*\*B:\*\*/);
  });

  it("/truthordare replies with a truth or a dare", async () => {
    const fake = await run("truthordare", { kind: "truth" });
    expect(replyText(fake)).toMatch(/Truth/);
    const dare = await run("truthordare", { kind: "dare" });
    expect(replyText(dare)).toMatch(/Dare/);
  });

  it("/truthordare errors on an invalid kind", async () => {
    const fake = await run("truthordare", { kind: "spicy" });
    expect(replyText(fake)).toMatch(/Something went wrong|truth.*dare.*random/i);
  });
});

describe("/uwu command", () => {
  it("replies with uwu-ified text", async () => {
    const fake = await run("uwu", { text: "Hello, love" });
    expect(replyText(fake)).toMatch(/Hewwo, wuv/);
  });

  it("errors when no text is given", async () => {
    const fake = await run("uwu", {});
    expect(replyText(fake)).toMatch(/Something went wrong|text/i);
  });
});

describe("/profile command", () => {
  it("shows points, XP, level and rank from the DB", async () => {
    await db.prepare("INSERT INTO users (guild_id, user_id, points, xp, level) VALUES (?, ?, ?, ?, ?)").run(
      "guild-1",
      "user-1",
      250,
      120,
      3,
    );
    const fake = await run("profile", {});
    const text = replyText(fake);
    expect(text).toContain("250");
    expect(text).toContain("120");
    expect(text).toMatch(/Level: 3/);
    expect(text).toMatch(/Server Rank: #1/);
  });

  it("shows a profile for another user, defaulting to zeros when unknown", async () => {
    const fake = await run("profile", { user: { id: "u9", username: "Ghost" } });
    const text = replyText(fake);
    expect(text).toContain("Ghost");
    expect(text).toMatch(/Points: 0/);
  });
});
