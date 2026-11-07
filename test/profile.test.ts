import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { AttachmentBuilder } from "discord.js";
import { parseGIF, decompressFrames } from "gifuct-js";
import type { SelenaDb } from "../src/lib/db.js";
import { getTestDb } from "./testDb.js";
import { addPoints, getBalance } from "../src/lib/economy.js";
import type { Command, CommandContext, CommandInvocation, CommandOptions, ReplyPayload } from "../src/lib/command.js";
import type { generateShopStock as GenerateShopStock } from "../src/lib/market.js";

// ---------------------------------------------------------------------------
// The real manifest (assets/profile-bgs/manifest.json, Worker A) is not
// on disk yet, so tests point the loader at a fixture manifest with the
// SELENA_PROFILE_BGS_MANIFEST env var. Modules that read the manifest
// (profileBgs, profile, commands/*, commands/index, router) are loaded
// with DYNAMIC imports after vi.resetModules() so they pick the fixture
// up; static imports here are only of modules that never touch it.
// Fixture: default + 10 static (10k–20k) + 20 animated GIFs (25k–50k).
// ---------------------------------------------------------------------------

const FIXTURE_MANIFEST = fileURLToPath(new URL("./fixtures/profile-bgs/manifest.json", import.meta.url));
const GUILD = "guild-1";
const GUILD2 = "guild-2";
const USER = "user-1";
const NOW = Date.parse("2026-11-07T12:00:00Z");

let db: SelenaDb;
let profileLib: typeof import("../src/lib/profile.js");
let profileBgs: typeof import("../src/lib/profileBgs.js");
let profileCommands: Command[];
let marketCommands: Command[];
let marketButtonHandlers: Record<string, (...args: never[]) => Promise<void>>;
let allCommands: Command[];
let handlePrefixMessage: (
  msg: unknown,
  ctx: CommandContext,
) => Promise<boolean>;
let generateShopStock: typeof GenerateShopStock;

beforeEach(async () => {
  db = getTestDb();
  process.env.SELENA_PROFILE_BGS_MANIFEST = FIXTURE_MANIFEST;
  vi.resetModules();
  profileLib = await import("../src/lib/profile.js");
  profileBgs = await import("../src/lib/profileBgs.js");
  profileCommands = (await import("../src/commands/profile.js")).commands;
  const marketModule = await import("../src/commands/market.js");
  marketCommands = marketModule.commands;
  marketButtonHandlers = marketModule.buttonHandlers;
  allCommands = (await import("../src/commands/index.js")).allCommands;
  handlePrefixMessage = (await import("../src/lib/router.js")).handlePrefixMessage;
  generateShopStock = (await import("../src/lib/market.js")).generateShopStock;
});

class FakeInv implements CommandInvocation {
  user: { id: string; username: string; displayAvatarURL?: () => string };
  guildId = GUILD;
  channelId = "chan-1";
  options: CommandOptions;
  replies: ReplyPayload[] = [];

  constructor(userId: string, args: Record<string, string | number | null> = {}, avatarUrl?: string) {
    this.user = { id: userId, username: userId };
    if (avatarUrl !== undefined) {
      // Arrow closure (no `this` use): the `this`-dependent behaviour
      // is covered by the DiscordLikeUser tests below.
      this.user.displayAvatarURL = () => avatarUrl;
    }
    this.options = {
      getString: (n: string) => (typeof args[n] === "string" ? (args[n] as string) : null),
      getInteger: (n: string) => (typeof args[n] === "number" ? (args[n] as number) : null),
      getNumber: (n: string) => (typeof args[n] === "number" ? (args[n] as number) : null),
      getBoolean: () => null,
      getUser: () => null,
      getRole: () => null,
    };
  }

  async reply(p: ReplyPayload): Promise<void> {
    this.replies.push(p);
  }

  async editReply(p: ReplyPayload): Promise<{ id: string }> {
    this.replies.push(p);
    return { id: "m1" };
  }

  async deferReply(): Promise<void> {}

  async followUp(p: ReplyPayload): Promise<void> {
    this.replies.push(p);
  }

  text(): string {
    const parts: string[] = [];
    for (const r of this.replies) {
      if (typeof r.content === "string") parts.push(r.content);
      for (const e of (r.embeds as Array<{ title?: string; description?: string }> | undefined) ?? []) {
        if (e.title) parts.push(e.title);
        if (e.description) parts.push(e.description);
      }
    }
    return parts.join("\n");
  }
}

const ctxFor = (testDb: SelenaDb): CommandContext => ({ db: testDb, guildId: GUILD });

async function runCmd(
  cmds: Command[],
  name: string,
  userId: string,
  args: Record<string, string | number | null>,
  avatarUrl?: string,
): Promise<FakeInv> {
  const cmd = cmds.find((c) => c.name === name)!;
  const inv = new FakeInv(userId, args, avatarUrl);
  await cmd.execute(inv, ctxFor(db));
  return inv;
}

async function giveGold(userId: string, amount: number, guildId = GUILD): Promise<void> {
  await addPoints(db, guildId, userId, amount, "test");
}

async function setXp(userId: string, guildId: string, xp: number): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO users (guild_id, user_id) VALUES (?, ?)").run(guildId, userId);
  await db.prepare("UPDATE users SET xp = ? WHERE guild_id = ? AND user_id = ?").run(xp, guildId, userId);
}

// Minimal FakePrefixMessage (same shape as test/prefix.test.ts's) for
// the router-level end-to-end checks.
class FakePrefixMessage {
  content: string;
  author: { id: string; username: string; bot?: boolean };
  webhookId: string | null = null;
  guildId: string | null = GUILD;
  channelId = "chan-1";
  guild: unknown = null;
  member: null = null;
  mentions = { users: new Map<string, { id: string; username: string }>() };
  replies: Record<string, unknown>[] = [];
  channelSends: Record<string, unknown>[] = [];
  sentEdits: Record<string, unknown>[] = [];
  channel: { send: (payload: Record<string, unknown>) => Promise<{ id: string; edit: (p: Record<string, unknown>) => Promise<unknown> }> };

  constructor(content: string, opts: { userId?: string; username?: string } = {}) {
    this.content = content;
    this.author = { id: opts.userId ?? USER, username: opts.username ?? "tester", bot: false };
    this.channel = {
      send: async (payload) => {
        this.channelSends.push(payload);
        return { id: "msg-2", edit: async (p: Record<string, unknown>) => { this.sentEdits.push(p); } };
      },
    };
  }

  async reply(payload: Record<string, unknown>): Promise<{ id: string; edit: (p: Record<string, unknown>) => Promise<unknown> }> {
    this.replies.push(payload);
    return { id: "msg-1", edit: async (p: Record<string, unknown>) => { this.sentEdits.push(p); } };
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

// ---------------------------------------------------------------------------
// Manifest loading (profileBgs)
// ---------------------------------------------------------------------------

describe("profileBgs (fixture manifest: 10 static + 20 animated)", () => {
  it("loads 30 buyable backgrounds, 10 static + 20 animated", () => {
    expect(profileBgs.PROFILE_BGS.length).toBe(30);
    expect(profileBgs.listBackgrounds().length).toBe(30);
    expect(profileBgs.PROFILE_BGS.filter((b) => b.type === "static").length).toBe(10);
    expect(profileBgs.PROFILE_BGS.filter((b) => b.type === "animated").length).toBe(20);
  });

  it("static prices sit 10k–20k, GIF prices 25k–50k (from the manifest, not hardcoded)", () => {
    for (const b of profileBgs.PROFILE_BGS) {
      if (b.type === "static") {
        expect(b.price).toBeGreaterThanOrEqual(10000);
        expect(b.price).toBeLessThanOrEqual(20000);
      } else {
        expect(b.price).toBeGreaterThanOrEqual(25000);
        expect(b.price).toBeLessThanOrEqual(50000);
      }
    }
  });

  it("default entry exists, is free, and is not in the buyable list", () => {
    expect(profileBgs.DEFAULT_BG_ID).toBe("default");
    const def = profileBgs.getBackground("default");
    expect(def?.price).toBe(0);
    expect(def?.type).toBe("static");
    expect(profileBgs.PROFILE_BGS.some((b) => b.id === "default")).toBe(false);
  });

  it("getBackground resolves by id, backgroundPath resolves to the file", () => {
    expect(profileBgs.getBackground("starfall")?.name).toBe("Starfall");
    expect(profileBgs.getBackground("starfall")?.type).toBe("animated");
    expect(profileBgs.getBackground("meadow-dawn")?.type).toBe("static");
    expect(profileBgs.getBackground("nope")).toBeUndefined();
    expect(profileBgs.backgroundPath("starfall")).toMatch(/starfall\.gif$/);
    expect(profileBgs.backgroundPath("nope")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// About Me
// ---------------------------------------------------------------------------

describe("about", () => {
  it("defaults to empty, sets and reads back", async () => {
    expect(await profileLib.getUserProfile(db, USER)).toEqual({ about: "", equippedBg: "default" });
    const res = await profileLib.setAbout(db, USER, "hello world");
    expect(res.ok).toBe(true);
    expect(res.about).toBe("hello world");
    expect((await profileLib.getUserProfile(db, USER)).about).toBe("hello world");
  });

  it("refuses text over 100 chars and leaves the stored value alone", async () => {
    await profileLib.setAbout(db, USER, "short");
    const res = await profileLib.setAbout(db, USER, "x".repeat(101));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("100");
    expect((await profileLib.getUserProfile(db, USER)).about).toBe("short");
  });

  it("accepts exactly 100 chars", async () => {
    expect((await profileLib.setAbout(db, USER, "x".repeat(100))).ok).toBe(true);
  });

  it("strips @everyone/@here mentions and discord invite links", async () => {
    const res = await profileLib.setAbout(db, USER, "hey @everyone and @here join discord.gg/abc123 now");
    expect(res.ok).toBe(true);
    expect(res.about).not.toContain("@everyone");
    expect(res.about).not.toContain("@here");
    expect(res.about).not.toContain("discord.gg/abc123");
    expect((await profileLib.getUserProfile(db, USER)).about).toBe(res.about);
  });

  it("strips discord.com/invite links too", async () => {
    const res = await profileLib.setAbout(db, USER, "see https://discord.com/invite/xyz");
    expect(res.ok).toBe(true);
    expect(res.about).not.toContain("discord.com/invite/xyz");
  });
});

// ---------------------------------------------------------------------------
// Buy / equip backgrounds
// ---------------------------------------------------------------------------

describe("buyBackground / equipBackground", () => {
  it("refuses an unknown background", async () => {
    const res = await profileLib.buyBackground(db, GUILD, USER, "nope", NOW);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("don't know");
  });

  it("refuses to buy the free default", async () => {
    const res = await profileLib.buyBackground(db, GUILD, USER, "default", NOW);
    expect(res.ok).toBe(false);
  });

  it("refuses when the user can't afford it, and moves no gold", async () => {
    await giveGold(USER, 5000);
    const res = await profileLib.buyBackground(db, GUILD, USER, "meadow-dawn", NOW);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not enough gold");
    expect((await getBalance(db, GUILD, USER)).points).toBe(5000);
    expect(await profileLib.getOwnedBackgrounds(db, USER)).toEqual([]);
  });

  it("buys a static bg: exact gold math + ownership row written", async () => {
    await giveGold(USER, 50000);
    const res = await profileLib.buyBackground(db, GUILD, USER, "meadow-dawn", NOW);
    expect(res.ok).toBe(true);
    expect(res.bgName).toBe("Meadow Dawn");
    expect(res.price).toBe(10000);
    expect(res.remainingGold).toBe(40000);
    expect((await getBalance(db, GUILD, USER)).points).toBe(40000);
    expect(await profileLib.getOwnedBackgrounds(db, USER)).toEqual(["meadow-dawn"]);
  });

  it("buys an animated GIF bg: exact gold math", async () => {
    await giveGold(USER, 60000);
    const res = await profileLib.buyBackground(db, GUILD, USER, "starfall", NOW);
    expect(res.ok).toBe(true);
    expect(res.bgName).toBe("Starfall");
    expect(res.price).toBe(25000);
    expect(res.remainingGold).toBe(35000);
    expect((await getBalance(db, GUILD, USER)).points).toBe(35000);
  });

  it("refuses a second buy of the same background, gold untouched", async () => {
    await giveGold(USER, 50000);
    expect((await profileLib.buyBackground(db, GUILD, USER, "meadow-dawn", NOW)).ok).toBe(true);
    const again = await profileLib.buyBackground(db, GUILD, USER, "meadow-dawn", NOW);
    expect(again.ok).toBe(false);
    expect(again.error).toContain("already own");
    expect((await getBalance(db, GUILD, USER)).points).toBe(40000);
  });

  it("equip refuses a background the user doesn't own", async () => {
    const res = await profileLib.equipBackground(db, USER, "starfall");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("don't own");
    expect((await profileLib.getUserProfile(db, USER)).equippedBg).toBe("default");
  });

  it("equip succeeds once owned, for both static and animated", async () => {
    await giveGold(USER, 100000);
    await profileLib.buyBackground(db, GUILD, USER, "meadow-dawn", NOW);
    await profileLib.buyBackground(db, GUILD, USER, "starfall", NOW);
    expect((await profileLib.equipBackground(db, USER, "meadow-dawn")).ok).toBe(true);
    expect((await profileLib.getUserProfile(db, USER)).equippedBg).toBe("meadow-dawn");
    expect((await profileLib.equipBackground(db, USER, "starfall")).ok).toBe(true);
    expect((await profileLib.getUserProfile(db, USER)).equippedBg).toBe("starfall");
  });

  it("the default background always equips, even with nothing owned", async () => {
    expect((await profileLib.equipBackground(db, USER, "default")).ok).toBe(true);
    expect((await profileLib.getUserProfile(db, USER)).equippedBg).toBe("default");
  });

  it("equip refuses an unknown background", async () => {
    expect((await profileLib.equipBackground(db, USER, "nope")).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Global rank (sums XP across all guilds)
// ---------------------------------------------------------------------------

describe("getGlobalRank", () => {
  it("sums XP across guilds: split XP beats single-guild XP", async () => {
    await setXp("user-a", GUILD, 1000);
    await setXp("user-a", GUILD2, 500); // total 1500
    await setXp("user-b", GUILD, 1200); // total 1200
    await setXp("user-c", GUILD2, 200); // total 200
    expect(await profileLib.getGlobalRank(db, "user-a")).toBe(1);
    expect(await profileLib.getGlobalRank(db, "user-b")).toBe(2);
    expect(await profileLib.getGlobalRank(db, "user-c")).toBe(3);
  });

  it("a user with no rows (total 0) ranks after everyone with XP", async () => {
    await setXp("user-a", GUILD, 100);
    expect(await profileLib.getGlobalRank(db, "ghost")).toBe(2);
  });

  it("tied totals share the same rank (strictly-greater count)", async () => {
    await setXp("user-a", GUILD, 500);
    await setXp("user-b", GUILD2, 500);
    expect(await profileLib.getGlobalRank(db, "user-a")).toBe(1);
    expect(await profileLib.getGlobalRank(db, "user-b")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// fetchAvatarBuffer (avatar bug fix, 2026-11-08)
// ---------------------------------------------------------------------------

/**
 * Faithful stand-in for a real discord.js User: displayAvatarURL reads
 * `this` (via avatarURL), exactly like the real class — detaching the
 * method and calling it unbound throws TypeError, which was the bug.
 * The URL builder mirrors @discordjs/rest dynamicMakeURL: animated
 * hashes force .gif unless forceStatic is set.
 */
class DiscordLikeUser {
  id: string;
  username: string;
  avatar: string | null;
  seenOptions: Array<Record<string, unknown>> = [];

  constructor(id: string, avatar: string | null) {
    this.id = id;
    this.username = id;
    this.avatar = avatar;
  }

  avatarURL(options: { extension?: string; size?: number; forceStatic?: boolean } = {}): string | null {
    if (!this.avatar) return null;
    const ext = this.avatar.startsWith("a_") && !options.forceStatic ? "gif" : (options.extension ?? "webp");
    return `https://cdn.discordapp.com/avatars/${this.id}/${this.avatar}.${ext}?size=${options.size ?? 1024}`;
  }

  displayAvatarURL(options: { extension?: string; size?: number; forceStatic?: boolean } = {}): string {
    this.seenOptions.push(options);
    return this.avatarURL(options) ?? "https://cdn.discordapp.com/embed/avatars/3.png";
  }
}

describe("fetchAvatarBuffer", () => {
  let fetchAvatarBuffer: (inv: CommandInvocation) => Promise<Buffer | null>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    fetchAvatarBuffer = (await import("../src/commands/profile.js")).fetchAvatarBuffer;
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    errorSpy.mockRestore();
  });

  const pngBytes = (text = "fake-png"): Buffer => Buffer.from(text);

  function stubFetchOk(body: Buffer): { calls: string[] } {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        };
      }),
    );
    return { calls };
  }

  it("returns the avatar bytes for a user with a custom avatar (bound call works)", async () => {
    const user = new DiscordLikeUser(USER, "abc123hash");
    const { calls } = stubFetchOk(pngBytes());
    const out = await fetchAvatarBuffer({ user } as unknown as CommandInvocation);
    expect(out?.toString()).toBe("fake-png");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("https://cdn.discordapp.com/avatars/user-1/abc123hash.png?size=256");
  });

  it("forces a still PNG even for animated avatars", async () => {
    const user = new DiscordLikeUser(USER, "a_animatedhash");
    const { calls } = stubFetchOk(pngBytes());
    const out = await fetchAvatarBuffer({ user } as unknown as CommandInvocation);
    expect(out).not.toBeNull();
    expect(user.seenOptions[0]).toEqual({ extension: "png", size: 256, forceStatic: true });
    expect(calls[0]).toContain(".png?size=256");
    expect(calls[0]).not.toContain(".gif");
  });

  it("fetches the Discord default avatar URL for a user with no custom avatar", async () => {
    const user = new DiscordLikeUser(USER, null);
    const { calls } = stubFetchOk(pngBytes("default"));
    const out = await fetchAvatarBuffer({ user } as unknown as CommandInvocation);
    expect(out?.toString()).toBe("default");
    expect(calls).toEqual(["https://cdn.discordapp.com/embed/avatars/3.png"]);
  });

  it("retries once on network failure, then returns null and logs the reason", async () => {
    const user = new DiscordLikeUser(USER, "abc123hash");
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchAvatarBuffer({ user } as unknown as CommandInvocation);
    expect(out).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join(" ")).toContain("attempt 2/2");
  });

  it("retries once on HTTP 500, then returns null", async () => {
    const user = new DiscordLikeUser(USER, "abc123hash");
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchAvatarBuffer({ user } as unknown as CommandInvocation)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers when the first attempt fails and the second succeeds", async () => {
    const user = new DiscordLikeUser(USER, "abc123hash");
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => {
          const b = pngBytes("recovered");
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        },
      });
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchAvatarBuffer({ user } as unknown as CommandInvocation);
    expect(out?.toString()).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null without fetching when the user has no displayAvatarURL", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchAvatarBuffer({ user: { id: USER, username: USER } } as unknown as CommandInvocation);
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Commands (FakeInv harness)
// ---------------------------------------------------------------------------

describe("profile commands", () => {
  it("uwu about sets the line and shows the current one when empty", async () => {
    const set = await runCmd(profileCommands, "about", USER, { text: "catcher of beetles" });
    expect(set.text()).toContain("catcher of beetles");
    const show = await runCmd(profileCommands, "about", USER, { text: null });
    expect(show.text()).toContain("catcher of beetles");
  });

  it("uwu about refuses >100 chars", async () => {
    const inv = await runCmd(profileCommands, "about", USER, { text: "x".repeat(101) });
    expect(inv.text()).toContain("100");
  });

  it("uwu bg equips an owned background, refuses one not owned", async () => {
    const notOwned = await runCmd(profileCommands, "bg", USER, { name: "starfall" });
    expect(notOwned.text()).toContain("don't own");
    await giveGold(USER, 50000);
    await profileLib.buyBackground(db, GUILD, USER, "starfall", NOW);
    const ok = await runCmd(profileCommands, "bg", USER, { name: "starfall" });
    expect(ok.text()).toContain("Equipped **Starfall**");
    expect((await profileLib.getUserProfile(db, USER)).equippedBg).toBe("starfall");
  });

  it("uwu bg matches by name prefix and by id", async () => {
    await giveGold(USER, 50000);
    await profileLib.buyBackground(db, GUILD, USER, "meadow-dawn", NOW);
    const inv = await runCmd(profileCommands, "bg", USER, { name: "meadow" });
    expect(inv.text()).toContain("Equipped **Meadow Dawn**");
  });

  it("uwu profile bg <name> routes to equip", async () => {
    await giveGold(USER, 50000);
    await profileLib.buyBackground(db, GUILD, USER, "starfall", NOW);
    const inv = await runCmd(profileCommands, "profile", USER, { action: "bg", target: "starfall" });
    expect(inv.text()).toContain("Equipped **Starfall**");
  });

  it("uwu profile falls back to the plain-text error path when the background file is missing", async () => {
    // The real default.png now exists on disk (Worker A landed), so the
    // missing-file case is simulated by equipping a fixture background
    // whose file is NOT in assets/profile-bgs/ (meadow-dawn.png):
    // backgroundPath() always resolves into the real assets dir, so the
    // renderer throws "Profile background not found" and the command
    // must reply with the error embed: never crash, never send a
    // broken file.
    await giveGold(USER, 50000);
    await profileLib.buyBackground(db, GUILD, USER, "meadow-dawn", NOW);
    await profileLib.equipBackground(db, USER, "meadow-dawn");
    const { renderProfileCard } = await import("../src/lib/profileCard.js");
    expect(typeof renderProfileCard).toBe("function");
    const inv = await runCmd(profileCommands, "profile", USER, { action: null, target: null });
    expect(inv.replies.length).toBe(1);
    expect(inv.replies[0]!.files).toBeUndefined();
    expect(inv.text()).toContain("That didn't work");
    expect(inv.text()).toContain("profile card");
  });

  it("renders a real 400x250 GIF from the exact input the command assembles", async () => {
    // Proves the command's input shape against the REAL renderer:
    // same values handleProfileShow passes, with a temp PNG standing
    // in for the not-yet-landed background file.
    const sharp = (await import("sharp")).default;
    const { parseGIF } = await import("gifuct-js");
    const { renderProfileCard } = await import("../src/lib/profileCard.js");
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(tmpdir(), "profile-cmd-"));
    const bgPath = path.join(dir, "bg.png");
    await sharp({ create: { width: 800, height: 500, channels: 3, background: { r: 30, g: 60, b: 120 } } })
      .png()
      .toFile(bgPath);
    await setXp(USER, GUILD, 1000);
    await giveGold(USER, 50000);
    await profileLib.setAbout(db, USER, "catcher of beetles");
    await profileLib.buyBackground(db, GUILD, USER, "meadow-dawn", NOW);
    await profileLib.equipBackground(db, USER, "meadow-dawn");
    const { rankCard } = await import("../src/lib/levels.js");
    const { getGems } = await import("../src/lib/market.js");
    const { getUserGuild } = await import("../src/lib/guilds.js");
    const profile = await profileLib.getUserProfile(db, USER);
    const card = rankCard(1000);
    const buf = await renderProfileCard({
      backgroundPath: bgPath,
      avatarBuffer: null,
      displayName: "tester",
      level: card.level,
      rank: await profileLib.getGlobalRank(db, USER),
      xpIntoLevel: card.xpIntoLevel,
      xpForNextLevel: card.xpIntoLevel + card.xpNeeded,
      gold: (await getBalance(db, GUILD, USER)).points,
      gems: await getGems(db, USER),
      about: profile.about,
      monstersCaught: 0,
      guildName: (await getUserGuild(db, USER))?.name ?? null,
    });
    expect(buf.subarray(0, 6).toString("ascii")).toBe("GIF89a");
    const gif = parseGIF(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    expect(gif.lsd.width).toBe(400);
    expect(gif.lsd.height).toBe(250);
    expect(buf.length).toBeGreaterThan(1000);
    await writeFile(path.join(dir, "card.gif"), buf);
  });

  it("uwu profile composites the fetched avatar into the card", async () => {
    // End-to-end: fetch -> render -> attachment, with a solid RED avatar.
    // The avatar box centre (x 45..70, y 45..70) must come out
    // red-dominant — that only happens when the fetched bytes land in
    // the card (the "?" fallback would show the dark background there).
    const sharp = (await import("sharp")).default;
    const redAvatar = await sharp({
      create: { width: 256, height: 256, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => redAvatar.buffer.slice(redAvatar.byteOffset, redAvatar.byteOffset + redAvatar.byteLength),
      })),
    );
    try {
      const inv = await runCmd(
        profileCommands,
        "profile",
        USER,
        { action: null, target: null },
        "https://cdn.discordapp.com/avatars/user-1/abc.png?size=256",
      );
      expect(inv.replies.length).toBe(1);
      const files = inv.replies[0]!.files as AttachmentBuilder[] | undefined;
      expect(files).toHaveLength(1);
      const gif = (files![0] as AttachmentBuilder).attachment as Buffer;
      expect(gif.subarray(0, 6).toString("ascii")).toMatch(/^GIF8[79]a$/);
      const parsed = parseGIF(gif.buffer.slice(gif.byteOffset, gif.byteOffset + gif.byteLength));
      const frame = decompressFrames(parsed, true)[0]!;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = 45; y < 70; y++) {
        for (let x = 45; x < 70; x++) {
          const i = (y * frame.dims.width + x) * 4;
          r += frame.patch[i] as number;
          g += frame.patch[i + 1] as number;
          b += frame.patch[i + 2] as number;
          n++;
        }
      }
      expect(r / n).toBeGreaterThan(80);
      expect(r / n).toBeGreaterThan(g / n + 40);
      expect(r / n).toBeGreaterThan(b / n + 40);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uwu profile still renders the card (placeholder avatar) when the avatar fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const inv = await runCmd(
        profileCommands,
        "profile",
        USER,
        { action: null, target: null },
        "https://cdn.discordapp.com/avatars/user-1/abc.png?size=256",
      );
      expect(inv.replies.length).toBe(1);
      const files = inv.replies[0]!.files as AttachmentBuilder[] | undefined;
      expect(files).toHaveLength(1);
      const gif = (files![0] as AttachmentBuilder).attachment as Buffer;
      expect(gif.subarray(0, 6).toString("ascii")).toMatch(/^GIF8[79]a$/);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      errorSpy.mockRestore();
    }
  });

  it("profile / bg / about resolve by alias (p, background, aboutme)", () => {
    expect(allCommands.find((c) => c.name === "profile")?.aliases).toContain("p");
    expect(allCommands.find((c) => c.name === "bg")?.aliases).toContain("background");
    expect(allCommands.find((c) => c.name === "about")?.aliases).toContain("aboutme");
    expect(allCommands.filter((c) => ["profile", "bg", "about"].includes(c.name)).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Shop backgrounds (market commands)
// ---------------------------------------------------------------------------

describe("shop backgrounds", () => {
  /** Flip the bg list to `page` (0-based) via the ◀ N ▶ button handler. */
  async function flipBgPage(page: number): Promise<string> {
    const handler = marketButtonHandlers["selena:shopbg"]!;
    const updates: { content: string; components?: unknown }[] = [];
    await handler(
      {
        customId: `selena:shopbg:list:${page}`,
        user: { id: USER },
        update: async (p: { content: string; components?: unknown }) => {
          updates.push(p);
        },
        reply: async () => {},
      } as never,
      ctxFor(db) as never,
    );
    expect(updates).toHaveLength(1);
    return String(updates[0]!.content);
  }

  it("uwu shop bg lists all 30 across 3 pages in the OwO format", async () => {
    const inv = await runCmd(marketCommands, "shop", USER, { action: "bg", item: null });
    const page1 = inv.text();
    expect(page1).toContain("30 total");
    expect(page1).toContain("Page 1/3");
    expect(page1).toMatch(/1  🖼️ Meadow Dawn\.+ 10K \[static\]/);
    expect(page1).toContain("Default — free [static]");
    // Every background appears exactly once across the three pages,
    // with its compact price — flip through and collect them all.
    const all = page1 + "\n" + (await flipBgPage(1)) + "\n" + (await flipBgPage(2));
    for (const b of profileBgs.listBackgrounds()) {
      expect(all).toContain(b.name);
    }
    expect(all).toMatch(/11  🖼️ Starfall\.+ 25K \[GIF\]/);
    expect(all).toContain("Page 2/3");
    expect(all).toContain("Page 3/3");
  });

  it("uwu shop bg marks owned ✓ and equipped ★", async () => {
    await giveGold(USER, 100000);
    await profileLib.buyBackground(db, GUILD, USER, "meadow-dawn", NOW);
    await profileLib.buyBackground(db, GUILD, USER, "starfall", NOW);
    await profileLib.equipBackground(db, USER, "starfall");
    const inv = await runCmd(marketCommands, "shop", USER, { action: "bg", item: null });
    const page1 = inv.text();
    expect(page1).toMatch(/1  🖼️ Meadow Dawn\.+ 10K \[static\] ✓/);
    // Starfall is #11, on page 2 — flip there for its marks.
    const page2 = await flipBgPage(1);
    expect(page2).toMatch(/11  🖼️ Starfall\.+ 25K \[GIF\] ✓ ★/);
  });

  it("uwu shop buy bg <name> buys, states name + price + remaining gold", async () => {
    await giveGold(USER, 50000);
    const inv = await runCmd(marketCommands, "shop", USER, { action: "buy", item: "bg meadow-dawn" });
    expect(inv.text()).toContain("Bought **Meadow Dawn** for 10,000 gold");
    expect(inv.text()).toContain("40,000 gold left");
    expect(await profileLib.getOwnedBackgrounds(db, USER)).toEqual(["meadow-dawn"]);
  });

  it("uwu shop buy bg refuses when the user can't afford it", async () => {
    await giveGold(USER, 1000);
    const inv = await runCmd(marketCommands, "shop", USER, { action: "buy", item: "bg starfall" });
    expect(inv.text()).toContain("not enough gold");
    expect(await profileLib.getOwnedBackgrounds(db, USER)).toEqual([]);
  });

  it("uwu shop buy bg refuses an unknown background", async () => {
    const inv = await runCmd(marketCommands, "shop", USER, { action: "buy", item: "bg nope" });
    expect(inv.text()).toContain("don't know");
  });

  it("the existing daily-shop buy path still works unchanged", async () => {
    const stock = generateShopStock(new Date().toISOString().slice(0, 10));
    const item = stock[0]!;
    await giveGold(USER, 100000);
    const inv = await runCmd(marketCommands, "shop", USER, { action: "buy", item: item.name });
    expect(inv.text()).toContain(`Bought 1 × ${item.name}`);
  });
});

// ---------------------------------------------------------------------------
// Router end-to-end (FakePrefixMessage harness)
// ---------------------------------------------------------------------------

describe("profile via handlePrefixMessage", () => {
  it("uwu shop bg works through the router", async () => {
    const msg = new FakePrefixMessage("uwu shop bg");
    expect(await handlePrefixMessage(msg as never, { db, guildId: GUILD })).toBe(true);
    expect(msg.allText()).toContain("30 total");
    expect(msg.allText()).toContain("Page 1/3");
    expect(msg.allText()).toContain("Meadow Dawn");
    // `uwu shop bg 2` jumps straight to page 2 (Starfall is #11).
    const msg2 = new FakePrefixMessage("uwu shop bg 2");
    expect(await handlePrefixMessage(msg2 as never, { db, guildId: GUILD })).toBe(true);
    expect(msg2.allText()).toContain("Page 2/3");
    expect(msg2.allText()).toContain("Starfall");
  });

  it("uwu about <text> sets the line through the router", async () => {
    const msg = new FakePrefixMessage("uwu about router test");
    expect(await handlePrefixMessage(msg as never, { db, guildId: GUILD })).toBe(true);
    expect(msg.allText()).toContain("router test");
    expect((await profileLib.getUserProfile(db, USER)).about).toBe("router test");
  });

  it("uwu profile replies with the error path (background file missing), never crashes", async () => {
    // Missing-file case via an equipped fixture background whose file
    // is not in assets/profile-bgs/ (see the direct-command test above).
    await giveGold(USER, 50000);
    await profileLib.buyBackground(db, GUILD, USER, "meadow-dawn", NOW);
    await profileLib.equipBackground(db, USER, "meadow-dawn");
    const msg = new FakePrefixMessage("uwu profile");
    expect(await handlePrefixMessage(msg as never, { db, guildId: GUILD })).toBe(true);
    expect(msg.allText()).toContain("That didn't work");
  });
});
