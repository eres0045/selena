import { existsSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  SCRATCH_COVERED,
  VISUAL_SUSPENSE,
  coinflipFaceEmoji,
  rouletteColorDot,
  symbolsLine,
} from "../src/lib/visualgames.js";
import { EMOJI_IDS } from "../src/lib/emoji.js";

// The module default (captured before any test can mutate it).
const DEFAULT_SUSPENSE_MS = VISUAL_SUSPENSE.ms;

function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Minimal PNG decoder: 8-bit RGBA (colour type 6), non-interlaced.
 * Enough to check transparency/size of the shipped emoji PNGs.
 */
function pngRgba(buf: Buffer): { width: number; height: number; pixels: Buffer } {
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let bitDepth = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] as number;
      colorType = data[9] as number;
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  expect(bitDepth).toBe(8);
  expect(colorType).toBe(6);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(width * height * 4);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos] as number;
    pos += 1;
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? (out[x - 4] as number) : 0;
      const b = y > 0 ? (pixels[(y - 1) * stride + x] as number) : 0;
      const c = y > 0 && x >= 4 ? (pixels[(y - 1) * stride + x - 4] as number) : 0;
      const v = row[x] as number;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = (v + pred) & 0xff;
    }
  }
  return { width, height, pixels };
}

function alphaAt(pixels: Buffer, width: number, x: number, y: number): number {
  return pixels[(y * width + x) * 4 + 3] as number;
}

describe("tiny-emoji helpers", () => {
  it("coinflip faces: Unicode fallbacks render while the IDs are blank", () => {
    // heads/tails are NOT uploaded yet — the PNGs are in
    // assets/emoji-animated/ waiting for upload. Until the IDs are
    // filled in src/lib/emoji.ts, the fallbacks show. (When the IDs
    // ARE filled, update this test to expect the <a:heads:id> markup.)
    expect(EMOJI_IDS.heads).toBe("");
    expect(EMOJI_IDS.tails).toBe("");
    expect(coinflipFaceEmoji("heads")).toBe("🪙");
    expect(coinflipFaceEmoji("tails")).toBe("⭐");
    expect(coinflipFaceEmoji("heads")).not.toBe(coinflipFaceEmoji("tails"));
  });

  it("roulette colour dots: red/black/green map to the right dot", () => {
    expect(rouletteColorDot("red")).toBe("🔴");
    expect(rouletteColorDot("black")).toBe("⚫");
    expect(rouletteColorDot("green")).toBe("🟢");
  });

  it("symbolsLine joins the result symbols with spaces", () => {
    expect(symbolsLine(["🍒", "🍋", "7️⃣"])).toBe("🍒 🍋 7️⃣");
    expect(symbolsLine(["💎", "💎", "💎"])).toBe("💎 💎 💎");
    expect(symbolsLine([])).toBe("");
  });

  it("scratch suspense shows three covered tiles", () => {
    expect(SCRATCH_COVERED).toBe("❓ ❓ ❓");
  });
});

describe("coin-face emoji PNGs (upload as server emoji 'heads' / 'tails')", () => {
  const headsPath = "assets/emoji-animated/heads.png";
  const tailsPath = "assets/emoji-animated/tails.png";

  it("both files exist, are 128x128 RGBA, and fit Discord's 256 KB cap", () => {
    for (const p of [headsPath, tailsPath]) {
      expect(existsSync(p), p).toBe(true);
      const buf = readFileSync(p);
      expect(pngSize(buf)).toEqual({ width: 128, height: 128 });
      expect(buf.length).toBeGreaterThan(1000);
      expect(buf.length).toBeLessThanOrEqual(256 * 1024);
    }
  });

  it("heads and tails are distinct faces", () => {
    const heads = readFileSync(headsPath);
    const tails = readFileSync(tailsPath);
    expect(heads.equals(tails)).toBe(false);
  });

  it("transparent corners, opaque centre (clean cutouts, no background)", () => {
    for (const p of [headsPath, tailsPath]) {
      const { width, height, pixels } = pngRgba(readFileSync(p));
      expect(width).toBe(128);
      expect(height).toBe(128);
      for (const [x, y] of [
        [0, 0],
        [127, 0],
        [0, 127],
        [127, 127],
      ] as const) {
        expect(alphaAt(pixels, width, x, y)).toBe(0);
      }
      expect(alphaAt(pixels, width, 64, 64)).toBe(255);
    }
  });
});

describe("visual suspense timing", () => {
  it("defaults to a ~2.4s watch phase", () => {
    expect(DEFAULT_SUSPENSE_MS).toBe(2400);
  });
});
