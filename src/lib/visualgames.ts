import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import GIFEncoder from "gif-encoder-2";
import { decodeGifFrames } from "./handstrip.js";

/**
 * Visual casino games (Ronit: "not text-based — let the user SEE the
 * flip/spin/reveal, then the result").
 *
 * Blackjack/high-low are already visual (card flip strips) and are NOT
 * touched here. The other four games play as suspense -> reveal: the bot
 * replies with the action animation and neutral text ("Flipping…"),
 * then EDITS that same reply ~2.4s later to the settled visual + the
 * result. The user watches the flip/spin, then sees it land.
 *
 *   * /coinflip — flip.gif (a real TOSS: the coin rises, gets big as
 *     it comes toward the viewer, falls spinning fast, and lands
 *     edge-on — the toss never leaks the result) -> heads.png/tails.png
 *     (TIGHT CLOSE-UPS of the landed face). Tails is a star-emboss
 *     disc, unmistakable at a glance.
 *   * /slots — spin.gif (reels scrolling, never settles on a combination)
 *     -> a strip composed at reply time from the REAL result symbols
 *     (machine frame + symbol tiles; never a canned 7-7-7).
 *   * /roulette — spin.gif (wheel turning, ball orbiting) -> wheel-<nn>.png
 *     (the 37-pocket European wheel with the ball on the ACTUAL number).
 *   * /scratch — three covered foil tiles ("?") -> the same three tiles
 *     revealed with the real drawn symbols.
 *
 * SMALL BUT SHARP: the shipped files are small (~240-320px wide, so
 * they take little space on screen) but rendered at 2x+ and
 * Lanczos-downscaled with an unsharp pass — the card-strip trick —
 * so they stay crisp, not blurry.
 *
 * Assets live in assets/games/ (built by scripts/render_visual_games.py).
 * Every visual has a TRANSPARENT background (the standing bg rule) and
 * was composite-checked on Discord dark (#313338) before shipping.
 * Game logic, bets and payouts are NOT changed here — only presentation.
 * If a visual asset is missing at runtime, the composer returns null
 * and the caller falls back to the old text-only reply.
 */

/** How long the suspense (spin/flip) phase plays before the reveal edit. */
export const VISUAL_SUSPENSE = { ms: 2400 };

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Directory holding the visual-game assets. */
export function gamesAssetDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../assets/games");
}

/** Read an asset file, or null when it is missing (caller falls back). */
export function tryReadAsset(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Coinflip
// ---------------------------------------------------------------------------

/** The toss: the $ coin rising, looming, falling, landing edge-on. */
export function coinflipFlipPath(): string {
  return resolve(gamesAssetDir(), "coinflip", "flip.gif");
}

/** The landed face: a tight close-up on the same 240x140 canvas as the toss. */
export function coinflipLandedPath(result: "heads" | "tails"): string {
  return resolve(gamesAssetDir(), "coinflip", result === "heads" ? "heads.png" : "tails.png");
}

// ---------------------------------------------------------------------------
// Roulette — European wheel order + ball angle
// ---------------------------------------------------------------------------

/**
 * Canonical European single-zero wheel order, clockwise from 0
 * (verified against multiple published references). The settled wheel
 * images are rendered from this exact order by
 * scripts/render_visual_games.py — the angle below and the PNGs agree
 * by construction, and the script asserts the ball sits on the right
 * pocket for all 37 numbers.
 */
export const ROULETTE_WHEEL_ORDER: readonly number[] = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24,
  16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];

/** Pocket index of a number in the wheel order (0 is the first pocket). */
export function roulettePocketIndex(roll: number): number {
  const i = ROULETTE_WHEEL_ORDER.indexOf(roll);
  if (i < 0) throw new Error(`not a roulette number: ${roll}`);
  return i;
}

/**
 * Centre angle (degrees) of a number's pocket, PIL convention: 0 deg =
 * 3 o'clock, positive = clockwise, so pocket 0 sits at the top (-90).
 * Adjacent pockets differ by exactly 360/37.
 */
export function roulettePocketAngle(roll: number): number {
  return -90 + (roulettePocketIndex(roll) + 0.5) * (360 / 37);
}

/** Settled wheel image with the ball on `roll`'s pocket. */
export function rouletteWheelPath(roll: number): string {
  return resolve(gamesAssetDir(), "roulette", `wheel-${String(roll).padStart(2, "0")}.png`);
}

export function rouletteWheelExists(roll: number): boolean {
  return existsSync(rouletteWheelPath(roll));
}

/** The spinning wheel (12 frames, loops while the user watches). */
export function rouletteSpinPath(): string {
  return resolve(gamesAssetDir(), "roulette", "spin.gif");
}

// ---------------------------------------------------------------------------
// Slots — settled strip composed at reply time from the real result
// ---------------------------------------------------------------------------

export const SLOTS_W = 320;
export const SLOTS_H = 210;
/** (x, y) of each reel window in the machine frame (see the script). */
export const SLOT_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [39, 55],
  [126, 55],
  [213, 55],
];
export const SLOT_TILE_W = 69;
export const SLOT_TILE_H = 78;

/** Slot emoji -> reel tile file (mirrors SLOT_SYMBOLS in lib/casino.ts). */
export const SLOT_TILE_KEYS: Record<string, string> = {
  "🍒": "cherry",
  "🍋": "lemon",
  "🍇": "grape",
  "🔔": "bell",
  "⭐": "star",
  "💎": "diamond",
  "🍀": "clover",
  "7️⃣": "seven",
};

export function slotsSpinPath(): string {
  return resolve(gamesAssetDir(), "slots", "spin.gif");
}

export function slotsMachinePath(): string {
  return resolve(gamesAssetDir(), "slots", "machine.gif");
}

export function slotsTilePath(key: string): string {
  return resolve(gamesAssetDir(), "slots", "tiles", `${key}.gif`);
}

// ---------------------------------------------------------------------------
// Scratch — covered / revealed tile strips
// ---------------------------------------------------------------------------

export const SCRATCH_W = 320;
export const SCRATCH_H = 120;
/** (x, y) of each tile in the scratch strip (see the script). */
export const SCRATCH_TILES: ReadonlyArray<readonly [number, number]> = [
  [18, 9],
  [117, 9],
  [216, 9],
];
export const SCRATCH_TILE_W = 87;
export const SCRATCH_TILE_H = 100;

/** Scratch emoji -> tile file (mirrors SCRATCH_SYMBOLS in lib/casino.ts). */
export const SCRATCH_TILE_KEYS: Record<string, string> = {
  "🍒": "cherry",
  "⭐": "star",
  "💎": "diamond",
  "7️⃣": "seven",
};

export function scratchTilePath(key: string): string {
  return resolve(gamesAssetDir(), "scratch", "tiles", `${key}.gif`);
}

export function scratchCoverPath(): string {
  return resolve(gamesAssetDir(), "scratch", "tiles", "cover.gif");
}

// ---------------------------------------------------------------------------
// Runtime GIF composition (same pattern as src/lib/handstrip.ts: pure-JS
// decode with gifuct-js, encode with gif-encoder-2, magenta transparency,
// disposal 2, play-once). Kept local so the card path is never touched.
// ---------------------------------------------------------------------------

/** Magenta marks transparent pixels for the GIF encoder. */
const TRANSPARENT_RGB = 0xff00ff;

function magentaTransparent(f: Buffer): Buffer {
  const out = Buffer.from(f);
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) {
      out[i] = 255;
      out[i + 1] = 0;
      out[i + 2] = 255;
    }
  }
  return out;
}

function encodeGif(width: number, height: number, frames: Buffer[]): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const enc = new GIFEncoder(width, height);
    const chunks: Buffer[] = [];
    const stream = enc.createReadStream();
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("error", rejectPromise);
    stream.on("end", () => resolvePromise(Buffer.concat(chunks)));
    enc.start();
    enc.setRepeat(-1); // play once (irrelevant for one frame, explicit anyway)
    enc.setDispose(2);
    (enc as unknown as { setTransparent(color: number): void }).setTransparent(TRANSPARENT_RGB);
    enc.setDelay(100);
    enc.setQuality(10);
    for (const f of frames) enc.addFrame(magentaTransparent(f));
    enc.finish();
  });
}

/** Paste an RGBA image onto the canvas, skipping transparent pixels. */
function pasteRgba(
  dst: Uint8ClampedArray,
  dstW: number,
  src: Buffer,
  srcW: number,
  srcH: number,
  dx: number,
  dy: number,
): void {
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const si = (y * srcW + x) * 4;
      if (src[si + 3] === 0) continue;
      const di = ((dy + y) * dstW + (dx + x)) * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = 255;
    }
  }
}

const tileCache = new Map<string, { width: number; height: number; frame: Buffer } | null>();

/** First frame of a tile GIF, or null when the file is missing/empty. */
function loadTile(path: string): { width: number; height: number; frame: Buffer } | null {
  const cached = tileCache.get(path);
  if (cached !== undefined) return cached;
  let loaded: { width: number; height: number; frame: Buffer } | null = null;
  const buf = tryReadAsset(path);
  if (buf) {
    const { width, height, frames } = decodeGifFrames(buf);
    if (frames.length > 0) loaded = { width, height, frame: frames[0] as Buffer };
  }
  tileCache.set(path, loaded);
  return loaded;
}

/** Test hook: forget cached tiles (forces a re-read from disk). */
export function clearVisualGamesCache(): void {
  tileCache.clear();
}

/**
 * Compose the settled slots strip: the machine frame with the REAL result
 * symbols in its three reel windows. Returns null when any asset is
 * missing or the wrong size (caller falls back to text).
 */
export async function composeSlotsSettled(symbols: string[]): Promise<Buffer | null> {
  if (symbols.length !== 3) return null;
  const keys: string[] = [];
  for (const s of symbols) {
    const key = SLOT_TILE_KEYS[s];
    if (!key) return null;
    keys.push(key);
  }
  const frame = loadTile(slotsMachinePath());
  if (!frame || frame.width !== SLOTS_W || frame.height !== SLOTS_H) return null;
  const tiles = keys.map((k) => loadTile(slotsTilePath(k)));
  for (const t of tiles) {
    if (!t || t.width !== SLOT_TILE_W || t.height !== SLOT_TILE_H) return null;
  }
  const canvas = new Uint8ClampedArray(SLOTS_W * SLOTS_H * 4); // transparent
  tiles.forEach((t, i) => {
    const [x, y] = SLOT_WINDOWS[i] as readonly [number, number];
    pasteRgba(canvas, SLOTS_W, (t as { frame: Buffer }).frame, SLOT_TILE_W, SLOT_TILE_H, x, y);
  });
  pasteRgba(canvas, SLOTS_W, frame.frame, SLOTS_W, SLOTS_H, 0, 0);
  return encodeGif(SLOTS_W, SLOTS_H, [Buffer.from(canvas)]);
}

/**
 * Compose a scratch strip. `symbols === null` -> all three tiles covered
 * (the suspense phase); otherwise the three revealed symbols. Returns
 * null when any asset is missing or the wrong size.
 */
export async function composeScratch(symbols: string[] | null): Promise<Buffer | null> {
  const paths: string[] = [];
  if (symbols === null) {
    paths.push(scratchCoverPath(), scratchCoverPath(), scratchCoverPath());
  } else {
    if (symbols.length !== 3) return null;
    for (const s of symbols) {
      const key = SCRATCH_TILE_KEYS[s];
      if (!key) return null;
      paths.push(scratchTilePath(key));
    }
  }
  const tiles = paths.map((p) => loadTile(p));
  for (const t of tiles) {
    if (!t || t.width !== SCRATCH_TILE_W || t.height !== SCRATCH_TILE_H) return null;
  }
  const canvas = new Uint8ClampedArray(SCRATCH_W * SCRATCH_H * 4); // transparent
  tiles.forEach((t, i) => {
    const [x, y] = SCRATCH_TILES[i] as readonly [number, number];
    pasteRgba(canvas, SCRATCH_W, (t as { frame: Buffer }).frame, SCRATCH_TILE_W, SCRATCH_TILE_H, x, y);
  });
  return encodeGif(SCRATCH_W, SCRATCH_H, [Buffer.from(canvas)]);
}
