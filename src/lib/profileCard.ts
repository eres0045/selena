import { readFile } from "node:fs/promises";
import sharp, { type OverlayOptions } from "sharp";
import { parseGIF, decompressFrames } from "gifuct-js";
import GIFEncoder from "gif-encoder-2";

/**
 * OwO-style profile card renderer (800x500 animated GIF).
 *
 * Pipeline (no native `canvas` — the VM cannot build it):
 *   1. Read the background file (fail-closed when missing).
 *   2. Decode it with gifuct-js: animated GIF -> composited RGBA frames
 *      (disposal honoured, same approach as src/lib/handstrip.ts);
 *      static PNG/JPG -> one frame via sharp.
 *   3. Per frame: sharp resizes the frame to 800x500 (cover), then
 *      composites a pre-rendered overlay PNG (dark scrim + all text/XP
 *      bar drawn as SVG, rendered once by sharp/librsvg) and the
 *      rounded avatar PNG.
 *   4. Frames are encoded to an animated GIF with gif-encoder-2
 *      (sharp alone cannot write animated GIFs).
 *
 * Text uses DejaVu Sans — present on this VM and on Render's Ubuntu
 * base image — via fontconfig, no custom font file shipped.
 */

export const PROFILE_CARD_WIDTH = 800;
export const PROFILE_CARD_HEIGHT = 500;
/** Max background frames kept in the output (keeps the GIF < 5 MB). */
export const PROFILE_CARD_MAX_FRAMES = 10;
export const PROFILE_CARD_MAX_BYTES = 5 * 1024 * 1024;

export interface ProfileCardInput {
  backgroundPath: string; // absolute path to the bg GIF (or default PNG)
  avatarBuffer: Buffer | null; // user's avatar PNG bytes (null = placeholder circle)
  displayName: string;
  level: number;
  rank: number; // global rank number (1 = top)
  xpIntoLevel: number; // XP earned towards the next level
  xpForNextLevel: number; // total XP needed for the next level
  gold: number;
  gems: number;
  about: string; // may be empty
  monstersCaught: number;
  guildName: string | null;
}

// Layout constants (800x500).
const AVATAR_X = 40;
const AVATAR_Y = 40;
const AVATAR_SIZE = 150;
const AVATAR_RADIUS = 36;
const TEXT_X = 215;
const CONTENT_RIGHT = 760;
const XP_BAR_Y = 208;
const XP_BAR_W = CONTENT_RIGHT - TEXT_X; // 545
const XP_BAR_H = 22;

/** XP progress as a 0..1 fraction. Exported so tests can pin the math. */
export function xpProgressFraction(input: Pick<ProfileCardInput, "xpIntoLevel" | "xpForNextLevel">): number {
  if (!Number.isFinite(input.xpForNextLevel) || input.xpForNextLevel <= 0) return 0;
  const into = Number.isFinite(input.xpIntoLevel) ? input.xpIntoLevel : 0;
  return Math.min(1, Math.max(0, into / input.xpForNextLevel));
}

function safeInt(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function fmt(n: number): string {
  return safeInt(n).toLocaleString("en-US");
}

/** Escape user text for embedding in SVG. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Rough per-char width factor for DejaVu Sans (bold is wider). */
function charWidth(fontSize: number, bold: boolean): number {
  return fontSize * (bold ? 0.62 : 0.52);
}

/** Truncate with an ellipsis so the text fits maxPx at the given size. */
export function truncateToWidth(text: string, maxPx: number, fontSize: number, bold = false): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length === 0) return clean;
  const w = charWidth(fontSize, bold);
  if (clean.length * w <= maxPx) return clean;
  const ellipsis = "…";
  const keep = Math.max(0, Math.floor((maxPx - w) / w));
  if (keep <= 0) return ellipsis;
  return clean.slice(0, keep).trimEnd() + ellipsis;
}

/** Word-wrap into at most `maxLines` lines fitting maxPx; ellipsis on overflow. */
export function wrapText(text: string, maxPx: number, fontSize: number, maxLines: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const w = charWidth(fontSize, false);
  const maxChars = Math.max(4, Math.floor(maxPx / w));
  const words = clean.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      // Max lines reached: stop and let the ellipsis logic below mark
      // the last line (there is still unwrapped text left over).
      if (lines.length >= maxLines) break;
      // A single over-long word gets hard-cut to fit the line.
      line = word.length > maxChars ? word.slice(0, maxChars) : word;
    }
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  // If there is leftover text beyond the last line, ellipsis it.
  const used = lines.join(" ").length;
  if (used < clean.length && lines.length > 0) {
    const last = lines[lines.length - 1] as string;
    lines[lines.length - 1] = last.length > 1 ? last.slice(0, -1).trimEnd() + "…" : "…";
  }
  return lines.slice(0, maxLines);
}

/** Decode a GIF buffer into composited RGBA frames (disposal honoured). */
function decodeGifFrames(buf: Buffer): { width: number; height: number; frames: Buffer[]; delays: number[] } {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const gif = parseGIF(ab);
  const frames = decompressFrames(gif, true);
  const w = gif.lsd.width;
  const h = gif.lsd.height;
  let canvas = new Uint8ClampedArray(w * h * 4);
  const out: Buffer[] = [];
  const delays: number[] = [];
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
    delays.push(typeof f.delay === "number" && f.delay > 0 ? f.delay * 10 : 100);
    prevDisposal = f.disposalType;
  }
  return { width: w, height: h, frames: out, delays };
}

function isGif(buf: Buffer): boolean {
  return buf.length >= 6 && buf.subarray(0, 3).toString("ascii") === "GIF";
}

/** Evenly sample frame indices down to at most `max` entries. */
function sampleIndices(count: number, max: number): number[] {
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(Math.floor((i * count) / max));
  return out;
}

/** Crop the avatar to a 150px rounded square (dest-in mask). */
async function roundedAvatar(avatarBuffer: Buffer): Promise<Buffer> {
  const mask = Buffer.from(
    `<svg width="${AVATAR_SIZE}" height="${AVATAR_SIZE}">` +
      `<rect x="0" y="0" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}" rx="${AVATAR_RADIUS}" fill="#ffffff"/>` +
      `</svg>`,
  );
  return sharp(avatarBuffer)
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover" })
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

/** Build the overlay SVG: dark scrim + every text element + XP bar. */
function buildOverlaySvg(input: ProfileCardInput): string {
  const name = truncateToWidth(input.displayName || "Unknown User", CONTENT_RIGHT - TEXT_X, 40, true);
  const progress = xpProgressFraction(input);
  const fillW = Math.round(XP_BAR_W * progress);
  const aboutLines = wrapText(input.about ?? "", CONTENT_RIGHT - AVATAR_X, 20, 2);
  const extras: string[] = [`Monsters caught: ${fmt(input.monstersCaught)}`];
  if (input.guildName && input.guildName.trim()) {
    extras.push(`Guild: ${truncateToWidth(input.guildName, 300, 19, false)}`);
  }
  const goldStr = `● ${fmt(input.gold)} gold`;
  const gemsStr = `◆ ${fmt(input.gems)} gems`;
  const gemsText = safeInt(input.gems) > 0 ? gemsStr : "";

  const aboutSvg =
    aboutLines.length > 0
      ? aboutLines
          .map(
            (line, i) =>
              `<text x="${AVATAR_X}" y="${368 + i * 28}" font-family="DejaVu Sans" font-size="20" fill="#e8ecf1">${escapeXml(line)}</text>`,
          )
          .join("\n")
      : `<text x="${AVATAR_X}" y="368" font-family="DejaVu Sans" font-size="20" font-style="italic" fill="#9aa7b5">No about me yet — set one with uwu about!</text>`;

  // Placeholder avatar circle (drawn in the overlay when no avatar bytes).
  const avatarPlaceholder =
    input.avatarBuffer === null
      ? `<rect x="${AVATAR_X}" y="${AVATAR_Y}" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}" rx="${AVATAR_RADIUS}" fill="#3a4756" stroke="#ffffff" stroke-opacity="0.85" stroke-width="4"/>` +
        `<text x="${AVATAR_X + AVATAR_SIZE / 2}" y="${AVATAR_Y + 98}" text-anchor="middle" font-family="DejaVu Sans" font-size="64" font-weight="bold" fill="#c7d0db">?</text>`
      : `<rect x="${AVATAR_X}" y="${AVATAR_Y}" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}" rx="${AVATAR_RADIUS}" fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="4"/>`;

  return `<svg width="${PROFILE_CARD_WIDTH}" height="${PROFILE_CARD_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000000" stop-opacity="0.42"/>
      <stop offset="0.55" stop-color="#000000" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.72"/>
    </linearGradient>
    <linearGradient id="xpfill" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffd54a"/>
      <stop offset="1" stop-color="#ffb300"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${PROFILE_CARD_WIDTH}" height="${PROFILE_CARD_HEIGHT}" fill="url(#scrim)"/>
  ${avatarPlaceholder}
  <text x="${TEXT_X}" y="92" font-family="DejaVu Sans" font-size="40" font-weight="bold" fill="#ffffff">${escapeXml(name)}</text>
  <text x="${TEXT_X}" y="126" font-family="DejaVu Sans" font-size="20" fill="#cfd8e3">An uwu Bot User</text>
  <text x="${TEXT_X}" y="172" font-family="DejaVu Sans" font-size="26" font-weight="bold" fill="#ffd54a">Lv ${fmt(input.level)}</text>
  <text x="${TEXT_X + 150}" y="172" font-family="DejaVu Sans" font-size="26" font-weight="bold" fill="#ffffff">Rank #${fmt(input.rank)}</text>
  <rect x="${TEXT_X}" y="${XP_BAR_Y}" width="${XP_BAR_W}" height="${XP_BAR_H}" rx="11" fill="#ffffff" fill-opacity="0.28"/>
  ${fillW > 0 ? `<rect x="${TEXT_X}" y="${XP_BAR_Y}" width="${fillW}" height="${XP_BAR_H}" rx="11" fill="url(#xpfill)"/>` : ""}
  <text x="${TEXT_X}" y="${XP_BAR_Y + XP_BAR_H + 24}" font-family="DejaVu Sans" font-size="18" fill="#e8ecf1">${fmt(input.xpIntoLevel)} / ${fmt(input.xpForNextLevel)} XP</text>
  <text x="${TEXT_X}" y="292" font-family="DejaVu Sans" font-size="24" font-weight="bold" fill="#ffd54a">${escapeXml(goldStr)}</text>
  ${gemsText ? `<text x="${CONTENT_RIGHT}" y="292" text-anchor="end" font-family="DejaVu Sans" font-size="24" font-weight="bold" fill="#7dd3fc">${escapeXml(gemsText)}</text>` : ""}
  <line x1="${AVATAR_X}" y1="316" x2="${CONTENT_RIGHT}" y2="316" stroke="#ffffff" stroke-opacity="0.25" stroke-width="1"/>
  <text x="${AVATAR_X}" y="344" font-family="DejaVu Sans" font-size="18" font-weight="bold" letter-spacing="2" fill="#9aa7b5">ABOUT ME</text>
  ${aboutSvg}
  <text x="${AVATAR_X}" y="452" font-family="DejaVu Sans" font-size="19" fill="#cfd8e3">${escapeXml(extras.join("   •   "))}</text>
</svg>`;
}

function encodeGif(width: number, height: number, frames: Buffer[], delays: number[]): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const enc = new GIFEncoder(width, height);
    const chunks: Buffer[] = [];
    const stream = enc.createReadStream();
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("error", rejectPromise);
    stream.on("end", () => resolvePromise(Buffer.concat(chunks)));
    enc.start();
    enc.setRepeat(0); // loop forever
    enc.setDispose(2); // each frame is a complete image
    enc.setQuality(10);
    frames.forEach((frame, i) => {
      const delay = Math.min(300, Math.max(60, delays[i] ?? 100));
      enc.setDelay(delay);
      enc.addFrame(frame);
    });
    enc.finish();
  });
}

/**
 * Render an 800x500 animated GIF profile card.
 * Throws a clear error when the background file is missing or unreadable
 * (fail-closed: never ship a blank card).
 */
export async function renderProfileCard(input: ProfileCardInput): Promise<Buffer> {
  let bgBuf: Buffer;
  try {
    bgBuf = await readFile(input.backgroundPath);
  } catch {
    throw new Error(`Profile background not found: ${input.backgroundPath}`);
  }

  // Decode background frames (GIF) or take the single static frame.
  let bgFrames: { width: number; height: number; data: Buffer }[];
  let delays: number[];
  if (isGif(bgBuf)) {
    const decoded = decodeGifFrames(bgBuf);
    if (decoded.frames.length === 0) {
      throw new Error(`Profile background has no frames: ${input.backgroundPath}`);
    }
    const keep = sampleIndices(decoded.frames.length, PROFILE_CARD_MAX_FRAMES);
    bgFrames = keep.map((i) => ({
      width: decoded.width,
      height: decoded.height,
      data: decoded.frames[i] as Buffer,
    }));
    delays = keep.map((i) => decoded.delays[i] as number);
  } else {
    const { data, info } = await sharp(bgBuf)
      .resize(PROFILE_CARD_WIDTH, PROFILE_CARD_HEIGHT, { fit: "cover" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    bgFrames = [{ width: info.width, height: info.height, data }];
    delays = [100];
  }

  // Overlay (scrim + text + XP bar) is identical on every frame: render once.
  const overlayPng = await sharp(Buffer.from(buildOverlaySvg(input))).png().toBuffer();
  const avatarPng = input.avatarBuffer ? await roundedAvatar(input.avatarBuffer) : null;

  const outFrames: Buffer[] = [];
  for (const bg of bgFrames) {
    const layers: OverlayOptions[] = [{ input: overlayPng, left: 0, top: 0 }];
    if (avatarPng) layers.unshift({ input: avatarPng, left: AVATAR_X, top: AVATAR_Y });
    const { data } = await sharp(bg.data, { raw: { width: bg.width, height: bg.height, channels: 4 } })
      .resize(PROFILE_CARD_WIDTH, PROFILE_CARD_HEIGHT, { fit: "cover" })
      .composite(layers)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    outFrames.push(data);
  }

  const gif = await encodeGif(PROFILE_CARD_WIDTH, PROFILE_CARD_HEIGHT, outFrames, delays);
  if (gif.length > PROFILE_CARD_MAX_BYTES) {
    throw new Error(`Profile card exceeded 5 MB (${gif.length} bytes)`);
  }
  return gif;
}
