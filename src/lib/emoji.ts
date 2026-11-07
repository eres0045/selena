/**
 * Animated custom emoji for Selena's embeds.
 *
 * The files live in assets/emoji-animated/ (see SOURCES.md there).
 * After each file is uploaded to the Zenith Esports server as a custom
 * emoji, fill in its Discord emoji ID in EMOJI_IDS below — the emoji
 * NAME on Discord must match the key (coin, slots, roulette, trophy,
 * gift, party, fire, star).
 *
 * Until an ID is filled in ("" = not uploaded yet), emoji() falls back
 * to the plain Unicode character, so the bot keeps working exactly as
 * before and the tests pass. Nothing else in the bot reads these IDs.
 */
export type EmojiName =
  | "coin"
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
  coin: "1568509688340025394",
  slots: "1568506467093454888",
  roulette: "1568506546621784175",
  trophy: "1568506606566510702",
  gift: "1568506671070707742",
  party: "1568506723390455889",
  fire: "1568506779086757898",
  star: "1568506842747768913",
};

const FALLBACK: Record<EmojiName, string> = {
  coin: "🪙",
  slots: "🎰",
  roulette: "🎡",
  trophy: "🏆",
  gift: "🎁",
  party: "🎉",
  fire: "🔥",
  star: "⭐",
};

/**
 * Markup for an animated custom emoji (`<a:name:id>`), or the plain
 * Unicode emoji while the custom one has no ID yet.
 */
export function emoji(name: EmojiName): string {
  const id = EMOJI_IDS[name];
  if (id) return `<a:${name}:${id}>`;
  return FALLBACK[name];
}
