import type { SelenaDb } from "./db.js";
import { addPoints, getBalance } from "./economy.js";
import { DEFAULT_BG_ID, getBackground, listBackgrounds } from "./profileBgs.js";

/**
 * Profiles — About Me, profile backgrounds, global rank (Worker C).
 *
 * Profile data is GLOBAL (keyed by user_id alone): your About Me and
 * your backgrounds follow you across servers. Backgrounds are bought
 * with guild-scoped gold (the guild the purchase ran in — same as
 * every shop buy), but ownership is global. Tables live in db.ts
 * SCHEMA: user_profiles, user_backgrounds.
 *
 * Fail closed: every rule violation returns { ok: false, error } with
 * a plain-English message the command passes straight to the user.
 * Nothing here sends replies.
 */

export const ABOUT_MAX_CHARS = 100;

export interface UserProfile {
  about: string;
  equippedBg: string;
}

/** Read a user's profile, creating the row (defaults) when missing. */
export async function getUserProfile(db: SelenaDb, userId: string): Promise<UserProfile> {
  await db
    .prepare("INSERT OR IGNORE INTO user_profiles (user_id) VALUES (?)")
    .run(userId);
  const row = (await db
    .prepare("SELECT about, equipped_bg FROM user_profiles WHERE user_id = ?")
    .get(userId)) as { about: string; equipped_bg: string } | undefined;
  return { about: row?.about ?? "", equippedBg: row?.equipped_bg ?? DEFAULT_BG_ID };
}

/**
 * Strip anything pingable or linkable from About Me text: @everyone /
 * @here (broken with a zero-width space so the stored string can never
 * ping) and Discord invite links (discord.gg/…,
 * discord.com/invite/…, discordapp.com/invite/…). The replacement is
 * visible, never silent deletion.
 */
export function sanitizeAbout(text: string): string {
  return text
    .replace(/@everyone/gi, "@\u200beveryone")
    .replace(/@here/gi, "@\u200bhere")
    .replace(/https?:\/\/(?:www\.)?discord(?:app)?\.(?:com|gg)\/invite\/[^\s]*/gi, "[invite link removed]")
    .replace(/discord\.gg\/[^\s]*/gi, "[invite link removed]")
    .replace(/discord(?:app)?\.com\/invite\/[^\s]*/gi, "[invite link removed]");
}

/** Set the About Me line (max 100 chars, mentions/invites stripped). */
export async function setAbout(
  db: SelenaDb,
  userId: string,
  text: string,
): Promise<{ ok: boolean; error?: string; about?: string }> {
  const trimmed = text.trim();
  if (trimmed.length > ABOUT_MAX_CHARS) {
    return { ok: false, error: `Your About Me is ${trimmed.length} characters — the limit is ${ABOUT_MAX_CHARS}. Shorten it and try again.` };
  }
  const about = sanitizeAbout(trimmed);
  await db.prepare("INSERT OR IGNORE INTO user_profiles (user_id) VALUES (?)").run(userId);
  await db
    .prepare("UPDATE user_profiles SET about = ? WHERE user_id = ?")
    .run(about, userId);
  return { ok: true, about };
}

export interface BuyBackgroundResult {
  ok: boolean;
  error?: string;
  bgId?: string;
  bgName?: string;
  price?: number;
  remainingGold?: number;
}

/**
 * Buy a background: one transaction — the bg must exist in the
 * manifest and not be the free default, the user must not already own
 * it, and the guild-scoped gold check + deduction happen atomically
 * (addPoints throws when the balance would go below 0, which rolls
 * the transaction back).
 */
export async function buyBackground(
  db: SelenaDb,
  guildId: string,
  userId: string,
  bgId: string,
  nowMs: number,
): Promise<BuyBackgroundResult> {
  const bg = getBackground(bgId);
  if (!bg) {
    return { ok: false, error: `I don't know a background called "${bgId}" — see \`uwu shop bg\` for the full list.` };
  }
  if (bg.id === DEFAULT_BG_ID) {
    return { ok: false, error: "The Default background is free — it's already yours. Equip it with `uwu bg default`." };
  }
  try {
    const out = await db.transaction(async (tx) => {
      const owned = (await tx
        .prepare("SELECT bg_id FROM user_backgrounds WHERE user_id = ? AND bg_id = ?")
        .get(userId, bg.id)) as { bg_id: string } | undefined;
      if (owned) {
        throw new Error(`You already own **${bg.name}** — equip it with \`uwu bg ${bg.name}\`.`);
      }
      const balance = await getBalance(tx, guildId, userId);
      if (balance.points < bg.price) {
        throw new Error(
          `**${bg.name}** costs ${bg.price.toLocaleString("en-US")} gold and you have ${balance.points.toLocaleString("en-US")} — not enough gold yet.`,
        );
      }
      await addPoints(tx, guildId, userId, -bg.price, `profile bg buy ${bg.id}`);
      await tx
        .prepare("INSERT INTO user_backgrounds (user_id, bg_id, purchased_at) VALUES (?, ?, ?)")
        .run(userId, bg.id, nowMs);
      const remaining = (await getBalance(tx, guildId, userId)).points;
      return { remainingGold: remaining };
    });
    return { ok: true, bgId: bg.id, bgName: bg.name, price: bg.price, remainingGold: out.remainingGold };
  } catch (e) {
    // Fail-closed: the transaction rolled back, so no gold moved and no
    // ownership row was written. Surface the rule message, not the stack.
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't buy that background — try again in a bit." };
  }
}

export interface EquipBackgroundResult {
  ok: boolean;
  error?: string;
  bgId?: string;
  bgName?: string;
}

/** Equip an owned background (or the free default, always allowed). */
export async function equipBackground(
  db: SelenaDb,
  userId: string,
  bgId: string,
): Promise<EquipBackgroundResult> {
  const bg = getBackground(bgId);
  if (!bg) {
    return { ok: false, error: `I don't know a background called "${bgId}" — see \`uwu shop bg\` for the full list.` };
  }
  if (bg.id !== DEFAULT_BG_ID) {
    const owned = (await db
      .prepare("SELECT bg_id FROM user_backgrounds WHERE user_id = ? AND bg_id = ?")
      .get(userId, bg.id)) as { bg_id: string } | undefined;
    if (!owned) {
      return { ok: false, error: `You don't own **${bg.name}** yet — buy it first with \`uwu shop buy bg ${bg.name}\` (${bg.price.toLocaleString("en-US")} gold).` };
    }
  }
  await db.prepare("INSERT OR IGNORE INTO user_profiles (user_id) VALUES (?)").run(userId);
  await db
    .prepare("UPDATE user_profiles SET equipped_bg = ? WHERE user_id = ?")
    .run(bg.id, userId);
  return { ok: true, bgId: bg.id, bgName: bg.name };
}

/** Background ids the user owns (excludes the free default). */
export async function getOwnedBackgrounds(db: SelenaDb, userId: string): Promise<string[]> {
  const rows = (await db
    .prepare("SELECT bg_id FROM user_backgrounds WHERE user_id = ? ORDER BY bg_id ASC")
    .all(userId)) as { bg_id: string }[];
  return rows.map((r) => String(r.bg_id));
}

/**
 * GLOBAL rank by total XP summed across ALL guilds for that user:
 * rank = 1 + the count of users whose summed XP is strictly greater
 * than this user's total. A user with no rows has total 0 and ranks
 * after everyone with XP. One SQL query; the inner aggregate sums XP
 * per user first, then the outer count compares totals (comparing raw
 * per-guild rows would over-count users who outrank in one guild only).
 */
export async function getGlobalRank(db: SelenaDb, userId: string): Promise<number> {
  const row = (await db
    .prepare(
      "SELECT 1 + COUNT(*) AS rank FROM " +
        "(SELECT user_id, SUM(xp) AS total FROM users GROUP BY user_id) AS totals " +
        "WHERE totals.total > (SELECT COALESCE(SUM(xp), 0) FROM users WHERE user_id = ?)",
    )
    .get(userId)) as { rank: number } | undefined;
  return Number(row?.rank ?? 1);
}

/** Find a background by id or name (exact, then prefix, case-insensitive). */
export function findBackground(query: string): ReturnType<typeof getBackground> {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return (
    getBackground(q) ??
    listBackgrounds().find((b) => b.name.toLowerCase() === q) ??
    listBackgrounds().find((b) => b.name.toLowerCase().startsWith(q)) ??
    listBackgrounds().find((b) => b.id.toLowerCase().startsWith(q))
  );
}
