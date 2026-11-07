import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Animated playing cards for the casino games.
 *
 * Discord cannot render PNGs as animations, so the cards are
 * pre-rendered: the faces in assets/cards/emoji-gg-black-pack/ and
 * assets/cards/emoji-gg-red-pack/ (emoji.gg cartoon card packs —
 * spades+clubs black pack, diamonds+hearts red pack, 200x200 PNGs)
 * are turned into flip GIFs by scripts/render_emoji_flips.py — each
 * card's 3D flip (back -> flip -> face) as an animated GIF in
 * assets/cards/flips/<CODE>.gif. The bot attaches those GIFs to its
 * replies; the packs stay in the repo as the source of the GIFs. (The
 * 4K realistic pack in assets/cards/real-pack/ and the older
 * playing-cards.html web-component art are kept as references only;
 * they no longer supply the faces.)
 * The GIFs are ~100px-wide cards, then composed into one (~700px)
 * transparent strip per game
 * by src/lib/handstrip.ts — bigger than the 28px version so the cards
 * read at phone size, smaller than the 50px version, and sharp, because
 * the cards are rendered at 8x and Lanczos-downscaled. The GIFs play ONCE
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

/**
 * Unicode playing-card glyph for a card code ("AS" -> 🂡, "10H" -> 🂺,
 * "KD" -> 🃎). One glyph per card, tiny in text — no image, no emoji
 * upload. Layout: spades U+1F0A1.., hearts U+1F0B1.., diamonds
 * U+1F0C1.., clubs U+1F0D1..; A=1, 2-10=2-10, J=11, Q=13, K=14 (the
 * Knight at offset 12 is skipped). Unknown codes pass through as text.
 */
const GLYPH_BASE: Record<string, number> = { S: 0x1f0a0, H: 0x1f0b0, D: 0x1f0c0, C: 0x1f0d0 };
const GLYPH_RANK_OFFSET: Record<string, number> = {
  A: 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 10,
  J: 11,
  Q: 13,
  K: 14,
};

export function cardGlyph(code: string): string {
  const suit = code.slice(-1);
  const rank = code.slice(0, -1);
  const base = GLYPH_BASE[suit];
  const offset = GLYPH_RANK_OFFSET[rank];
  if (base === undefined || offset === undefined) return code;
  return String.fromCodePoint(base + offset);
}

/** The face-down card back glyph (🂠), used for hidden cards. */
export const CARD_BACK = "🂠";

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
