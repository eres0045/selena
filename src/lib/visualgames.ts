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
 * touched here. The other four games play as ONE continuous motion:
 * the bot defers, replies with a single play-once GIF that IS the
 * result — the coin tosses and lands on the real face, the reels spin
 * and stop on the real symbols, the ball rolls into the real pocket,
 * the foil peels to the real symbols — and the GIF freezes there.
 * ~2.4s later the bot edits the SAME reply and changes ONLY the text
 * (the picture is never swapped, never re-attached, never re-looped),
 * so there is no cut/glitch at the end and nothing looks swapped in.
 * The old two-image flow (generic suspense GIF -> settled image) is
 * kept ONLY as a fallback when the runtime composition fails.
 *
 *   * /coinflip — toss frames (rise, loom big, fall spinning, land
 *     edge-on) + the face widening from the sliver to the REAL face
 *     (heads $ / tails star) and holding.
 *   * /slots — reel-scroll frames with braking delays + one
 *     half-stopped frame + the settled strip with the REAL symbols.
 *   * /roulette — wheel-spin frames (ending back at the base
 *     orientation) + the ball rolling along the rim into the REAL
 *     pocket, then holding.
 *   * /scratch — covered foil tiles, a quick crossfade reveal to the
 *     REAL drawn symbols, then holding.
 *
 * The GIF's landing moment falls just before the ~2.4s text edit, so
 * the player sees it land and then the words confirm it — the text
 * never names the result before the picture shows it.
 *
 * SMALL ON SCREEN: Discord on a phone stretches EVERY attached
 * image to the full message width (~340px) no matter how small the
 * file is — shrinking the file did NOT shrink the display, it just
 * made it blurrier. So every visual ships on a ~700px-wide
 * transparent canvas with the art drawn SMALL and centred in it:
 * when Discord stretches the canvas to message width, the art
 * itself displays at only ~120-170px. (Same mechanism as the v7
 * card strips: 100px cards inside a 700px strip.) Art is rendered
 * at 2x+ and Lanczos-downscaled with an unsharp pass, so it stays
 * crisp.
 *
 * Assets live in assets/games/ (built by scripts/render_visual_games.py).
 * Every visual has a TRANSPARENT background (the standing bg rule) and
 * was composite-checked on Discord dark (#313338) before shipping.
 * Game logic, bets and payouts are NOT changed here — only presentation.
 * If a visual asset is missing at runtime, the composers return null
 * and the caller falls back to the old two-image flow (or text).
 */

/** How long the suspense (spin/flip) phase plays before the reveal edit. */
export const VISUAL_SUSPENSE = { ms: 2400 };

/**
 * Slots spin animation (plain-text frames, OwO-style): how many
 * spinning frames cycle before the settle edit, and the ms between
 * them. 4 frames × 450ms ≈ 1.8s of spin, matching the ~2s suspense of
 * the other games. Tests set frameMs to 0 for speed.
 */
export const SLOT_SPIN = { frames: 4, frameMs: 450 };

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

/** The landed face: the coin ~250px on the same 700x280 canvas as the toss. */
export function coinflipLandedPath(result: "heads" | "tails"): string {
  return resolve(gamesAssetDir(), "coinflip", result === "heads" ? "heads.png" : "tails.png");
}

/**
 * The landed face as a single-frame GIF (same art as the PNG) — the
 * runtime composer decodes the face with the same GIF path as the
 * toss frames, so the landing squash is pixel-exact.
 */
export function coinflipFaceGifPath(result: "heads" | "tails"): string {
  return resolve(gamesAssetDir(), "coinflip", result === "heads" ? "heads.gif" : "tails.gif");
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

/** The spinning wheel (9 frames, ends back at the base orientation). */
export function rouletteSpinPath(): string {
  return resolve(gamesAssetDir(), "roulette", "spin.gif");
}

/** The wheel with NO ball — the composer draws the ball onto it. */
export function rouletteBasePath(): string {
  return resolve(gamesAssetDir(), "roulette", "base.gif");
}

/**
 * Roulette spin geometry, ship px — MUST match scripts/render_visual_games.py
 * (ROULETTE_ART 471x377 on the 700x500 canvas: the render wheel radius
 * 520 and ball orbit 464 scale by 471/1400). The tests pin the last
 * spin frame's ball against these numbers.
 */
export const ROULETTE_SHIP_CX = 350;
export const ROULETTE_SHIP_CY = 250;
export const ROULETTE_SHIP_BALL_R = 156;
export const ROULETTE_SHIP_BALL_D = 22;
/** Spin frames in spin.gif, and the ball's orbit in it (deg, PIL convention). */
export const ROULETTE_SPIN_FRAMES = 9;
export const ROULETTE_BALL_START_DEG = 200;
export const ROULETTE_BALL_STEP_DEG = 42;

// ---------------------------------------------------------------------------
// Slots — settled strip composed at reply time from the real result
// ---------------------------------------------------------------------------

export const SLOTS_W = 700;
export const SLOTS_H = 280;
/** (x, y) of each reel window in the machine frame (see the script). */
export const SLOT_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [218, 85],
  [313, 85],
  [408, 85],
];
export const SLOT_TILE_W = 75;
export const SLOT_TILE_H = 85;

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

export const SCRATCH_W = 700;
export const SCRATCH_H = 150;
/** (x, y) of each tile in the scratch strip (see the script). */
export const SCRATCH_TILES: ReadonlyArray<readonly [number, number]> = [
  [160, 11],
  [295, 11],
  [430, 11],
];
export const SCRATCH_TILE_W = 110;
export const SCRATCH_TILE_H = 127;

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

function encodeGifFrames(width: number, height: number, frames: GifFrame[]): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const enc = new GIFEncoder(width, height);
    const chunks: Buffer[] = [];
    const stream = enc.createReadStream();
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("error", rejectPromise);
    stream.on("end", () => resolvePromise(Buffer.concat(chunks)));
    enc.start();
    enc.setRepeat(-1); // play once (no loop extension — the GIF freezes on its last frame)
    enc.setDispose(2);
    (enc as unknown as { setTransparent(color: number): void }).setTransparent(TRANSPARENT_RGB);
    enc.setDelay(100);
    enc.setQuality(10);
    for (const f of frames) {
      enc.setDelay(f.delayMs);
      enc.addFrame(magentaTransparent(f.pixels));
    }
    enc.finish();
  });
}

/** Single-delay encode (one frame, or several at 100ms each). */
function encodeGif(width: number, height: number, frames: Buffer[]): Promise<Buffer> {
  return encodeGifFrames(
    width,
    height,
    frames.map((pixels) => ({ pixels, delayMs: 100 })),
  );
}

/** One GIF frame: composited RGBA pixels + how long it shows (ms). */
export interface GifFrame {
  pixels: Buffer;
  delayMs: number;
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

/** Test hook: forget cached tiles/frames (forces a re-read from disk). */
export function clearVisualGamesCache(): void {
  tileCache.clear();
  gifCache.clear();
}

/** Decoded GIF asset (all frames composited, RGBA, canvas-sized). */
interface DecodedGif {
  width: number;
  height: number;
  frames: Buffer[];
}

const gifCache = new Map<string, DecodedGif | null>();

/**
 * Decode a GIF asset into composited RGBA frames, cached per process
 * (decoding costs ~100-160ms; the spin GIFs are reused every game).
 * Null when the file is missing or undecodable.
 */
function decodeGifAsset(path: string): DecodedGif | null {
  const cached = gifCache.get(path);
  if (cached !== undefined) return cached;
  let loaded: DecodedGif | null = null;
  const buf = tryReadAsset(path);
  if (buf) {
    try {
      const { width, height, frames } = decodeGifFrames(buf);
      if (frames.length > 0) loaded = { width, height, frames };
    } catch {
      loaded = null;
    }
  }
  gifCache.set(path, loaded);
  return loaded;
}

/**
 * Compress a frame horizontally around its centre by `factor`
 * (1 = identity, 0.16 = a thin sliver). Nearest-neighbour: the
 * transitional squash frames show for ~100ms each, and the disc's
 * vertical extent is untouched, so this reads as the coin turning
 * edge-on-to-face — exactly the flip the toss already does.
 */
function squashFrameHorizontal(frame: Buffer, width: number, height: number, factor: number): Buffer {
  if (factor >= 1) return Buffer.from(frame);
  const out = Buffer.alloc(frame.length); // transparent
  const cx = width / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.round(cx + (x - cx) / factor);
      if (sx < 0 || sx >= width) continue;
      const si = (y * width + sx) * 4;
      if (frame[si + 3] === 0) continue;
      const di = (y * width + x) * 4;
      out[di] = frame[si];
      out[di + 1] = frame[si + 1];
      out[di + 2] = frame[si + 2];
      out[di + 3] = frame[si + 3];
    }
  }
  return out;
}

/**
 * Draw the roulette ball (white, grey rim) onto a copy of a wheel frame
 * at `angleDeg` (PIL convention: 0 deg = 3 o'clock, positive =
 * clockwise), on the ball's orbit radius. The spin frames draw the
 * ball at render scale; this matches it at ship scale, so a settling
 * frame continues exactly where the last spin frame left the ball.
 */
function drawBallOnFrame(frame: Buffer, width: number, height: number, angleDeg: number): Buffer {
  const out = Buffer.from(frame);
  const a = (angleDeg * Math.PI) / 180;
  const bx = ROULETTE_SHIP_CX + ROULETTE_SHIP_BALL_R * Math.cos(a);
  const by = ROULETTE_SHIP_CY + ROULETTE_SHIP_BALL_R * Math.sin(a);
  const r = ROULETTE_SHIP_BALL_D / 2;
  const rim = 2;
  for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
    const dxMax = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)));
    for (let dx = -dxMax; dx <= dxMax; dx++) {
      const x = Math.round(bx) + dx;
      const y = Math.round(by) + dy;
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const i = (y * width + x) * 4;
      if (dist > r - rim) {
        out[i] = 120;
        out[i + 1] = 120;
        out[i + 2] = 120;
      } else {
        out[i] = 255;
        out[i + 1] = 255;
        out[i + 2] = 255;
      }
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Crossfade between two same-size frames (t = 0 -> a, 1 -> b). */
function blendFrames(a: Buffer, b: Buffer, t: number): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = Math.round(a[i] * (1 - t) + b[i] * t);
  }
  return out;
}

/** Slot symbols in reel-strip order (mirrors SLOT_ORDER in the render script). */
const SLOT_ORDER: readonly string[] = ["🍒", "🍋", "🍇", "🔔", "⭐", "💎", "🍀", "7️⃣"];

/**
 * The slots canvas: tiles pasted at the given positions, then the
 * machine frame on top (its opaque body clips any tile overflow, so a
 * tile offset half out of its window reads as a reel mid-stop — the
 * window shows the boundary between two symbols, like a real machine).
 * Returns null when the frame is missing or the wrong size.
 */
function slotsCanvas(placements: Array<{ frame: Buffer; x: number; y: number }>): Buffer | null {
  const frame = loadTile(slotsMachinePath());
  if (!frame || frame.width !== SLOTS_W || frame.height !== SLOTS_H) return null;
  const canvas = new Uint8ClampedArray(SLOTS_W * SLOTS_H * 4); // transparent
  for (const p of placements) pasteRgba(canvas, SLOTS_W, p.frame, SLOT_TILE_W, SLOT_TILE_H, p.x, p.y);
  pasteRgba(canvas, SLOTS_W, frame.frame, SLOTS_W, SLOTS_H, 0, 0);
  return Buffer.from(canvas);
}

/**
 * The settled slots strip as a raw RGBA frame: the machine frame with
 * the REAL result symbols in its three reel windows. Null when any
 * asset is missing or the wrong size.
 */
export function composeSlotsSettledFrame(symbols: string[]): Buffer | null {
  if (symbols.length !== 3) return null;
  const placements: Array<{ frame: Buffer; x: number; y: number }> = [];
  for (let i = 0; i < 3; i++) {
    const key = SLOT_TILE_KEYS[symbols[i] as string];
    if (!key) return null;
    const t = loadTile(slotsTilePath(key));
    if (!t || t.width !== SLOT_TILE_W || t.height !== SLOT_TILE_H) return null;
    const [x, y] = SLOT_WINDOWS[i] as readonly [number, number];
    placements.push({ frame: t.frame, x, y });
  }
  return slotsCanvas(placements);
}

/**
 * One braking frame: each reel half-stopped — the result symbol
 * arriving from below, the previous symbol leaving at the top. The
 * reels travel upward (the spin GIF's offsets grow), so the symbol
 * before the result in strip order is the one leaving.
 */
export function composeSlotsBrakeFrame(symbols: string[]): Buffer | null {
  if (symbols.length !== 3) return null;
  const dy = Math.floor(SLOT_TILE_H / 2); // half a tile out of the window
  const placements: Array<{ frame: Buffer; x: number; y: number }> = [];
  for (let i = 0; i < 3; i++) {
    const sym = symbols[i] as string;
    const key = SLOT_TILE_KEYS[sym];
    if (!key) return null;
    const t = loadTile(slotsTilePath(key));
    if (!t || t.width !== SLOT_TILE_W || t.height !== SLOT_TILE_H) return null;
    const orderIdx = SLOT_ORDER.indexOf(sym);
    const prevKey = SLOT_TILE_KEYS[SLOT_ORDER[(orderIdx + SLOT_ORDER.length - 1) % SLOT_ORDER.length] as string];
    const prev = loadTile(slotsTilePath(prevKey as string));
    if (!prev || prev.width !== SLOT_TILE_W || prev.height !== SLOT_TILE_H) return null;
    const [x, y] = SLOT_WINDOWS[i] as readonly [number, number];
    placements.push({ frame: prev.frame, x, y: y + dy - SLOT_TILE_H });
    placements.push({ frame: t.frame, x, y: y + dy });
  }
  return slotsCanvas(placements);
}

/**
 * Compose the settled slots strip: the machine frame with the REAL result
 * symbols in its three reel windows. Returns null when any asset is
 * missing or the wrong size (caller falls back to text).
 */
export async function composeSlotsSettled(symbols: string[]): Promise<Buffer | null> {
  const frame = composeSlotsSettledFrame(symbols);
  if (!frame) return null;
  return encodeGif(SLOTS_W, SLOTS_H, [frame]);
}

/**
 * Compose a scratch strip as a raw RGBA frame. `symbols === null` ->
 * all three tiles covered (the suspense phase); otherwise the three
 * revealed symbols. Null when any asset is missing or the wrong size.
 */
export function composeScratchFrame(symbols: string[] | null): Buffer | null {
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
  return Buffer.from(canvas);
}

/**
 * Compose a scratch strip. `symbols === null` -> all three tiles covered
 * (the suspense phase); otherwise the three revealed symbols. Returns
 * null when any asset is missing or the wrong size.
 */
export async function composeScratch(symbols: string[] | null): Promise<Buffer | null> {
  const frame = composeScratchFrame(symbols);
  if (!frame) return null;
  return encodeGif(SCRATCH_W, SCRATCH_H, [frame]);
}

// ---------------------------------------------------------------------------
// Runtime result GIFs — ONE continuous motion per game, play-once,
// ending on the REAL result and freezing there. The settle edit then
// changes ONLY the text, so the picture never swaps and nothing looks
// staged. Each composer returns null when an asset is missing or the
// result is invalid — the caller falls back to the old two-image flow.
// ---------------------------------------------------------------------------

/**
 * /coinflip: the toss (16 frames, 75ms) + the face widening from the
 * edge-on sliver to the REAL face (heads $ / tails star) and holding.
 * Lands at ~1.6s, freezes to ~2.2s; the text edit lands at ~2.4s.
 */
export async function composeCoinflipResult(result: "heads" | "tails"): Promise<Buffer | null> {
  if (result !== "heads" && result !== "tails") return null;
  const toss = decodeGifAsset(coinflipFlipPath());
  const face = decodeGifAsset(coinflipFaceGifPath(result));
  if (!toss || toss.width !== 700 || toss.height !== 280 || toss.frames.length !== 16) return null;
  if (!face || face.width !== 700 || face.height !== 280 || face.frames.length < 1) return null;
  const faceFrame = face.frames[0] as Buffer;
  const frames: GifFrame[] = toss.frames.map((pixels) => ({ pixels, delayMs: 75 }));
  // Land: the face widens from the sliver (the toss ends edge-on) to
  // full, then holds on the face.
  for (const k of [0.16, 0.48, 0.8, 1.0]) {
    frames.push({ pixels: squashFrameHorizontal(faceFrame, 700, 280, k), delayMs: 100 });
  }
  frames.push({ pixels: faceFrame, delayMs: 600 });
  return encodeGifFrames(700, 280, frames);
}

/**
 * /slots: the reels scrolling (first 13 frames at speed, last 3
 * braking) + one half-stopped frame + the settled strip with the REAL
 * symbols, holding. Lands at ~1.9s, freezes to ~2.3s.
 */
export async function composeSlotsResult(symbols: string[]): Promise<Buffer | null> {
  const spin = decodeGifAsset(slotsSpinPath());
  if (!spin || spin.width !== SLOTS_W || spin.height !== SLOTS_H || spin.frames.length !== 16) return null;
  const settled = composeSlotsSettledFrame(symbols);
  const brake = composeSlotsBrakeFrame(symbols);
  if (!settled || !brake) return null;
  const frames: GifFrame[] = spin.frames.map((pixels, i) => ({
    pixels,
    delayMs: i < 13 ? 80 : i === 13 ? 120 : i === 14 ? 200 : 300,
  }));
  frames.push({ pixels: brake, delayMs: 200 });
  frames.push({ pixels: settled, delayMs: 400 });
  return encodeGifFrames(SLOTS_W, SLOTS_H, frames);
}

/**
 * /roulette: the wheel spinning (9 frames, ending back at the base
 * orientation) + the ball rolling along the rim into the REAL pocket
 * + holding. Lands at ~1.6s, freezes to ~2.2s.
 */
export async function composeRouletteResult(roll: number): Promise<Buffer | null> {
  if (!Number.isInteger(roll) || roll < 0 || roll > 36) return null;
  const spin = decodeGifAsset(rouletteSpinPath());
  const base = decodeGifAsset(rouletteBasePath());
  if (!spin || spin.width !== 700 || spin.height !== 500 || spin.frames.length !== ROULETTE_SPIN_FRAMES) return null;
  if (!base || base.width !== 700 || base.height !== 500 || base.frames.length < 1) return null;
  const pocketAngle = roulettePocketAngle(roll);
  // The last spin frame leaves the ball here (render script:
  // 200 - 42*(9-1) = -136 deg). Roll it to the pocket along the
  // shortest arc — the wheel itself has stopped by then, like a real
  // wheel: the ball keeps rolling a moment, then drops in.
  const lastBallAngle = ROULETTE_BALL_START_DEG - ROULETTE_BALL_STEP_DEG * (ROULETTE_SPIN_FRAMES - 1);
  const delta = ((pocketAngle - lastBallAngle + 540) % 360) - 180;
  const baseFrame = base.frames[0] as Buffer;
  const frames: GifFrame[] = spin.frames.map((pixels) => ({ pixels, delayMs: 130 }));
  for (const t of [1 / 3, 2 / 3, 1]) {
    frames.push({
      pixels: drawBallOnFrame(baseFrame, 700, 500, lastBallAngle + delta * t),
      delayMs: 150,
    });
  }
  frames.push({ pixels: drawBallOnFrame(baseFrame, 700, 500, pocketAngle), delayMs: 600 });
  return encodeGifFrames(700, 500, frames);
}

/**
 * /scratch: the covered foil tiles holding (the "scratching" wait),
 * a quick crossfade reveal to the REAL drawn symbols, then holding.
 * Reveals at ~1.6s, freezes to ~2.2s.
 */
export async function composeScratchResult(symbols: string[]): Promise<Buffer | null> {
  const covered = composeScratchFrame(null);
  const revealed = composeScratchFrame(symbols);
  if (!covered || !revealed) return null;
  const frames: GifFrame[] = [
    { pixels: covered, delayMs: 1400 },
    { pixels: blendFrames(covered, revealed, 1 / 3), delayMs: 120 },
    { pixels: blendFrames(covered, revealed, 2 / 3), delayMs: 120 },
    { pixels: revealed, delayMs: 600 },
  ];
  return encodeGifFrames(SCRATCH_W, SCRATCH_H, frames);
}
