import { describe, expect, it, beforeEach } from "vitest";
import type { SelenaDb } from "../src/lib/db.js";
import { getTestDb } from "./testDb.js";
import { addPoints, getBalance } from "../src/lib/economy.js";
import { getUserMonsters } from "../src/lib/huntDb.js";
import type { CommandContext, CommandInvocation, CommandOptions, ReplyPayload } from "../src/lib/command.js";
import {
  REGIONS,
  distanceKm,
  encounterMonsterInWorldArea,
  findWorldArea,
  travelMinutes,
} from "../src/lib/world.js";
import {
  AUTOHUNT_GOLD_PER_HOUR,
  buttonHandlers,
  commands,
  getLocation,
  processAutoHuntTicks,
  travelDueSweep,
} from "../src/commands/world.js";

const GUILD = "guild-1";
const USER = "user-1";
const CHANNEL = "chan-1";

// ---------------------------------------------------------------------------
// Fakes (direct execute — this module is not in src/commands/index.ts
// yet; the coordinator registers it, so tests call execute directly)
// ---------------------------------------------------------------------------

class FakeInv implements CommandInvocation {
  user = { id: USER, username: "tester" };
  guildId = GUILD;
  channelId = CHANNEL;
  options: CommandOptions;
  replies: ReplyPayload[] = [];

  constructor(args: Record<string, string | number | null> = {}) {
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
    return this.replies.map((r) => r.content ?? "").join("\n");
  }
}

class FakeButton {
  customId: string;
  user = { id: USER };
  updates: ReplyPayload[] = [];
  replies: ReplyPayload[] = [];

  constructor(customId: string) {
    this.customId = customId;
  }

  async update(p: ReplyPayload): Promise<void> {
    this.updates.push(p);
  }

  async reply(p: ReplyPayload): Promise<void> {
    this.replies.push(p);
  }

  text(): string {
    return this.updates.map((u) => u.content ?? "").join("\n");
  }
}

class FakeClient {
  sends: { channelId: string; content: string }[] = [];
  channels = {
    fetch: async (id: string) => ({
      send: async (p: { content?: string }) => {
        this.sends.push({ channelId: id, content: p.content ?? "" });
      },
    }),
  };
}

describe("world map + travel + auto-hunt", () => {
  let db: SelenaDb;
  const ctx = (): CommandContext => ({ db, guildId: GUILD });

  beforeEach(() => {
    db = getTestDb();
  });

  async function run(name: string, args: Record<string, string | number | null> = {}, userId = USER): Promise<FakeInv> {
    const cmd = commands.find((c) => c.name === name)!;
    expect(cmd, `command ${name} exists`).toBeDefined();
    const inv = new FakeInv(args);
    inv.user = { id: userId, username: "tester" };
    await cmd.execute(inv, ctx());
    return inv;
  }

  async function setLevel(level: number, userId = USER): Promise<void> {
    await getBalance(db, GUILD, userId); // creates the users row
    await db.prepare("UPDATE users SET level = ? WHERE guild_id = ? AND user_id = ?").run(level, GUILD, userId);
  }

  async function press(customId: string): Promise<FakeButton> {
    const btn = new FakeButton(customId);
    await buttonHandlers["selena:map"]!(btn as never, ctx());
    return btn;
  }

  async function setLocationFields(fields: Record<string, unknown>): Promise<void> {
    const sets = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
    await db.prepare(`UPDATE user_location SET ${sets} WHERE user_id = ?`).run(...Object.values(fields), USER);
  }

  // -------------------------------------------------------------------------
  // Travel time math
  // -------------------------------------------------------------------------

  it("travel time is 5 min/km: 2 km = 10 min", () => {
    const a = findWorldArea("meadow")!;
    const b = { ...a, x: 2, y: 0 };
    expect(distanceKm(a, b)).toBe(2);
    expect(travelMinutes(a, b)).toBe(10);
  });

  it("travel time on known coords: meadow -> woods is 2.2 km = 11 min, meadow -> peaks is 4 km = 20 min", () => {
    const meadow = findWorldArea("meadow")!;
    const woods = findWorldArea("woods")!;
    const peaks = findWorldArea("peaks")!;
    expect(distanceKm(meadow, woods)).toBe(2.2);
    expect(travelMinutes(meadow, woods)).toBe(11);
    expect(distanceKm(meadow, peaks)).toBe(4);
    expect(travelMinutes(meadow, peaks)).toBe(20);
    expect(travelMinutes(meadow, meadow)).toBe(5); // minimum 5 min
  });

  it("encounterMonsterInWorldArea: Region 1 uses the Phase 1 pool, deeper areas use tier weights over the roster", () => {
    const meadow = findWorldArea("meadow")!;
    const m1 = encounterMonsterInWorldArea(meadow, () => 0);
    expect(["Common", "Uncommon"]).toContain(m1.tier);
    expect(m1.name).toBe("Pebble Pup"); // first Common in the meadow pool, rand = 0
    const dunes = findWorldArea("glass-dunes")!;
    const m2 = encounterMonsterInWorldArea(dunes, () => 0);
    expect(m2.tier).toBe("Rare"); // rand 0 -> first weighted tier
    expect(m2.name).toBe("Crystal Wolf"); // first Rare in the roster
  });

  // -------------------------------------------------------------------------
  // Travel start
  // -------------------------------------------------------------------------

  it("uwu travel starts a trip and sets every travel field", async () => {
    await setLevel(5);
    const before = Date.now();
    const inv = await run("travel", { area: "woods" });
    expect(inv.text()).toContain("Travelling to Whispering Woods");
    expect(inv.text()).toContain("2.2 km");
    expect(inv.text()).toContain("11 min");
    const loc = (await getLocation(db, USER))!;
    expect(loc.currentArea).toBe("meadow");
    expect(loc.travellingTo).toBe("woods");
    expect(loc.travelOrigin).toBe("meadow");
    expect(loc.lastLocation).toBe("meadow");
    expect(loc.travelChannelId).toBe(CHANNEL);
    expect(loc.travelGuildId).toBe(GUILD);
    expect(loc.travelStartedAt).toBeGreaterThanOrEqual(before);
    expect(loc.lastAutohuntAt).toBe(loc.travelStartedAt);
    expect(loc.travelEndsAt).toBe(loc.travelStartedAt! + 11 * 60_000);
    expect(loc.autoHunt).toBe(false);
  });

  it("uwu travel refuses a locked area and an unknown area", async () => {
    const locked = await run("travel", { area: "hollow" });
    expect(locked.text()).toContain("unlocks at level 15");
    expect(await getLocation(db, USER)).toBeNull();
    const unknown = await run("travel", { area: "nowhere" });
    expect(unknown.text()).toContain('No area called "nowhere"');
  });

  it("uwu travel refuses a second trip while already travelling", async () => {
    await setLevel(15);
    await run("travel", { area: "woods" });
    const second = await run("travel", { area: "peaks" });
    expect(second.text()).toContain("already travelling to Whispering Woods");
    expect(second.text()).toMatch(/arrive in \d+ min/);
    expect((await getLocation(db, USER))!.travellingTo).toBe("woods");
  });

  it("uwu travel refuses travelling to the area you are already in", async () => {
    const inv = await run("travel", { area: "meadow" });
    expect(inv.text()).toContain("already in Meadow of Beginnings");
  });

  it("uwu travel with no arg reports status while travelling and while idle", async () => {
    const idle = await run("travel", {});
    expect(idle.text()).toContain("You are in Meadow of Beginnings");
    expect(idle.text()).toContain("not travelling");
    await setLevel(5);
    await run("travel", { area: "woods" });
    const busy = await run("travel", {});
    expect(busy.text()).toContain("Travelling to Whispering Woods");
    expect(busy.text()).toMatch(/\d+ min left/);
    expect(busy.text()).toContain("Auto-hunt is off");
  });

  it("uwu travel is free — starting a trip costs no gold", async () => {
    await setLevel(5);
    await addPoints(db, GUILD, USER, 100, "test grant");
    await run("travel", { area: "woods" });
    expect((await getBalance(db, GUILD, USER)).points).toBe(100);
  });

  // -------------------------------------------------------------------------
  // Arrival sweep
  // -------------------------------------------------------------------------

  it("travelDueSweep moves the player, clears travel fields, and announces arrival", async () => {
    await setLevel(5);
    await run("travel", { area: "woods" });
    // Trip ended a second ago; the sweep has not run yet.
    await setLocationFields({ travel_ends_at: Date.now() - 1000 });
    const client = new FakeClient();
    await travelDueSweep(db, client as never);
    const loc = (await getLocation(db, USER))!;
    expect(loc.currentArea).toBe("woods");
    expect(loc.travellingTo).toBeNull();
    expect(loc.travelEndsAt).toBeNull();
    expect(loc.travelOrigin).toBeNull();
    expect(loc.travelChannelId).toBeNull();
    expect(loc.travelGuildId).toBeNull();
    expect(loc.lastLocation).toBe("meadow"); // origin kept
    expect(client.sends).toHaveLength(1);
    expect(client.sends[0]!.channelId).toBe(CHANNEL);
    expect(client.sends[0]!.content).toBe("You arrived at Whispering Woods.");
  });

  it("travelDueSweep ignores trips that have not ended yet and never throws on a broken channel", async () => {
    await setLevel(5);
    await run("travel", { area: "woods" });
    const client = new FakeClient();
    await travelDueSweep(db, client as never);
    expect((await getLocation(db, USER))!.currentArea).toBe("meadow");
    expect(client.sends).toHaveLength(0);
    const broken = { channels: { fetch: async () => { throw new Error("boom"); } } };
    await expect(travelDueSweep(db, broken as never)).resolves.toBeUndefined();
    await expect(travelDueSweep(db, null)).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Auto-hunt
  // -------------------------------------------------------------------------

  it("uwu autohunt refuses to turn on unless travelling, and toggles off cleanly", async () => {
    const idle = await run("autohunt", { mode: "on" });
    expect(idle.text()).toContain("only runs while travelling");
    await setLevel(5);
    await run("travel", { area: "woods" });
    const on = await run("autohunt", { mode: "on" });
    expect(on.text()).toContain("Auto-hunt on");
    expect((await getLocation(db, USER))!.autoHunt).toBe(true);
    const again = await run("autohunt", { mode: "on" });
    expect(again.text()).toContain("already on");
    const off = await run("autohunt", { mode: "off" });
    expect(off.text()).toContain("Auto-hunt off");
    expect((await getLocation(db, USER))!.autoHunt).toBe(false);
    const bad = await run("autohunt", { mode: "maybe" });
    expect(bad.text()).toContain("Usage: `uwu autohunt on|off`");
  });

  it("auto-hunt ticks: forced catches award monsters and charge 200 gold/hour pro-rata", async () => {
    await setLevel(5);
    await addPoints(db, GUILD, USER, 1000, "test grant");
    await run("travel", { area: "woods" });
    await run("autohunt", { mode: "on" });
    const t0 = Date.now();
    // Exactly one hour of travel (120 ticks of 30s).
    await setLocationFields({
      travel_started_at: t0,
      last_autohunt_at: t0,
      travel_ends_at: t0 + 3_600_000,
      auto_hunt_seconds: 0,
      auto_hunt_charged: 0,
    });
    const client = new FakeClient();
    await processAutoHuntTicks(db, client as never, t0 + 3_600_000, () => 0);
    const loc = (await getLocation(db, USER))!;
    expect(loc.autoHuntSeconds).toBe(3600);
    expect(loc.autoHuntCharged).toBe(AUTOHUNT_GOLD_PER_HOUR); // 120 ticks = 1 hour = 200 gold
    expect(loc.lastAutohuntAt).toBe(t0 + 3_600_000);
    expect(loc.autoHunt).toBe(true);
    expect((await getBalance(db, GUILD, USER)).points).toBe(800);
    const owned = await getUserMonsters(db, GUILD, USER);
    expect(owned).toHaveLength(1);
    expect(owned[0]!.monster.name).toBe("Glowcap Shroom"); // first Common in the woods pool
    expect(owned[0]!.count).toBe(120);
    expect(client.sends).toHaveLength(1);
    expect(client.sends[0]!.content).toContain("Auto-hunt caught:");
    expect(client.sends[0]!.content).toContain("Glowcap Shroom ×120");
    expect(client.sends[0]!.content).toContain("-200 gold");
  });

  it("auto-hunt ticks stop at the trip's end even when the sweep runs late", async () => {
    await setLevel(5);
    await addPoints(db, GUILD, USER, 1000, "test grant");
    await run("travel", { area: "woods" });
    await run("autohunt", { mode: "on" });
    const t0 = Date.now();
    await setLocationFields({
      travel_started_at: t0,
      last_autohunt_at: t0,
      travel_ends_at: t0 + 60_000, // 2 ticks, then the trip ends
      auto_hunt_seconds: 0,
      auto_hunt_charged: 0,
    });
    await processAutoHuntTicks(db, null, t0 + 3_600_000, () => 0); // sweep an hour late
    const loc = (await getLocation(db, USER))!;
    expect(loc.autoHuntSeconds).toBe(60);
    expect(loc.autoHuntCharged).toBe(3); // floor(60 * 200 / 3600) = 3
    expect(loc.lastAutohuntAt).toBe(t0 + 60_000);
    expect((await getBalance(db, GUILD, USER)).points).toBe(997);
  });

  it("auto-hunt turns off when the user cannot afford the next charge, and never goes negative", async () => {
    await setLevel(5);
    // No gold at all.
    await run("travel", { area: "woods" });
    await run("autohunt", { mode: "on" });
    const t0 = Date.now();
    await setLocationFields({
      travel_started_at: t0,
      last_autohunt_at: t0,
      travel_ends_at: t0 + 3_600_000,
      auto_hunt_seconds: 0,
      auto_hunt_charged: 0,
    });
    await processAutoHuntTicks(db, null, t0 + 60_000, () => 0);
    const loc = (await getLocation(db, USER))!;
    expect(loc.autoHunt).toBe(false);
    expect((await getBalance(db, GUILD, USER)).points).toBe(0);
    // A second sweep does nothing more — auto-hunt stays off.
    await processAutoHuntTicks(db, null, t0 + 3_600_000, () => 0);
    expect((await getLocation(db, USER))!.autoHunt).toBe(false);
    expect((await getBalance(db, GUILD, USER)).points).toBe(0);
  });

  it("auto-hunt does nothing when off, and never throws", async () => {
    await setLevel(5);
    await run("travel", { area: "woods" });
    await expect(processAutoHuntTicks(db, null, Date.now() + 3_600_000, () => 0)).resolves.toBeUndefined();
    expect((await getLocation(db, USER))!.autoHuntSeconds).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Map command + buttons
  // -------------------------------------------------------------------------

  it("uwu map renders origin + current markers and the travel status", async () => {
    await setLevel(5);
    await run("travel", { area: "woods" });
    const inv = await run("map", {});
    const text = inv.text();
    expect(text).toContain("🗺️ World Map");
    expect(text).toContain("Meadow of Beginnings");
    expect(text).toContain("🔴");
    expect(text).toContain("You are here");
    expect(text).toContain("○");
    expect(text).toContain("Started here");
    expect(text).toContain("Travelling to Whispering Woods");
    for (const region of REGIONS) expect(text).toContain(region.name);
    expect(text).not.toContain("tower"); // towers are another worker's system
    // Four buttons, zoom-in carrying the player's current region.
    const row = inv.replies[0]!.components![0] as unknown as {
      toJSON: () => { components: { custom_id: string }[] };
    };
    const ids = row.toJSON().components.map((b) => b.custom_id);
    expect(ids).toEqual([
      "selena:map:zoom-in:starting-lands",
      "selena:map:zoom-out",
      "selena:map:mark",
      "selena:map:last-location",
    ]);
  });

  it("uwu map falls back to the Phase 1 hunt area when there is no location row", async () => {
    await db
      .prepare(
        "INSERT INTO user_hunt (guild_id, user_id, last_hunt_at, current_area) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT (guild_id, user_id) DO UPDATE SET current_area = EXCLUDED.current_area",
      )
      .run(GUILD, USER, Date.now(), "peaks");
    await setLevel(10);
    const inv = await run("map", {});
    expect(inv.text()).toContain("Ember Peaks");
    expect(inv.text()).toContain("You are here");
  });

  it("map Mark button toggles a pin on the current area", async () => {
    await run("map", {});
    const first = await press("selena:map:mark");
    expect(first.text()).toContain("📌 Meadow of Beginnings");
    expect((await getLocation(db, USER))!.mapMarks).toEqual(["meadow"]);
    const second = await press("selena:map:mark");
    expect(second.text()).not.toContain("📌 Meadow of Beginnings");
    expect((await getLocation(db, USER))!.mapMarks).toEqual([]);
  });

  it("map Zoom In shows one region in detail, Zoom Out returns to the whole world", async () => {
    await run("map", {});
    const zoomed = await press("selena:map:zoom-in:starting-lands");
    expect(zoomed.text()).toContain("Starting Lands");
    expect(zoomed.text()).toContain("wild Lv 1–5");
    expect(zoomed.text()).not.toContain("The Shifting Dunes");
    const out = await press("selena:map:zoom-out");
    expect(out.text()).toContain("🗺️ World Map");
    expect(out.text()).toContain("The Shifting Dunes");
    expect(out.text()).toContain("The Sky Isles");
  });

  it("map Last Location focuses the view on the area travelled from", async () => {
    await setLevel(5);
    await run("travel", { area: "woods" });
    await run("map", {});
    const focused = await press("selena:map:last-location");
    // last_location is meadow, in the Starting Lands — zoomed view, not the world.
    expect(focused.text()).toContain("Starting Lands");
    expect(focused.text()).toContain("wild Lv 1–5");
    expect(focused.text()).not.toContain("🗺️ World Map");
  });

  it("map buttons only change the view — pressing them never moves the player", async () => {
    await setLevel(5);
    await run("travel", { area: "woods" });
    await press("selena:map:zoom-in:shifting-dunes");
    await press("selena:map:last-location");
    const loc = (await getLocation(db, USER))!;
    expect(loc.currentArea).toBe("meadow");
    expect(loc.travellingTo).toBe("woods");
  });
});
