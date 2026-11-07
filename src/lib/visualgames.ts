import { emoji } from "./emoji.js";

/**
 * Tiny-emoji casino games (Ronit 2026-11-07: "very small but sharp
 * emojis for all").
 *
 * The big-image approach is DEAD: Discord on his phone stretches every
 * attached image to the full message width no matter how small the
 * file is, so shrinking files never made the games look smaller —
 * only blurrier. These four games now use emoji-sized visuals INLINE
 * in the message text only. ZERO attached images, no strips, no
 * wheel images.
 *
 * Blackjack/high-low are already visual (card flip strips) and are NOT
 * touched here. The other four games keep the same suspense -> reveal
 * flow: the bot defers, shows the action emoji + neutral text
 * ("Flipping…"), then EDITS that same reply ~2.4s later to the
 * settled emoji + result. Game logic, bets and payouts are NOT changed
 * — only presentation. The settled message always shows the exact
 * real result as emoji inline: the coin face, the slot symbols, the
 * roulette number + colour dot, the scratch symbols.
 *
 *   * /coinflip — suspense: the animated server coin emoji spinning.
 *     Settled: the landed face as a small custom emoji — heads is the
 *     clean PIL $ disc, tails the gold star disc (PNGs in
 *     assets/emoji-animated/heads.png + tails.png; upload as server
 *     emoji "heads"/"tails" and fill the IDs in src/lib/emoji.ts).
 *     The animated coin spins forever so it CANNOT be the settled
 *     heads. Until the IDs are filled, the Unicode fallbacks 🪙 / ⭐
 *     are used. Heads and tails are unmistakable at emoji size.
 *   * /slots — suspense: the animated slots server emoji + "Spinning…".
 *     Settled: the three REAL result symbols as inline Unicode emoji.
 *   * /roulette — suspense: the animated roulette server emoji +
 *     "Spinning…", no number named. Settled: the winning number +
 *     a colour dot (🔴 red / ⚫ black / 🟢 green for 0). The number +
 *     colour IS the result — no wheel image.
 *   * /scratch — suspense: three covered tiles "❓ ❓ ❓" + "Scratching…".
 *     Settled: the three REAL drawn symbols as inline emoji.
 */

/** How long the suspense (spin/flip) phase plays before the reveal edit. */
export const VISUAL_SUSPENSE = { ms: 2400 };

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// ---------------------------------------------------------------------------
// Coinflip — the landed face as a small custom emoji (or Unicode fallback)
// ---------------------------------------------------------------------------

/** Emoji for the landed coin face: the custom heads/tails emoji once uploaded, 🪙 / ⭐ until then. */
export function coinflipFaceEmoji(result: "heads" | "tails"): string {
  return emoji(result);
}

// ---------------------------------------------------------------------------
// Roulette — the winning number + a colour dot inline
// ---------------------------------------------------------------------------

export const ROULETTE_COLOR_DOT: Record<"red" | "black" | "green", string> = {
  red: "🔴",
  black: "⚫",
  green: "🟢",
};

/** Colour dot for a roulette result colour ("red" | "black" | "green"). */
export function rouletteColorDot(color: "red" | "black" | "green"): string {
  return ROULETTE_COLOR_DOT[color];
}

// ---------------------------------------------------------------------------
// Slots / scratch — the real result symbols as one inline emoji line
// ---------------------------------------------------------------------------

/** Result symbols as a single inline emoji line, e.g. "🍒 🍋 7️⃣". */
export function symbolsLine(symbols: readonly string[]): string {
  return symbols.join(" ");
}

/** The three covered scratch tiles shown during the suspense phase. */
export const SCRATCH_COVERED = "❓ ❓ ❓";
