import { describe, expect, it } from "vitest";
import { EMOJI_IDS, emoji, type EmojiName } from "../src/lib/emoji.js";

const NAMES: EmojiName[] = ["coin", "slots", "roulette", "trophy", "gift", "party", "fire", "star"];

const FALLBACK: Record<EmojiName, string> = {
  coin: "🪙",
  slots: "🎰",
  roulette: "🎡",
  trophy: "🏆",
  gift: "🎁",
  party: "🎉",
  fire: "🔥",
  star: "⭐",
};

describe("emoji()", () => {
  it("falls back to Unicode while an ID is \"\" (not uploaded yet)", () => {
    for (const name of NAMES) {
      expect(EMOJI_IDS[name]).toBe("");
      expect(emoji(name)).toBe(FALLBACK[name]);
    }
  });

  it("returns animated custom-emoji markup once an ID is set", () => {
    // A real snowflake as a STRING: as a JS number it would round
    // (...678 -> ...680), which is why EMOJI_IDS stores strings.
    EMOJI_IDS.coin = "123456789012345678";
    try {
      expect(emoji("coin")).toBe("<a:coin:123456789012345678>");
      // Other names still fall back — IDs are independent.
      expect(emoji("party")).toBe("🎉");
    } finally {
      EMOJI_IDS.coin = "";
    }
    expect(emoji("coin")).toBe("🪙");
  });

  it("covers every name the commands use", () => {
    expect(Object.keys(EMOJI_IDS).sort()).toEqual([...NAMES].sort());
  });
});
