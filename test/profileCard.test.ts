import { describe, expect, it, beforeAll } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import GIFEncoder from "gif-encoder-2";
import { parseGIF, decompressFrames } from "gifuct-js";
import {
  renderProfileCard,
  xpProgressFraction,
  escapeXml,
  truncateToWidth,
  wrapText,
  type ProfileCardInput,
} from "../src/lib/profileCard.js";

const W = 800;
const H = 500;

let bgGifPath = "";
let bgPngPath = "";
let avatarBuf: Buffer;

function gifFrameCount(buf: Buffer): number {
  const gif = parseGIF(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return decompressFrames(gif, true).length;
}

function gifSize(buf: Buffer): { width: number; height: number } {
  const gif = parseGIF(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return { width: gif.lsd.width, height: gif.lsd.height };
}

async function makeAnimatedBg(file: string, frames = 4): Promise<void> {
  const raws: Buffer[] = [];
  for (let i = 0; i < frames; i++) {
    const c1 = ["#1a2a6c", "#134e5e", "#41295a", "#0f2027"][i % 4] as string;
    const c2 = ["#b21f1f", "#71b280", "#2f0743", "#2c5364"][i % 4] as string;
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/></svg>`;
    const { data } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    raws.push(data);
  }
  const gif = await new Promise<Buffer>((resolve, reject) => {
    const enc = new GIFEncoder(W, H);
    const chunks: Buffer[] = [];
    const stream = enc.createReadStream();
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    enc.start();
    enc.setRepeat(0);
    enc.setDispose(2);
    enc.setQuality(10);
    for (const f of raws) {
      enc.setDelay(100);
      enc.addFrame(f);
    }
    enc.finish();
  });
  await writeFile(file, gif);
}

beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "profile-card-"));
  bgGifPath = path.join(dir, "bg.gif");
  bgPngPath = path.join(dir, "bg.png");
  await makeAnimatedBg(bgGifPath, 4);
  await sharp({
    create: { width: W, height: H, channels: 3, background: { r: 30, g: 60, b: 120 } },
  })
    .png()
    .toFile(bgPngPath);
  avatarBuf = await sharp({
    create: { width: 256, height: 256, channels: 3, background: { r: 124, g: 58, b: 237 } },
  })
    .png()
    .toBuffer();
});

function baseInput(overrides: Partial<ProfileCardInput> = {}): ProfileCardInput {
  return {
    backgroundPath: bgGifPath,
    avatarBuffer: avatarBuf,
    displayName: "Test User",
    level: 12,
    rank: 5,
    xpIntoLevel: 1250,
    xpForNextLevel: 5000,
    gold: 9999,
    gems: 7,
    about: "Just a test user.",
    monstersCaught: 10,
    guildName: "FORTEC",
    ...overrides,
  };
}

function firstFramePixels(buf: Buffer): { patch: Uint8ClampedArray; width: number; height: number } {
  const gif = parseGIF(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const frames = decompressFrames(gif, true);
  const f = frames[0]!;
  return { patch: f.patch, width: f.dims.width, height: f.dims.height };
}

/** Mean RGB over a rectangle of the decoded frame (avatar region check). */
function meanRgb(
  frame: { patch: Uint8ClampedArray; width: number },
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { r: number; g: number; b: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * frame.width + x) * 4;
      r += frame.patch[i] as number;
      g += frame.patch[i + 1] as number;
      b += frame.patch[i + 2] as number;
      n++;
    }
  }
  return { r: r / n, g: g / n, b: b / n };
}

describe("renderProfileCard", () => {
  it("renders an 800x500 animated GIF under 5MB from an animated bg", async () => {
    const buf = await renderProfileCard(baseInput());
    expect(buf.subarray(0, 6).toString("ascii")).toMatch(/^GIF8[79]a$/);
    expect(gifSize(buf)).toEqual({ width: 800, height: 500 });
    expect(gifFrameCount(buf)).toBeGreaterThan(1);
    expect(buf.length).toBeLessThan(5 * 1024 * 1024);
  });

  it("renders a single-frame GIF from a static PNG background", async () => {
    const buf = await renderProfileCard(baseInput({ backgroundPath: bgPngPath }));
    expect(buf.subarray(0, 6).toString("ascii")).toMatch(/^GIF8[79]a$/);
    expect(gifSize(buf)).toEqual({ width: 800, height: 500 });
    expect(gifFrameCount(buf)).toBe(1);
  });

  it("renders with a null avatar (placeholder circle, no throw)", async () => {
    const buf = await renderProfileCard(baseInput({ avatarBuffer: null }));
    expect(buf.subarray(0, 6).toString("ascii")).toMatch(/^GIF8[79]a$/);
    expect(buf.length).toBeGreaterThan(1000);
  });

  it("composites the avatar pixels into the card (red avatar = red avatar region)", async () => {
    // Solid red avatar on the static BLUE background: the avatar box
    // (x 40..190, y 40..190) must come out red-dominant in the centre
    // (the white border + scrim are avoided by sampling the middle).
    const redAvatar = await sharp({
      create: { width: 256, height: 256, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const withAvatar = await renderProfileCard(baseInput({ backgroundPath: bgPngPath, avatarBuffer: redAvatar }));
    const rgb = meanRgb(firstFramePixels(withAvatar), 100, 100, 140, 140);
    expect(rgb.r).toBeGreaterThan(80);
    expect(rgb.r).toBeGreaterThan(rgb.g + 40);
    expect(rgb.r).toBeGreaterThan(rgb.b + 40);
    // Control: the same card with a null avatar is NOT red there
    // (blue background under the dark scrim).
    const noAvatar = await renderProfileCard(baseInput({ backgroundPath: bgPngPath, avatarBuffer: null }));
    const rgbNull = meanRgb(firstFramePixels(noAvatar), 100, 100, 140, 140);
    expect(rgbNull.r).toBeLessThan(rgbNull.b);
  });

  it("renders with empty about and null guild (placeholder text, no throw)", async () => {
    const buf = await renderProfileCard(baseInput({ about: "", guildName: null, gems: 0 }));
    expect(buf.subarray(0, 6).toString("ascii")).toMatch(/^GIF8[79]a$/);
  });

  it("truncates/clamps long displayName and about without throwing", async () => {
    const buf = await renderProfileCard(
      baseInput({
        displayName: "A".repeat(200) + "<script>alert(1)</script>",
        about: "word ".repeat(200) + "<b>bold</b> & \"quotes\"",
      }),
    );
    expect(buf.subarray(0, 6).toString("ascii")).toMatch(/^GIF8[79]a$/);
    expect(gifSize(buf)).toEqual({ width: 800, height: 500 });
  });

  it("throws a clear error for a missing background file (fail-closed)", async () => {
    await expect(renderProfileCard(baseInput({ backgroundPath: "/nonexistent/bg.gif" }))).rejects.toThrow(
      /Profile background not found/,
    );
  });
});

describe("xpProgressFraction", () => {
  it("matches input XP math", () => {
    expect(xpProgressFraction({ xpIntoLevel: 1250, xpForNextLevel: 5000 })).toBe(0.25);
    expect(xpProgressFraction({ xpIntoLevel: 0, xpForNextLevel: 5000 })).toBe(0);
    expect(xpProgressFraction({ xpIntoLevel: 5000, xpForNextLevel: 5000 })).toBe(1);
  });

  it("clamps overfull progress and guards zero/negative totals", () => {
    expect(xpProgressFraction({ xpIntoLevel: 9999, xpForNextLevel: 5000 })).toBe(1);
    expect(xpProgressFraction({ xpIntoLevel: 100, xpForNextLevel: 0 })).toBe(0);
    expect(xpProgressFraction({ xpIntoLevel: -50, xpForNextLevel: 5000 })).toBe(0);
  });
});

describe("sanitizers", () => {
  it("escapeXml escapes markup", () => {
    expect(escapeXml('<a href="x">&\'b\'</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;b&apos;&lt;/a&gt;");
  });

  it("truncateToWidth ellipsizes over-long names", () => {
    const out = truncateToWidth("A".repeat(100), 300, 40, true);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThan(100);
    expect(truncateToWidth("Short", 300, 40, true)).toBe("Short");
  });

  it("wrapText clamps to 2 lines with an ellipsis", () => {
    const lines = wrapText("word ".repeat(100), 700, 20, 2);
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines.join(" ").endsWith("…")).toBe(true);
    expect(wrapText("", 700, 20, 2)).toEqual([]);
  });
});
