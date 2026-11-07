import { describe, expect, it } from "vitest";
import { EMOJI_IDS, emoji, type EmojiName } from "../src/lib/emoji.js";

const NAMES: EmojiName[] = [
  "coin",
  "heads",
  "tails",
  "slots",
  "roulette",
  "trophy",
  "gift",
  "party",
  "fire",
  "star",
];

// Uploaded so far — all ten names now have real IDs. heads/tails are
// STATIC emoji (<:name:id>), the other eight are animated (<a:name:id>).
const UPLOADED: EmojiName[] = ["coin", "slots", "roulette", "trophy", "gift", "party", "fire", "star"];
const STATIC_UPLOADED: EmojiName[] = ["heads", "tails"];

const FALLBACK: Record<EmojiName, string> = {
  coin: "🪙",
  heads: "🪙",
  tails: "⭐",
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

  it("returns animated custom-emoji markup for the real uploaded IDs", () => {
    // Every uploaded ID is a non-empty digit string, and emoji() renders
    // it as <a:name:id> — the markup Discord animates.
    for (const name of UPLOADED) {
      expect(EMOJI_IDS[name]).toMatch(/^[0-9]{10,}$/);
      expect(emoji(name)).toBe(`<a:${name}:${EMOJI_IDS[name]}>`);
    }
    // Static emoji (heads/tails) render as <:name:id> — the `a:`
    // prefix is for animated emoji only.
    for (const name of STATIC_UPLOADED) {
      expect(EMOJI_IDS[name]).toMatch(/^[0-9]{10,}$/);
      expect(emoji(name)).toBe(`<:${name}:${EMOJI_IDS[name]}>`);
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
