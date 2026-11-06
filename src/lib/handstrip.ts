import { readFileSync } from "node:fs";
import { parseGIF, decompressFrames } from "gifuct-js";
import GIFEncoder from "gif-encoder-2";
import { flipGifExists, flipGifPath } from "./cards.js";

/**
 * OwO-style compact card displays: one wide strip image per embed.
 *
 * Discord upscales a NARROW image to the full message width on phones,
 * which is why the old ~106px strip came out huge and blurry. So the
 * strip file is WIDE (~560px): each hand is one row of ~100px cards,
 * centred in the frame, and Discord displays it near its native size —
 * small on screen AND sharp (the cards are rendered at 2x and downscaled
 * with Lanczos). The strip background is TRANSPARENT (GIF transparency),
 * not a green felt box, so it blends into Discord's dark embed and each
 * card stands on its own with a small gap between cards.
 *
 * Newly dealt cards keep their animation: the strip is itself an animated
 * GIF in which the new card flips from its back to its face while the
 * other cards stay face-up — and it plays ONCE (no loop extension),
 * ending with all cards face-up. A settled hand is a static one-frame
 * strip. All frames come from the pre-rendered flip GIFs in
 * assets/cards/flips/ (rendered from Ronit's playing-cards.html at 2x,
 * downscaled sharp to 100px, transparent corners); the strip is composed
 * at reply time with pure-JS GIF decode/encode (gifuct-js +
 * gif-encoder-2) — no native canvas.
 */

export const STRIP_CARD_W = 100;
export const STRIP_CARD_H = 140;
/** px between the left edges of neighbouring cards: 100px card + 12px gap. */
export const STRIP_STEP = 112;
/** px between the dealer row and the player row. */
export const STRIP_ROW_GAP = 12;
/**
 * Minimum strip width in the file. Hands are centred in this frame, so
 * even a 2-card hand ships as a ~560px-wide file and Discord does not
 * upscale it ~3x. Wider hands grow the canvas as needed.
 */
export const STRIP_MIN_WIDTH = 560;
export const STRIP_FRAME_MS = 95;
/** Magenta marks transparent pixels for the GIF encoder (see encodeGif). */
const TRANSPARENT_RGB = 0xff00ff;

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

/**
 * Decode a GIF buffer into composited RGBA frames (one Buffer per frame,
 * each width*height*4 bytes, transparent where the GIF is transparent).
 * Exported for tests.
 */
export function decodeGifFrames(buf: Buffer): { width: number; height: number; frames: Buffer[] } {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const gif = parseGIF(ab);
  const frames = decompressFrames(gif, true);
  const w = gif.lsd.width;
  const h = gif.lsd.height;
  const canvas = new Uint8ClampedArray(w * h * 4); // transparent
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
  return { width: w, height: h, frames: out };
}

function loadCardFrames(code: string): Buffer[] | null {
  const cached = frameCache.get(code);
  if (cached) return cached;
  if (!flipGifExists(code)) return null;
  const { frames } = decodeGifFrames(readFileSync(flipGifPath(code)));
  if (frames.length === 0) return null;
  frameCache.set(code, frames);
  return frames;
}

/** Paste a card frame onto the canvas, skipping transparent pixels so an
 * overlapping card never erases the card beneath it. */
function paste(dst: Uint8ClampedArray, dstW: number, src: Buffer, dx: number, dy: number): void {
  for (let y = 0; y < STRIP_CARD_H; y++) {
    for (let x = 0; x < STRIP_CARD_W; x++) {
      const si = (y * STRIP_CARD_W + x) * 4;
      if (src[si + 3] === 0) continue;
      const di = ((dy + y) * dstW + (dx + x)) * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = 255;
    }
  }
}

/**
 * Mark transparent pixels magenta for the GIF encoder: gif-encoder-2
 * only makes pixels transparent when their RGB matches the colour given
 * to setTransparent, so transparent pixels must carry that exact RGB.
 * Magenta never appears on a real card, so no real pixel is affected.
 */
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
    // -1: no NETSCAPE2.0 loop extension — the strip plays exactly once
    // and stops on the final frame (all cards face-up). 0 would loop
    // forever; the encoder only writes the extension when repeat >= 0.
    enc.setRepeat(-1);
    // Transparent background: pixels whose RGB is magenta become the
    // GIF's transparent index (see magentaTransparent above). The
    // bundled gif-encoder-2 types omit setTransparent, so call it
    // through a cast — the method exists at runtime (verified in
    // node_modules/gif-encoder-2/src/GIFEncoder.js).
    (enc as unknown as { setTransparent(color: number): void }).setTransparent(TRANSPARENT_RGB);
    enc.setDelay(STRIP_FRAME_MS);
    enc.setQuality(10);
    for (const f of frames) enc.addFrame(magentaTransparent(f));
    enc.finish();
  });
}

/**
 * Compose rows of cards into one wide strip image. Each row is a hand;
 * cards sit side by side with a small gap, and rows are centred in a
 * frame at least STRIP_MIN_WIDTH wide so Discord displays the strip
 * near its native size instead of upscaling a narrow image. Cards
 * marked `animate` flip through their frames; the rest show their face
 * (or the back when `faceDown`). Returns null when any card has no
 * rendered flip GIF — the caller then falls back to a text-only embed.
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
  const naturalWidth = Math.max(
    0,
    ...rows.map((row) => (row.length === 0 ? 0 : STRIP_CARD_W + (row.length - 1) * STRIP_STEP)),
  );
  const width = Math.max(STRIP_MIN_WIDTH, naturalWidth);
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
    const canvas = new Uint8ClampedArray(width * height * 4); // transparent
    rows.forEach((row, r) => {
      const y = r * (STRIP_CARD_H + STRIP_ROW_GAP);
      const rowWidth = row.length === 0 ? 0 : STRIP_CARD_W + (row.length - 1) * STRIP_STEP;
      const x0 = Math.floor((width - rowWidth) / 2);
      row.forEach((card, c) => {
        const cardFrames = loaded.get(card.code) as Buffer[];
        const src = card.animate
          ? cardFrames[Math.min(i, cardFrames.length - 1)] as Buffer
          : card.faceDown
            ? cardFrames[0] as Buffer
            : cardFrames[cardFrames.length - 1] as Buffer;
        paste(canvas, width, src, x0 + c * STRIP_STEP, y);
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
