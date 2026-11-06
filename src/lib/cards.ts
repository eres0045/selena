import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Animated playing cards for the casino games.
 *
 * Discord cannot render HTML/CSS/JS, so the cards are pre-rendered: the
 * <playing-card> component in assets/cards/playing-cards.html (Ronit's own
 * file) is rendered in headless Chromium by scripts/capture_flips.py and
 * each card's 3D flip (back -> flip -> face) is captured as an animated
 * GIF in assets/cards/flips/<CODE>.gif. The bot attaches those GIFs to
 * its replies; the HTML file stays in the repo as the source of the GIFs.
 * The GIFs are shrunk to ~28px-wide cards by scripts/resize_flips.py,
 * then composed into one half-size (~280px) transparent strip per game
 * by src/lib/handstrip.ts — small on screen AND sharp, because the
 * cards are rendered at 4x and Lanczos-downscaled. The GIFs play ONCE
 * and stop on the face (no loop extension), use disposal method 2 so
 * each frame is a clean image (no mid-flip smear), and the card corners
 * are transparent (no felt box). Row labels ("DEALER" / "YOU" + totals)
 * are separate sprites in assets/cards/labels/, rendered by
 * scripts/render_labels.py and pasted into the strip by handstrip.ts.
 */

export const CARD_SUITS = ["S", "H", "D", "C"] as const;
export const CARD_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;

/** All 52 card codes, e.g. "AS", "10H", "KD". */
export const FLIP_CODES: string[] = CARD_SUITS.flatMap((s) => CARD_RANKS.map((r) => `${r}${s}`));

const SUIT_SYMBOLS: Record<string, string> = { S: "♠", H: "♥", D: "♦", C: "♣" };

/** "AS" -> "A♠", "10H" -> "10♥". Plain ranks pass through unchanged. */
export function prettyCard(code: string): string {
  const suit = code.slice(-1);
  const symbol = SUIT_SYMBOLS[suit];
  if (!symbol) return code;
  return `${code.slice(0, -1)}${symbol}`;
}

/** Directory holding the rendered flip GIFs (and the static card faces). */
export function cardsAssetDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../assets/cards");
}

export function flipGifDir(): string {
  return resolve(cardsAssetDir(), "flips");
}

/** Absolute path of the flip GIF for a card code ("AS" -> .../flips/AS.gif). */
export function flipGifPath(code: string): string {
  return resolve(flipGifDir(), `${code}.gif`);
}

export function flipGifExists(code: string): boolean {
  return existsSync(flipGifPath(code));
}

/** Absolute path of a label sprite GIF ("word-dealer", "digit-2", ...). */
export function labelGifPath(name: string): string {
  return resolve(cardsAssetDir(), "labels", `${name}.gif`);
}

export function labelGifExists(name: string): boolean {
  return existsSync(labelGifPath(name));
}
