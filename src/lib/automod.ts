import type { SelenaDb } from "./db.js";

/**
 * Auto-mod: pure functions only. No Discord calls here — the entrypoint
 * (src/index.ts) wires these into messageCreate and applies the action.
 */

// Short list of well-known English profanity used as the default banned
// list. Deliberately no slurs targeting protected groups. Server staff can
// replace the list via settings; tests use neutral placeholders
// ("badword1") instead of these words.
export const DEFAULT_BANNED_WORDS: readonly string[] = [
  "damn",
  "hell",
  "shit",
  "fuck",
  "bitch",
  "bastard",
  "crap",
];

export interface AutomodSettings {
  /** Words that trigger a violation (defaults to DEFAULT_BANNED_WORDS). */
  bannedWords?: readonly string[];
  /** Window for spam counting, ms (default 5000). */
  spamWindowMs?: number;
  /** Messages inside the window that count as spam (default 5). */
  spamThreshold?: number;
  /** Whether links are allowed at all (default false — links are flagged). */
  allowLinks?: boolean;
  /** Hostnames (or suffixes) exempt from the link filter. */
  allowedDomains?: readonly string[];
  /** When true, violations return "warn" instead of "delete". */
  warnOnly?: boolean;
}

export type AutomodAction = "none" | "delete" | "warn";

export interface AutomodResult {
  action: AutomodAction;
  reasons: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `text` contains any word from `wordList` (whole-word, case-insensitive). */
export function containsBannedWord(text: string, wordList: readonly string[]): boolean {
  if (wordList.length === 0) return false;
  const pattern = new RegExp(`\\b(${wordList.map(escapeRegExp).join("|")})\\b`, "i");
  return pattern.test(text);
}

/**
 * True when at least `threshold` of `recentMessageTimestamps` fall inside
 * `windowMs` ending at the latest timestamp in the list. The latest
 * timestamp is the reference point so the function is deterministic in
 * tests (callers pass real message timestamps).
 */
export function isSpam(recentMessageTimestamps: readonly number[], windowMs: number, threshold: number): boolean {
  if (recentMessageTimestamps.length === 0 || threshold <= 0) return false;
  const latest = Math.max(...recentMessageTimestamps);
  const count = recentMessageTimestamps.filter((t) => latest - t <= windowMs).length;
  return count >= threshold;
}

const URL_RE = /(?:https?:\/\/|www\.)[^\s/$.?#].[^\s]*/gi;

/** Extract the hostname of a URL-ish string, or null when unparseable. */
function hostnameOf(raw: string): string | null {
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when `text` contains a URL whose host is NOT on the allow-list.
 * `allowList` entries match the host exactly or as a suffix
 * (e.g. "discord.gg" also allows "canary.discord.gg").
 */
export function containsLink(text: string, allowList: readonly string[] = []): boolean {
  const matches = text.match(URL_RE) ?? [];
  for (const m of matches) {
    const host = hostnameOf(m);
    if (!host) return true; // unparseable URL-ish text: treat as a link
    const allowed = allowList.some((d) => {
      const dom = d.toLowerCase();
      return host === dom || host.endsWith(`.${dom}`);
    });
    if (!allowed) return true;
  }
  return false;
}

/**
 * Run all checks on one message. `history` is the author's recent message
 * timestamps (ms). Returns the action to take plus human-readable reasons.
 * No violation -> { action: "none", reasons: [] }.
 */
export function checkMessage(
  text: string,
  history: readonly number[],
  settings: AutomodSettings = {},
): AutomodResult {
  const reasons: string[] = [];
  const bannedWords = settings.bannedWords ?? DEFAULT_BANNED_WORDS;
  if (containsBannedWord(text, bannedWords)) reasons.push("banned word");
  const windowMs = settings.spamWindowMs ?? 5000;
  const threshold = settings.spamThreshold ?? 5;
  if (isSpam(history, windowMs, threshold)) reasons.push("spam");
  if (!settings.allowLinks && containsLink(text, settings.allowedDomains ?? [])) {
    reasons.push("link");
  }
  if (reasons.length === 0) return { action: "none", reasons };
  return { action: settings.warnOnly ? "warn" : "delete", reasons };
}

// ---------------------------------------------------------------------------
// Starboard helper. Lives here (next to the other message-gating logic):
// decides whether a message has earned a starboard post yet, and records
// the running star count. The entrypoint does the actual posting.
// ---------------------------------------------------------------------------

export interface StarboardCheck {
  /** True when the message just crossed the threshold and has no post yet. */
  shouldPost: boolean;
  /** Threshold read from guild_settings (default 3). */
  threshold: number;
  /** True when a starboard post already exists for this message. */
  alreadyPosted: boolean;
  stars: number;
}

export function checkStarboard(db: SelenaDb, guildId: string, messageId: string, starCount: number): StarboardCheck {
  const settings = db
    .prepare("SELECT starboard_threshold FROM guild_settings WHERE guild_id = ?")
    .get(guildId) as { starboard_threshold: number | null } | undefined;
  const threshold = Number(settings?.starboard_threshold ?? 3);
  const existing = db
    .prepare("SELECT starboard_message_id, stars FROM starboard_posts WHERE guild_id = ? AND message_id = ?")
    .get(guildId, messageId) as { starboard_message_id: string | null; stars: number } | undefined;

  db.prepare(
    `INSERT INTO starboard_posts (guild_id, message_id, starboard_message_id, stars)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id, message_id) DO UPDATE SET stars = excluded.stars`,
  ).run(guildId, messageId, existing?.starboard_message_id ?? null, starCount);

  const alreadyPosted = !!existing?.starboard_message_id;
  return {
    shouldPost: !alreadyPosted && starCount >= threshold,
    threshold,
    alreadyPosted,
    stars: starCount,
  };
}
