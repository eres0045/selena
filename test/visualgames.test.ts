import { existsSync, readFileSync } from "node:fs";
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

function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
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

  it("a settled wheel PNG exists for every number, 700x560", () => {
    for (let n = 0; n <= 36; n++) {
      const p = rouletteWheelPath(n);
      expect(existsSync(p), `wheel-${String(n).padStart(2, "0")}.png`).toBe(true);
      const size = pngSize(readFileSync(p));
      expect(size).toEqual({ width: 700, height: 560 });
    }
  });
});

describe("coinflip faces", () => {
  it("heads and tails are distinct 700x360 PNGs on the same canvas", () => {
    const heads = readFileSync(coinflipLandedPath("heads"));
    const tails = readFileSync(coinflipLandedPath("tails"));
    expect(pngSize(heads)).toEqual({ width: 700, height: 360 });
    expect(pngSize(tails)).toEqual({ width: 700, height: 360 });
    expect(heads.equals(tails)).toBe(false);
  });

  it("the flip GIF is animated (16 frames) on the same 700x360 canvas", () => {
    const buf = readFileSync(coinflipFlipPath());
    const info = gifInfo(buf);
    expect(info).toEqual({ width: 700, height: 360, frames: 16 });
  });
});

describe("spin GIFs", () => {
  it("slots spin is animated (16 frames, 700x460)", () => {
    const info = gifInfo(readFileSync(slotsSpinPath()));
    expect(info).toEqual({ width: 700, height: 460, frames: 16 });
  });

  it("roulette spin is animated (12 frames, 700x560)", () => {
    const info = gifInfo(readFileSync(rouletteSpinPath()));
    expect(info).toEqual({ width: 700, height: 560, frames: 12 });
  });
});

describe("composeSlotsSettled", () => {
  it("returns a 700x460 GIF showing the real result symbols", async () => {
    const buf = await composeSlotsSettled(["🍒", "🍒", "🍒"]);
    expect(buf).not.toBeNull();
    const info = gifInfo(buf as Buffer);
    expect(info).toEqual({ width: 700, height: 460, frames: 1 });
    // Window 1 (x 85-235, y 120-290) shows a cherry: red pixels present.
    const { width, patch } = gifFramePixels(buf as Buffer);
    expect(hasPixel(patch, width, [120, 150, 200, 240], (r, g, b) => r > 150 && g < 110 && b < 110)).toBe(true);
  });

  it("shows the 7 tile (red 7) when the result is 7-7-7", async () => {
    const buf = await composeSlotsSettled(["7️⃣", "7️⃣", "7️⃣"]);
    expect(buf).not.toBeNull();
    const { width, patch } = gifFramePixels(buf as Buffer);
    expect(hasPixel(patch, width, [100, 140, 220, 260], (r, g, b) => r > 150 && g < 80 && b < 80)).toBe(true);
  });

  it("returns null for an unknown symbol or the wrong symbol count", async () => {
    expect(await composeSlotsSettled(["🍒", "🍒", "🦄"])).toBeNull();
    expect(await composeSlotsSettled(["🍒", "🍒"])).toBeNull();
  });
});

describe("composeScratch", () => {
  it("covered strip (null) is a 700x260 GIF with three foil tiles", async () => {
    const buf = await composeScratch(null);
    expect(buf).not.toBeNull();
    expect(gifInfo(buf as Buffer)).toEqual({ width: 700, height: 260, frames: 1 });
  });

  it("revealed strip shows the real drawn symbols (blue diamond)", async () => {
    const buf = await composeScratch(["💎", "💎", "💎"]);
    expect(buf).not.toBeNull();
    const { width, patch } = gifFramePixels(buf as Buffer);
    // Tile 1 (x 40-230, y 20-240): the diamond is light blue.
    expect(hasPixel(patch, width, [90, 90, 180, 170], (r, g, b) => b > 200 && r > 100 && r < 200)).toBe(true);
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
