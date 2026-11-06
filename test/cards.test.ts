import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import {
  FLIP_CODES,
  flipGifExists,
  flipGifPath,
  prettyCard,
} from "../src/lib/cards.js";
import { decodeGifFrames } from "../src/lib/handstrip.js";

const LOOP_EXT = Buffer.from("NETSCAPE2.0");

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

/** Fraction of pixels whose RGB differs by more than 10 in any channel. */
function frameDiffFraction(a: Buffer, b: Buffer): number {
  let diff = 0;
  const pixels = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    if (
      Math.abs(a[i] - b[i]) > 10 ||
      Math.abs(a[i + 1] - b[i + 1]) > 10 ||
      Math.abs(a[i + 2] - b[i + 2]) > 10
    ) {
      diff++;
    }
  }
  return diff / pixels;
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

  it("every GIF is a real animated GIF, 100x140, under 1 MB", () => {
    for (const code of FLIP_CODES) {
      const buf = readFileSync(flipGifPath(code));
      expect(buf.subarray(0, 6).toString("ascii")).toBe("GIF89a");
      expect(buf.readUInt16LE(6)).toBe(100);
      expect(buf.readUInt16LE(8)).toBe(140);
      expect(gifFrameCount(buf)).toBeGreaterThanOrEqual(7);
      expect(statSync(flipGifPath(code)).size).toBeLessThan(1_000_000);
    }
  });

  it("every flip GIF plays ONCE (no NETSCAPE2.0 loop extension)", () => {
    for (const code of FLIP_CODES) {
      const buf = readFileSync(flipGifPath(code));
      expect(buf.includes(LOOP_EXT), `${code} loops forever`).toBe(false);
    }
  });

  it("every flip GIF has a transparent background (no felt box)", () => {
    // Spot-check three codes: decode and require the corners transparent
    // (alpha 0) and the card centre opaque on the first and last frames.
    for (const code of ["AS", "10H", "KD"]) {
      const { width, height, frames } = decodeGifFrames(readFileSync(flipGifPath(code)));
      expect(frames.length).toBeGreaterThanOrEqual(7);
      for (const frame of [frames[0] as Buffer, frames[frames.length - 1] as Buffer]) {
        const corner = 0 * 4 + 3;
        const centre = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4 + 3;
        expect(frame[corner]).toBe(0);
        expect(frame[centre]).toBe(255);
      }
    }
  });

  it("every flip GIF starts on the card back and ends settled on the face", () => {
    // Spot-check: the last frame is the face, not the back (huge
    // difference from frame 0), the motion is converging (the last step
    // moves less than the first step), and the last frame shows the full
    // card face (opaque-pixel fraction near the card's area, not the
    // thin sliver of a mid-flip edge-on frame).
    for (const code of ["AS", "10H", "KD"]) {
      const { frames } = decodeGifFrames(readFileSync(flipGifPath(code)));
      const first = frames[0] as Buffer;
      const last = frames[frames.length - 1] as Buffer;
      const prev = frames[frames.length - 2] as Buffer;
      const second = frames[1] as Buffer;
      expect(frameDiffFraction(first, last)).toBeGreaterThan(0.2);
      expect(frameDiffFraction(prev, last)).toBeLessThan(frameDiffFraction(first, second));
      const opaque = (f: Buffer): number => {
        let n = 0;
        for (let i = 3; i < f.length; i += 4) if (f[i] === 255) n++;
        return n / (f.length / 4);
      };
      expect(opaque(last)).toBeGreaterThan(0.8);
      expect(opaque(first)).toBeGreaterThan(0.8);
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
