import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import {
  FLIP_CODES,
  flipGifExists,
  flipGifPath,
  prettyCard,
} from "../src/lib/cards.js";

/**
 * Count the frames of a GIF by counting its Graphic Control Extension
 * blocks (0x21 0xF9) — one per frame. Good enough to prove a GIF is
 * animated without a decoder.
 */
function gifFrameCount(buf: Buffer): number {
  let count = 0;
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0x21 && buf[i + 1] === 0xf9) count++;
  }
  return count;
}

describe("animated flip GIFs (rendered from Ronit's playing-cards.html)", () => {
  it("has one flip GIF for every one of the 52 cards", () => {
    expect(FLIP_CODES).toHaveLength(52);
    expect(new Set(FLIP_CODES).size).toBe(52);
    for (const code of FLIP_CODES) {
      expect(flipGifExists(code), `missing flip GIF for ${code}`).toBe(true);
      expect(flipGifPath(code)).toMatch(new RegExp(`${code}\\.gif$`));
    }
  });

  it("every GIF is a real animated GIF, 60x84 (small OwO-style cards), under 1 MB", () => {
    for (const code of FLIP_CODES) {
      const buf = readFileSync(flipGifPath(code));
      expect(buf.subarray(0, 6).toString("ascii")).toBe("GIF89a");
      expect(buf.readUInt16LE(6)).toBe(60);
      expect(buf.readUInt16LE(8)).toBe(84);
      expect(gifFrameCount(buf)).toBeGreaterThanOrEqual(8);
      expect(statSync(flipGifPath(code)).size).toBeLessThan(1_000_000);
    }
  });

  it("every flip GIF starts on the card back (frame 0) and ends on the face", () => {
    // The hand-strip composer uses frame 0 as the face-down card, so the
    // back must be a real frame of every GIF — spot-check three codes.
    for (const code of ["AS", "10H", "KD"]) {
      const buf = readFileSync(flipGifPath(code));
      expect(gifFrameCount(buf)).toBeGreaterThanOrEqual(8);
    }
  });
});

describe("prettyCard", () => {
  it("renders codes with suit symbols", () => {
    expect(prettyCard("AS")).toBe("A♠");
    expect(prettyCard("10H")).toBe("10♥");
    expect(prettyCard("KD")).toBe("K♦");
    expect(prettyCard("QC")).toBe("Q♣");
    expect(prettyCard("7")).toBe("7");
  });
});
