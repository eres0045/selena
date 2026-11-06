/**
 * Pure MLBB logic for Selena: hero lookups over the static snapshot,
 * MLBB profile storage, best-effort verification, and rank handling.
 *
 * VERIFICATION HONESTY: this is a LOCAL code check only. Selena issues a
 * 6-digit code in-channel and the user confirms it back; Moonton does
 * not validate anything here. Even Miya MLBB's own reviews report that
 * verify codes often do not arrive — our flow never claims otherwise.
 */
import type { SelenaDb } from "./db.js";
import { secureInt } from "./rng.js";
import { GACHA_CARDS, findHero, type GachaCard, type Hero } from "../data/heroes.js";

export const MLBB_RANKS = [
  "Warrior",
  "Elite",
  "Master",
  "Grandmaster",
  "Epic",
  "Legend",
  "Mythic",
  "Mythical Honor",
  "Mythical Glory",
] as const;

export type MlbbRank = (typeof MLBB_RANKS)[number];

/** Verification codes live for 10 minutes. */
export const VERIFY_CODE_TTL_MS = 10 * 60 * 1000;

export const SNAPSHOT_NOTE =
  "Static snapshot — may be stale after patches, not live data.";

export const VERIFICATION_NOTE =
  "Local code check only — not verified by Moonton. Selena issues the code here and you confirm it back; Moonton validates nothing in this flow.";

export interface MlbbProfile {
  guildId: string;
  userId: string;
  mlbbId: string;
  ign: string | null;
  verified: boolean;
  rankName: string | null;
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
}

type ProfileRow = Record<string, unknown>;

function rowToProfile(row: ProfileRow): MlbbProfile {
  return {
    guildId: String(row.guild_id),
    userId: String(row.user_id),
    mlbbId: String(row.mlbb_id),
    ign: row.ign == null ? null : String(row.ign),
    verified: Number(row.verified) === 1,
    rankName: row.rank_name == null ? null : String(row.rank_name),
  };
}

/** Look up a hero in the static snapshot (name/id, case-insensitive, partial). */
export function heroLookup(query: string): Hero | undefined {
  return findHero(query);
}

export interface CounterResult {
  hero: Hero;
  /** Heroes this hero is strong against. */
  counters: Hero[];
  /** Heroes that counter this hero. */
  counteredBy: Hero[];
}

/** Resolve a hero's counters / countered-by lists to full hero entries. */
export function counterLookup(heroName: string): CounterResult | undefined {
  const hero = findHero(heroName);
  if (!hero) return undefined;
  const resolve = (names?: string[]): Hero[] =>
    (names ?? [])
      .map((n) => findHero(n))
      .filter((h): h is Hero => h !== undefined);
  return {
    hero,
    counters: resolve(hero.counters),
    counteredBy: resolve(hero.counteredBy),
  };
}

/**
 * Create or replace a member's MLBB profile (unverified). Re-registering
 * resets verification (a new code must be issued) but keeps any stored rank.
 */
export function registerProfile(
  db: SelenaDb,
  guildId: string,
  userId: string,
  mlbbId: string,
  ign: string,
): MlbbProfile {
  const id = mlbbId.trim();
  const name = ign.trim();
  if (!id) throw new Error("MLBB ID is required.");
  if (!name) throw new Error("IGN is required.");
  if (id.length > 32) throw new Error("MLBB ID is too long (max 32 characters).");
  if (name.length > 32) throw new Error("IGN is too long (max 32 characters).");
  db.prepare(
    `INSERT INTO mlbb_profiles (guild_id, user_id, mlbb_id, ign, verified, verify_code, verify_expires)
     VALUES (?, ?, ?, ?, 0, NULL, NULL)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET
       mlbb_id = excluded.mlbb_id,
       ign = excluded.ign,
       verified = 0,
       verify_code = NULL,
       verify_expires = NULL`,
  ).run(guildId, userId, id, name);
  const profile = getProfile(db, guildId, userId);
  if (!profile) throw new Error("Failed to store MLBB profile.");
  return profile;
}

/**
 * Issue a 6-digit verification code for a registered profile.
 * Throws when the member has no profile yet.
 */
export function startVerification(
  db: SelenaDb,
  guildId: string,
  userId: string,
): { code: string; expiresAt: number } {
  const profile = getProfile(db, guildId, userId);
  if (!profile) throw new Error("No MLBB profile found. Register with /register-mlbb first.");
  const code = String(secureInt(100000, 1000000));
  const expiresAt = Date.now() + VERIFY_CODE_TTL_MS;
  db.prepare(
    "UPDATE mlbb_profiles SET verify_code = ?, verify_expires = ? WHERE guild_id = ? AND user_id = ?",
  ).run(code, expiresAt, guildId, userId);
  return { code, expiresAt };
}

/**
 * Check a verification code. `nowMs` is injectable so expiry is testable.
 * On success the profile is marked verified and the code is cleared
 * (single use).
 */
export function confirmVerification(
  db: SelenaDb,
  guildId: string,
  userId: string,
  code: string,
  nowMs: number,
): VerifyResult {
  const row = db
    .prepare("SELECT * FROM mlbb_profiles WHERE guild_id = ? AND user_id = ?")
    .get(guildId, userId) as ProfileRow | undefined;
  if (!row) {
    return { ok: false, error: "No MLBB profile found. Register with /register-mlbb first." };
  }
  if (row.verify_code == null || row.verify_expires == null) {
    return { ok: false, error: "No verification code has been issued. Register again to get a fresh code." };
  }
  if (String(code).trim() !== String(row.verify_code)) {
    return { ok: false, error: "Incorrect verification code. Check the code and try again." };
  }
  if (nowMs > Number(row.verify_expires)) {
    return { ok: false, error: "Verification code has expired. Register again to get a fresh code." };
  }
  db.prepare(
    "UPDATE mlbb_profiles SET verified = 1, verify_code = NULL, verify_expires = NULL WHERE guild_id = ? AND user_id = ?",
  ).run(guildId, userId);
  return { ok: true };
}

/** Read a member's MLBB profile, if one exists. */
export function getProfile(
  db: SelenaDb,
  guildId: string,
  userId: string,
): MlbbProfile | undefined {
  const row = db
    .prepare("SELECT * FROM mlbb_profiles WHERE guild_id = ? AND user_id = ?")
    .get(guildId, userId) as ProfileRow | undefined;
  return row ? rowToProfile(row) : undefined;
}

/** Set a member's rank. Rank must be one of MLBB_RANKS (case-insensitive). */
export function setRank(
  db: SelenaDb,
  guildId: string,
  userId: string,
  rankName: string,
): VerifyResult {
  const canonical = MLBB_RANKS.find(
    (r) => r.toLowerCase() === rankName.trim().toLowerCase(),
  );
  if (!canonical) {
    return {
      ok: false,
      error: `Unknown rank "${rankName}". Valid ranks: ${MLBB_RANKS.join(", ")}.`,
    };
  }
  const profile = getProfile(db, guildId, userId);
  if (!profile) {
    return { ok: false, error: "No MLBB profile found. Register with /register-mlbb first." };
  }
  db.prepare(
    "UPDATE mlbb_profiles SET rank_name = ? WHERE guild_id = ? AND user_id = ?",
  ).run(canonical, guildId, userId);
  return { ok: true };
}

export interface TopHeroCard {
  card: GachaCard;
  count: number;
}

/**
 * A member's most-collected gacha heroes (for /profile). Reads the
 * gacha_cards table; returns [] when the member has no cards yet.
 */
export function getTopHeroCards(
  db: SelenaDb,
  guildId: string,
  userId: string,
  limit = 5,
): TopHeroCard[] {
  const rows = db
    .prepare(
      "SELECT card_id, count FROM gacha_cards WHERE guild_id = ? AND user_id = ? ORDER BY count DESC, card_id ASC LIMIT ?",
    )
    .all(guildId, userId, limit);
  const out: TopHeroCard[] = [];
  for (const row of rows) {
    const card = GACHA_CARDS.find((c) => c.id === String(row.card_id));
    if (card) out.push({ card, count: Number(row.count) });
  }
  return out;
}
