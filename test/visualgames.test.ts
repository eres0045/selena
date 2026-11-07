import { existsSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { parseGIF, decompressFrames } from "gifuct-js";
import { describe, expect, it } from "vitest";
import {
  VISUAL_SUSPENSE,
  coinflipFlipPath,
  coinflipLandedPath,
  composeScratch,
  composeSlotsSettled,
  roulettePocketAngle,
  roulettePocketIndex,
  rouletteSpinPath,
  rouletteWheelPath,
  slotsSpinPath,
  tryReadAsset,
  ROULETTE_WHEEL_ORDER,
} from "../src/lib/visualgames.js";

// The module default (captured before any test can mutate it).
const DEFAULT_SUSPENSE_MS = VISUAL_SUSPENSE.ms;

function gifInfo(buf: Buffer): { width: number; height: number; frames: number } {
  const gif = parseGIF(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const frames = decompressFrames(gif, true);
  return { width: gif.lsd.width as number, height: gif.lsd.height as number, frames: frames.length };
}

function gifFramePixels(buf: Buffer): { width: number; height: number; patch: Uint8ClampedArray } {
  const gif = parseGIF(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const frames = decompressFrames(gif, true);
  const f = frames[0] as { dims: { width: number; height: number }; patch: Uint8ClampedArray };
  return { width: f.dims.width, height: f.dims.height, patch: f.patch };
}

/** Width of the opaque x-range of one GIF frame (0 when fully transparent). */
function frameOpaqueWidth(buf: Buffer, index: number): number {
  const gif = parseGIF(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const frames = decompressFrames(gif, true);
  const f = frames[index] as { dims: { width: number; height: number }; patch: Uint8ClampedArray };
  let x0 = f.dims.width;
  let x1 = -1;
  for (let y = 0; y < f.dims.height; y++) {
    for (let x = 0; x < f.dims.width; x++) {
      if (f.patch[(y * f.dims.width + x) * 4 + 3] !== 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
    }
  }
  return x1 < 0 ? 0 : x1 - x0 + 1;
}

function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Width of the opaque x-range of a PNG (0 when fully transparent).
 * Minimal reader for what PIL writes: 8-bit RGBA (type 6) or RGB
 * (type 2), non-interlaced. Used to prove the ART is small inside
 * its wide canvas — the property that makes a visual look small on
 * a phone. */
function pngOpaqueWidth(buf: Buffer): number {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error("not a PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] as number;
      colorType = data[9] as number;
      if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || data[12] !== 0) {
        throw new Error(`unsupported PNG: bitDepth ${bitDepth} colorType ${colorType}`);
      }
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + len;
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const bpp = channels;
  let x0 = width;
  let x1 = -1;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart] as number;
    const row = Buffer.from(raw.subarray(rowStart + 1, rowStart + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? (row[i - bpp] as number) : 0;
      const b = prev[i] as number;
      const c = i >= bpp ? (prev[i - bpp] as number) : 0;
      let v = row[i] as number;
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (v + pr) & 0xff;
      }
      row[i] = v;
    }
    for (let x = 0; x < width; x++) {
      const alpha = channels === 4 ? (row[x * 4 + 3] as number) : 255;
      if (alpha !== 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
    }
    prev = row;
  }
  return x1 < 0 ? 0 : x1 - x0 + 1;
}

/** True when some pixel in the box satisfies the colour test. */
function hasPixel(
  patch: Uint8ClampedArray,
  width: number,
  box: [number, number, number, number],
  test: (r: number, g: number, b: number) => boolean,
): boolean {
  const [x0, y0, x1, y1] = box;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      if (patch[i + 3] === 0) continue;
      if (test(patch[i] as number, patch[i + 1] as number, patch[i + 2] as number)) return true;
    }
  }
  return false;
}

describe("roulette wheel order + ball angle", () => {
  it("is the 37-pocket European order, 0-36 each exactly once", () => {
    expect(ROULETTE_WHEEL_ORDER).toHaveLength(37);
    expect([...ROULETTE_WHEEL_ORDER].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 37 }, (_, i) => i),
    );
    expect(ROULETTE_WHEEL_ORDER[0]).toBe(0);
    expect(ROULETTE_WHEEL_ORDER.slice(0, 8)).toEqual([0, 32, 15, 19, 4, 21, 2, 25]);
  });

  it("pocket 0 is centred at the top (-90 + half a pocket)", () => {
    expect(roulettePocketAngle(0)).toBeCloseTo(-90 + 0.5 * (360 / 37), 9);
    expect(roulettePocketAngle(32)).toBeCloseTo(-90 + 1.5 * (360 / 37), 9);
    expect(roulettePocketAngle(26)).toBeCloseTo(-90 + 36.5 * (360 / 37), 9);
  });

  it("adjacent pockets differ by exactly 360/37 and all 37 angles are distinct", () => {
    const angles = ROULETTE_WHEEL_ORDER.map((n) => roulettePocketAngle(n));
    for (let i = 1; i < angles.length; i++) {
      expect((angles[i] as number) - (angles[i - 1] as number)).toBeCloseTo(360 / 37, 9);
    }
    expect(new Set(angles).size).toBe(37);
  });

  it("the angle for a number maps back to that number's pocket", () => {
    for (let n = 0; n <= 36; n++) {
      const a = roulettePocketAngle(n);
      const idx = Math.floor((((a + 90) % 360) + 360) % 360 / (360 / 37));
      expect(idx).toBe(roulettePocketIndex(n));
    }
  });

  it("throws for numbers that are not on the wheel", () => {
    expect(() => roulettePocketIndex(37)).toThrow();
    expect(() => roulettePocketIndex(-1)).toThrow();
  });

  it("a settled wheel PNG exists for every number, 700x500", () => {
    for (let n = 0; n <= 36; n++) {
      const p = rouletteWheelPath(n);
      expect(existsSync(p), `wheel-${String(n).padStart(2, "0")}.png`).toBe(true);
      const size = pngSize(readFileSync(p));
      expect(size).toEqual({ width: 700, height: 500 });
    }
  });
});

describe("coinflip faces", () => {
  it("heads and tails are distinct 700x280 PNGs, coin ~330px on the canvas", () => {
    const heads = readFileSync(coinflipLandedPath("heads"));
    const tails = readFileSync(coinflipLandedPath("tails"));
    expect(pngSize(heads)).toEqual({ width: 700, height: 280 });
    expect(pngSize(tails)).toEqual({ width: 700, height: 280 });
    expect(heads.equals(tails)).toBe(false);
  });

  it("the toss GIF is animated (16 frames) on the same 700x280 canvas", () => {
    const buf = readFileSync(coinflipFlipPath());
    const info = gifInfo(buf);
    expect(info).toEqual({ width: 700, height: 280, frames: 16 });
  });

  it("the toss rises, looms big, and lands edge-on (never leaks the face)", () => {
    const buf = readFileSync(coinflipFlipPath());
    // Frame 0: small rising coin (~150px wide). Frame 5: big at the top
    // (~288px wide). Frame 15: edge-on sliver, face hidden (<=10px).
    expect(frameOpaqueWidth(buf, 0)).toBeGreaterThanOrEqual(120);
    expect(frameOpaqueWidth(buf, 0)).toBeLessThanOrEqual(180);
    expect(frameOpaqueWidth(buf, 5)).toBeGreaterThanOrEqual(240);
    expect(frameOpaqueWidth(buf, 15)).toBeLessThanOrEqual(10);
  });
});

describe("spin GIFs", () => {
  it("slots spin is animated (16 frames, 700x280)", () => {
    const info = gifInfo(readFileSync(slotsSpinPath()));
    expect(info).toEqual({ width: 700, height: 280, frames: 16 });
  });

  it("roulette spin is animated (12 frames, 700x500)", () => {
    const info = gifInfo(readFileSync(rouletteSpinPath()));
    expect(info).toEqual({ width: 700, height: 500, frames: 12 });
  });
});

describe("small art in a wide canvas — the art, not the file, is small", () => {
  it("every visual's opaque art is well under its 700px canvas width", async () => {
    // Discord stretches the whole 700px canvas to message width on a
    // phone (~340px), so the art displays at art/700 of that. The ART
    // width — not the file width — is what makes a visual look small
    // on screen. (Shrinking the file alone never worked: 240px files
    // still displayed full-width, just blurrier.)
    const toss = readFileSync(coinflipFlipPath());
    expect(frameOpaqueWidth(toss, 5)).toBeGreaterThanOrEqual(240); // looming, still reads
    expect(frameOpaqueWidth(toss, 5)).toBeLessThanOrEqual(340);
    // Landed faces: coin ~330px on a 700px canvas -> ~160px on screen.
    expect(pngOpaqueWidth(readFileSync(coinflipLandedPath("heads")))).toBeLessThanOrEqual(400);
    expect(pngOpaqueWidth(readFileSync(coinflipLandedPath("tails")))).toBeLessThanOrEqual(400);
    // Slots machine art ~325px -> ~158px on screen.
    const slotsSpin = readFileSync(slotsSpinPath());
    expect(frameOpaqueWidth(slotsSpin, 0)).toBeGreaterThanOrEqual(280);
    expect(frameOpaqueWidth(slotsSpin, 0)).toBeLessThanOrEqual(400);
    // Roulette wheel ~456px -> ~221px on screen (the one allowed exception).
    expect(pngOpaqueWidth(readFileSync(rouletteWheelPath(17)))).toBeGreaterThanOrEqual(400);
    expect(pngOpaqueWidth(readFileSync(rouletteWheelPath(17)))).toBeLessThanOrEqual(500);
    // Composed strips: slots machine frame, scratch tiles span 160..540.
    const settledSlots = (await composeSlotsSettled(["🍒", "🍋", "7️⃣"])) as Buffer;
    expect(frameOpaqueWidth(settledSlots, 0)).toBeLessThanOrEqual(400);
    const settledScratch = (await composeScratch(["💎", "⭐", "🍒"])) as Buffer;
    expect(frameOpaqueWidth(settledScratch, 0)).toBeGreaterThanOrEqual(320);
    expect(frameOpaqueWidth(settledScratch, 0)).toBeLessThanOrEqual(450);
  });
});

describe("composeSlotsSettled", () => {
  it("returns a 700x280 GIF showing the real result symbols", async () => {
    const buf = await composeSlotsSettled(["🍒", "🍒", "🍒"]);
    expect(buf).not.toBeNull();
    const info = gifInfo(buf as Buffer);
    expect(info).toEqual({ width: 700, height: 280, frames: 1 });
    // Window 1 (x 218-293, y 85-170) shows a cherry: red pixels present.
    const { width, patch } = gifFramePixels(buf as Buffer);
    expect(hasPixel(patch, width, [240, 110, 275, 145], (r, g, b) => r > 150 && g < 110 && b < 110)).toBe(true);
  });

  it("shows the 7 tile (red 7) when the result is 7-7-7", async () => {
    const buf = await composeSlotsSettled(["7️⃣", "7️⃣", "7️⃣"]);
    expect(buf).not.toBeNull();
    const { width, patch } = gifFramePixels(buf as Buffer);
    expect(hasPixel(patch, width, [235, 105, 275, 145], (r, g, b) => r > 150 && g < 80 && b < 80)).toBe(true);
  });

  it("returns null for an unknown symbol or the wrong symbol count", async () => {
    expect(await composeSlotsSettled(["🍒", "🍒", "🦄"])).toBeNull();
    expect(await composeSlotsSettled(["🍒", "🍒"])).toBeNull();
  });
});

describe("composeScratch", () => {
  it("covered strip (null) is a 700x150 GIF with three foil tiles", async () => {
    const buf = await composeScratch(null);
    expect(buf).not.toBeNull();
    expect(gifInfo(buf as Buffer)).toEqual({ width: 700, height: 150, frames: 1 });
  });

  it("revealed strip shows the real drawn symbols (blue diamond)", async () => {
    const buf = await composeScratch(["💎", "💎", "💎"]);
    expect(buf).not.toBeNull();
    const { width, patch } = gifFramePixels(buf as Buffer);
    // Tile 1 (x 160-270, y 11-138): the diamond is light blue.
    expect(hasPixel(patch, width, [185, 45, 245, 105], (r, g, b) => b > 200 && r > 100 && r < 200)).toBe(true);
  });

  it("returns null for an unknown symbol", async () => {
    expect(await composeScratch(["💎", "💎", "🦄"])).toBeNull();
  });
});

describe("visual suspense timing", () => {
  it("defaults to a ~2.4s watch phase", () => {
    expect(DEFAULT_SUSPENSE_MS).toBe(2400);
  });

  it("tryReadAsset returns null for a missing file", () => {
    expect(tryReadAsset("/definitely/not/a/real/path.gif")).toBeNull();
  });
});
