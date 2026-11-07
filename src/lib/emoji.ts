/**
 * Custom emoji for Selena's embeds (animated + the two static coin
 * faces).
 *
 * The files live in assets/emoji-animated/ (see SOURCES.md there).
 * After each file is uploaded to the Zenith Esports server as a custom
 * emoji, fill in its Discord emoji ID in EMOJI_IDS below — the emoji
 * NAME on Discord must match the key (coin, slots, roulette, trophy,
 * gift, party, fire, star, heads, tails). heads/tails are STATIC
 * (PNG); the rest are animated (GIF).
 *
 * Until an ID is filled in ("" = not uploaded yet), emoji() falls back
 * to the plain Unicode character, so the bot keeps working exactly as
 * before and the tests pass. Nothing else in the bot reads these IDs.
 */
export type EmojiName =
  | "coin"
  | "heads"
  | "tails"
  | "slots"
  | "roulette"
  | "trophy"
  | "gift"
  | "party"
  | "fire"
  | "star";

/**
 * Discord custom-emoji IDs, as STRINGS — snowflakes are 64-bit and can
 * exceed Number.MAX_SAFE_INTEGER, so a JS number would silently round
 * them (123456789012345678 becomes ...680). "" = not uploaded yet
 * (Unicode fallback).
 */
export const EMOJI_IDS: Record<EmojiName, string> = {
  coin: "1568514166443212840",
  // heads/tails uploaded 2026-11-07 as STATIC server emoji (PNGs in
  // assets/emoji-animated/heads.png / tails.png).
  heads: "1568526877256192050",
  tails: "1568526956025356328",
  slots: "1568506467093454888",
  roulette: "1568506546621784175",
  trophy: "1568506606566510702",
  gift: "1568514248881995776",
  party: "1568506723390455889",
  fire: "1568506779086757898",
  star: "1568506842747768913",
};

const FALLBACK: Record<EmojiName, string> = {
  coin: "🪙",
  heads: "🪙",
  tails: "⭐",
  slots: "🎰",
  roulette: "🎡",
  trophy: "🏆",
  gift: "🎁",
  party: "🎉",
  fire: "🔥",
  star: "⭐",
};

/**
 * Markup for a custom emoji, or the plain Unicode emoji while the
 * custom one has no ID yet. Animated emoji render as `<a:name:id>`,
 * static ones as `<:name:id>` — the `a:` prefix on a static emoji
 * would not render, so heads/tails (static PNGs) use the plain form.
 */
const STATIC: ReadonlySet<EmojiName> = new Set(["heads", "tails"]);

export function emoji(name: EmojiName): string {
  const id = EMOJI_IDS[name];
  if (id) return STATIC.has(name) ? `<:${name}:${id}>` : `<a:${name}:${id}>`;
  return FALLBACK[name];
}
