import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

/**
 * The OwO big-list shop format (Ron's order, 2026-11-07 — from his
 * OwO Shop: Rings / Wallpapers screenshots): any big list (10+
 * items) renders as NUMBERED rows with a dotted leader filling to a
 * right-aligned compact price/value, then a small trailing icon —
 * paginated 10 per page with ◀ N ▶ buttons (the middle button shows
 * the current page number, disabled).
 *
 *   1  🖼️ Neon Street .................. 20K [static] ✓
 *   2  🖼️ Rainy Street ................. 18K [static]
 *   Page 1/3
 *
 * Applies to the background catalogue (`uwu shop bg`), the tower
 * list (`uwu tower`), and any future big list — the rule is recorded
 * in docs/hunt-world-phase2-design.md so new lists follow it without
 * being told again. Prices use OwO's compact form (10, 100, 1K, 10K,
 * 100K, 1M, 10M).
 */

/** OwO-style compact price: 10, 100, 1K, 1.5K, 12K, 100K, 1M, 2.5M, 10M. */
export function compactGold(n: number): string {
  const v = Math.trunc(n);
  if (v < 1000) return String(v);
  const trim = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  if (v < 1_000_000) return `${trim(v / 1000)}K`;
  if (v < 1_000_000_000) return `${trim(v / 1_000_000)}M`;
  return `${trim(v / 1_000_000_000)}B`;
}

/**
 * Dotted leader: `name` padded with "." to `width` characters
 * (minimum 3 dots, so even the longest names get a visible leader).
 */
export function dotted(name: string, width = 30): string {
  const len = [...name].length;
  return name + ".".repeat(Math.max(3, width - len));
}

/**
 * One OwO-shop row: number, emoji, name + dotted leader, value,
 * then any trailing marks (e.g. " ✓" / " ★"). Pass "" for `emoji`
 * when the row has none (the ??? tower rows).
 *
 *   shopRow(1, "🖼️", "Neon Street", "20K [static]", " ✓")
 *   → "1  🖼️ Neon Street .................. 20K [static] ✓"
 */
export function shopRow(num: number, emoji: string, name: string, value: string, suffix = ""): string {
  const icon = emoji ? `${emoji} ` : "";
  return `${num}  ${icon}${dotted(name)} ${value}${suffix}`;
}

/**
 * OwO-style page buttons: ◀, the current page number (disabled),
 * ▶. `prefix` is the button customId prefix, e.g.
 * "selena:shopbg:list" — the page number is appended as the last
 * segment (":<page>", 0-based), matching the existing tower handler.
 */
export function pageButtons(
  prefix: string,
  page: number,
  pageCount: number,
): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${prefix}:${page - 1}`)
        .setLabel("◀")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`${prefix}:${page}`)
        .setLabel(String(page + 1))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`${prefix}:${page + 1}`)
        .setLabel("▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= pageCount - 1),
    ),
  ];
}
