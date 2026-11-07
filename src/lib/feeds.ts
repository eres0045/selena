import type { SelenaDb } from "./db.js";

/**
 * Announcements + rare-catch logs (Phase 2 design §11).
 *
 * - Announcements: the global update feed, stored in `announcements`
 *   (never hard-coded), posted by admins with `uwu announce`.
 * - Rare logs: the Epic+ brag board, stored in `rare_logs`. Rows are
 *   written automatically at the moment an item is awarded — callers
 *   pass every award through logRareCatch and it filters by tier
 *   itself, so no caller has to remember which tiers count.
 * - Everything is plain text. Feed output never contains `<@id>`
 *   mentions (leaderboard no-ping rule): names are resolved display
 *   names, and IDs are only ever a fallback when a guild lookup fails.
 */

/** Tiers that belong on the rare-catch feed. Common/Uncommon/Rare never log. */
export const RARE_TIERS: readonly string[] = ["Epic", "Legendary", "Mythic", "UwU"];

export type RareItemType = "monster" | "weapon" | "pet" | "crate" | "other";
export type RareSource = "hunt" | "roll" | "auction" | "trade" | "shop" | "tower" | "battle";

export interface RareCatchEntry {
  userId: string;
  guildId: string;
  itemType: RareItemType;
  itemRef: string;
  tier: string;
  source: RareSource;
  nowMs: number;
}

export interface AnnouncementRow {
  id: number;
  title: string;
  body: string;
  posted_by: string;
  posted_at: number;
}

export interface RareLogRow {
  id: number;
  user_id: string;
  guild_id: string;
  item_type: string;
  item_ref: string;
  tier: string;
  source: string;
  caught_at: number;
}

const TITLE_MIN = 3;
const TITLE_MAX = 80;
const BODY_MIN = 1;
const BODY_MAX = 500;

/** `2026-11-07` — same date shape huntDb uses for day keys. */
function dayString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const TIER_EMOJI: Record<string, string> = {
  Epic: "💜",
  Legendary: "⭐",
  Mythic: "🔮",
  UwU: "🌈",
};

/**
 * Record a rare catch/award in `rare_logs`. Silently no-ops for
 * Common/Uncommon/Rare (and any unknown tier) — callers must NOT
 * pre-filter; pass every award here.
 *
 * Never throws: a logging failure must never break an award. Failures
 * are reported to the console and swallowed.
 */
export async function logRareCatch(db: SelenaDb, entry: RareCatchEntry): Promise<void> {
  if (!RARE_TIERS.includes(entry.tier)) return;
  try {
    await db
      .prepare(
        "INSERT INTO rare_logs (user_id, guild_id, item_type, item_ref, tier, source, caught_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(entry.userId, entry.guildId, entry.itemType, entry.itemRef, entry.tier, entry.source, entry.nowMs);
  } catch (e) {
    console.error("uwu: failed to log rare catch:", e instanceof Error ? e.message : e);
  }
}

/**
 * Post an announcement to the global feed. Returns the new row id.
 * Throws when the title is not 3–80 chars or the body is not 1–500
 * chars (lengths measured after trimming).
 */
export async function postAnnouncement(
  db: SelenaDb,
  title: string,
  body: string,
  postedBy: string,
  nowMs: number,
): Promise<number> {
  const t = title.trim();
  const b = body.trim();
  if (t.length < TITLE_MIN || t.length > TITLE_MAX) {
    throw new Error(`Announcement title must be ${TITLE_MIN}–${TITLE_MAX} characters.`);
  }
  if (b.length < BODY_MIN || b.length > BODY_MAX) {
    throw new Error(`Announcement text must be ${BODY_MIN}–${BODY_MAX} characters.`);
  }
  const r = await db
    .prepare("INSERT INTO announcements (title, body, posted_by, posted_at) VALUES (?, ?, ?, ?)")
    .run(t, b, postedBy, nowMs);
  return Number(r.lastInsertRowid);
}

/** Latest announcements, newest first. */
export async function getAnnouncements(db: SelenaDb, limit = 10): Promise<AnnouncementRow[]> {
  return (await db
    .prepare(
      "SELECT id, title, body, posted_by, posted_at FROM announcements ORDER BY posted_at DESC, id DESC LIMIT ?",
    )
    .all(limit)) as unknown as AnnouncementRow[];
}

/**
 * Latest rare-catch rows, newest first. `guildId === null` = global
 * (all of Discord); otherwise only that server's rows.
 */
export async function getRareLogs(db: SelenaDb, guildId: string | null, limit = 10): Promise<RareLogRow[]> {
  if (guildId === null) {
    return (await db
      .prepare(
        "SELECT id, user_id, guild_id, item_type, item_ref, tier, source, caught_at FROM rare_logs ORDER BY caught_at DESC, id DESC LIMIT ?",
      )
      .all(limit)) as unknown as RareLogRow[];
  }
  return (await db
    .prepare(
      "SELECT id, user_id, guild_id, item_type, item_ref, tier, source, caught_at FROM rare_logs WHERE guild_id = ? ORDER BY caught_at DESC, id DESC LIMIT ?",
    )
    .all(guildId, limit)) as unknown as RareLogRow[];
}

/**
 * One plain-text line for a rare-catch row. `displayName` is the
 * already-resolved display name (resolved by the command layer via
 * resolveDisplayNames) — never a `<@id>` mention.
 */
export function formatRareLog(entry: RareLogRow, displayName: string): string {
  const emoji = TIER_EMOJI[entry.tier] ?? "✨";
  return `${emoji} ${entry.item_ref} — ${displayName} · ${entry.tier} ${entry.item_type} · via ${entry.source} · ${dayString(entry.caught_at)}`;
}

/** Format one announcement as a single plain-text line with its date. */
export function formatAnnouncement(row: AnnouncementRow): string {
  return `• ${dayString(row.posted_at)} — ${row.title}: ${row.body}`;
}

/** Minimal shape of a discord.js Client the sweep needs (channels only). */
export interface SweepClient {
  channels: {
    fetch: (id: string) => Promise<{ send: (msg: unknown) => Promise<unknown> } | null>;
  };
}

/**
 * How long after a catch the sweep will still auto-post it to a
 * server's log channel. Older unposted rows are marked posted without
 * sending — they stay visible via `uwu logs`, and an admin who sets a
 * log channel weeks later must not get spammed with ancient catches.
 */
export const RARE_LOG_POST_WINDOW_MS = 10 * 60 * 1000;

/**
 * Post unposted rare-log rows to each guild's configured log channel
 * (guild_settings.log_channel_id). Runs from the coordinator's 60s
 * due-task sweep. One message per entry, plain text, no mentions.
 *
 * - Guilds with no log channel: rows stay unposted while fresh (a
 *   channel set within the window still catches them), then age out
 *   and are marked posted without sending.
 * - A failed fetch/send leaves the row unposted so the next sweep
 *   retries it while it is still fresh.
 * - Never throws: a sweep failure must never break the due-task loop.
 */
export async function rareLogSweep(db: SelenaDb, client: SweepClient): Promise<void> {
  try {
    const now = Date.now();
    const rows = (await db
      .prepare(
        "SELECT id, user_id, guild_id, item_type, item_ref, tier, source, caught_at FROM rare_logs WHERE posted = 0 ORDER BY caught_at ASC, id ASC",
      )
      .all()) as unknown as RareLogRow[];
    for (const row of rows) {
      try {
        if (row.caught_at < now - RARE_LOG_POST_WINDOW_MS) {
          // Too old to auto-post — mark done so it never spams later.
          await db.prepare("UPDATE rare_logs SET posted = 1 WHERE id = ?").run(row.id);
          continue;
        }
        const settings = (await db
          .prepare("SELECT log_channel_id FROM guild_settings WHERE guild_id = ?")
          .get(row.guild_id)) as { log_channel_id: string | null } | undefined;
        const channelId = settings?.log_channel_id ?? null;
        if (!channelId) continue; // no log channel yet — leave unposted
        const channel = await client.channels.fetch(channelId);
        if (!channel || typeof channel.send !== "function") continue; // retry next sweep
        // The sweep has no guild member lookup: the raw user id is the
        // fallback display name (plain text, never a mention). `uwu logs`
        // resolves real display names.
        await channel.send({ content: formatRareLog(row, row.user_id) });
        await db.prepare("UPDATE rare_logs SET posted = 1 WHERE id = ?").run(row.id);
      } catch (e) {
        console.error(`uwu: rare-log sweep failed for row #${row.id}:`, e instanceof Error ? e.message : e);
      }
    }
  } catch (e) {
    console.error("uwu: rare-log sweep failed:", e instanceof Error ? e.message : e);
  }
}
