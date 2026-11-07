// Rename guards (2026-11-07): the bot is now "uwu", not "Selena", and the
// temporary /grantpoints command is gone. These tests pin the user-visible
// surfaces — internal identifiers (SelenaDb, selenaEmbed, `selena:` button
// customIds, console logs) deliberately keep the old name.
import { describe, expect, it } from "vitest";
import { allCommands, HELP_GROUPS } from "../src/commands/index.js";
import { pointsEmbed } from "../src/lib/command.js";
import { DARES, generateMeme, memeDescription } from "../src/lib/fun.js";
import { getTestDb } from "./testDb.js";
import { FakeChatInput } from "../src/lib/testkit.js";

const GUILD = "guild-1";

describe("grantpoints removal", () => {
  it("no longer registers a grantpoints command", () => {
    expect(allCommands.some((c) => c.name === "grantpoints")).toBe(false);
  });

  it("has no Owner help group", () => {
    expect(HELP_GROUPS.some((g) => g.category === "Owner")).toBe(false);
  });
});

describe("uwu rename (user-visible strings)", () => {
  it("the /balance description names uwu, not Selena", () => {
    const cmd = allCommands.find((c) => c.name === "balance");
    expect(cmd).toBeDefined();
    expect(cmd!.description).toContain("uwu");
    expect(cmd!.description).not.toContain("Selena");
  });

  it("the /help embed title is 'uwu — all commands'", async () => {
    const cmd = allCommands.find((c) => c.name === "help")!;
    const fake = new FakeChatInput({ commandName: "help", options: {} });
    await (cmd.execute as (i: unknown, ctx: unknown) => Promise<void>)(fake, {
      db: await getTestDb(),
      guildId: GUILD,
    });
    const payload = fake.firstReplyPayload() as Record<string, unknown>;
    const embed = (payload.embeds as { title?: string }[] | undefined)?.[0];
    expect(embed?.title).toBe("uwu — all commands");
  });

  it("the points footer names uwu, not Selena", () => {
    const footer = pointsEmbed("Title", "Body").toJSON().footer?.text ?? "";
    expect(footer).toBe("uwu gold is fun-only — no real money.");
    expect(footer).not.toContain("Selena");
    expect(footer).not.toContain("points");
  });

  it("the dare list says 'I love uwu' and has no Selena", () => {
    expect(DARES.some((d) => d.includes("I love uwu"))).toBe(true);
    expect(DARES.some((d) => d.includes("Selena"))).toBe(false);
  });

  it("the meme text-only note names uwu, not Selena", () => {
    const text = memeDescription(generateMeme(() => 0.5));
    expect(text).toContain("uwu has no Canvas");
    expect(text).not.toContain("Selena");
  });
});
