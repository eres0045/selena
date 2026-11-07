import { describe, expect, it } from "vitest";
import { allCommands, HELP_GROUPS } from "../src/commands/index.js";
import {
  buildHelpEmbed,
  helpAuthor,
  helpEmbedLength,
} from "../src/commands/help.js";

const AVATAR = "https://cdn.discordapp.com/avatars/123/abc.png";

describe("help author (requesting user on the box, OwO-style)", () => {
  it("helpAuthor prefers the display name and uses the avatar URL", () => {
    expect(
      helpAuthor({ username: "eres_007", displayName: "Yohh", displayAvatarURL: () => AVATAR }),
    ).toEqual({ name: "Yohh", iconURL: AVATAR });
  });

  it("helpAuthor falls back to the username when there is no display name", () => {
    expect(helpAuthor({ username: "tester", displayAvatarURL: () => AVATAR })).toEqual({
      name: "tester",
      iconURL: AVATAR,
    });
  });

  it("helpAuthor omits the icon when the user has no displayAvatarURL", () => {
    expect(helpAuthor({ username: "tester" })).toEqual({ name: "tester" });
  });

  it("helpAuthor never throws when displayAvatarURL throws", () => {
    expect(
      helpAuthor({
        username: "tester",
        displayAvatarURL: () => {
          throw new Error("boom");
        },
      }),
    ).toEqual({ name: "tester" });
  });

  it("buildHelpEmbed heads the box with the author's name and avatar", () => {
    const json = buildHelpEmbed(HELP_GROUPS, { name: "Yohh", iconURL: AVATAR }).toJSON();
    expect(json.author).toEqual({ name: "Yohh", icon_url: AVATAR });
    expect(json.title).toBe("Command List");
    // The list itself is unchanged: every command name still present.
    const text = (json.fields ?? []).map((f) => f.value).join(" ");
    for (const cmd of allCommands) {
      expect(text).toContain(`\`${cmd.name}\``);
    }
  });

  it("buildHelpEmbed without an author has no author block", () => {
    expect(buildHelpEmbed(HELP_GROUPS).toJSON().author).toBeUndefined();
  });

  it("helpEmbedLength counts the author name against the embed cap", () => {
    const plain = buildHelpEmbed(HELP_GROUPS);
    const headed = buildHelpEmbed(HELP_GROUPS, { name: "Yohh", iconURL: AVATAR });
    expect(helpEmbedLength(headed)).toBe(helpEmbedLength(plain) + "Yohh".length);
    expect(helpEmbedLength(headed)).toBeLessThanOrEqual(6000);
  });
});
