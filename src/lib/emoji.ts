/**
 * Custom emoji for Selena's embeds (animated unless noted).
 *
 * The files live in assets/emoji-animated/ (see SOURCES.md there).
 * After each file is uploaded to the Zenith Esports server as a custom
 * emoji, fill in its Discord emoji ID in EMOJI_IDS below — the emoji
 * NAME on Discord must match the key (coin, gold, gem, slots,
 * roulette, trophy, gift, party, fire, star).
 *
 * Until an ID is filled in ("" = not uploaded yet), emoji() falls back
 * to the plain Unicode character, so the bot keeps working exactly as
 * before and the tests pass. Nothing else in the bot reads these IDs.
 */
export type EmojiName =
  | "coin"
  | "gold"
  | "gem"
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
  gold: "1568562054107766854",
  gem: "1568557201797423197",
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
  gold: "🪙",
  gem: "💎",
  slots: "🎰",
  roulette: "🎡",
  trophy: "🏆",
  gift: "🎁",
  party: "🎉",
  fire: "🔥",
  star: "⭐",
};

/**
 * Which custom emoji are animated. Static ones render `<:name:id>`,
 * animated ones `<a:name:id>`. Everything here is animated except
 * gold (the gag_sheckles coin stacks are a static PNG).
 */
const ANIMATED: Record<EmojiName, boolean> = {
  coin: true,
  gold: false,
  gem: true,
  slots: true,
  roulette: true,
  trophy: true,
  gift: true,
  party: true,
  fire: true,
  star: true,
};

/**
 * Markup for a custom emoji (`<:name:id>` static, `<a:name:id>`
 * animated), or the plain Unicode emoji while the custom one has no
 * ID yet.
 */
export function emoji(name: EmojiName): string {
  const id = EMOJI_IDS[name];
  if (id) return ANIMATED[name] ? `<a:${name}:${id}>` : `<:${name}:${id}>`;
  return FALLBACK[name];
}
