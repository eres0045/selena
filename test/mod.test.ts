import { describe, expect, it } from "vitest";
import { getTestDb } from "../src/lib/db.js";
import { FakeChatInput } from "../src/lib/testkit.js";
import {
  commands,
  closeTicket,
  getReactionRole,
  listModActions,
  listWarnings,
  openTicket,
  recordModAction,
  setReactionRole,
  warnUser,
} from "../src/commands/mod.js";
import type { Command } from "../src/lib/command.js";

const GUILD = "guild-1";
const MOD = "mod-1";
const USER = "user-9";

function run(name: string, opts: Record<string, unknown> = {}, permissions: string[] = ["ModerateMembers", "KickMembers", "BanMembers", "ManageRoles"]) {
  const cmd = commands.find((c) => c.data.name === name);
  if (!cmd) throw new Error(`command not found: ${name}`);
  const fake = new FakeChatInput({ commandName: name, options: opts, userId: MOD, username: "mod", permissions });
  return { cmd: cmd as Command, fake };
}

async function exec(name: string, opts: Record<string, unknown> = {}, permissions?: string[]) {
  const db = getTestDb();
  const { cmd, fake } = run(name, opts, permissions);
  await (cmd.execute as (i: unknown, ctx: unknown) => Promise<void>)(fake, { db, guildId: GUILD });
  return { db, fake };
}

const target = { id: USER, username: "trouble" };

describe("warn", () => {
  it("records a warning + mod action and lists it", async () => {
    const { db, fake } = await exec("warn", { user: target, reason: "spam" });
    expect(fake.allText()).toContain("warned");
    const rows = listWarnings(db, GUILD, USER);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe("spam");
    expect(listModActions(db, GUILD)).toHaveLength(1);
    // helper path
    const id = warnUser(db, GUILD, USER, MOD, "second offence", 2000);
    expect(id).toBeGreaterThan(0);
    expect(listWarnings(db, GUILD, USER)).toHaveLength(2);
  });

  it("rejects a user without ModerateMembers", async () => {
    const { db, fake } = await exec("warn", { user: target, reason: "spam" }, []);
    expect(fake.allText()).toContain("ModerateMembers");
    expect(listWarnings(db, GUILD, USER)).toHaveLength(0);
  });

  it("errors when reason is missing", async () => {
    const { db, fake } = await exec("warn", { user: target });
    expect(fake.allText()).toContain("required");
    expect(listWarnings(db, GUILD, USER)).toHaveLength(0);
  });
});

describe("mute / timeout / kick / ban permission gating", () => {
  it("mute records + replies on success, rejects without permission", async () => {
    const { db, fake } = await exec("mute", { user: target, "duration-minutes": 10, reason: "caps" });
    expect(fake.allText()).toContain("muted for 10");
    expect(listModActions(db, GUILD).some((a) => a.action === "mute")).toBe(true);

    const denied = await exec("mute", { user: target, "duration-minutes": 10, reason: "caps" }, []);
    expect(denied.fake.allText()).toContain("ModerateMembers");
    expect(listModActions(denied.db, GUILD)).toHaveLength(0);
  });

  it("timeout behaves like mute", async () => {
    const { db, fake } = await exec("timeout", { user: target, "duration-minutes": 5, reason: "flood" });
    expect(fake.allText()).toContain("timed out");
    expect(listModActions(db, GUILD).some((a) => a.action === "timeout")).toBe(true);
  });

  it("kick requires KickMembers", async () => {
    const ok = await exec("kick", { user: target, reason: "bye" });
    expect(ok.fake.allText()).toContain("kicked");
    const denied = await exec("kick", { user: target, reason: "bye" }, ["ModerateMembers"]);
    expect(denied.fake.allText()).toContain("KickMembers");
  });

  it("ban requires BanMembers and records delete-days", async () => {
    const ok = await exec("ban", { user: target, reason: "cheating", "delete-days": 1 });
    expect(ok.fake.allText()).toContain("banned");
    expect(listModActions(ok.db, GUILD)[0]!.reason).toContain("delete 1d");
    const denied = await exec("ban", { user: target, reason: "cheating" }, []);
    expect(denied.fake.allText()).toContain("BanMembers");
  });

  it("unban requires BanMembers, errors without a user id", async () => {
    const ok = await exec("unban", { "user-id": "user-77", reason: "appeal accepted" });
    expect(ok.fake.allText()).toContain("unbanned");
    const denied = await exec("unban", { "user-id": "user-77" }, []);
    expect(denied.fake.allText()).toContain("BanMembers");
    const missing = await exec("unban", {}, ["BanMembers"]);
    expect(missing.fake.allText()).toContain("required");
  });
});

describe("warnings / modlog", () => {
  it("warnings lists newest first and reports none cleanly", async () => {
    const db = getTestDb();
    warnUser(db, GUILD, USER, MOD, "first", 1000);
    warnUser(db, GUILD, USER, MOD, "second", 2000);
    const { fake } = run("warnings", { user: target });
    const cmd = commands.find((c) => c.data.name === "warnings")!;
    await (cmd.execute as (i: unknown, ctx: unknown) => Promise<void>)(fake, { db, guildId: GUILD });
    const text = fake.allText();
    expect(text.indexOf("second")).toBeLessThan(text.indexOf("first"));

    const clean = await exec("warnings", { user: { id: "user-clean", username: "clean" } });
    expect(clean.fake.allText()).toContain("no warnings");
  });

  it("modlog orders newest first", async () => {
    const db = getTestDb();
    recordModAction(db, GUILD, USER, MOD, "warn", "a", 1000);
    recordModAction(db, GUILD, USER, MOD, "kick", "b", 3000);
    recordModAction(db, GUILD, USER, MOD, "ban", "c", 2000);
    const rows = listModActions(db, GUILD, 10);
    expect(rows.map((r) => r.action)).toEqual(["kick", "ban", "warn"]);
    const { fake } = run("modlog", {});
    const cmd = commands.find((c) => c.data.name === "modlog")!;
    await (cmd.execute as (i: unknown, ctx: unknown) => Promise<void>)(fake, { db, guildId: GUILD });
    expect(fake.allText()).toContain("kick");
  });

  it("modlog rejects without permission and reports empty", async () => {
    const denied = await exec("modlog", {}, []);
    expect(denied.fake.allText()).toContain("ModerateMembers");
    const empty = await exec("modlog", {});
    expect(empty.fake.allText()).toContain("No moderation actions");
  });
});

describe("tickets", () => {
  it("open creates a row, re-open returns the existing ticket, close closes it", async () => {
    const db = getTestDb();
    const t1 = openTicket(db, GUILD, USER, "need help", 1000);
    expect(t1.status).toBe("open");
    const t2 = openTicket(db, GUILD, USER, "need help again", 2000);
    expect(t2.id).toBe(t1.id);
    const closed = closeTicket(db, GUILD, USER, 3000);
    expect(closed?.status).toBe("closed");
    expect(closed?.closed_at).toBe(3000);
    expect(closeTicket(db, GUILD, USER, 4000)).toBeNull();
  });

  it("/ticket open via command, close with none open errors", async () => {
    const { db, fake } = await exec("ticket", { action: "open", reason: "stuck" });
    expect(fake.allText()).toContain("Ticket #");
    expect(db.prepare("SELECT COUNT(*) AS c FROM tickets WHERE status='open'").get()?.c).toBe(1);

    const missingReason = await exec("ticket", { action: "open" });
    expect(missingReason.fake.allText()).toContain("reason is required");

    const noTicket = await exec("ticket", { action: "close" });
    expect(noTicket.fake.allText()).toContain("no open ticket");
  });
});

describe("reaction roles", () => {
  it("stores a mapping and reads it back, overwriting on re-map", () => {
    const db = getTestDb();
    setReactionRole(db, GUILD, "chan-1", "msg-1", "🔥", "role-1");
    expect(getReactionRole(db, GUILD, "msg-1", "🔥")).toBe("role-1");
    expect(getReactionRole(db, GUILD, "msg-1", "❌")).toBeNull();
    setReactionRole(db, GUILD, "chan-1", "msg-1", "🔥", "role-2");
    expect(getReactionRole(db, GUILD, "msg-1", "🔥")).toBe("role-2");
  });

  it("/reactionrole command stores the mapping, rejects without ManageRoles", async () => {
    const { db, fake } = await exec("reactionrole", {
      "message-id": "msg-9",
      emoji: "⭐",
      role: { id: "role-9", name: "Star" },
    });
    expect(fake.allText()).toContain("Reaction role saved");
    expect(getReactionRole(db, GUILD, "msg-9", "⭐")).toBe("role-9");

    const denied = await exec("reactionrole", { "message-id": "msg-9", emoji: "⭐", role: { id: "role-9", name: "Star" } }, []);
    expect(denied.fake.allText()).toContain("ManageRoles");
  });
});
