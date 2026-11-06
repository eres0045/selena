import { describe, it, expect } from "vitest";
import {
  STRIP_CARD_H,
  STRIP_CARD_W,
  STRIP_ROW_GAP,
  STRIP_STEP,
  composeHandStrip,
} from "../src/lib/handstrip.js";

/** Count frames by counting Graphic Control Extension blocks (0x21 0xF9). */
function gifFrameCount(buf: Buffer): number {
  let count = 0;
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0x21 && buf[i + 1] === 0xf9) count++;
  }
  return count;
}

describe("composeHandStrip (OwO-style compact strips)", () => {
  it("uses small 60px cards", () => {
    expect(STRIP_CARD_W).toBe(60);
    expect(STRIP_CARD_H).toBe(84);
    expect(STRIP_STEP).toBeLessThan(STRIP_CARD_W); // fanned overlap
  });

  it("composes a two-row blackjack strip: dealer on top, player below", async () => {
    const strip = await composeHandStrip([
      [{ code: "KH" }, { code: "AS", faceDown: true }],
      [{ code: "AS" }, { code: "10H" }],
    ]);
    expect(strip).not.toBeNull();
    expect(strip?.width).toBe(STRIP_CARD_W + STRIP_STEP);
    expect(strip?.height).toBe(STRIP_CARD_H * 2 + STRIP_ROW_GAP);
    expect(strip?.frames).toBe(1); // nothing animates
    expect(strip?.animated).toBe(false);
    expect(strip?.buffer.subarray(0, 6).toString("ascii")).toBe("GIF89a");
  });

  it("animates the newly dealt card and keeps the others still", async () => {
    const strip = await composeHandStrip([
      [{ code: "KH" }, { code: "AS", faceDown: true }],
      [{ code: "AS", animate: true }, { code: "10H" }],
    ]);
    expect(strip).not.toBeNull();
    expect(strip?.animated).toBe(true);
    expect(strip?.frames).toBeGreaterThanOrEqual(8);
    // The byte scan can over-count (0x21 0xF9 can occur inside image data),
    // so it only bounds the real frame count from below.
    expect(gifFrameCount(strip?.buffer as Buffer)).toBeGreaterThanOrEqual(strip?.frames as number);
    expect(strip?.buffer.length).toBeLessThan(1_000_000);
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

  it("a single-row high/low strip is one row tall", async () => {
    const strip = await composeHandStrip([[{ code: "5H" }, { code: "9D", animate: true }]]);
    expect(strip).not.toBeNull();
    expect(strip?.width).toBe(STRIP_CARD_W + STRIP_STEP);
    expect(strip?.height).toBe(STRIP_CARD_H);
    expect(strip?.animated).toBe(true);
  });
});
