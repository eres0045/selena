import { existsSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { parseGIF, decompressFrames } from "gifuct-js";
import { describe, expect, it } from "vitest";
import { decodeGifFrames } from "../src/lib/handstrip.js";
import {
  VISUAL_SUSPENSE,
  coinflipFaceGifPath,
  coinflipFlipPath,
  coinflipLandedPath,
  composeCoinflipResult,
  composeRouletteResult,
  composeScratch,
  composeScratchResult,
  composeSlotsResult,
  composeSlotsSettled,
  composeSlotsSettledFrame,
  roulettePocketAngle,
  roulettePocketIndex,
  rouletteSpinPath,
  rouletteWheelPath,
  slotsSpinPath,
  tryReadAsset,
  ROULETTE_BALL_START_DEG,
  ROULETTE_BALL_STEP_DEG,
  ROULETTE_SHIP_BALL_R,
  ROULETTE_SHIP_CX,
  ROULETTE_SHIP_CY,
  ROULETTE_SPIN_FRAMES,
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
  const { width, height, frames } = decodeGifFrames(buf);
  return { width, height, patch: new Uint8ClampedArray(frames[0] as Buffer) };
}

/** Width of the opaque x-range of one GIF frame (0 when fully transparent). */
function frameOpaqueWidth(buf: Buffer, index: number): number {
  const { width, frames } = decodeGifFrames(buf);
  const patch = frames[index] as Buffer;
  const height = patch.length / (width * 4);
  let x0 = width;
  let x1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (patch[(y * width + x) * 4 + 3] !== 0) {
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

/** Minimal PNG reader for what PIL writes: 8-bit RGBA (type 6) or RGB
 * (type 2), non-interlaced. Returns full-canvas RGBA bytes. */
function decodePngRgba(buf: Buffer): { width: number; height: number; rgba: Buffer } {
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
  const rgba = Buffer.alloc(width * height * 4);
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
      const di = (y * width + x) * 4;
      if (channels === 4) {
        rgba[di] = row[x * 4] as number;
        rgba[di + 1] = row[x * 4 + 1] as number;
        rgba[di + 2] = row[x * 4 + 2] as number;
        rgba[di + 3] = row[x * 4 + 3] as number;
      } else {
        rgba[di] = row[x * 3] as number;
        rgba[di + 1] = row[x * 3 + 1] as number;
        rgba[di + 2] = row[x * 3 + 2] as number;
        rgba[di + 3] = 255;
      }
    }
    prev = row;
  }
  return { width, height, rgba };
}

/**
 * Width of the opaque x-range of a PNG (0 when fully transparent).
 * Used to prove the ART is small inside its wide canvas — the
 * property that makes a visual look small on a phone.
 */
function pngOpaqueWidth(buf: Buffer): number {
  const { width, height, rgba } = decodePngRgba(buf);
  let x0 = width;
  let x1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] !== 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
    }
  }
  return x1 < 0 ? 0 : x1 - x0 + 1;
}

function pngFramePixels(buf: Buffer): { width: number; height: number; patch: Uint8ClampedArray } {
  const { width, height, rgba } = decodePngRgba(buf);
  return { width, height, patch: new Uint8ClampedArray(rgba) };
}

function gifDelays(buf: Buffer): number[] {
  const gif = parseGIF(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  return (decompressFrames(gif, true) as Array<{ delay: number }>).map((f) => f.delay ?? 0);
}

/** Total play time of a GIF in ms (gifuct-js reports each frame's delay in ms). */
function gifTotalMs(buf: Buffer): number {
  return gifDelays(buf).reduce((sum, d) => sum + d, 0);
}

/**
 * Composited full-canvas RGBA frames via the production decoder.
 * (Raw gifuct-js patches are CROPPED to the changed region, so pixel
 * positions in a raw patch are NOT canvas positions — every pixel
 * check here must use these composited frames.)
 */
function gifFrames(buf: Buffer): Buffer[] {
  return decodeGifFrames(buf).frames;
}

/** True when at least `frac` of pixels match within `tol` per channel (GIF re-encode is lossy). */
function patchesMatchWithin(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  tol: number,
  frac: number,
): boolean {
  if (a.length !== b.length) return false;
  let ok = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (
      Math.abs((a[i] as number) - (b[i] as number)) <= tol &&
      Math.abs((a[i + 1] as number) - (b[i + 1] as number)) <= tol &&
      Math.abs((a[i + 2] as number) - (b[i + 2] as number)) <= tol &&
      Math.abs((a[i + 3] as number) - (b[i + 3] as number)) <= tol
    ) {
      ok++;
    }
  }
  return ok / (a.length / 4) >= frac;
}

/** Count of near-white pixels in a box (the roulette ball is a solid white disc). */
function countWhite(
  patch: ArrayLike<number>,
  width: number,
  box: [number, number, number, number],
): number {
  const [x0, y0, x1, y1] = box;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      if ((patch[i] as number) > 240 && (patch[i + 1] as number) > 240 && (patch[i + 2] as number) > 240) n++;
    }
  }
  return n;
}

/** True when some pixel in the box satisfies the colour test. */
function hasPixel(
  patch: ArrayLike<number>,
  width: number,
  box: [number, number, number, number],
  test: (r: number, g: number, b: number) => boolean,
): boolean {
  const [x0, y0, x1, y1] = box;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      if ((patch[i + 3] as number) === 0) continue;
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
  it("heads and tails are distinct 700x280 PNGs, coin ~250px on the canvas (~120px on screen)", () => {
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
    // Frame 0: small rising coin (~114px wide). Frame 5: big at the top
    // (~218px wide). Frame 15: edge-on sliver, face hidden (<=10px).
    expect(frameOpaqueWidth(buf, 0)).toBeGreaterThanOrEqual(90);
    expect(frameOpaqueWidth(buf, 0)).toBeLessThanOrEqual(140);
    expect(frameOpaqueWidth(buf, 5)).toBeGreaterThanOrEqual(190);
    expect(frameOpaqueWidth(buf, 5)).toBeLessThanOrEqual(250);
    expect(frameOpaqueWidth(buf, 15)).toBeLessThanOrEqual(10);
  });

  it("each landed face also ships as a single-frame GIF for the runtime composer", () => {
    for (const face of ["heads", "tails"] as const) {
      const info = gifInfo(readFileSync(coinflipFaceGifPath(face)));
      expect(info).toEqual({ width: 700, height: 280, frames: 1 });
    }
  });
});

describe("spin GIFs", () => {
  it("slots spin is animated (16 frames, 700x280)", () => {
    const info = gifInfo(readFileSync(slotsSpinPath()));
    expect(info).toEqual({ width: 700, height: 280, frames: 16 });
  });

  it("roulette spin is animated (9 frames, 700x500, ending back at the base orientation)", () => {
    const info = gifInfo(readFileSync(rouletteSpinPath()));
    expect(info).toEqual({ width: 700, height: 500, frames: 9 });
    expect(ROULETTE_SPIN_FRAMES).toBe(9);
  });

  it("the last roulette spin frame leaves the ball where the composer expects it (-136 deg)", () => {
    // Render script: ball angle 200 - 42*(9-1) = -136 deg, orbit 156px
    // around (350, 250) at ship scale.
    const lastAngle = ROULETTE_BALL_START_DEG - ROULETTE_BALL_STEP_DEG * (ROULETTE_SPIN_FRAMES - 1);
    expect(lastAngle).toBe(-136);
    const buf = readFileSync(rouletteSpinPath());
    const frames = gifFrames(buf);
    const last = frames[frames.length - 1] as Buffer;
    const a = (lastAngle * Math.PI) / 180;
    const bx = Math.round(ROULETTE_SHIP_CX + ROULETTE_SHIP_BALL_R * Math.cos(a));
    const by = Math.round(ROULETTE_SHIP_CY + ROULETTE_SHIP_BALL_R * Math.sin(a));
    // A solid white ball (~22px disc) sits there: hundreds of white px.
    expect(countWhite(last, 700, [bx - 15, by - 15, bx + 15, by + 15])).toBeGreaterThanOrEqual(150);
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
    expect(frameOpaqueWidth(toss, 5)).toBeGreaterThanOrEqual(190); // looming, still reads
    expect(frameOpaqueWidth(toss, 5)).toBeLessThanOrEqual(250);
    // Landed faces: coin ~250px on a 700px canvas -> ~120px on screen.
    expect(pngOpaqueWidth(readFileSync(coinflipLandedPath("heads")))).toBeLessThanOrEqual(300);
    expect(pngOpaqueWidth(readFileSync(coinflipLandedPath("tails")))).toBeLessThanOrEqual(300);
    // Slots machine art ~325px -> ~158px on screen.
    const slotsSpin = readFileSync(slotsSpinPath());
    expect(frameOpaqueWidth(slotsSpin, 0)).toBeGreaterThanOrEqual(280);
    expect(frameOpaqueWidth(slotsSpin, 0)).toBeLessThanOrEqual(400);
    // Roulette wheel ~355px -> ~170px on screen (ball still findable: see below).
    expect(pngOpaqueWidth(readFileSync(rouletteWheelPath(17)))).toBeGreaterThanOrEqual(320);
    expect(pngOpaqueWidth(readFileSync(rouletteWheelPath(17)))).toBeLessThanOrEqual(400);
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

// ---------------------------------------------------------------------------
// Runtime result GIFs — one continuous motion, play-once, ending on the
// REAL result and freezing there. The settle edit then changes only
// the text, so the picture never swaps and nothing looks staged.
// ---------------------------------------------------------------------------

describe("composeCoinflipResult", () => {
  it("tosses and lands on heads: 21 frames, ~2.2s, play-once, final frame is the $ face", async () => {
    const buf = await composeCoinflipResult("heads");
    expect(buf).not.toBeNull();
    expect((buf as Buffer).length).toBeLessThan(2_000_000);
    expect(gifInfo(buf as Buffer)).toEqual({ width: 700, height: 280, frames: 21 });
    expect(gifTotalMs(buf as Buffer)).toBeGreaterThanOrEqual(2100);
    expect(gifTotalMs(buf as Buffer)).toBeLessThanOrEqual(2300);
    expect((buf as Buffer).includes(Buffer.from("NETSCAPE"))).toBe(false); // no loop extension
    const frames = gifFrames(buf as Buffer);
    // The toss frames come first (frame 0 is the small rising coin),
    // the landing widens from a sliver, and the last frame IS the
    // landed face (matches the heads GIF within GIF re-encode loss).
    expect(frameOpaqueWidth(buf as Buffer, 0)).toBeLessThanOrEqual(140);
    const face = gifFrames(readFileSync(coinflipFaceGifPath("heads")))[0] as Buffer;
    const last = frames[frames.length - 1] as Buffer;
    expect(patchesMatchWithin(last, face, 20, 0.97)).toBe(true);
  });

  it("tosses and lands on tails: final frame is the star face, not the $ face", async () => {
    const buf = await composeCoinflipResult("tails");
    expect(buf).not.toBeNull();
    const frames = gifFrames(buf as Buffer);
    const last = frames[frames.length - 1] as Buffer;
    const tailsFace = gifFrames(readFileSync(coinflipFaceGifPath("tails")))[0] as Buffer;
    const headsFace = gifFrames(readFileSync(coinflipFaceGifPath("heads")))[0] as Buffer;
    expect(patchesMatchWithin(last, tailsFace, 20, 0.97)).toBe(true);
    expect(patchesMatchWithin(last, headsFace, 20, 0.97)).toBe(false);
  });
});

describe("composeSlotsResult", () => {
  it("spins, brakes and stops on the real symbols: 18 frames, ~2.3s, play-once", async () => {
    const buf = await composeSlotsResult(["🍒", "🍒", "🍒"]);
    expect(buf).not.toBeNull();
    expect((buf as Buffer).length).toBeLessThan(2_000_000);
    expect(gifInfo(buf as Buffer)).toEqual({ width: 700, height: 280, frames: 18 });
    expect(gifTotalMs(buf as Buffer)).toBeGreaterThanOrEqual(2160);
    expect(gifTotalMs(buf as Buffer)).toBeLessThanOrEqual(2360);
    expect((buf as Buffer).includes(Buffer.from("NETSCAPE"))).toBe(false);
    // The last frame IS the settled strip (matches the composed strip
    // within GIF re-encode loss) — and window 1 shows a cherry.
    const frames = gifFrames(buf as Buffer);
    const last = frames[frames.length - 1] as Buffer;
    const settled = (await composeSlotsSettled(["🍒", "🍒", "🍒"])) as Buffer;
    const settledFrame = gifFrames(settled)[0] as Buffer;
    expect(patchesMatchWithin(last, settledFrame, 20, 0.97)).toBe(true);
    expect(hasPixel(last, 700, [240, 110, 275, 145], (r, g, b) => r > 150 && g < 110 && b < 110)).toBe(true);
  });

  it("returns null for an unknown symbol", async () => {
    expect(await composeSlotsResult(["🍒", "🍒", "🦄"])).toBeNull();
    expect(await composeSlotsResult(["🍒", "🍒"])).toBeNull();
  });
});

describe("composeRouletteResult", () => {
  it("spins and settles the ball in the real pocket: 13 frames, ~2.2s, play-once", async () => {
    const buf = await composeRouletteResult(17);
    expect(buf).not.toBeNull();
    expect((buf as Buffer).length).toBeLessThan(2_000_000);
    expect(gifInfo(buf as Buffer)).toEqual({ width: 700, height: 500, frames: 13 });
    expect(gifTotalMs(buf as Buffer)).toBeGreaterThanOrEqual(2120);
    expect(gifTotalMs(buf as Buffer)).toBeLessThanOrEqual(2320);
    expect((buf as Buffer).includes(Buffer.from("NETSCAPE"))).toBe(false);
    // The last frame has the white ball ON 17's pocket — the same
    // spot the settled wheel PNG has it.
    const a = (roulettePocketAngle(17) * Math.PI) / 180;
    const bx = Math.round(ROULETTE_SHIP_CX + ROULETTE_SHIP_BALL_R * Math.cos(a));
    const by = Math.round(ROULETTE_SHIP_CY + ROULETTE_SHIP_BALL_R * Math.sin(a));
    const frames = gifFrames(buf as Buffer);
    const last = frames[frames.length - 1] as Buffer;
    expect(countWhite(last, 700, [bx - 15, by - 15, bx + 15, by + 15])).toBeGreaterThanOrEqual(150);
    const wheel = pngFramePixels(readFileSync(rouletteWheelPath(17)));
    expect(countWhite(wheel.patch, 700, [bx - 15, by - 15, bx + 15, by + 15])).toBeGreaterThanOrEqual(150);
  });

  it("returns null for numbers that are not on the wheel", async () => {
    expect(await composeRouletteResult(37)).toBeNull();
    expect(await composeRouletteResult(-1)).toBeNull();
  });
});

describe("composeScratchResult", () => {
  it("holds covered, reveals the real symbols, then holds: 4 frames, ~2.2s, play-once", async () => {
    const buf = await composeScratchResult(["💎", "💎", "💎"]);
    expect(buf).not.toBeNull();
    expect((buf as Buffer).length).toBeLessThan(2_000_000);
    expect(gifInfo(buf as Buffer)).toEqual({ width: 700, height: 150, frames: 4 });
    expect(gifTotalMs(buf as Buffer)).toBeGreaterThanOrEqual(2140);
    expect(gifTotalMs(buf as Buffer)).toBeLessThanOrEqual(2340);
    expect((buf as Buffer).includes(Buffer.from("NETSCAPE"))).toBe(false);
    const frames = gifFrames(buf as Buffer);
    const first = frames[0] as Buffer;
    const last = frames[frames.length - 1] as Buffer;
    // First frame: covered foil (silver-grey) in tile 1 — no strong-blue
    // diamond pixels at all (the foil's pale blue-grey never exceeds b-r 60).
    expect(hasPixel(first, 700, [185, 45, 245, 105], (r, g, b) => r > 150 && r < 220 && Math.abs(r - b) < 25)).toBe(true);
    expect(hasPixel(first, 700, [185, 45, 245, 105], (r, g, b) => b - r > 60)).toBe(false);
    // Last frame: the revealed diamond in tile 1 (strong blue).
    expect(hasPixel(last, 700, [185, 45, 245, 105], (r, g, b) => b - r > 60)).toBe(true);
  });

  it("returns null for an unknown symbol", async () => {
    expect(await composeScratchResult(["💎", "💎", "🦄"])).toBeNull();
  });
});
