import { beforeEach, describe, expect, it } from "vitest";
import { getTestDb, type SelenaDb } from "../src/lib/db.js";
import { FakeButton, FakeChatInput, FakeModalSubmit } from "../src/lib/testkit.js";
import type { CommandContext } from "../src/lib/command.js";
import * as lib from "../src/lib/manage.js";
import { buttonHandlers, commands, modalHandlers } from "../src/commands/manage.js";

let db: SelenaDb;
let ctx: CommandContext;

beforeEach(() => {
  db = getTestDb();
  ctx = { db, guildId: "guild-1" };
  lib.clearDraft("guild:guild-1");
});

const cmd = (name: string) => commands.find((c) => c.data.name === name)!;

async function exec(name: string, opts: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const fake = new FakeChatInput({ commandName: name, options: opts, ...extra });
  await cmd(name).execute(fake as never, ctx);
  return fake;
}

function fakeGuild(roleNames: string[], added: string[]) {
  return {
    roles: {
      cache: {
        find: (fn: (r: { id: string; name: string }) => boolean) =>
          roleNames.map((n) => ({ id: `role-${n}`, name: n })).find(fn),
      },
    },
    members: {
      fetch: async (id: string) => ({
        id,
        roles: {
          add: async (role: { name: string }) => {
            added.push(`${id}:${role.name}`);
          },
        },
      }),
    },
  };
}

const NOW = Date.UTC(2026, 10, 6, 12, 0); // 2026-11-06 12:00 UTC

// ---------------------------------------------------------------------------
// Squads (lib)
// ---------------------------------------------------------------------------

describe("squads (lib)", () => {
  it("creates a squad and lists it with member counts", () => {
    const r = lib.createSquad(db, "guild-1", "Zenith A", "user-cap", NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.squad.name).toBe("Zenith A");
    const squads = lib.listSquads(db, "guild-1");
    expect(squads).toHaveLength(1);
    expect(squads[0]!.memberCount).toBe(1); // captain auto-added
    expect(squads[0]!.captain_id).toBe("user-cap");
  });

  it("rejects duplicate names (case-insensitive) and empty names", () => {
    expect(lib.createSquad(db, "guild-1", "Zenith A", null, NOW).ok).toBe(true);
    expect(lib.createSquad(db, "guild-1", "zenith a", null, NOW)).toMatchObject({ ok: false });
    expect(lib.createSquad(db, "guild-1", "   ", null, NOW)).toMatchObject({ ok: false });
  });

  it("adds and removes members", () => {
    lib.createSquad(db, "guild-1", "Zenith A", null, NOW);
    expect(lib.addSquadMember(db, "guild-1", "Zenith A", "user-1", "member").ok).toBe(true);
    expect(lib.addSquadMember(db, "guild-1", "Nope", "user-1", "member")).toMatchObject({ ok: false });
    expect(lib.listSquadMembers(db, 1)).toEqual([{ userId: "user-1", role: "member" }]);
    expect(lib.removeSquadMember(db, "guild-1", "Zenith A", "user-1").ok).toBe(true);
    expect(lib.removeSquadMember(db, "guild-1", "Zenith A", "user-1")).toMatchObject({ ok: false });
    expect(lib.listSquadMembers(db, 1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Lineups (lib)
// ---------------------------------------------------------------------------

describe("lineups (lib)", () => {
  it("assigns members to lineups and builds the lineup card", () => {
    lib.createSquad(db, "guild-1", "Zenith A", null, NOW);
    expect(lib.assignLineup(db, "guild-1", "Zenith A", "u1", "Main Lineup").ok).toBe(true);
    expect(lib.assignLineup(db, "guild-1", "Zenith A", "u2", "Prime").ok).toBe(true);
    const r = lib.assignLineup(db, "guild-1", "Zenith A", "u3", "Tryout");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.main).toEqual(["u1"]);
    expect(r.card.prime).toEqual(["u2"]);
    expect(r.card.tryout).toEqual(["u3"]);
    const text = lib.formatLineupCard(r.card);
    expect(text).toContain("Main Lineup");
    expect(text).toContain("<@u1>");
    expect(text).toContain("Prime");
    expect(text).toContain("Tryout");
  });

  it("rejects invalid lineups and missing squads", () => {
    lib.createSquad(db, "guild-1", "Zenith A", null, NOW);
    expect(lib.assignLineup(db, "guild-1", "Zenith A", "u1", "Bench")).toMatchObject({ ok: false });
    expect(lib.assignLineup(db, "guild-1", "Ghost", "u1", "Prime")).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// Scrims (lib)
// ---------------------------------------------------------------------------

describe("scrims (lib)", () => {
  it("parses valid future dates", () => {
    const r = lib.parseScrimDate("2026-11-08", "20:30", NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scheduledAt).toBe(Date.UTC(2026, 10, 8, 20, 30));
  });

  it("rejects past dates, garbage input, and impossible dates", () => {
    expect(lib.parseScrimDate("2026-11-05", "20:30", NOW)).toMatchObject({ ok: false });
    expect(lib.parseScrimDate("2026-11-06", "12:00", NOW)).toMatchObject({ ok: false }); // == now
    expect(lib.parseScrimDate("08/11/2026", "20:30", NOW)).toMatchObject({ ok: false });
    expect(lib.parseScrimDate("2026-11-08", "8pm", NOW)).toMatchObject({ ok: false });
    expect(lib.parseScrimDate("2026-02-30", "20:30", NOW)).toMatchObject({ ok: false });
    expect(lib.parseScrimDate("2026-13-01", "20:30", NOW)).toMatchObject({ ok: false });
    expect(lib.parseScrimDate("2026-11-08", "24:00", NOW)).toMatchObject({ ok: false });
  });

  it("schedules, lists, and tracks RSVPs with upsert", () => {
    const s = lib.scheduleScrim(db, "guild-1", "Team X", "2026-11-08", "20:30", "user-1", NOW);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(lib.listScrims(db, "guild-1", NOW)).toHaveLength(1);
    expect(lib.listScrims(db, "guild-1", NOW)[0]!.opponent).toBe("Team X");
    const r1 = lib.upsertRsvp(db, s.scrimId, "u1", true);
    expect(r1).toMatchObject({ ok: true, yes: 1, no: 0 });
    const r2 = lib.upsertRsvp(db, s.scrimId, "u1", false); // change of mind: still one row
    expect(r2).toMatchObject({ ok: true, yes: 0, no: 1 });
    expect(lib.upsertRsvp(db, 999, "u1", true)).toMatchObject({ ok: false });
    expect(lib.scheduleScrim(db, "guild-1", "Team Y", "2020-01-01", "10:00", "user-1", NOW)).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// Tryouts (lib)
// ---------------------------------------------------------------------------

describe("tryouts (lib)", () => {
  const input = { ign: "Eres", mlbbId: "12345", role: "Jungler", rank: "Mythic", heroes: "Ling, Selena" };

  it("submits a valid tryout as pending", () => {
    const r = lib.submitTryout(db, "guild-1", "user-1", input, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tryout.status).toBe("pending");
    expect(r.tryout.rank_name).toBe("Mythic");
  });

  it("rejects bad ranks and empty fields", () => {
    expect(lib.submitTryout(db, "guild-1", "user-1", { ...input, rank: "Immortal" }, NOW)).toMatchObject({ ok: false });
    expect(lib.submitTryout(db, "guild-1", "user-1", { ...input, ign: "  " }, NOW)).toMatchObject({ ok: false });
    expect(lib.submitTryout(db, "guild-1", "user-1", { ...input, heroes: "" }, NOW)).toMatchObject({ ok: false });
    expect(lib.submitTryout(db, "guild-1", "user-1", { ...input, mlbbId: "" }, NOW)).toMatchObject({ ok: false });
  });

  it("accepts canonical rank case-insensitively", () => {
    const r = lib.submitTryout(db, "guild-1", "user-1", { ...input, rank: "mythical glory" }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tryout.rank_name).toBe("Mythical Glory");
  });

  it("accept/reject updates status once, with Tryout role intent on accept", () => {
    const created = lib.submitTryout(db, "guild-1", "user-1", input, NOW);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const accepted = lib.decideTryout(db, "guild-1", created.tryoutId, "accepted");
    expect(accepted).toMatchObject({ ok: true, roleIntent: "Tryout" });
    expect(lib.decideTryout(db, "guild-1", created.tryoutId, "rejected")).toMatchObject({ ok: false });
    const created2 = lib.submitTryout(db, "guild-1", "user-2", input, NOW);
    if (!created2.ok) return;
    expect(lib.decideTryout(db, "guild-1", created2.tryoutId, "rejected")).toMatchObject({ ok: true, roleIntent: null });
    expect(lib.decideTryout(db, "guild-1", 999, "accepted")).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// Brackets (lib)
// ---------------------------------------------------------------------------

describe("brackets (lib)", () => {
  it("creates round-1 matches seeded in given order", () => {
    const r = lib.createBracket(db, "guild-1", "Zenith Cup", ["Alpha", "Beta", "Gamma", "Delta"], NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches).toHaveLength(2);
    expect([r.matches[0]!.team_a, r.matches[0]!.team_b]).toEqual(["Alpha", "Beta"]);
    expect([r.matches[1]!.team_a, r.matches[1]!.team_b]).toEqual(["Gamma", "Delta"]);
    expect(r.matches.every((m) => m.round === 1)).toBe(true);
  });

  it("rejects non-power-of-two, duplicate, too-few and too-many teams", () => {
    expect(lib.createBracket(db, "guild-1", "Cup", ["A", "B", "C"], NOW)).toMatchObject({ ok: false });
    expect(lib.createBracket(db, "guild-1", "Cup", ["A", "B", "C", "D", "E"], NOW)).toMatchObject({ ok: false });
    expect(lib.createBracket(db, "guild-1", "Cup", ["A", "A", "B", "C"], NOW)).toMatchObject({ ok: false });
    expect(lib.createBracket(db, "guild-1", "Cup", ["A"], NOW)).toMatchObject({ ok: false });
    expect(lib.createBracket(db, "guild-1", "Cup", Array.from({ length: 17 }, (_, i) => `T${i}`), NOW)).toMatchObject({ ok: false });
  });

  it("advances winners through a 4-team bracket to completion", () => {
    const created = lib.createBracket(db, "guild-1", "Zenith Cup", ["Alpha", "Beta", "Gamma", "Delta"], NOW);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const [semi1, semi2] = created.matches;
    // Wrong winner rejected
    expect(lib.reportMatch(db, "guild-1", created.bracketId, semi1!.id, "Gamma", 2, 1)).toMatchObject({ ok: false });
    // Semi 1: Alpha wins — no final yet (sibling undecided)
    const r1 = lib.reportMatch(db, "guild-1", created.bracketId, semi1!.id, "Alpha", 2, 1, "user-1", NOW);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.advancedTo).toBeNull();
    expect(r1.bracketComplete).toBe(false);
    // Already-reported rejected
    expect(lib.reportMatch(db, "guild-1", created.bracketId, semi1!.id, "Alpha", 2, 0)).toMatchObject({ ok: false });
    // Semi 2: Gamma wins — final is created (Alpha vs Gamma)
    const r2 = lib.reportMatch(db, "guild-1", created.bracketId, semi2!.id, "Gamma", 2, 0, "user-1", NOW);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.advancedTo).not.toBeNull();
    expect(r2.advancedTo!.team_a).toBe("Alpha");
    expect(r2.advancedTo!.team_b).toBe("Gamma");
    expect(r2.advancedTo!.round).toBe(2);
    // Final: Alpha wins — bracket complete
    const r3 = lib.reportMatch(db, "guild-1", created.bracketId, r2.advancedTo!.id, "Alpha", 3, 2, "user-1", NOW);
    expect(r3).toMatchObject({ ok: true, bracketComplete: true });
    expect(lib.getBracket(db, created.bracketId)!.state).toBe("complete");
    // Bad scores / missing match rejected
    expect(lib.reportMatch(db, "guild-1", created.bracketId, r2.advancedTo!.id, "Alpha", -1, 2)).toMatchObject({ ok: false });
    expect(lib.reportMatch(db, "guild-1", created.bracketId, 9999, "Alpha", 2, 1)).toMatchObject({ ok: false });
    expect(lib.reportMatch(db, "guild-1", 9999, semi1!.id, "Alpha", 2, 1)).toMatchObject({ ok: false });
  });

  it("seasonStandings counts wins per team", () => {
    const created = lib.createBracket(db, "guild-1", "Zenith Cup", ["Alpha", "Beta", "Gamma", "Delta"], NOW);
    if (!created.ok) return;
    const [semi1, semi2] = created.matches;
    lib.reportMatch(db, "guild-1", created.bracketId, semi1!.id, "Alpha", 2, 1);
    lib.reportMatch(db, "guild-1", created.bracketId, semi2!.id, "Gamma", 2, 0);
    const final = lib.getBracket(db, created.bracketId)!.matches.find((m) => m.round === 2)!;
    lib.reportMatch(db, "guild-1", created.bracketId, final.id, "Alpha", 3, 2);
    const standings = lib.seasonStandings(db, "guild-1");
    expect(standings[0]).toMatchObject({ team: "Alpha", wins: 2 });
    expect(standings[1]).toMatchObject({ team: "Gamma", wins: 1 });
    expect(standings.find((s) => s.team === "Beta")).toMatchObject({ wins: 0, losses: 1, played: 1 });
    // Scoped to the bracket, same result here
    expect(lib.seasonStandings(db, "guild-1", created.bracketId)[0]!.team).toBe("Alpha");
    expect(lib.seasonStandings(db, "other-guild")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Drafts (lib)
// ---------------------------------------------------------------------------

describe("drafts (lib)", () => {
  it("runs a full ban/pick flow to completion", () => {
    expect(lib.createDraft("chan-1", "Alpha", "Beta", NOW).ok).toBe(true);
    const bans: Array<[string, string]> = [
      ["A", "Selena"], ["B", "Ling"], ["A", "Fanny"], ["B", "Gusion"], ["A", "Hayabusa"], ["B", "Lancelot"],
    ];
    for (const [team, hero] of bans) {
      expect(lib.banHero("chan-1", team as "A" | "B", hero).ok).toBe(true);
    }
    const afterBans = lib.getDraft("chan-1")!;
    expect(afterBans.phase).toBe("pick");
    expect(afterBans.turn).toBe("A");
    expect(afterBans.bansA).toEqual(["Selena", "Fanny", "Hayabusa"]);
    // Picks alternate A/B, 5 each
    const picks = ["Miya", "Layla", "Tigreal", "Eudora", "Rafaela", "Johnson", "Alucard", "Karina", "Balmond", "Saber"];
    for (const hero of picks) {
      expect(lib.applyDraftAction("chan-1", hero).ok).toBe(true);
    }
    const done = lib.getDraft("chan-1")!;
    expect(done.phase).toBe("done");
    expect(done.picksA).toHaveLength(5);
    expect(done.picksB).toHaveLength(5);
    expect(lib.applyDraftAction("chan-1", "Zilong")).toMatchObject({ ok: false });
  });

  it("rejects duplicates, picks during bans, and validates against a hero list", () => {
    lib.createDraft("chan-2", "Alpha", "Beta", NOW);
    expect(lib.banHero("chan-2", "A", "Selena").ok).toBe(true);
    expect(lib.banHero("chan-2", "B", "selena")).toMatchObject({ ok: false }); // duplicate, case-insensitive
    expect(lib.pickHero("chan-2", "A", "Miya")).toMatchObject({ ok: false }); // still ban phase
    expect(lib.validateDraftHero("NotAHero", ["Selena", "Ling"])).toMatchObject({ ok: false });
    expect(lib.validateDraftHero("selena", ["Selena", "Ling"])).toMatchObject({ ok: true, hero: "Selena" });
    expect(lib.validateDraftHero("Anything", [])).toMatchObject({ ok: true });
    expect(lib.createDraft("chan-3", "Same", "Same")).toMatchObject({ ok: false });
    expect(lib.createDraft("chan-3", "", "Beta")).toMatchObject({ ok: false });
    expect(lib.banHero("no-such-channel", "A", "Selena")).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// Rank roles (lib)
// ---------------------------------------------------------------------------

describe("rankrole (lib)", () => {
  it("reads the registered rank and errors without a profile/rank", () => {
    expect(lib.getMemberRank(db, "guild-1", "user-1")).toMatchObject({ ok: false });
    db.prepare(
      "INSERT INTO mlbb_profiles (guild_id, user_id, mlbb_id, ign, rank_name) VALUES (?, ?, ?, ?, ?)",
    ).run("guild-1", "user-1", "123", "Eres", null);
    expect(lib.getMemberRank(db, "guild-1", "user-1")).toMatchObject({ ok: false });
    db.prepare("UPDATE mlbb_profiles SET rank_name = ? WHERE user_id = ?").run("Mythic", "user-1");
    expect(lib.getMemberRank(db, "guild-1", "user-1")).toMatchObject({ ok: true, rank: "Mythic" });
  });
});

// ---------------------------------------------------------------------------
// Mocked-client integration tests
// ---------------------------------------------------------------------------

describe("/squad command", () => {
  it("creates, lists, adds and removes via the command", async () => {
    const created = await exec("squad", {
      subcommand: "create",
      name: "Zenith A",
      captain: { id: "user-cap", username: "cap" },
    });
    expect(created.allText()).toContain("Squad created");
    expect(created.allText()).toContain("Zenith A");

    const dup = await exec("squad", { subcommand: "create", name: "Zenith A" });
    expect(dup.allText()).toContain("already exists");

    const listed = await exec("squad", { subcommand: "list" });
    expect(listed.allText()).toContain("Zenith A");
    expect(listed.allText()).toContain("1 member");

    const added = await exec("squad", {
      subcommand: "add",
      squad: "Zenith A",
      user: { id: "user-1", username: "one" },
      role: "member",
    });
    expect(added.allText()).toContain("joined");

    const removed = await exec("squad", {
      subcommand: "remove",
      squad: "Zenith A",
      user: { id: "user-1", username: "one" },
    });
    expect(removed.allText()).toContain("removed");

    const badRemove = await exec("squad", {
      subcommand: "remove",
      squad: "Zenith A",
      user: { id: "user-1", username: "one" },
    });
    expect(badRemove.allText()).toContain("not a member");
  });
});

describe("/lineup command", () => {
  it("assigns a lineup, shows the lineup card, and assigns the Discord role when it exists", async () => {
    await exec("squad", { subcommand: "create", name: "Zenith A" });
    const added: string[] = [];
    const fake = new FakeChatInput({
      commandName: "lineup",
      options: { subcommand: "assign", squad: "Zenith A", user: { id: "u1", username: "one" }, lineup: "Main Lineup" },
      permissions: ["ManageRoles"],
    });
    (fake as unknown as Record<string, unknown>).guild = fakeGuild(["Main Lineup"], added);
    await cmd("lineup").execute(fake as never, ctx);
    expect(fake.allText()).toContain("Main Lineup");
    expect(fake.allText()).toContain("<@u1>");
    expect(fake.allText()).toContain('Discord role "Main Lineup" assigned');
    expect(added).toEqual(["u1:Main Lineup"]);
    expect(lib.lineupCard(db, 1)!.main).toEqual(["u1"]);
  });

  it("records in DB even when the Discord role does not exist", async () => {
    await exec("squad", { subcommand: "create", name: "Zenith A" });
    const fake = new FakeChatInput({
      commandName: "lineup",
      options: { subcommand: "assign", squad: "Zenith A", user: { id: "u1", username: "one" }, lineup: "Prime" },
      permissions: ["ManageRoles"],
    });
    (fake as unknown as Record<string, unknown>).guild = fakeGuild([], []);
    await cmd("lineup").execute(fake as never, ctx);
    expect(fake.allText()).toContain("not found on this server");
    expect(lib.lineupCard(db, 1)!.prime).toEqual(["u1"]);
  });

  it("requires ManageRoles and rejects bad lineups", async () => {
    await exec("squad", { subcommand: "create", name: "Zenith A" });
    const noPerm = await exec(
      "lineup",
      { subcommand: "assign", squad: "Zenith A", user: { id: "u1", username: "one" }, lineup: "Prime" },
      { permissions: [] },
    );
    expect(noPerm.allText()).toContain("Manage Roles");
    const bad = await exec(
      "lineup",
      { subcommand: "assign", squad: "Zenith A", user: { id: "u1", username: "one" }, lineup: "Bench" },
      { permissions: ["ManageRoles"] },
    );
    expect(bad.allText()).toContain("Lineup must be one of");
  });
});

describe("/scrim command + RSVP button", () => {
  it("schedules with an attendance button and tracks RSVPs", async () => {
    const scheduled = await exec("scrim", {
      subcommand: "schedule",
      opponent: "Team X",
      date: "2099-01-10",
      time: "20:30",
    });
    expect(scheduled.allText()).toContain("Scrim scheduled");
    expect(JSON.stringify(scheduled.replies)).toContain("selena:scrim:rsvp:1:yes");
    expect(JSON.stringify(scheduled.replies)).toContain("selena:scrim:rsvp:1:no");

    const yes = new FakeButton({ customId: "selena:scrim:rsvp:1:yes", userId: "u1" });
    await buttonHandlers["selena:scrim"]!(yes as never, ctx);
    expect(lib.getRsvpCounts(db, 1)).toEqual({ yes: 1, no: 0 });
    const no = new FakeButton({ customId: "selena:scrim:rsvp:1:no", userId: "u1" });
    await buttonHandlers["selena:scrim"]!(no as never, ctx);
    expect(lib.getRsvpCounts(db, 1)).toEqual({ yes: 0, no: 1 });

    const listed = await exec("scrim", { subcommand: "list" });
    expect(listed.allText()).toContain("Team X");
  });

  it("rejects past dates and unknown scrims on RSVP", async () => {
    const past = await exec("scrim", {
      subcommand: "schedule",
      opponent: "Team X",
      date: "2020-01-01",
      time: "10:00",
    });
    expect(past.allText()).toContain("in the past");
    const ghost = new FakeButton({ customId: "selena:scrim:rsvp:999:yes", userId: "u1" });
    await buttonHandlers["selena:scrim"]!(ghost as never, ctx);
    expect(ghost.replies[0]).toBeDefined();
  });
});

describe("/tryout command + modal + accept/reject buttons", () => {
  it("opens a modal and logs a valid tryout on submit", async () => {
    const opened = await exec("tryout", {});
    expect(opened.replies.some((r) => r.kind === "showModal")).toBe(true);

    const modal = new FakeModalSubmit({
      customId: "selena:tryout:submit",
      userId: "user-1",
      fields: { ign: "Eres", mlbb_id: "12345", role: "Jungler", rank: "Mythic", heroes: "Ling, Selena" },
    });
    await modalHandlers["selena:tryout"]!(modal as never, ctx);
    expect(modal.replies.length).toBeGreaterThan(0);
    const tryout = lib.getTryout(db, "guild-1", 1);
    expect(tryout?.status).toBe("pending");
    expect(tryout?.ign).toBe("Eres");
  });

  it("rejects a bad rank on modal submit", async () => {
    const modal = new FakeModalSubmit({
      customId: "selena:tryout:submit",
      userId: "user-1",
      fields: { ign: "Eres", mlbb_id: "12345", role: "Jungler", rank: "Immortal", heroes: "Ling" },
    });
    await modalHandlers["selena:tryout"]!(modal as never, ctx);
    expect(lib.getTryout(db, "guild-1", 1)).toBeUndefined();
  });

  it("accept/reject buttons update status", async () => {
    lib.submitTryout(db, "guild-1", "user-1", { ign: "Eres", mlbbId: "1", role: "Jungler", rank: "Mythic", heroes: "Ling" }, NOW);
    lib.submitTryout(db, "guild-1", "user-2", { ign: "Two", mlbbId: "2", role: "Roamer", rank: "Legend", heroes: "Tigreal" }, NOW);
    const accept = new FakeButton({ customId: "selena:tryout:accept:1", userId: "staff-1" });
    await buttonHandlers["selena:tryout"]!(accept as never, ctx);
    expect(lib.getTryout(db, "guild-1", 1)!.status).toBe("accepted");
    const reject = new FakeButton({ customId: "selena:tryout:reject:2", userId: "staff-1" });
    await buttonHandlers["selena:tryout"]!(reject as never, ctx);
    expect(lib.getTryout(db, "guild-1", 2)!.status).toBe("rejected");
    const again = new FakeButton({ customId: "selena:tryout:accept:1", userId: "staff-1" });
    await buttonHandlers["selena:tryout"]!(again as never, ctx);
    expect(lib.getTryout(db, "guild-1", 1)!.status).toBe("accepted");
  });
});

describe("/bracket + /report-match commands", () => {
  it("creates and views a bracket; rejects non-power-of-two", async () => {
    const created = await exec("bracket", { subcommand: "create", name: "Zenith Cup", teams: "Alpha, Beta, Gamma, Delta" });
    expect(created.allText()).toContain("Bracket created");
    expect(created.allText()).toContain("Alpha vs Beta");
    const view = await exec("bracket", { subcommand: "view", id: 1 });
    expect(view.allText()).toContain("Zenith Cup");
    const bad = await exec("bracket", { subcommand: "create", name: "Bad Cup", teams: "A, B, C" });
    expect(bad.allText()).toContain("power of two");
    const missing = await exec("bracket", { subcommand: "view", id: 999 });
    expect(missing.allText()).toContain("not found");
  });

  it("reports matches through the command and shows standings", async () => {
    await exec("bracket", { subcommand: "create", name: "Zenith Cup", teams: "Alpha, Beta, Gamma, Delta" });
    const state = lib.getBracket(db, 1)!;
    const [semi1, semi2] = state.matches;
    const wrong = await exec("report-match", {
      "bracket-id": 1,
      "match-id": semi1!.id,
      winner: "Gamma",
      "score-a": 2,
      "score-b": 1,
    });
    expect(wrong.allText()).toContain("must be one of this match's teams");
    await exec("report-match", { "bracket-id": 1, "match-id": semi1!.id, winner: "Alpha", "score-a": 2, "score-b": 1 });
    await exec("report-match", { "bracket-id": 1, "match-id": semi2!.id, winner: "Gamma", "score-a": 2, "score-b": 0 });
    const final = lib.getBracket(db, 1)!.matches.find((m) => m.round === 2)!;
    const done = await exec("report-match", {
      "bracket-id": 1,
      "match-id": final.id,
      winner: "Alpha",
      "score-a": 3,
      "score-b": 2,
    });
    expect(done.allText()).toContain("Bracket complete");
    const standings = await exec("bracket", { subcommand: "standings" });
    expect(standings.allText()).toContain("Alpha");
    expect(standings.allText()).toContain("2W");
  });
});

describe("/draft command + buttons", () => {
  it("starts a draft and applies hero-button bans for the turn team", async () => {
    const started = await exec("draft", { subcommand: "start", "team-a": "Alpha", "team-b": "Beta" });
    expect(started.allText()).toContain("Alpha vs Beta");
    expect(started.allText()).toContain("Ban phase");
    const btn = new FakeButton({ customId: "selena:draft:hero:Selena", userId: "u1" });
    (btn as unknown as Record<string, unknown>).channelId = "guild:guild-1";
    await buttonHandlers["selena:draft"]!(btn as never, ctx);
    expect(lib.getDraft("guild:guild-1")!.bansA).toEqual(["Selena"]);
  });

  it("rejects starting a draft with the same team twice", async () => {
    const bad = await exec("draft", { subcommand: "start", "team-a": "Alpha", "team-b": "Alpha" });
    expect(bad.allText()).toContain("must be different");
  });

  it("accepts a ban/pick via the draft modal", async () => {
    lib.createDraft("guild:guild-1", "Alpha", "Beta", NOW);
    const modal = new FakeModalSubmit({
      customId: "selena:draft:modal",
      userId: "u1",
      fields: { team: "A", action: "ban", hero: "Ling" },
    });
    (modal as unknown as Record<string, unknown>).channelId = "guild:guild-1";
    await modalHandlers["selena:draft"]!(modal as never, ctx);
    expect(lib.getDraft("guild:guild-1")!.bansA).toEqual(["Ling"]);
    const badTeam = new FakeModalSubmit({
      customId: "selena:draft:modal",
      userId: "u1",
      fields: { team: "C", action: "ban", hero: "Selena" },
    });
    (badTeam as unknown as Record<string, unknown>).channelId = "guild:guild-1";
    await modalHandlers["selena:draft"]!(badTeam as never, ctx);
    expect(lib.getDraft("guild:guild-1")!.bansA).toEqual(["Ling"]);
  });
});
