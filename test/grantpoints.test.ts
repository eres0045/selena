import { describe, it, expect, beforeEach } from "vitest";
import { type SelenaDb } from "../src/lib/db.js";
import { getTestDb } from "./testDb.js";
import { FakeChatInput } from "../src/lib/testkit.js";
import { getBalance } from "../src/lib/economy.js";
import { commands as grantCommands } from "../src/commands/grantpoints.js";
import { allCommands } from "../src/commands/index.js";
import type { CommandContext } from "../src/lib/command.js";

// TEMPORARY tests for the TEMPORARY /grantpoints command (2026-11-07).
// Remove with src/commands/grantpoints.ts and its registry entries after
// the casino visual test.

let db: SelenaDb;
let ctx: CommandContext;
const GUILD = "guild-1";
const OWNER = "owner-1";
const OTHER = "user-2";

function findCommand(name: string) {
  const cmd = grantCommands.find((c) => c.data.name === name);
  if (!cmd) throw new Error(`command not found: ${name}`);
  return cmd;
}

async function run(
  options: Record<string, unknown>,
  userId: string,
  guildOwnerId?: string,
) {
  const cmd = findCommand("grantpoints");
  const fake = new FakeChatInput({
    commandName: "grantpoints",
    options,
    userId,
    username: userId === OWNER ? "owner" : "tester",
    guildId: GUILD,
    guildOwnerId,
  });
  await cmd.execute(fake as never, ctx);
  return fake;
}

beforeEach(async () => {
  db = getTestDb();
  ctx = { db, guildId: GUILD };
});

describe("/grantpoints (TEMPORARY)", () => {
  it("is registered with amount + optional user options", () => {
    const cmd = findCommand("grantpoints");
    expect(cmd.data.name).toBe("grantpoints");
    const names = cmd.data.options.map((o) => o.name);
    expect(names).toContain("amount");
    expect(names).toContain("user");
    expect(allCommands.some((c) => c.data.name === "grantpoints")).toBe(true);
  });

  it("owner grants points to themselves and the reply shows the new balance", async () => {
    const fake = await run({ amount: 999999 }, OWNER, OWNER);
    expect((await getBalance(db, GUILD, OWNER)).points).toBe(999999);
    expect(fake.allText()).toContain("999,999");
    expect(fake.allText()).toContain("New balance");
    // Success reply is public (not ephemeral) so the grant is verifiable.
    const reply = fake.replies.find((r) => r.kind === "reply");
    expect((reply?.payload as { ephemeral?: boolean } | undefined)?.ephemeral).not.toBe(true);
  });

  it("owner can grant to another user; the invoker balance is untouched", async () => {
    const fake = await run({ amount: 500, user: { id: OTHER, username: "other" } }, OWNER, OWNER);
    expect((await getBalance(db, GUILD, OTHER)).points).toBe(500);
    expect((await getBalance(db, GUILD, OWNER)).points).toBe(0);
    expect(fake.allText()).toContain("500");
  });

  it("non-owner is rejected and no points move", async () => {
    const fake = await run({ amount: 999999 }, OTHER, OWNER);
    expect(fake.allText()).toContain("owner-only");
    expect((await getBalance(db, GUILD, OTHER)).points).toBe(0);
    expect((await getBalance(db, GUILD, OWNER)).points).toBe(0);
    const reply = fake.replies.find((r) => r.kind === "reply");
    expect((reply?.payload as { ephemeral?: boolean } | undefined)?.ephemeral).toBe(true);
  });

  it("non-owner cannot grant to someone else either", async () => {
    const fake = await run({ amount: 100, user: { id: OWNER, username: "owner" } }, OTHER, OWNER);
    expect(fake.allText()).toContain("owner-only");
    expect((await getBalance(db, GUILD, OWNER)).points).toBe(0);
  });

  it("fails closed when the guild/owner cannot be determined", async () => {
    // No guildOwnerId -> FakeChatInput.guild is null -> guard rejects.
    const fake = await run({ amount: 100 }, OWNER);
    expect(fake.allText()).toContain("owner-only");
    expect((await getBalance(db, GUILD, OWNER)).points).toBe(0);
  });

  it("owner with an invalid amount is rejected and no points move", async () => {
    const fake = await run({ amount: 0 }, OWNER, OWNER);
    expect(fake.allText()).toContain("positive whole number");
    expect((await getBalance(db, GUILD, OWNER)).points).toBe(0);
  });
});
