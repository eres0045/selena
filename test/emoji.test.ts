import { describe, expect, it } from "vitest";
import { EMOJI_IDS, emoji, type EmojiName } from "../src/lib/emoji.js";

const NAMES: EmojiName[] = ["coin", "gold", "gem", "slots", "roulette", "trophy", "gift", "party", "fire", "star"];

const FALLBACK: Record<EmojiName, string> = {
  coin: "🪙",
  gold: "🪙",
  gem: "💎",
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
    // The committed IDs are real now; blank each one in turn (restoring
    // afterwards) to prove the fallback still works per name.
    for (const name of NAMES) {
      const saved = EMOJI_IDS[name];
      EMOJI_IDS[name] = "";
      try {
        expect(emoji(name)).toBe(FALLBACK[name]);
      } finally {
        EMOJI_IDS[name] = saved;
      }
    }
  });

  it("returns custom-emoji markup for the real uploaded IDs", () => {
    // Every committed ID is a non-empty digit string. Animated names
    // render as <a:name:id>; gold is static so it renders <:gold:id>.
    for (const name of NAMES) {
      expect(EMOJI_IDS[name]).toMatch(/^[0-9]{10,}$/);
      const expected = name === "gold" ? `<:${name}:${EMOJI_IDS[name]}>` : `<a:${name}:${EMOJI_IDS[name]}>`;
      expect(emoji(name)).toBe(expected);
    }
    // A real snowflake as a STRING: as a JS number it would round
    // (...678 -> ...680), which is why EMOJI_IDS stores strings.
    const saved = EMOJI_IDS.coin;
    EMOJI_IDS.coin = "123456789012345678";
    try {
      expect(emoji("coin")).toBe("<a:coin:123456789012345678>");
    } finally {
      EMOJI_IDS.coin = saved;
    }
    expect(emoji("coin")).toBe(`<a:coin:${saved}>`);
  });

  it("covers every name the commands use", () => {
    expect(Object.keys(EMOJI_IDS).sort()).toEqual([...NAMES].sort());
  });
});
