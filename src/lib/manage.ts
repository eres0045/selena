import type { SelenaDb } from "./db.js";

/**
 * Management lib — squads, lineups, scrims, tryouts, brackets, drafts,
 * rank roles, season standings. All functions are pure over the DB (plus
 * one module-level Map for draft sessions, which are intentionally not in
 * the schema) so tests can drive them without Discord.
 *
 * Discord role assignment itself is NOT done here: commands attempt it at
 * runtime only when the guild role exists, and always record in the DB.
 */

export const LINEUP_ROLES = ["Main Lineup", "Prime", "Tryout"] as const;
export type LineupRole = (typeof LINEUP_ROLES)[number];

export const TRYOUT_RANKS = [
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

type Err = { ok: false; error: string };
type Ok<T> = { ok: true } & T;
type Result<T> = Ok<T> | Err;

function err(error: string): Err {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Squads
// ---------------------------------------------------------------------------

export interface SquadRow {
  id: number;
  guild_id: string;
  name: string;
  captain_id: string | null;
  kind: string;
  created_at: number;
}

export interface SquadWithCount extends SquadRow {
  memberCount: number;
}

export async function resolveSquad(db: SelenaDb, guildId: string, ref: string): Promise<SquadRow | undefined> {
  const trimmed = ref.trim();
  let row: Record<string, unknown> | undefined;
  if (/^\d+$/.test(trimmed)) {
    row = await db.prepare("SELECT * FROM squads WHERE guild_id = ? AND id = ?").get(guildId, Number(trimmed));
  }
  if (!row) {
    row = await db
      .prepare("SELECT * FROM squads WHERE guild_id = ? AND LOWER(name) = LOWER(?)")
      .get(guildId, trimmed);
  }
  if (!row) return undefined;
  return {
    id: Number(row.id),
    guild_id: String(row.guild_id),
    name: String(row.name),
    captain_id: row.captain_id === null || row.captain_id === undefined ? null : String(row.captain_id),
    kind: String(row.kind ?? "squad"),
    created_at: Number(row.created_at),
  };
}

export async function createSquad(
  db: SelenaDb,
  guildId: string,
  name: string,
  captainId?: string | null,
  nowMs: number = Date.now(),
): Promise<Result<{ squadId: number; squad: SquadRow }>> {
  const clean = name.trim();
  if (!clean) return err("Squad name can't be empty.");
  if (clean.length > 64) return err("Squad name must be 64 characters or fewer.");
  if (await resolveSquad(db, guildId, clean)) return err(`A squad named "${clean}" already exists.`);
  const r = await db
    .prepare("INSERT INTO squads (guild_id, name, captain_id, kind, created_at) VALUES (?, ?, ?, 'squad', ?)")
    .run(guildId, clean, captainId ?? null, nowMs);
  const squad = await resolveSquad(db, guildId, String(r.lastInsertRowid));
  if (!squad) return err("Failed to create squad.");
  if (captainId) {
    await db.prepare("INSERT INTO squad_members (squad_id, user_id, role) VALUES (?, ?, 'captain') ON CONFLICT (squad_id, user_id) DO UPDATE SET role = EXCLUDED.role").run(
      squad.id,
      captainId,
    );
  }
  return { ok: true, squadId: squad.id, squad };
}

export async function listSquads(db: SelenaDb, guildId: string): Promise<SquadWithCount[]> {
  const rows = await db
    .prepare(
      `SELECT s.id, s.guild_id, s.name, s.captain_id, s.kind, s.created_at, COUNT(sm.user_id) AS member_count FROM squads s
       LEFT JOIN squad_members sm ON sm.squad_id = s.id
       WHERE s.guild_id = ? GROUP BY s.id, s.guild_id, s.name, s.captain_id, s.kind, s.created_at ORDER BY s.name ASC`,
    )
    .all(guildId);
  return rows.map((r) => ({
    id: Number(r.id),
    guild_id: String(r.guild_id),
    name: String(r.name),
    captain_id: r.captain_id === null || r.captain_id === undefined ? null : String(r.captain_id),
    kind: String(r.kind ?? "squad"),
    created_at: Number(r.created_at),
    memberCount: Number(r.member_count ?? 0),
  }));
}

export async function addSquadMember(
  db: SelenaDb,
  guildId: string,
  squadRef: string,
  userId: string,
  role: string,
): Promise<Result<{ squad: SquadRow }>> {
  const squad = await resolveSquad(db, guildId, squadRef);
  if (!squad) return err(`Squad "${squadRef}" not found.`);
  const cleanRole = role.trim();
  if (!cleanRole) return err("Role can't be empty.");
  await db.prepare("INSERT INTO squad_members (squad_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (squad_id, user_id) DO UPDATE SET role = EXCLUDED.role").run(
    squad.id,
    userId,
    cleanRole,
  );
  return { ok: true, squad };
}

export async function removeSquadMember(
  db: SelenaDb,
  guildId: string,
  squadRef: string,
  userId: string,
): Promise<Result<{ squad: SquadRow }>> {
  const squad = await resolveSquad(db, guildId, squadRef);
  if (!squad) return err(`Squad "${squadRef}" not found.`);
  const r = await db
    .prepare("DELETE FROM squad_members WHERE squad_id = ? AND user_id = ?")
    .run(squad.id, userId);
  if (r.changes === 0) return err(`<@${userId}> is not a member of "${squad.name}".`);
  return { ok: true, squad };
}

export async function listSquadMembers(
  db: SelenaDb,
  squadId: number,
): Promise<Array<{ userId: string; role: string }>> {
  return (
    await db
      .prepare("SELECT user_id, role FROM squad_members WHERE squad_id = ? ORDER BY role, user_id")
      .all(squadId)
  ).map((r) => ({ userId: String(r.user_id), role: String(r.role) }));
}

// ---------------------------------------------------------------------------
// Lineups
// ---------------------------------------------------------------------------

export interface LineupCard {
  squad: SquadRow;
  main: string[];
  prime: string[];
  tryout: string[];
  other: Array<{ userId: string; role: string }>;
}

export async function lineupCard(db: SelenaDb, squadId: number): Promise<LineupCard | undefined> {
  const squad = await db.prepare("SELECT * FROM squads WHERE id = ?").get(squadId);
  if (!squad) return undefined;
  const members = await listSquadMembers(db, squadId);
  const card: LineupCard = {
    squad: {
      id: Number(squad.id),
      guild_id: String(squad.guild_id),
      name: String(squad.name),
      captain_id: squad.captain_id === null || squad.captain_id === undefined ? null : String(squad.captain_id),
      kind: String(squad.kind ?? "squad"),
      created_at: Number(squad.created_at),
    },
    main: [],
    prime: [],
    tryout: [],
    other: [],
  };
  for (const m of members) {
    if (m.role === "Main Lineup") card.main.push(m.userId);
    else if (m.role === "Prime") card.prime.push(m.userId);
    else if (m.role === "Tryout") card.tryout.push(m.userId);
    else card.other.push(m);
  }
  return card;
}

export async function assignLineup(
  db: SelenaDb,
  guildId: string,
  squadRef: string,
  userId: string,
  lineup: string,
): Promise<Result<{ squad: SquadRow; card: LineupCard }>> {
  if (!LINEUP_ROLES.includes(lineup as LineupRole)) {
    return err(`Lineup must be one of: ${LINEUP_ROLES.join(", ")}.`);
  }
  const squad = await resolveSquad(db, guildId, squadRef);
  if (!squad) return err(`Squad "${squadRef}" not found.`);
  await db.prepare("INSERT INTO squad_members (squad_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (squad_id, user_id) DO UPDATE SET role = EXCLUDED.role").run(
    squad.id,
    userId,
    lineup,
  );
  const card = await lineupCard(db, squad.id);
  if (!card) return err("Failed to load lineup.");
  return { ok: true, squad, card };
}

/** Render a lineup card as embed description text. */
export function formatLineupCard(card: LineupCard): string {
  const line = (label: string, ids: string[]): string =>
    `**${label}** (${ids.length})\n${ids.length ? ids.map((id) => `• <@${id}>`).join("\n") : "_—_"}`;
  const parts = [line("Main Lineup", card.main), line("Prime", card.prime), line("Tryout", card.tryout)];
  if (card.other.length > 0) {
    parts.push(
      `**Other** (${card.other.length})\n${card.other.map((m) => `• <@${m.userId}> — ${m.role}`).join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Scrims
// ---------------------------------------------------------------------------

export function parseScrimDate(
  dateStr: string,
  timeStr: string,
  nowMs: number = Date.now(),
): Result<{ scheduledAt: number }> {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!dateMatch) return err(`Date "${dateStr}" is invalid — use YYYY-MM-DD, e.g. 2026-11-08.`);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeStr.trim());
  if (!timeMatch) return err(`Time "${timeStr}" is invalid — use HH:MM (24-hour), e.g. 20:30.`);
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (month < 1 || month > 12) return err(`Date "${dateStr}" is invalid — month must be 01–12.`);
  if (hour > 23 || minute > 59) return err(`Time "${timeStr}" is invalid — hour 00–23, minute 00–59.`);
  const scheduledAt = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(scheduledAt);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return err(`Date "${dateStr}" is not a real calendar date.`);
  }
  if (scheduledAt <= nowMs) return err("That date/time is in the past — schedule a future scrim.");
  return { ok: true, scheduledAt };
}

export interface ScrimRow {
  id: number;
  opponent: string;
  scheduledAt: number;
  createdBy: string;
  yes: number;
  no: number;
}

export async function scheduleScrim(
  db: SelenaDb,
  guildId: string,
  opponent: string,
  dateStr: string,
  timeStr: string,
  createdBy: string,
  nowMs: number = Date.now(),
): Promise<Result<{ scrimId: number; scheduledAt: number }>> {
  const clean = opponent.trim();
  if (!clean) return err("Opponent can't be empty.");
  const parsed = parseScrimDate(dateStr, timeStr, nowMs);
  if (!parsed.ok) return parsed;
  const r = await db
    .prepare(
      "INSERT INTO scrims (guild_id, opponent, scheduled_at, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(guildId, clean, parsed.scheduledAt, createdBy, nowMs);
  return { ok: true, scrimId: Number(r.lastInsertRowid), scheduledAt: parsed.scheduledAt };
}

export async function getRsvpCounts(db: SelenaDb, scrimId: number): Promise<{ yes: number; no: number }> {
  const rows = await db
    .prepare("SELECT attending, COUNT(*) AS n FROM scrim_rsvps WHERE scrim_id = ? GROUP BY attending")
    .all(scrimId);
  let yes = 0;
  let no = 0;
  for (const r of rows) {
    if (Number(r.attending) === 1) yes = Number(r.n);
    else no = Number(r.n);
  }
  return { yes, no };
}

export async function listScrims(db: SelenaDb, guildId: string, nowMs: number = Date.now()): Promise<ScrimRow[]> {
  const rows = await db
    .prepare(
      "SELECT * FROM scrims WHERE guild_id = ? AND scheduled_at >= ? ORDER BY scheduled_at ASC",
    )
    .all(guildId, nowMs);
  const out: ScrimRow[] = [];
  for (const r of rows) {
    const counts = await getRsvpCounts(db, Number(r.id));
    out.push({
      id: Number(r.id),
      opponent: String(r.opponent),
      scheduledAt: Number(r.scheduled_at),
      createdBy: String(r.created_by),
      yes: counts.yes,
      no: counts.no,
    });
  }
  return out;
}

export async function upsertRsvp(
  db: SelenaDb,
  scrimId: number,
  userId: string,
  attending: boolean,
): Promise<Result<{ yes: number; no: number }>> {
  const scrim = await db.prepare("SELECT id FROM scrims WHERE id = ?").get(scrimId);
  if (!scrim) return err(`Scrim #${scrimId} not found.`);
  await db.prepare(
    `INSERT INTO scrim_rsvps (scrim_id, user_id, attending) VALUES (?, ?, ?)
     ON CONFLICT(scrim_id, user_id) DO UPDATE SET attending = excluded.attending`,
  ).run(scrimId, userId, attending ? 1 : 0);
  return { ok: true, ...(await getRsvpCounts(db, scrimId)) };
}

// ---------------------------------------------------------------------------
// Tryouts
// ---------------------------------------------------------------------------

export interface TryoutInput {
  ign: string;
  mlbbId: string;
  role: string;
  rank: string;
  heroes: string;
}

export interface TryoutRow {
  id: number;
  guild_id: string;
  user_id: string;
  ign: string;
  mlbb_id: string | null;
  role: string;
  rank_name: string;
  heroes: string;
  status: string;
  created_at: number;
}

function toTryoutRow(row: Record<string, unknown>): TryoutRow {
  return {
    id: Number(row.id),
    guild_id: String(row.guild_id),
    user_id: String(row.user_id),
    ign: String(row.ign),
    mlbb_id: row.mlbb_id === null || row.mlbb_id === undefined ? null : String(row.mlbb_id),
    role: String(row.role),
    rank_name: String(row.rank_name),
    heroes: String(row.heroes),
    status: String(row.status),
    created_at: Number(row.created_at),
  };
}

export async function submitTryout(
  db: SelenaDb,
  guildId: string,
  userId: string,
  input: TryoutInput,
  nowMs: number = Date.now(),
): Promise<Result<{ tryoutId: number; tryout: TryoutRow }>> {
  const ign = input.ign.trim();
  const mlbbId = input.mlbbId.trim();
  const role = input.role.trim();
  const rankRaw = input.rank.trim();
  const heroes = input.heroes.trim();
  if (!ign) return err("IGN can't be empty.");
  if (!mlbbId) return err("MLBB ID can't be empty.");
  if (!role) return err("Role can't be empty.");
  if (!rankRaw) return err("Rank can't be empty.");
  if (!heroes) return err("Heroes can't be empty — list your main heroes.");
  const rank = TRYOUT_RANKS.find((r) => r.toLowerCase() === rankRaw.toLowerCase());
  if (!rank) {
    return err(
      `Rank "${rankRaw}" isn't valid — use one of: ${TRYOUT_RANKS.join(", ")}.`,
    );
  }
  const r = await db
    .prepare(
      `INSERT INTO tryouts (guild_id, user_id, ign, mlbb_id, role, rank_name, heroes, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(guildId, userId, ign, mlbbId, role, rank, heroes, nowMs);
  const row = await db.prepare("SELECT * FROM tryouts WHERE id = ?").get(Number(r.lastInsertRowid));
  if (!row) return err("Failed to log tryout.");
  return { ok: true, tryoutId: Number(r.lastInsertRowid), tryout: toTryoutRow(row) };
}

export async function getTryout(db: SelenaDb, guildId: string, tryoutId: number): Promise<TryoutRow | undefined> {
  const row = await db.prepare("SELECT * FROM tryouts WHERE guild_id = ? AND id = ?").get(guildId, tryoutId);
  return row ? toTryoutRow(row) : undefined;
}

export async function decideTryout(
  db: SelenaDb,
  guildId: string,
  tryoutId: number,
  decision: "accepted" | "rejected",
): Promise<Result<{ tryout: TryoutRow; roleIntent: string | null }>> {
  const tryout = await getTryout(db, guildId, tryoutId);
  if (!tryout) return err(`Tryout #${tryoutId} not found.`);
  if (tryout.status !== "pending") return err(`Tryout #${tryoutId} was already ${tryout.status}.`);
  await db.prepare("UPDATE tryouts SET status = ? WHERE id = ?").run(decision, tryoutId);
  const updated = await getTryout(db, guildId, tryoutId);
  if (!updated) return err("Failed to update tryout.");
  // Role assignment itself happens at runtime; this records the intent.
  return { ok: true, tryout: updated, roleIntent: decision === "accepted" ? "Tryout" : null };
}

/** Staff channel configured for this guild, if any (tryout posts go there at runtime). */
export async function getStaffChannelId(db: SelenaDb, guildId: string): Promise<string | null> {
  const row = await db.prepare("SELECT staff_channel_id FROM guild_settings WHERE guild_id = ?").get(guildId);
  if (!row || row.staff_channel_id === null || row.staff_channel_id === undefined) return null;
  return String(row.staff_channel_id);
}

// ---------------------------------------------------------------------------
// Brackets
// ---------------------------------------------------------------------------

export interface MatchRow {
  id: number;
  bracket_id: number;
  round: number;
  slot: number;
  team_a: string | null;
  team_b: string | null;
  winner: string | null;
  score_a: number | null;
  score_b: number | null;
}

export interface BracketState {
  id: number;
  name: string;
  state: string;
  teams: string[];
  matches: MatchRow[];
  totalRounds: number;
}

export function isPowerOfTwo(n: number): boolean {
  return n >= 2 && (n & (n - 1)) === 0;
}

function toMatchRow(row: Record<string, unknown>): MatchRow {
  return {
    id: Number(row.id),
    bracket_id: Number(row.bracket_id),
    round: Number(row.round),
    slot: Number(row.slot),
    team_a: row.team_a === null || row.team_a === undefined ? null : String(row.team_a),
    team_b: row.team_b === null || row.team_b === undefined ? null : String(row.team_b),
    winner: row.winner === null || row.winner === undefined ? null : String(row.winner),
    score_a: row.score_a === null || row.score_a === undefined ? null : Number(row.score_a),
    score_b: row.score_b === null || row.score_b === undefined ? null : Number(row.score_b),
  };
}

export async function createBracket(
  db: SelenaDb,
  guildId: string,
  name: string,
  teams: string[],
  nowMs: number = Date.now(),
): Promise<Result<{ bracketId: number; matches: MatchRow[] }>> {
  const cleanName = name.trim();
  if (!cleanName) return err("Bracket name can't be empty.");
  const cleanTeams = teams.map((t) => t.trim()).filter((t) => t.length > 0);
  if (cleanTeams.length < 2) return err("A bracket needs at least 2 teams.");
  if (cleanTeams.length > 16) return err("A bracket supports at most 16 teams.");
  const seen = new Set<string>();
  for (const t of cleanTeams) {
    const key = t.toLowerCase();
    if (seen.has(key)) return err(`Duplicate team "${t}" — each team may only enter once.`);
    seen.add(key);
  }
  if (!isPowerOfTwo(cleanTeams.length)) {
    return err(
      `Team count must be a power of two (2, 4, 8, 16) — got ${cleanTeams.length}. Add or remove teams.`,
    );
  }
  const b = await db
    .prepare("INSERT INTO brackets (guild_id, name, state, created_at) VALUES (?, ?, 'open', ?)")
    .run(guildId, cleanName, nowMs);
  const bracketId = Number(b.lastInsertRowid);
  for (let i = 0; i < cleanTeams.length; i++) {
    await db
      .prepare("INSERT INTO bracket_entries (bracket_id, seed, team_name) VALUES (?, ?, ?)")
      .run(bracketId, i + 1, cleanTeams[i]);
  }
  const matches: MatchRow[] = [];
  for (let slot = 0; slot < cleanTeams.length / 2; slot++) {
    const teamA = cleanTeams[slot * 2] as string;
    const teamB = cleanTeams[slot * 2 + 1] as string;
    const m = await db
      .prepare(
        "INSERT INTO matches (bracket_id, round, slot, team_a, team_b, created_at) VALUES (?, 1, ?, ?, ?, ?)",
      )
      .run(bracketId, slot, teamA, teamB, nowMs);
    const row = await db.prepare("SELECT * FROM matches WHERE id = ?").get(Number(m.lastInsertRowid));
    if (row) matches.push(toMatchRow(row));
  }
  return { ok: true, bracketId, matches };
}

export async function getBracket(db: SelenaDb, bracketId: number): Promise<BracketState | undefined> {
  const bracket = await db.prepare("SELECT * FROM brackets WHERE id = ?").get(bracketId);
  if (!bracket) return undefined;
  const entries = (
    await db
      .prepare("SELECT team_name FROM bracket_entries WHERE bracket_id = ? ORDER BY seed ASC")
      .all(bracketId)
  ).map((r) => String(r.team_name));
  const matches = (
    await db
      .prepare("SELECT * FROM matches WHERE bracket_id = ? ORDER BY round ASC, slot ASC")
      .all(bracketId)
  ).map(toMatchRow);
  return {
    id: Number(bracket.id),
    name: String(bracket.name),
    state: String(bracket.state),
    teams: entries,
    matches,
    totalRounds: Math.log2(Math.max(2, entries.length)),
  };
}

export async function reportMatch(
  db: SelenaDb,
  guildId: string,
  bracketId: number,
  matchId: number,
  winner: string,
  scoreA: number,
  scoreB: number,
  reportedBy?: string,
  nowMs: number = Date.now(),
): Promise<Result<{ match: MatchRow; advancedTo: MatchRow | null; bracketComplete: boolean }>> {
  const bracket = await getBracket(db, bracketId);
  if (!bracket) return err(`Bracket #${bracketId} not found.`);
  const match = bracket.matches.find((m) => m.id === matchId);
  if (!match) return err(`Match #${matchId} not found in bracket #${bracketId}.`);
  if (match.winner) return err(`Match #${matchId} was already reported — ${match.winner} won.`);
  const cleanWinner = winner.trim();
  if (cleanWinner !== match.team_a && cleanWinner !== match.team_b) {
    return err(
      `Winner must be one of this match's teams (${match.team_a ?? "?"} vs ${match.team_b ?? "?"}) — got "${winner}".`,
    );
  }
  if (!Number.isInteger(scoreA) || scoreA < 0 || !Number.isInteger(scoreB) || scoreB < 0) {
    return err("Scores must be whole numbers (0 or more).");
  }
  await db.prepare(
    "UPDATE matches SET winner = ?, score_a = ?, score_b = ?, reported_by = ? WHERE id = ?",
  ).run(cleanWinner, scoreA, scoreB, reportedBy ?? null, matchId);
  const updatedRow = await db.prepare("SELECT * FROM matches WHERE id = ?").get(matchId);
  const updated = updatedRow ? toMatchRow(updatedRow) : match;

  let advancedTo: MatchRow | null = null;
  let bracketComplete = false;
  if (match.round >= bracket.totalRounds) {
    await db.prepare("UPDATE brackets SET state = 'complete' WHERE id = ?").run(bracketId);
    bracketComplete = true;
  } else {
    // Advance only when BOTH feeder matches of the next-round slot are decided.
    const siblingSlot = match.slot % 2 === 0 ? match.slot + 1 : match.slot - 1;
    const sibling = bracket.matches.find((m) => m.round === match.round && m.slot === siblingSlot);
    if (sibling?.winner) {
      const lowSlot = Math.min(match.slot, siblingSlot);
      const lowWinner = match.slot === lowSlot ? cleanWinner : sibling.winner;
      const highWinner = match.slot === lowSlot ? sibling.winner : cleanWinner;
      const nextSlot = Math.floor(match.slot / 2);
      const nextRound = match.round + 1;
      const m = await db
        .prepare(
          "INSERT INTO matches (bracket_id, round, slot, team_a, team_b, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(bracketId, nextRound, nextSlot, lowWinner, highWinner, nowMs);
      const row = await db.prepare("SELECT * FROM matches WHERE id = ?").get(Number(m.lastInsertRowid));
      if (row) advancedTo = toMatchRow(row);
    }
  }
  return { ok: true, match: updated, advancedTo, bracketComplete };
}

export interface StandingEntry {
  team: string;
  wins: number;
  losses: number;
  played: number;
}

/** Season standings: wins per team across decided matches in the guild. */
export async function seasonStandings(db: SelenaDb, guildId: string, bracketId?: number): Promise<StandingEntry[]> {
  const bracketFilter = bracketId !== undefined ? "AND m.bracket_id = ?" : "";
  const params: unknown[] = [guildId];
  if (bracketId !== undefined) params.push(bracketId);
  const winRows = await db
    .prepare(
      `SELECT m.winner AS team, COUNT(*) AS wins FROM matches m
       JOIN brackets b ON b.id = m.bracket_id
       WHERE b.guild_id = ? AND m.winner IS NOT NULL ${bracketFilter}
       GROUP BY m.winner`,
    )
    .all(...params);
  const playedRows = await db
    .prepare(
      `SELECT team, COUNT(*) AS played FROM (
         SELECT team_a AS team FROM matches m JOIN brackets b ON b.id = m.bracket_id
         WHERE b.guild_id = ? AND m.winner IS NOT NULL ${bracketFilter}
         UNION ALL
         SELECT team_b AS team FROM matches m JOIN brackets b ON b.id = m.bracket_id
         WHERE b.guild_id = ? AND m.winner IS NOT NULL ${bracketFilter}
       ) AS played_teams GROUP BY team`,
    )
    .all(...params, ...params);
  const wins = new Map<string, number>();
  for (const r of winRows) wins.set(String(r.team), Number(r.wins));
  const played = new Map<string, number>();
  for (const r of playedRows) played.set(String(r.team), Number(r.played));
  const teams = new Set([...wins.keys(), ...played.keys()]);
  return [...teams]
    .map((team) => {
      const w = wins.get(team) ?? 0;
      const p = played.get(team) ?? 0;
      return { team, wins: w, losses: p - w, played: p };
    })
    .sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.team.localeCompare(b.team));
}

// ---------------------------------------------------------------------------
// Drafts (in-memory sessions keyed by channel id — no table in the schema)
// ---------------------------------------------------------------------------

export const DRAFT_BAN_LIMIT = 3;
export const DRAFT_PICK_LIMIT = 5;

export interface DraftState {
  channelId: string;
  teamA: string;
  teamB: string;
  bansA: string[];
  bansB: string[];
  picksA: string[];
  picksB: string[];
  phase: "ban" | "pick" | "done";
  turn: "A" | "B";
  createdAt: number;
}

const drafts = new Map<string, DraftState>();

export function createDraft(
  channelId: string,
  teamA: string,
  teamB: string,
  nowMs: number = Date.now(),
): Result<{ draft: DraftState }> {
  const a = teamA.trim();
  const b = teamB.trim();
  if (!a || !b) return err("Both team names are required to start a draft.");
  if (a.toLowerCase() === b.toLowerCase()) return err("The two draft teams must be different.");
  const draft: DraftState = {
    channelId,
    teamA: a,
    teamB: b,
    bansA: [],
    bansB: [],
    picksA: [],
    picksB: [],
    phase: "ban",
    turn: "A",
    createdAt: nowMs,
  };
  drafts.set(channelId, draft);
  return { ok: true, draft };
}

export function getDraft(channelId: string): DraftState | undefined {
  return drafts.get(channelId);
}

export function clearDraft(channelId: string): boolean {
  return drafts.delete(channelId);
}

function draftHeroTaken(draft: DraftState, hero: string): boolean {
  const key = hero.toLowerCase();
  return [...draft.bansA, ...draft.bansB, ...draft.picksA, ...draft.picksB].some(
    (h) => h.toLowerCase() === key,
  );
}

/**
 * Validate a hero name. When a hero list is supplied (from the heroes
 * dataset), the name must match it (case-insensitive) and the canonical
 * spelling is returned. Without a list, any non-empty name is accepted.
 */
export function validateDraftHero(
  hero: string,
  validHeroes?: readonly string[],
): Result<{ hero: string }> {
  const clean = hero.trim();
  if (!clean) return err("Hero name can't be empty.");
  if (validHeroes && validHeroes.length > 0) {
    const found = validHeroes.find((h) => h.toLowerCase() === clean.toLowerCase());
    if (!found) return err(`"${clean}" isn't a known hero — check the spelling.`);
    return { ok: true, hero: found };
  }
  return { ok: true, hero: clean };
}

function advanceAfterBan(draft: DraftState): void {
  if (draft.bansA.length >= DRAFT_BAN_LIMIT && draft.bansB.length >= DRAFT_BAN_LIMIT) {
    draft.phase = "pick";
    draft.turn = "A";
  } else {
    draft.turn = draft.turn === "A" ? "B" : "A";
  }
}

function advanceAfterPick(draft: DraftState): void {
  if (draft.picksA.length >= DRAFT_PICK_LIMIT && draft.picksB.length >= DRAFT_PICK_LIMIT) {
    draft.phase = "done";
  } else {
    draft.turn = draft.turn === "A" ? "B" : "A";
  }
}

export function banHero(
  channelId: string,
  team: "A" | "B",
  hero: string,
  validHeroes?: readonly string[],
): Result<{ draft: DraftState }> {
  const draft = drafts.get(channelId);
  if (!draft) return err("No active draft in this channel — start one with /draft start.");
  if (draft.phase !== "ban") return err("The ban phase is over — picks are underway.");
  const checked = validateDraftHero(hero, validHeroes);
  if (!checked.ok) return checked;
  const list = team === "A" ? draft.bansA : draft.bansB;
  if (list.length >= DRAFT_BAN_LIMIT) return err(`Team ${team === "A" ? draft.teamA : draft.teamB} has used all ${DRAFT_BAN_LIMIT} bans.`);
  if (draftHeroTaken(draft, checked.hero)) return err(`"${checked.hero}" is already banned or picked.`);
  list.push(checked.hero);
  advanceAfterBan(draft);
  return { ok: true, draft };
}

export function pickHero(
  channelId: string,
  team: "A" | "B",
  hero: string,
  validHeroes?: readonly string[],
): Result<{ draft: DraftState }> {
  const draft = drafts.get(channelId);
  if (!draft) return err("No active draft in this channel — start one with /draft start.");
  if (draft.phase !== "pick") {
    return draft.phase === "done"
      ? err("This draft is finished.")
      : err("Picks haven't started yet — finish the ban phase first.");
  }
  const checked = validateDraftHero(hero, validHeroes);
  if (!checked.ok) return checked;
  const list = team === "A" ? draft.picksA : draft.picksB;
  if (list.length >= DRAFT_PICK_LIMIT) return err(`Team ${team === "A" ? draft.teamA : draft.teamB} has already picked ${DRAFT_PICK_LIMIT} heroes.`);
  if (draftHeroTaken(draft, checked.hero)) return err(`"${checked.hero}" is already banned or picked.`);
  list.push(checked.hero);
  advanceAfterPick(draft);
  return { ok: true, draft };
}

/** Apply the current turn's action (ban during ban phase, pick during pick phase). */
export function applyDraftAction(
  channelId: string,
  hero: string,
  validHeroes?: readonly string[],
): Result<{ draft: DraftState; action: "ban" | "pick"; team: "A" | "B" }> {
  const draft = drafts.get(channelId);
  if (!draft) return err("No active draft in this channel — start one with /draft start.");
  if (draft.phase === "done") return err("This draft is finished.");
  const teamBefore = draft.turn;
  if (draft.phase === "ban") {
    const r = banHero(channelId, teamBefore, hero, validHeroes);
    if (!r.ok) return r;
    return { ok: true, draft: r.draft, action: "ban", team: teamBefore };
  }
  const r = pickHero(channelId, teamBefore, hero, validHeroes);
  if (!r.ok) return r;
  return { ok: true, draft: r.draft, action: "pick", team: teamBefore };
}

export function formatDraft(draft: DraftState): string {
  const teamName = (t: "A" | "B"): string => (t === "A" ? draft.teamA : draft.teamB);
  const phaseText =
    draft.phase === "done"
      ? "Draft complete"
      : draft.phase === "ban"
        ? `Ban phase — ${teamName(draft.turn)} to ban`
        : `Pick phase — ${teamName(draft.turn)} to pick`;
  const list = (label: string, items: string[]): string =>
    `**${label}** (${items.length}): ${items.length ? items.join(", ") : "_—_"}`;
  return [
    `**${draft.teamA} vs ${draft.teamB}** — ${phaseText}`,
    "",
    list(`${draft.teamA} bans`, draft.bansA),
    list(`${draft.teamB} bans`, draft.bansB),
    list(`${draft.teamA} picks`, draft.picksA),
    list(`${draft.teamB} picks`, draft.picksB),
  ].join("\n");
}
