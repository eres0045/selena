import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { SelenaDb } from "../src/lib/db.js";
import { getTestDb } from "./testDb.js";
import { addPoints, getBalance } from "../src/lib/economy.js";
import { addMonster } from "../src/lib/huntDb.js";
import { MONSTER_BY_ID, type Monster } from "../src/lib/hunt.js";
import { FakeButton, FakeChatInput } from "../src/lib/testkit.js";
import {
  getBattleStreak,
  settleBattle,
  type TeamMemberInput,
} from "../src/lib/battle.js";
import {
  battleCardRenderer,
  battleReplay,
  buttonHandlers,
  commands,
} from "../src/commands/battle.js";
import type { BattleCardInput } from "../src/lib/battleCard.js";

const GUILD = "guild-1";
const ALICE = "user-alice";
const BOB = "user-bob";

function mon(id: number): Monster {
  return MONSTER_BY_ID.get(id)!;
}

/** A side's team from roster ids, all level 1. */
function team(ids: number[]): TeamMemberInput[] {
  return ids.map((id) => ({ monster: mon(id), level: 1 }));
}

async function settle(
  db: SelenaDb,
  winner: "A" | "B" | "draw",
): Promise<{ aStreak: number; bStreak: number }> {
  const settled = await settleBattle(db, {
    guildId: GUILD, aId: ALICE, bId: BOB, winner, wager: 0,
    aTeam: team([91]), bTeam: team([1]),
  });
  return { aStreak: settled.aStreak, bStreak: settled.bStreak };
}

describe("battle win streaks (getBattleStreak / settleBattle)", () => {
  let db: SelenaDb;
  beforeEach(() => {
    db = getTestDb();
  });

  it("streak starts at 0 for a new user (no row yet)", async () => {
    expect(await getBattleStreak(db, ALICE)).toBe(0);
    expect(await getBattleStreak(db, BOB)).toBe(0);
  });

  it("winner streak +1 after settleBattle, loser resets to 0", async () => {
    const streaks = await settle(db, "A");
    expect(streaks).toEqual({ aStreak: 1, bStreak: 0 });
    expect(await getBattleStreak(db, ALICE)).toBe(1);
    expect(await getBattleStreak(db, BOB)).toBe(0);
  });

  it("a second consecutive win makes it 2", async () => {
    await settle(db, "A");
    const streaks = await settle(db, "A");
    expect(streaks).toEqual({ aStreak: 2, bStreak: 0 });
    expect(await getBattleStreak(db, ALICE)).toBe(2);
  });

  it("a loss after wins resets the streak to 0 (and the other side starts at 1)", async () => {
    await settle(db, "A");
    await settle(db, "A");
    expect(await getBattleStreak(db, ALICE)).toBe(2);
    const streaks = await settle(db, "B");
    expect(streaks).toEqual({ aStreak: 0, bStreak: 1 });
    expect(await getBattleStreak(db, ALICE)).toBe(0);
    expect(await getBattleStreak(db, BOB)).toBe(1);
  });

  it("a draw leaves both streaks unchanged (and writes no rows)", async () => {
    await settle(db, "A"); // Alice 1, Bob 0.
    const streaks = await settle(db, "draw");
    expect(streaks).toEqual({ aStreak: 1, bStreak: 0 });
    expect(await getBattleStreak(db, ALICE)).toBe(1);
    expect(await getBattleStreak(db, BOB)).toBe(0);
  });

  it("a draw with no prior battles leaves both at 0 and creates no rows", async () => {
    const streaks = await settle(db, "draw");
    expect(streaks).toEqual({ aStreak: 0, bStreak: 0 });
    const rows = await db.prepare("SELECT * FROM user_battle_streaks").all();
    expect(rows).toEqual([]);
  });

  it("streaks survive a redeploy-style new connection (read-back from the table)", async () => {
    await settle(db, "A");
    await settle(db, "A");
    // Same DB, fresh read — the streak lives in user_battle_streaks,
    // not in memory, so a new process/connection sees it.
    const row = (await db
      .prepare("SELECT streak FROM user_battle_streaks WHERE user_id = ?")
      .get(ALICE)) as { streak: number } | undefined;
    expect(row?.streak).toBe(2);
    expect(await getBattleStreak(db, ALICE)).toBe(2);
    expect(await getBattleStreak(db, BOB)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Replay integration — stubbed renderer via the battleCardRenderer seam
// ---------------------------------------------------------------------------

describe("battle card replay integration", () => {
  let db: SelenaDb;
  const ctx = () => ({ db, guildId: GUILD });
  const realRender = battleCardRenderer.render;
  const fakePng = Buffer.from("fake-png-bytes");

  beforeEach(() => {
    db = getTestDb();
    battleReplay.delayMs = 0;
  });

  afterEach(() => {
    battleCardRenderer.render = realRender;
  });

  async function seedZoo(userId: string, monsterIds: number[]): Promise<void> {
    for (const id of monsterIds) await addMonster(db, GUILD, userId, id, "hunt", Date.now());
  }

  async function acceptBattle(): Promise<FakeButton> {
    await seedZoo(ALICE, [91, 92, 93]);
    await seedZoo(BOB, [1, 2, 3]);
    await addPoints(db, GUILD, ALICE, 1000, "test seed");
    await addPoints(db, GUILD, BOB, 1000, "test seed");
    const cmd = commands.find((c) => c.name === "battle")!;
    const inv = new FakeChatInput({
      commandName: "battle",
      userId: ALICE,
      username: "Alice",
      guildId: GUILD,
      options: { opponent: { id: BOB, username: "Bob" } },
    });
    await cmd.execute(inv as never, ctx());
    const row = (await db
      .prepare("SELECT id FROM battle_challenges WHERE challenger_id = ? AND opponent_id = ? ORDER BY id DESC LIMIT 1")
      .get(ALICE, BOB)) as { id: number } | undefined;
    expect(row, "challenge row created").toBeDefined();
    const btn = new FakeButton({ customId: `selena:battle:accept:${Number(row!.id)}`, userId: BOB, username: "Bob" });
    await buttonHandlers["selena:battle"]!(btn as never, ctx());
    return btn;
  }

  function editPayloads(btn: FakeButton): Array<Record<string, unknown>> {
    return btn.replies
      .filter((r) => r.kind === "editReply")
      .map((r) => r.payload as Record<string, unknown>);
  }

  it("renders a card per round and attaches it to the final edit", async () => {
    const calls: BattleCardInput[] = [];
    battleCardRenderer.render = async (input: BattleCardInput) => {
      calls.push(input);
      return fakePng;
    };
    const btn = await acceptBattle();
    // Opening card first (round 0, full-HP snapshot), then one per round.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]!.round).toBe(0);
    expect(calls[0]!.aFighters.every((f) => f.hp === f.maxHp)).toBe(true);
    expect(calls[0]!.bFighters.every((f) => f.hp === f.maxHp)).toBe(true);
    expect(calls[0]!.actionLine).toBe("The battle begins!");
    // 3 Legendaries vs 3 Commons never draws — the final card carries
    // the footer with the winner's XP and streak.
    const footerCall = calls.find((c) => c.footer);
    expect(footerCall, "final card has a footer").toBeDefined();
    expect(footerCall!.footer!.winnerStreak).toBeGreaterThanOrEqual(1);
    expect(footerCall!.footer!.winnerXp).toBeGreaterThan(0);
    expect(footerCall!.footer!.roundsFought).toBe(footerCall!.round);
    // Every edit (opening, rounds, final) replaced the attachment.
    const edits = editPayloads(btn);
    expect(edits.length).toBe(calls.length);
    for (const payload of edits) {
      const files = payload.files as Array<{ name?: string; attachment?: unknown }> | undefined;
      expect(files, "edit carries a battle.png attachment").toHaveLength(1);
      expect(files![0]!.name).toBe("battle.png");
      expect(files![0]!.attachment).toBe(fakePng);
    }
    // The final edit still carries the plain-text result as content.
    const last = edits[edits.length - 1]!;
    expect(String(last.content ?? "")).toMatch(/wins!|draw/);
  });

  it("a throwing renderer falls back to plain text and the battle still settles", async () => {
    battleCardRenderer.render = async () => {
      throw new Error("renderer boom");
    };
    // Fresh DB: both start at 0. acceptBattle() seeds 1,000 each, then
    // settlement adds winner 100 + loser 25 = +125 total.
    const before = (await getBalance(db, GUILD, ALICE)).points + (await getBalance(db, GUILD, BOB)).points;
    const btn = await acceptBattle();
    const after = (await getBalance(db, GUILD, ALICE)).points + (await getBalance(db, GUILD, BOB)).points;
    expect(after).toBe(before + 2000 + 125);
    const row = (await db
      .prepare("SELECT status FROM battle_challenges WHERE challenger_id = ? AND opponent_id = ? ORDER BY id DESC LIMIT 1")
      .get(ALICE, BOB)) as { status: string } | undefined;
    expect(row?.status).toBe("accepted");
    // Every edit fell back to plain text — no files anywhere.
    const edits = editPayloads(btn);
    expect(edits.length).toBeGreaterThan(0);
    for (const payload of edits) {
      expect(payload.files).toBeUndefined();
      expect(typeof payload.content).toBe("string");
    }
    const last = edits[edits.length - 1]!;
    expect(String(last.content ?? "")).toMatch(/wins!|draw/);
    // The round edits fell back to the old plain-text path too.
    expect(edits.some((p) => String(p.content ?? "").includes("Round 1"))).toBe(true);
  });
});
