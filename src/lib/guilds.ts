import type { SelenaDb } from "./db.js";
import { powerBudget, type Monster } from "./hunt.js";
import { getUserMonsters } from "./huntDb.js";

/**
 * Guilds — Phase 2 (design docs/hunt-world-phase2-design.md §3).
 *
 * Guilds are GLOBAL across Discord: membership is keyed by user_id
 * alone (never by a Discord guild id), one guild per player, max 20
 * members. Guild XP comes from member activity (hunt 10, roll 10,
 * battle win 50, tower floor 100 — callers pass the amount in via
 * addGuildXp). Perks scale with guild level and are read through the
 * getGuild*Bonus getters; the combined catch bonus is capped at +30%
 * by the CALLERS, not here — these getters return the guild part only.
 *
 * This module is pure DB helpers: it never touches gold (the 5,000
 * gold create cost is charged by the command, in the same transaction
 * as createGuild) and never sends replies. Every rule violation throws
 * an Error with a plain-English message; the command turns it into a
 * plain-text reply. Fail closed: a failed DB query throws, never
 * silently grants membership, a role, or XP.
 *
 * Tables (db.ts SCHEMA — owned there, not here): guilds, guild_members.
 */

export const GUILD_CREATE_COST = 5000;
export const GUILD_MAX_MEMBERS = 20;
export const GUILD_MAX_LEVEL = 10;

/** XP needed to REACH each level (index 0 = level 1). Doc §3.2. */
const GUILD_LEVEL_THRESHOLDS: readonly number[] = [
  0, 1000, 3000, 6000, 10000, 15000, 20000, 25000, 30000, 35000,
];

interface GuildRow {
  id: number;
  name: string;
  leader_id: string;
  level: number;
  xp: number;
}

function rowToGuild(row: Record<string, unknown>): GuildRow {
  return {
    id: Number(row.id),
    name: String(row.name),
    leader_id: String(row.leader_id),
    level: Number(row.level),
    xp: Number(row.xp),
  };
}

/** Level for a total XP amount (1–10, capped). */
export function guildLevelForXp(xp: number): number {
  let level = 1;
  for (let i = 0; i < GUILD_LEVEL_THRESHOLDS.length; i++) {
    if (xp >= GUILD_LEVEL_THRESHOLDS[i]!) level = i + 1;
  }
  return Math.min(level, GUILD_MAX_LEVEL);
}

/** Level derived from the guild's stored XP (immune to a stale stored level). */
function levelOf(guild: GuildRow): number {
  return guildLevelForXp(guild.xp);
}

async function getGuildById(db: SelenaDb, guildId: number): Promise<GuildRow | null> {
  const row = await db.prepare("SELECT id, name, leader_id, level, xp FROM guilds WHERE id = ?").get(guildId);
  return row ? rowToGuild(row) : null;
}

/** The guild a user belongs to, or null when guildless. */
export async function getUserGuild(db: SelenaDb, userId: string): Promise<GuildRow | null> {
  const row = await db
    .prepare(
      "SELECT g.id, g.name, g.leader_id, g.level, g.xp FROM guilds g " +
        "JOIN guild_members m ON m.guild_id = g.id WHERE m.user_id = ?",
    )
    .get(userId);
  return row ? rowToGuild(row) : null;
}

/** Find a guild by name (case-insensitive), or null when there is none. */
export async function getGuildByName(db: SelenaDb, name: string): Promise<GuildRow | null> {
  const row = await db
    .prepare("SELECT id, name, leader_id, level, xp FROM guilds WHERE LOWER(name) = LOWER(?)")
    .get(name.trim());
  return row ? rowToGuild(row) : null;
}

async function countMembers(db: SelenaDb, guildId: number): Promise<number> {
  const row = (await db
    .prepare("SELECT COUNT(*) AS n FROM guild_members WHERE guild_id = ?")
    .get(guildId)) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

async function getMemberRole(db: SelenaDb, guildId: number, userId: string): Promise<string | null> {
  const row = (await db
    .prepare("SELECT role FROM guild_members WHERE guild_id = ? AND user_id = ?")
    .get(guildId, userId)) as { role: string } | undefined;
  return row ? String(row.role) : null;
}

/** Trim, collapse inner whitespace, and enforce the name rules. */
function validateGuildName(name: string): string {
  const clean = name.trim().replace(/\s+/g, " ");
  if (clean.length < 2 || clean.length > 24) {
    throw new Error("Guild names must be 2–24 characters.");
  }
  if (!/^[A-Za-z0-9 ]+$/.test(clean)) {
    throw new Error("Guild names can only use letters, numbers, and spaces.");
  }
  return clean;
}

/**
 * Create a guild; the creator becomes Leader. Does NOT charge gold —
 * the command charges GUILD_CREATE_COST in the same transaction.
 */
export async function createGuild(
  db: SelenaDb,
  userId: string,
  name: string,
  nowMs: number,
): Promise<GuildRow> {
  const clean = validateGuildName(name);
  const existing = await getUserGuild(db, userId);
  if (existing) {
    throw new Error(`You're already in "${existing.name}" — leave it before creating a new guild.`);
  }
  if (await getGuildByName(db, clean)) {
    throw new Error(`A guild called "${clean}" already exists.`);
  }
  let id: number;
  try {
    const res = await db
      .prepare("INSERT INTO guilds (name, leader_id, level, xp, created_at) VALUES (?, ?, 1, 0, ?)")
      .run(clean, userId, nowMs);
    id = Number(res.lastInsertRowid);
  } catch (e) {
    if (/duplicate|unique/i.test(e instanceof Error ? e.message : "")) {
      throw new Error(`A guild called "${clean}" already exists.`);
    }
    throw e;
  }
  if (!id) {
    // Fallback if the driver did not report the new id: re-read by name.
    const created = await getGuildByName(db, clean);
    if (!created) throw new Error("Couldn't create that guild — try again in a bit.");
    id = created.id;
  }
  await db
    .prepare("INSERT INTO guild_members (guild_id, user_id, role, joined_at) VALUES (?, ?, 'leader', ?)")
    .run(id, userId, nowMs);
  return { id, name: clean, leader_id: userId, level: 1, xp: 0 };
}

/** Open join (no invite needed). Returns the guild joined. */
export async function joinGuild(
  db: SelenaDb,
  userId: string,
  name: string,
  nowMs: number,
): Promise<GuildRow> {
  const guild = await getGuildByName(db, name);
  if (!guild) {
    throw new Error(`No guild called "${name.trim()}" — check the name with \`uwu guild rank\`.`);
  }
  const existing = await getUserGuild(db, userId);
  if (existing) {
    throw new Error(`You're already in "${existing.name}" — leave it before joining another guild.`);
  }
  if ((await countMembers(db, guild.id)) >= GUILD_MAX_MEMBERS) {
    throw new Error(`"${guild.name}" is full (${GUILD_MAX_MEMBERS}/${GUILD_MAX_MEMBERS} members).`);
  }
  await db
    .prepare("INSERT INTO guild_members (guild_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)")
    .run(guild.id, userId, nowMs);
  return guild;
}

/** Leave your guild. The leader cannot leave — promote or disband first. */
export async function leaveGuild(db: SelenaDb, userId: string): Promise<GuildRow> {
  const guild = await getUserGuild(db, userId);
  if (!guild) throw new Error("You're not in a guild.");
  if (guild.leader_id === userId) {
    throw new Error("You're the leader — promote someone to leader first, or disband the guild.");
  }
  await db.prepare("DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?").run(guild.id, userId);
  return guild;
}

/** Leader/officer invites a user into the guild. The target joins as Member. */
export async function inviteMember(
  db: SelenaDb,
  guildId: number,
  inviterId: string,
  targetId: string,
): Promise<GuildRow> {
  const guild = await getGuildById(db, guildId);
  if (!guild) throw new Error("That guild doesn't exist.");
  const role = await getMemberRole(db, guildId, inviterId);
  if (role !== "leader" && role !== "officer") {
    throw new Error("Only the leader or an officer can invite people.");
  }
  if (targetId === inviterId) throw new Error("You're already in this guild.");
  const targetGuild = await getUserGuild(db, targetId);
  if (targetGuild) {
    throw new Error(
      targetGuild.id === guildId
        ? "They're already in this guild."
        : "They're already in another guild.",
    );
  }
  if ((await countMembers(db, guildId)) >= GUILD_MAX_MEMBERS) {
    throw new Error(`"${guild.name}" is full (${GUILD_MAX_MEMBERS}/${GUILD_MAX_MEMBERS} members).`);
  }
  await db
    .prepare("INSERT INTO guild_members (guild_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)")
    .run(guildId, targetId, Date.now());
  return guild;
}

/** Leader only. Cannot kick yourself or the leader (there is only one). */
export async function kickMember(
  db: SelenaDb,
  guildId: number,
  actorId: string,
  targetId: string,
): Promise<GuildRow> {
  const guild = await getGuildById(db, guildId);
  if (!guild) throw new Error("That guild doesn't exist.");
  if ((await getMemberRole(db, guildId, actorId)) !== "leader") {
    throw new Error("Only the guild leader can kick members.");
  }
  if (targetId === actorId) {
    throw new Error("You can't kick yourself — leave or disband instead.");
  }
  const targetRole = await getMemberRole(db, guildId, targetId);
  if (targetRole === null) throw new Error("They're not in this guild.");
  if (targetRole === "leader") throw new Error("You can't kick the leader.");
  await db.prepare("DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?").run(guildId, targetId);
  return guild;
}

/**
 * Leader only. Member → Officer. Officer → Leader (leadership transfer:
 * the target becomes leader and the old leader becomes officer).
 */
export async function promoteMember(
  db: SelenaDb,
  guildId: number,
  actorId: string,
  targetId: string,
): Promise<{ guild: GuildRow; newRole: "officer" | "leader" }> {
  const guild = await getGuildById(db, guildId);
  if (!guild) throw new Error("That guild doesn't exist.");
  if ((await getMemberRole(db, guildId, actorId)) !== "leader") {
    throw new Error("Only the guild leader can promote members.");
  }
  if (targetId === actorId) throw new Error("You're already the leader.");
  const targetRole = await getMemberRole(db, guildId, targetId);
  if (targetRole === null) throw new Error("They're not in this guild.");
  if (targetRole === "leader") throw new Error("They're already the leader.");
  if (targetRole === "member") {
    await db
      .prepare("UPDATE guild_members SET role = 'officer' WHERE guild_id = ? AND user_id = ?")
      .run(guildId, targetId);
    return { guild, newRole: "officer" };
  }
  // Officer -> leader: transfer leadership; the old leader becomes officer.
  await db
    .prepare("UPDATE guild_members SET role = 'officer' WHERE guild_id = ? AND user_id = ?")
    .run(guildId, actorId);
  await db
    .prepare("UPDATE guild_members SET role = 'leader' WHERE guild_id = ? AND user_id = ?")
    .run(guildId, targetId);
  await db.prepare("UPDATE guilds SET leader_id = ? WHERE id = ?").run(targetId, guildId);
  return { guild: { ...guild, leader_id: targetId }, newRole: "leader" };
}

/** Leader only. Deletes the guild and all its memberships. */
export async function disbandGuild(
  db: SelenaDb,
  guildId: number,
  actorId: string,
): Promise<GuildRow> {
  const guild = await getGuildById(db, guildId);
  if (!guild) throw new Error("That guild doesn't exist.");
  if ((await getMemberRole(db, guildId, actorId)) !== "leader") {
    throw new Error("Only the guild leader can disband the guild.");
  }
  await db.prepare("DELETE FROM guild_members WHERE guild_id = ?").run(guildId);
  await db.prepare("DELETE FROM guilds WHERE id = ?").run(guildId);
  return guild;
}

/**
 * Add guild XP for a member's activity (callers pass 10 per hunt, 10
 * per roll, 50 per battle win, 100 per tower floor — doc §3.2).
 * Returns null when the user has no guild.
 */
export async function addGuildXp(
  db: SelenaDb,
  userId: string,
  amount: number,
): Promise<{ leveledUp: boolean; newLevel: number } | null> {
  const guild = await getUserGuild(db, userId);
  if (!guild) return null;
  const newXp = Math.max(0, guild.xp + amount);
  const newLevel = guildLevelForXp(newXp);
  await db.prepare("UPDATE guilds SET xp = ?, level = ? WHERE id = ?").run(newXp, newLevel, guild.id);
  return { leveledUp: newLevel > levelOf(guild), newLevel };
}

/**
 * Best-effort guild XP for activity (10 per hunt catch, 10 per roll pull,
 * 50 per battle win, 100 per tower floor — doc §3.2). Never throws: a user
 * with no guild, or any DB error, is silently a no-op — the activity that
 * earned the XP already succeeded, and it must never break the reply.
 */
export async function awardGuildXpBestEffort(
  db: SelenaDb,
  userId: string,
  amount: number,
): Promise<void> {
  try {
    await addGuildXp(db, userId, amount);
  } catch (e) {
    console.error("uwu: guild XP award failed:", e instanceof Error ? e.message : e);
  }
}

/** Catch-chance bonus in percent points from the member's guild level. */
export async function getGuildCatchBonus(db: SelenaDb, userId: string): Promise<number> {
  const guild = await getUserGuild(db, userId);
  if (!guild) return 0;
  const level = levelOf(guild);
  if (level >= 10) return 17;
  if (level >= 6) return 7;
  if (level >= 2) return 2;
  return 0;
}

/** Gold-from-sells bonus in percent from the member's guild level. */
export async function getGuildSellBonus(db: SelenaDb, userId: string): Promise<number> {
  const guild = await getUserGuild(db, userId);
  if (!guild) return 0;
  const level = levelOf(guild);
  if (level >= 8) return 15;
  if (level >= 4) return 5;
  return 0;
}

/** XP bonus in percent from the member's guild level (5% at level 10). */
export async function getGuildXpBonus(db: SelenaDb, userId: string): Promise<number> {
  const guild = await getUserGuild(db, userId);
  if (!guild) return 0;
  return levelOf(guild) >= 10 ? 5 : 0;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * One member's guild-power contribution: the sum of the power budgets
 * of their 3 strongest monsters, across every Discord server they own
 * monsters in (guilds are global; zoo rows are still keyed per Discord
 * server, so each server's zoo is read and merged by monster id).
 */
async function memberTop3Power(db: SelenaDb, userId: string): Promise<number> {
  const guildRows = (await db
    .prepare("SELECT DISTINCT guild_id FROM user_monsters WHERE user_id = ?")
    .all(userId)) as { guild_id: string }[];
  const byId = new Map<number, Monster>();
  for (const r of guildRows) {
    const owned = await getUserMonsters(db, String(r.guild_id), userId);
    for (const o of owned) byId.set(o.monster.id, o.monster);
  }
  return [...byId.values()]
    .map((m) => powerBudget(m))
    .sort((a, b) => b - a)
    .slice(0, 3)
    .reduce((sum, v) => sum + v, 0);
}

/**
 * Top guilds ordered by level DESC, then XP DESC, then total power
 * (sum of members' top-3 monster power budgets). Level here is derived
 * from stored XP so the board never shows a stale stored level.
 */
export async function getGuildRank(
  db: SelenaDb,
  limit = 10,
): Promise<{ id: number; name: string; level: number; xp: number; memberCount: number; power: number }[]> {
  const rows = await db.prepare("SELECT id, name, leader_id, level, xp FROM guilds").all();
  const entries: { id: number; name: string; level: number; xp: number; memberCount: number; power: number }[] = [];
  for (const row of rows) {
    const guild = rowToGuild(row);
    const members = (await db
      .prepare("SELECT user_id FROM guild_members WHERE guild_id = ?")
      .all(guild.id)) as { user_id: string }[];
    let power = 0;
    for (const m of members) {
      power += await memberTop3Power(db, String(m.user_id));
    }
    entries.push({
      id: guild.id,
      name: guild.name,
      level: levelOf(guild),
      xp: guild.xp,
      memberCount: members.length,
      power,
    });
  }
  entries.sort((a, b) => b.level - a.level || b.xp - a.xp || b.power - a.power);
  return entries.slice(0, limit);
}
