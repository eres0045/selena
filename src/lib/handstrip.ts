import { readFileSync } from "node:fs";
import { parseGIF, decompressFrames } from "gifuct-js";
import GIFEncoder from "gif-encoder-2";
import { flipGifExists, flipGifPath, labelGifExists, labelGifPath } from "./cards.js";

/**
 * OwO-style compact card displays: one small strip image per embed.
 *
 * The strip file is ~280px wide with ~40px cards — between the 50px
 * version (too big) and the 28px version (too small to read) — and the
 * cards stay sharp because they are rendered at 4x (600x840) and
 * Lanczos-downscaled to 40x56 with a mild unsharp. The strip background
 * is TRANSPARENT (GIF transparency), not a green felt box, so it blends
 * into Discord's dark embed and each card stands on its own with a
 * small gap between cards.
 *
 * The image explains itself: every row carries its label IN the image —
 * a word ("DEALER" / "YOU" / "FIRST" / "NEXT") over the row's total
 * ("17", or "?" while the dealer's hole card is hidden) — rendered from
 * the crisp sprites in assets/cards/labels/ (scripts/render_labels.py).
 * Nothing about the hands lives in the embed text any more; the bet and
 * result live in the embed FOOTER (below the image).
 *
 * Newly dealt cards keep their animation: the strip is itself an animated
 * GIF in which the new card flips from its back to its face while the
 * other cards stay face-up — and it plays ONCE (no loop extension),
 * ending with all cards face-up. A settled hand is a static one-frame
 * strip. All frames come from the pre-rendered flip GIFs in
 * assets/cards/flips/ (rendered from Ronit's playing-cards.html at 4x,
 * downscaled sharp to 40px, transparent corners, disposal 2 so the flip
 * never smears); the strip is composed at reply time with pure-JS GIF
 * decode/encode (gifuct-js + gif-encoder-2) — no native canvas.
 *
 * Disposal matters: the flip GIFs are written with disposal method 2
 * (restore to background), so each frame is a complete image and the
 * canvas is cleared before the next frame. decodeGifFrames below
 * honours that — without it, mid-flip frames composite over the card
 * back and the flip smears instead of flipping (that was the "looks
 * bad when it moves" bug). The strip encoder likewise writes
 * disposal 2 (see encodeGif).
 */

export const STRIP_CARD_W = 40;
export const STRIP_CARD_H = 56;
/** px between the left edges of neighbouring cards: 40px card + 6px gap. */
export const STRIP_STEP = 46;
/** px between the dealer row and the player row. */
export const STRIP_ROW_GAP = 10;
/**
 * Minimum strip width in the file. Hands are laid out from the left in
 * this frame, so even a 2-card hand ships as a ~280px-wide file.
 */
export const STRIP_MIN_WIDTH = 280;
export const STRIP_FRAME_MS = 95;
/** Left/right padding of the strip frame. */
export const STRIP_PAD = 8;
/** Width of the label column at the left of each row (word + total). */
export const LABEL_W = 64;
/** Gap between the label column and the first card. */
export const LABEL_GAP = 6;
/** Gap between the label word and the total beneath it. */
export const LABEL_LINE_GAP = 3;
/** Word sprites ("DEALER", "YOU", ...) are 16px tall; totals 19px. */
export const LABEL_WORD_H = 16;
export const LABEL_VALUE_H = 19;
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

/**
 * A row's in-image label: the word over the row's total, e.g.
 * { title: "DEALER", value: "17" } or { title: "YOU", value: "?" }.
 * One label per row, in the same order as the rows.
 */
export interface RowLabel {
  title: string;
  value: string;
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
 *
 * Disposal is honoured: when the previous frame's disposal method is 2
 * (restore to background — how the flip GIFs are written), the canvas
 * is cleared to transparent before the next frame's patch is applied.
 * Without this, a mid-flip sliver frame composites over the previous
 * full card back and the flip smears instead of flipping.
 */
export function decodeGifFrames(buf: Buffer): { width: number; height: number; frames: Buffer[] } {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const gif = parseGIF(ab);
  const frames = decompressFrames(gif, true);
  const w = gif.lsd.width;
  const h = gif.lsd.height;
  let canvas = new Uint8ClampedArray(w * h * 4); // transparent
  const out: Buffer[] = [];
  let prevDisposal = 0;
  for (const f of frames) {
    if (prevDisposal === 2) canvas = new Uint8ClampedArray(w * h * 4);
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
    prevDisposal = f.disposalType;
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

/** Paste an RGBA image onto the canvas, skipping transparent pixels so
 * an overlapping card never erases the card beneath it. */
function pasteImage(
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

/** Paste a card frame onto the canvas (a card-sized pasteImage). */
function paste(dst: Uint8ClampedArray, dstW: number, src: Buffer, dx: number, dy: number): void {
  pasteImage(dst, dstW, src, STRIP_CARD_W, STRIP_CARD_H, dx, dy);
}

// ---------------------------------------------------------------------------
// Row labels (word + total, rendered from the sprites in assets/cards/labels/)
// ---------------------------------------------------------------------------

interface LabelSprite {
  width: number;
  height: number;
  frame: Buffer;
}

const labelCache = new Map<string, LabelSprite | null>();

/** First frame of a label sprite GIF, or null when the file is missing. */
function loadLabelSprite(name: string): LabelSprite | null {
  const cached = labelCache.get(name);
  if (cached !== undefined) return cached;
  if (!labelGifExists(name)) {
    labelCache.set(name, null);
    return null;
  }
  const { width, height, frames } = decodeGifFrames(readFileSync(labelGifPath(name)));
  if (frames.length === 0) {
    labelCache.set(name, null);
    return null;
  }
  const sprite: LabelSprite = { width, height, frame: frames[0] as Buffer };
  labelCache.set(name, sprite);
  return sprite;
}

/**
 * Draw one row's label (word over total) into the label column. Returns
 * false when a needed sprite file is missing — the caller then falls
 * back to a text-only embed instead of shipping a half-labelled strip.
 */
function drawRowLabel(
  canvas: Uint8ClampedArray,
  dstW: number,
  rowY: number,
  label: RowLabel,
): boolean {
  const word = loadLabelSprite(`word-${label.title.toLowerCase()}`);
  if (!word) return false;
  const glyphs: LabelSprite[] = [];
  for (const ch of label.value) {
    const glyph = loadLabelSprite(`digit-${ch === "?" ? "q" : ch}`);
    if (!glyph) return false;
    glyphs.push(glyph);
  }
  // Word over total, vertically centred in the row.
  const labelTop =
    rowY + Math.floor((STRIP_CARD_H - (LABEL_WORD_H + LABEL_LINE_GAP + LABEL_VALUE_H)) / 2);
  pasteImage(canvas, dstW, word.frame, word.width, word.height, STRIP_PAD, labelTop);
  let x = STRIP_PAD;
  const valueY = labelTop + LABEL_WORD_H + LABEL_LINE_GAP;
  for (const glyph of glyphs) {
    pasteImage(canvas, dstW, glyph.frame, glyph.width, glyph.height, x, valueY);
    x += glyph.width + 2;
  }
  return true;
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
    // Disposal 2 (restore to background) on every frame, so each strip
    // frame is a complete image and Discord never composites one frame
    // over the previous one (that smear is what made flips look bad).
    // (The encoder also defaults to 2 when a transparent colour is set;
    // this makes it explicit.)
    enc.setDispose(2);
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
 * Compose rows of cards into one small strip image. Each row is a hand;
 * cards sit side by side with a small gap. With rowLabels, each row gets
 * its in-image label (word over total) in a label column at the left and
 * the rows are left-aligned; without labels the rows are centred in a
 * frame at least STRIP_MIN_WIDTH wide. Cards marked `animate` flip
 * through their frames; the rest show their face (or the back when
 * `faceDown`). Returns null when any card has no rendered flip GIF, or
 * any label has no sprite — the caller then falls back to a text-only
 * embed.
 */
export async function composeHandStrip(
  rows: StripCard[][],
  rowLabels?: RowLabel[],
): Promise<StripResult | null> {
  const useLabels = !!rowLabels && rowLabels.length === rows.length;
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
  // Pre-check the label sprites so a half-labelled strip never ships.
  if (useLabels) {
    for (const label of rowLabels as RowLabel[]) {
      if (!loadLabelSprite(`word-${label.title.toLowerCase()}`)) return null;
      for (const ch of label.value) {
        if (!loadLabelSprite(`digit-${ch === "?" ? "q" : ch}`)) return null;
      }
    }
  }
  const cardsWidth = (row: StripCard[]): number =>
    row.length === 0 ? 0 : STRIP_CARD_W + (row.length - 1) * STRIP_STEP;
  const labelCol = STRIP_PAD + LABEL_W + LABEL_GAP;
  const naturalWidth = Math.max(
    0,
    ...rows.map((row) => (useLabels ? labelCol + cardsWidth(row) : cardsWidth(row))),
  );
  const width = Math.max(STRIP_MIN_WIDTH, naturalWidth + (useLabels ? STRIP_PAD : 0));
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
      const rowWidth = cardsWidth(row);
      const x0 = useLabels ? labelCol : Math.floor((width - rowWidth) / 2);
      // Labels were pre-checked above, so drawRowLabel cannot fail here.
      if (useLabels) drawRowLabel(canvas, width, y, (rowLabels as RowLabel[])[r] as RowLabel);
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
  labelCache.clear();
}
