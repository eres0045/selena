import { readFileSync } from "node:fs";
import { parseGIF, decompressFrames } from "gifuct-js";
import GIFEncoder from "gif-encoder-2";
import { flipGifExists, flipGifPath } from "./cards.js";

/**
 * OwO-style compact card displays: one small strip image per embed.
 *
 * Discord embeds show a single image, so each hand is composed into one
 * small strip (cards side by side with a slight overlap, like a fanned
 * hand, ~60px per card) and both hands go into one image with the dealer
 * on top and the player below. Newly dealt cards keep their animation:
 * the strip is itself an animated GIF in which the new card flips from
 * its back to its face while the other cards stay face-up. A settled
 * hand is a static one-frame strip. All frames come from the pre-rendered
 * flip GIFs in assets/cards/flips/ (rendered from Ronit's
 * playing-cards.html); the strip is composed at reply time with pure-JS
 * GIF decode/encode (gifuct-js + gif-encoder-2) — no native canvas.
 */

export const STRIP_CARD_W = 60;
export const STRIP_CARD_H = 84;
/** px between the left edges of neighbouring cards (14px overlap). */
export const STRIP_STEP = 46;
/** px between the dealer row and the player row. */
export const STRIP_ROW_GAP = 10;
/** Green felt, matching the capture stage in scripts/capture_flips.py. */
export const STRIP_FELT: [number, number, number] = [0x0a, 0x2c, 0x21];
export const STRIP_FRAME_MS = 95;

export interface StripCard {
  /** Card code, e.g. "AS", "10H". */
  code: string;
  /** Flip this card through its frames (newly dealt card). */
  animate?: boolean;
  /** Show the card back (dealer's hole card while the game is live). */
  faceDown?: boolean;
}

export interface StripResult {
  /** GIF bytes (animated when `animated` is true, one static frame otherwise). */
  buffer: Buffer;
  width: number;
  height: number;
  frames: number;
  animated: boolean;
}

/** Composited RGBA frames of one card's flip GIF (back -> flip -> face). */
const frameCache = new Map<string, Buffer[]>();

function loadCardFrames(code: string): Buffer[] | null {
  const cached = frameCache.get(code);
  if (cached) return cached;
  if (!flipGifExists(code)) return null;
  const buf = readFileSync(flipGifPath(code));
  const gif = parseGIF(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const frames = decompressFrames(gif, true);
  const w = gif.lsd.width;
  const h = gif.lsd.height;
  const canvas = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    canvas[i * 4] = STRIP_FELT[0];
    canvas[i * 4 + 1] = STRIP_FELT[1];
    canvas[i * 4 + 2] = STRIP_FELT[2];
    canvas[i * 4 + 3] = 255;
  }
  const out: Buffer[] = [];
  for (const f of frames) {
    const { left, top, width, height } = f.dims;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const si = (y * width + x) * 4;
        if (f.patch[si + 3] > 0) {
          const di = ((top + y) * w + (left + x)) * 4;
          canvas[di] = f.patch[si];
          canvas[di + 1] = f.patch[si + 1];
          canvas[di + 2] = f.patch[si + 2];
          canvas[di + 3] = 255;
        }
      }
    }
    out.push(Buffer.from(canvas));
  }
  if (out.length === 0) return null;
  frameCache.set(code, out);
  return out;
}

function paste(dst: Uint8ClampedArray, dstW: number, src: Buffer, dx: number, dy: number): void {
  for (let y = 0; y < STRIP_CARD_H; y++) {
    for (let x = 0; x < STRIP_CARD_W; x++) {
      const si = (y * STRIP_CARD_W + x) * 4;
      const di = ((dy + y) * dstW + (dx + x)) * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = src[si + 3];
    }
  }
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
    enc.setRepeat(0);
    enc.setDelay(STRIP_FRAME_MS);
    enc.setQuality(10);
    for (const f of frames) enc.addFrame(f);
    enc.finish();
  });
}

/**
 * Compose rows of cards into one strip image. Each row is a hand; cards
 * sit side by side with a slight overlap. Cards marked `animate` flip
 * through their frames; the rest show their face (or the back when
 * `faceDown`). Returns null when any card has no rendered flip GIF —
 * the caller then falls back to a text-only embed.
 */
export async function composeHandStrip(rows: StripCard[][]): Promise<StripResult | null> {
  const loaded = new Map<string, Buffer[]>();
  for (const row of rows) {
    for (const card of row) {
      if (!loaded.has(card.code)) {
        const frames = loadCardFrames(card.code);
        if (!frames) return null;
        loaded.set(card.code, frames);
      }
    }
  }
  const width = Math.max(
    0,
    ...rows.map((row) => (row.length === 0 ? 0 : STRIP_CARD_W + (row.length - 1) * STRIP_STEP)),
  );
  const height = rows.length * STRIP_CARD_H + Math.max(0, rows.length - 1) * STRIP_ROW_GAP;
  if (width === 0 || height === 0) return null;

  let frameCount = 1;
  for (const row of rows) {
    for (const card of row) {
      if (card.animate) frameCount = Math.max(frameCount, loaded.get(card.code)?.length ?? 1);
    }
  }

  const frames: Buffer[] = [];
  for (let i = 0; i < frameCount; i++) {
    const canvas = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < width * height; p++) {
      canvas[p * 4] = STRIP_FELT[0];
      canvas[p * 4 + 1] = STRIP_FELT[1];
      canvas[p * 4 + 2] = STRIP_FELT[2];
      canvas[p * 4 + 3] = 255;
    }
    rows.forEach((row, r) => {
      const y = r * (STRIP_CARD_H + STRIP_ROW_GAP);
      row.forEach((card, c) => {
        const cardFrames = loaded.get(card.code) as Buffer[];
        const src = card.animate
          ? cardFrames[Math.min(i, cardFrames.length - 1)] as Buffer
          : card.faceDown
            ? cardFrames[0] as Buffer
            : cardFrames[cardFrames.length - 1] as Buffer;
        paste(canvas, width, src, c * STRIP_STEP, y);
      });
    });
    frames.push(Buffer.from(canvas));
  }

  const buffer = await encodeGif(width, height, frames);
  return { buffer, width, height, frames: frameCount, animated: frameCount > 1 };
}

/** Test hook: forget cached frames (forces a re-read from disk). */
export function clearStripCache(): void {
  frameCache.clear();
}
