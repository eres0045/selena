import { describe, expect, it, beforeEach, vi } from "vitest";
import { type SelenaDb } from "../src/lib/db.js";
import { getTestDb } from "./testDb.js";
import { FakeChatInput } from "../src/lib/testkit.js";
import { addPoints } from "../src/lib/economy.js";
import { commands as casinoCommands } from "../src/commands/casino.js";
import { VISUAL_SUSPENSE } from "../src/lib/visualgames.js";
import type { CommandContext } from "../src/lib/command.js";

// When the runtime composition fails (missing asset, bad result), the
// four visual games must fall back to the old two-image flow (generic
// suspense GIF -> settled image) instead of crashing or failing the
// game. Mock all four composers to null and prove the fallback path.
vi.mock("../src/lib/visualgames.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/visualgames.js")>();
  return {
    ...actual,
    composeCoinflipResult: async () => null,
    composeSlotsResult: async () => null,
    composeRouletteResult: async () => null,
    composeScratchResult: async () => null,
  };
});

let db: SelenaDb;
let ctx: CommandContext;
const GUILD = "guild-1";

async function seed(userId: string, points: number): Promise<void> {
  await addPoints(db, GUILD, userId, points, "seed");
}

function findCommand(name: string) {
  const cmd = casinoCommands.find((c) => c.name === name);
  if (!cmd) throw new Error(`command not found: ${name}`);
  return cmd;
}

async function run(name: string, options: Record<string, unknown>, userId = "user-1", username = "tester") {
  const cmd = findCommand(name);
  const fake = new FakeChatInput({ commandName: name, options, userId, username, guildId: GUILD });
  await cmd.execute(fake as never, ctx);
  return fake;
}

beforeEach(async () => {
  db = getTestDb();
  ctx = { db, guildId: GUILD };
  // The visual games wait ~2.4s between the spin and the reveal edit;
  // tests exercise the flow, not the wait.
  VISUAL_SUSPENSE.ms = 0;
});

describe("visual games fallback: composers return null -> old two-image flow", () => {
  function edits(fake: FakeChatInput) {
    return fake.replies.filter((r) => r.kind === "editReply");
  }
  function fileNames(payload: unknown): string[] {
    const p = payload as { files?: Array<{ name?: string | null }> };
    return (p.files ?? []).map((f) => f.name ?? "");
  }
  function embedOf(payload: unknown): { title?: string; description?: string; image?: { url?: string } } | undefined {
    const p = payload as { embeds?: Array<{ title?: string; description?: string; image?: { url?: string } }> };
    return p.embeds?.[0];
  }

  it("coinflip: suspense flip.gif, then the landed face image", async () => {
    await seed("user-1", 1000);
    const fake = await run("coinflip", { bet: 100, guess: "heads" });
    expect(fake.replies[0]?.kind).toBe("deferReply");
    const [spin, settled] = edits(fake);
    expect(fileNames(spin!.payload)).toEqual(["flip.gif"]);
    const landed = /landed \*\*(heads|tails)\*\*/.exec(embedOf(settled!.payload)?.description ?? "")?.[1];
    expect(landed).toMatch(/^(heads|tails)$/);
    expect(fileNames(settled!.payload)).toEqual([`${landed}.png`]);
    expect(embedOf(settled!.payload)?.image?.url).toBe(`attachment://${landed}.png`);
  });

  it("slots: suspense spin.gif, then the settled strip", async () => {
    await seed("user-1", 1000);
    const fake = await run("slots", { bet: 100 });
    const [spin, settled] = edits(fake);
    expect(fileNames(spin!.payload)).toEqual(["spin.gif"]);
    expect(fileNames(settled!.payload)).toEqual(["settled.gif"]);
    expect(embedOf(settled!.payload)?.image?.url).toBe("attachment://settled.gif");
  });

  it("roulette: suspense spin.gif, then the wheel with the ball on the rolled number", async () => {
    await seed("user-1", 1000);
    const fake = await run("roulette", { bet: 100, "bet-on": "red" });
    const [spin, settled] = edits(fake);
    expect(fileNames(spin!.payload)).toEqual(["spin.gif"]);
    const rolled = /landed on \*\*(\d+) /.exec(embedOf(settled!.payload)?.description ?? "")?.[1];
    expect(rolled).toMatch(/^\d+$/);
    const wheelName = `wheel-${String(rolled).padStart(2, "0")}.png`;
    expect(fileNames(settled!.payload)).toEqual([wheelName]);
    expect(embedOf(settled!.payload)?.image?.url).toBe(`attachment://${wheelName}`);
  });

  it("scratch: covered foil tiles, then the revealed tiles", async () => {
    await seed("user-1", 1000);
    const fake = await run("scratch", { bet: 100 });
    const [spin, settled] = edits(fake);
    expect(fileNames(spin!.payload)).toEqual(["covered.gif"]);
    expect(fileNames(settled!.payload)).toEqual(["revealed.gif"]);
    expect(embedOf(settled!.payload)?.image?.url).toBe("attachment://revealed.gif");
  });
});
