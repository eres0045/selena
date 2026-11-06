import { describe, expect, it } from "vitest";
import { GatewayIntentBits } from "discord.js";
import { buildClient, runDueTasks, shouldLogin, start } from "../src/index.js";
import { allButtonHandlers, allCommands, allModalHandlers } from "../src/commands/index.js";
import { getTestDb } from "../src/lib/db.js";

describe("shouldLogin", () => {
  it("is false without a token", () => {
    expect(shouldLogin({})).toBe(false);
    expect(shouldLogin({ DISCORD_TOKEN: "   " })).toBe(false);
  });

  it("is true with a dummy token", () => {
    expect(shouldLogin({ DISCORD_TOKEN: "dummy-token" })).toBe(true);
  });
});

describe("start() without a token", () => {
  it("does not attempt a login and resolves", async () => {
    const saved = process.env.DISCORD_TOKEN;
    delete process.env.DISCORD_TOKEN;
    try {
      await expect(start()).resolves.toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.DISCORD_TOKEN = saved;
    }
  });
});

describe("buildClient", () => {
  it("has the required intents", () => {
    const client = buildClient();
    const intents = client.options.intents;
    for (const bit of [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.MessageContent,
    ]) {
      expect(intents.has(bit)).toBe(true);
    }
  });
});

describe("registry completeness", () => {
  it("has no duplicate command names and every command has a description", () => {
    const names = allCommands.map((c) => c.data.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThan(0);
    for (const cmd of allCommands) {
      expect(cmd.data.name.length).toBeGreaterThan(0);
      expect(cmd.data.description.length).toBeGreaterThan(0);
      expect(typeof cmd.execute).toBe("function");
    }
  });

  it("all button/modal handler keys start with 'selena:'", () => {
    for (const key of [...Object.keys(allButtonHandlers), ...Object.keys(allModalHandlers)]) {
      expect(key.startsWith("selena:")).toBe(true);
    }
  });
});

describe("runDueTasks", () => {
  it("ends due giveaways without a games module (no winners, no crash)", async () => {
    const db = getTestDb();
    db.prepare(
      "INSERT INTO giveaways (guild_id, channel_id, prize, ends_at, winners_count, ended, created_by, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
    ).run("guild-1", "chan-1", "test prize", Date.now() - 1000, 1, "user-1", Date.now());
    await runDueTasks(db, null);
    const row = db.prepare("SELECT ended FROM giveaways WHERE id = 1").get() as { ended: number };
    expect(row.ended).toBe(1);
  });

  it("leaves future giveaways and undeliverable reminders alone", async () => {
    const db = getTestDb();
    db.prepare(
      "INSERT INTO giveaways (guild_id, channel_id, prize, ends_at, winners_count, ended, created_by, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
    ).run("guild-1", "chan-1", "future prize", Date.now() + 60_000, 1, "user-1", Date.now());
    db.prepare(
      "INSERT INTO reminders (guild_id, user_id, channel_id, text, due_at, delivered, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    ).run("guild-1", "user-1", "chan-1", "past reminder", Date.now() - 1000, Date.now());
    await runDueTasks(db, null);
    expect((db.prepare("SELECT ended FROM giveaways WHERE id = 1").get() as { ended: number }).ended).toBe(0);
    // no client -> reminder stays undelivered (nothing can send it)
    expect((db.prepare("SELECT delivered FROM reminders WHERE id = 1").get() as { delivered: number }).delivered).toBe(0);
  });
});
