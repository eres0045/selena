import { describe, it, expect } from "vitest";
import {
  STRIP_CARD_H,
  STRIP_CARD_W,
  STRIP_MIN_WIDTH,
  STRIP_ROW_GAP,
  STRIP_STEP,
  composeHandStrip,
  decodeGifFrames,
} from "../src/lib/handstrip.js";

/** Count frames by counting Graphic Control Extension blocks (0x21 0xF9). */
function gifFrameCount(buf: Buffer): number {
  let count = 0;
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0x21 && buf[i + 1] === 0xf9) count++;
  }
  return count;
}

/** True when any Graphic Control Extension block sets the transparent-colour flag. */
function gifHasTransparency(buf: Buffer): boolean {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x21 && buf[i + 1] === 0xf9 && buf[i + 2] === 0x04) {
      if ((buf[i + 3] & 0x01) === 1) return true;
    }
  }
  return false;
}

const LOOP_EXT = Buffer.from("NETSCAPE2.0");

describe("composeHandStrip (OwO-style compact strips)", () => {
  it("uses ~28px cards in a half-size (~280px) strip file", () => {
    expect(STRIP_CARD_W).toBe(28);
    expect(STRIP_CARD_H).toBe(39);
    expect(STRIP_STEP).toBeGreaterThan(STRIP_CARD_W); // gap, not overlap
    expect(STRIP_MIN_WIDTH).toBe(280);
  });

  it("composes a two-row blackjack strip: dealer on top, player below, centred in a small frame", async () => {
    const strip = await composeHandStrip([
      [{ code: "KH" }, { code: "AS", faceDown: true }],
      [{ code: "AS" }, { code: "10H" }],
    ]);
    expect(strip).not.toBeNull();
    expect(strip?.width).toBe(STRIP_MIN_WIDTH);
    expect(strip?.height).toBe(STRIP_CARD_H * 2 + STRIP_ROW_GAP);
    expect(strip?.frames).toBe(1); // nothing animates
    expect(strip?.animated).toBe(false);
    expect(strip?.buffer.subarray(0, 6).toString("ascii")).toBe("GIF89a");
  });

  it("the strip background is transparent, not a felt box", async () => {
    const strip = await composeHandStrip([
      [{ code: "KH" }, { code: "AS", faceDown: true }],
      [{ code: "AS" }, { code: "10H" }],
    ]);
    expect(strip).not.toBeNull();
    const buf = strip?.buffer as Buffer;
    expect(gifHasTransparency(buf)).toBe(true);
    const { width, frames } = decodeGifFrames(buf);
    const frame = frames[0] as Buffer;
    // Padding around the centred hand is transparent…
    expect(frame[(0 * width + 0) * 4 + 3]).toBe(0);
    // …and so is a card's own rounded corner: the first dealer card
    // starts at x0 = (280 - (28 + 34)) / 2 = 109, y = 0.
    const x0 = Math.floor((STRIP_MIN_WIDTH - (STRIP_CARD_W + STRIP_STEP)) / 2);
    expect(frame[(0 * width + x0) * 4 + 3]).toBe(0);
    // …while the card centre is opaque.
    expect(frame[(19 * width + (x0 + 14)) * 4 + 3]).toBe(255);
  });

  it("animates the newly dealt card and keeps the others still", async () => {
    const strip = await composeHandStrip([
      [{ code: "KH" }, { code: "AS", faceDown: true }],
      [{ code: "AS", animate: true }, { code: "10H" }],
    ]);
    expect(strip).not.toBeNull();
    expect(strip?.animated).toBe(true);
    expect(strip?.frames).toBeGreaterThanOrEqual(7);
    // The byte scan can over-count (0x21 0xF9 can occur inside image data),
    // so it only bounds the real frame count from below.
    expect(gifFrameCount(strip?.buffer as Buffer)).toBeGreaterThanOrEqual(strip?.frames as number);
    expect(strip?.buffer.length).toBeLessThan(1_000_000);
  });

  it("the animated strip plays ONCE and ends on the face", async () => {
    const strip = await composeHandStrip([
      [{ code: "KH" }, { code: "AS", faceDown: true }],
      [{ code: "AS", animate: true }, { code: "10H" }],
    ]);
    expect(strip).not.toBeNull();
    const buf = strip?.buffer as Buffer;
    expect(buf.includes(LOOP_EXT)).toBe(false);
    expect(gifHasTransparency(buf)).toBe(true);
    // The animated strip's last frame is exactly the settled face-up
    // strip's only frame (same cards, same layout, all face-up).
    const settled = await composeHandStrip([
      [{ code: "KH" }, { code: "AS", faceDown: true }],
      [{ code: "AS" }, { code: "10H" }],
    ]);
    expect(settled).not.toBeNull();
    const animatedFrames = decodeGifFrames(buf).frames;
    const settledFrames = decodeGifFrames(settled?.buffer as Buffer).frames;
    expect(settledFrames).toHaveLength(1);
    expect(Buffer.compare(
      animatedFrames[animatedFrames.length - 1] as Buffer,
      settledFrames[0] as Buffer,
    )).toBe(0);
  });

  it("a face-down card renders differently from the same card face-up", async () => {
    const down = await composeHandStrip([[{ code: "AS", faceDown: true }]]);
    const up = await composeHandStrip([[{ code: "AS" }]]);
    expect(down).not.toBeNull();
    expect(up).not.toBeNull();
    expect(Buffer.compare(down?.buffer as Buffer, up?.buffer as Buffer)).not.toBe(0);
  });

  it("returns null when a card has no rendered flip GIF", async () => {
    const strip = await composeHandStrip([[{ code: "ZZ" }]]);
    expect(strip).toBeNull();
  });

  it("a single-row high/low strip is one row tall and small", async () => {
    const strip = await composeHandStrip([[{ code: "5H" }, { code: "9D", animate: true }]]);
    expect(strip).not.toBeNull();
    expect(strip?.width).toBe(STRIP_MIN_WIDTH);
    expect(strip?.height).toBe(STRIP_CARD_H);
    expect(strip?.animated).toBe(true);
  });

  it("labels: dealer/you rows carry their word + total in the image", async () => {
    const strip = await composeHandStrip(
      [
        [{ code: "KH" }, { code: "AS", faceDown: true }],
        [{ code: "AS" }, { code: "10H" }],
      ],
      [
        { title: "DEALER", value: "?" },
        { title: "YOU", value: "15" },
      ],
    );
    expect(strip).not.toBeNull();
    expect(strip?.width).toBe(STRIP_MIN_WIDTH);
    expect(strip?.height).toBe(STRIP_CARD_H * 2 + STRIP_ROW_GAP);
    const buf = strip?.buffer as Buffer;
    expect(gifHasTransparency(buf)).toBe(true);
    const { width, frames } = decodeGifFrames(buf);
    const frame = frames[0] as Buffer;
    // The label column (x 8..64) has real ink: the DEALER word and the
    // "?" below it. Count opaque pixels in the dealer row's label block.
    let ink = 0;
    for (let y = 0; y < STRIP_CARD_H; y++) {
      for (let x = 8; x < 64; x++) {
        if (frame[(y * width + x) * 4 + 3] === 255) ink++;
      }
    }
    expect(ink).toBeGreaterThan(150);
    // …while the padding around the labels stays transparent.
    expect(frame[(0 * width + 0) * 4 + 3]).toBe(0);
    expect(frame[(10 * width + 270) * 4 + 3]).toBe(0);
  });

  it("labels: the total changes the strip, and '?' renders", async () => {
    const rows = [
      [{ code: "KH" }, { code: "AS", faceDown: true }],
      [{ code: "AS" }, { code: "10H" }],
    ];
    const seventeen = await composeHandStrip(rows, [
      { title: "DEALER", value: "17" },
      { title: "YOU", value: "15" },
    ]);
    const twentyOne = await composeHandStrip(rows, [
      { title: "DEALER", value: "21" },
      { title: "YOU", value: "15" },
    ]);
    const hidden = await composeHandStrip(rows, [
      { title: "DEALER", value: "?" },
      { title: "YOU", value: "15" },
    ]);
    expect(seventeen).not.toBeNull();
    expect(twentyOne).not.toBeNull();
    expect(hidden).not.toBeNull();
    expect(Buffer.compare(seventeen?.buffer as Buffer, twentyOne?.buffer as Buffer)).not.toBe(0);
    expect(Buffer.compare(seventeen?.buffer as Buffer, hidden?.buffer as Buffer)).not.toBe(0);
  });

  it("labels: an unknown word falls back to null (text-only embed)", async () => {
    const strip = await composeHandStrip([[{ code: "AS" }]], [{ title: "NOPE", value: "7" }]);
    expect(strip).toBeNull();
  });

  it("labels: the animated strip still plays ONCE and ends on the face", async () => {
    const labels = [
      { title: "DEALER", value: "?" },
      { title: "YOU", value: "15" },
    ];
    const strip = await composeHandStrip(
      [
        [{ code: "KH" }, { code: "AS", faceDown: true }],
        [{ code: "AS", animate: true }, { code: "10H" }],
      ],
      labels,
    );
    expect(strip).not.toBeNull();
    expect(strip?.animated).toBe(true);
    const buf = strip?.buffer as Buffer;
    expect(buf.includes(LOOP_EXT)).toBe(false);
    const settled = await composeHandStrip(
      [
        [{ code: "KH" }, { code: "AS", faceDown: true }],
        [{ code: "AS" }, { code: "10H" }],
      ],
      labels,
    );
    expect(settled).not.toBeNull();
    const animatedFrames = decodeGifFrames(buf).frames;
    const settledFrames = decodeGifFrames(settled?.buffer as Buffer).frames;
    expect(settledFrames).toHaveLength(1);
    expect(Buffer.compare(
      animatedFrames[animatedFrames.length - 1] as Buffer,
      settledFrames[0] as Buffer,
    )).toBe(0);
  });
});
