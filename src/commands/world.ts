import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { Command, CommandContext, ReplyPayload } from "../lib/command.js";
import { fmt } from "../lib/command.js";
import type { SelenaDb } from "../lib/db.js";
import { addPoints, getBalance } from "../lib/economy.js";
import {
  attemptCatch,
  monsterEmoji,
  monstersInArea,
  monstersOfTier,
  type Monster,
  type Tier,
} from "../lib/hunt.js";
import { awardMonster, getHuntState } from "../lib/huntDb.js";
import { getGuildCatchBonus } from "../lib/guilds.js";
import { secureFloat } from "../lib/rng.js";
import {
  REGIONS,
  WORLD_AREAS,
  distanceKm,
  drawMonsterFromWorldArea,
  encounterMonsterInWorldArea,
  findWorldArea,
  travelMinutes,
  type WorldArea,
  type WorldRegion,
} from "../lib/world.js";

/**
 * World map + travel + auto-hunt (Phase 2, design
 * docs/hunt-world-phase2-design.md §2 + §6.1).
 *
 * One shared world across all of Discord. Travel takes real time
 * (5 min/km); auto-hunt runs only while travelling and costs 200 gold
 * per hour. Plain-text OwO-style replies everywhere, like the rest of
 * the bot — no embeds.
 *
 * Towers are NOT listed on the map: they belong to the towers system
 * (another worker) and stay out of this module entirely.
 *
 * The 60s due-task sweep in src/index.ts is expected to call the two
 * exported sweep functions (travelDueSweep, processAutoHuntTicks) —
 * this module does NOT wire itself into index.ts.
 *
 * NOTE on map buttons: the customId carries no user id (spec format
 * `selena:map:<action>[:<arg>]`), so a press renders the map for the
 * PRESSER (their location, their marks) and edits the shared message.
 * Buttons only ever change the view — they never move the player.
 */

// ---------------------------------------------------------------------------
// Constants (locked numbers — Ronit's, do not re-decide)
// ---------------------------------------------------------------------------

/** Gold charged per hour of auto-hunt while travelling (design §2.4). */
export const AUTOHUNT_GOLD_PER_HOUR = 200;
/** One auto-hunt tick per hunt cooldown (design §2.4). */
export const AUTOHUNT_TICK_MS = 30_000;

// ---------------------------------------------------------------------------
// Location state (user_location — global per user, not per guild)
// ---------------------------------------------------------------------------

export interface LocationState {
  userId: string;
  currentArea: string;
  travellingTo: string | null;
  travelEndsAt: number | null;
  travelOrigin: string | null;
  travelChannelId: string | null;
  travelGuildId: string | null;
  travelStartedAt: number | null;
  lastAutohuntAt: number | null;
  autoHunt: boolean;
  autoHuntSeconds: number;
  autoHuntCharged: number;
  mapMarks: string[];
  mapZoom: string;
  lastLocation: string | null;
}

export function defaultLocation(userId: string): LocationState {
  return {
    userId,
    currentArea: "meadow",
    travellingTo: null,
    travelEndsAt: null,
    travelOrigin: null,
    travelChannelId: null,
    travelGuildId: null,
    travelStartedAt: null,
    lastAutohuntAt: null,
    autoHunt: false,
    autoHuntSeconds: 0,
    autoHuntCharged: 0,
    mapMarks: [],
    mapZoom: "world",
    lastLocation: null,
  };
}

function parseMarks(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/** The player's stored location row, or null when they have none yet. */
export async function getLocation(db: SelenaDb, userId: string): Promise<LocationState | null> {
  const row = (await db
    .prepare(
      "SELECT user_id, current_area, travelling_to, travel_ends_at, travel_origin, " +
        "travel_channel_id, travel_guild_id, travel_started_at, last_autohunt_at, " +
        "auto_hunt, auto_hunt_seconds, auto_hunt_charged, map_marks, map_zoom, last_location " +
        "FROM user_location WHERE user_id = ?",
    )
    .get(userId)) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    userId: String(row.user_id),
    currentArea: String(row.current_area ?? "meadow"),
    travellingTo: row.travelling_to == null ? null : String(row.travelling_to),
    travelEndsAt: row.travel_ends_at == null ? null : Number(row.travel_ends_at),
    travelOrigin: row.travel_origin == null ? null : String(row.travel_origin),
    travelChannelId: row.travel_channel_id == null ? null : String(row.travel_channel_id),
    travelGuildId: row.travel_guild_id == null ? null : String(row.travel_guild_id),
    travelStartedAt: row.travel_started_at == null ? null : Number(row.travel_started_at),
    lastAutohuntAt: row.last_autohunt_at == null ? null : Number(row.last_autohunt_at),
    autoHunt: Number(row.auto_hunt ?? 0) !== 0,
    autoHuntSeconds: Number(row.auto_hunt_seconds ?? 0),
    autoHuntCharged: Number(row.auto_hunt_charged ?? 0),
    mapMarks: parseMarks(row.map_marks),
    mapZoom: String(row.map_zoom ?? "world"),
    lastLocation: row.last_location == null ? null : String(row.last_location),
  };
}

/** Insert or replace a whole location row. */
export async function saveLocation(db: SelenaDb, loc: LocationState): Promise<void> {
  await db
    .prepare(
      "INSERT INTO user_location (user_id, current_area, travelling_to, travel_ends_at, travel_origin, " +
        "travel_channel_id, travel_guild_id, travel_started_at, last_autohunt_at, " +
        "auto_hunt, auto_hunt_seconds, auto_hunt_charged, map_marks, map_zoom, last_location) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (user_id) DO UPDATE SET current_area = EXCLUDED.current_area, " +
        "travelling_to = EXCLUDED.travelling_to, travel_ends_at = EXCLUDED.travel_ends_at, " +
        "travel_origin = EXCLUDED.travel_origin, travel_channel_id = EXCLUDED.travel_channel_id, " +
        "travel_guild_id = EXCLUDED.travel_guild_id, travel_started_at = EXCLUDED.travel_started_at, " +
        "last_autohunt_at = EXCLUDED.last_autohunt_at, auto_hunt = EXCLUDED.auto_hunt, " +
        "auto_hunt_seconds = EXCLUDED.auto_hunt_seconds, auto_hunt_charged = EXCLUDED.auto_hunt_charged, " +
        "map_marks = EXCLUDED.map_marks, map_zoom = EXCLUDED.map_zoom, last_location = EXCLUDED.last_location",
    )
    .run(
      loc.userId,
      loc.currentArea,
      loc.travellingTo,
      loc.travelEndsAt,
      loc.travelOrigin,
      loc.travelChannelId,
      loc.travelGuildId,
      loc.travelStartedAt,
      loc.lastAutohuntAt,
      loc.autoHunt ? 1 : 0,
      loc.autoHuntSeconds,
      loc.autoHuntCharged,
      JSON.stringify(loc.mapMarks),
      loc.mapZoom,
      loc.lastLocation,
    );
}

/**
 * Where the player is right now: user_location.current_area, falling
 * back to the Phase 1 hunt area (user_hunt.current_area), then
 * 'meadow'. Unknown stored ids fall back to 'meadow' too.
 */
export async function resolveCurrentArea(db: SelenaDb, guildId: string, userId: string): Promise<string> {
  const loc = await getLocation(db, userId);
  if (loc && findWorldArea(loc.currentArea)) return loc.currentArea;
  if (loc && loc.currentArea) {
    // Stored id is not a known area — treat as unset, not as a place.
  }
  try {
    const hunt = await getHuntState(db, guildId, userId);
    if (hunt.currentArea && findWorldArea(hunt.currentArea)) return hunt.currentArea;
  } catch {
    /* fail closed to meadow below — a failed hunt-state read never grants a location */
  }
  return "meadow";
}

/** True while a trip is still running (travelling_to set, ends in the future). */
export function isTravelling(loc: LocationState | null, nowMs: number): boolean {
  return !!loc?.travellingTo && (loc.travelEndsAt ?? 0) > nowMs;
}

/** Clear the travel fields of an overdue trip, moving the player to the destination. */
export function settleOverdueTravel(loc: LocationState, nowMs: number): boolean {
  if (!loc.travellingTo || (loc.travelEndsAt ?? 0) > nowMs) return false;
  loc.currentArea = loc.travellingTo;
  loc.travellingTo = null;
  loc.travelEndsAt = null;
  loc.travelOrigin = null;
  loc.travelChannelId = null;
  loc.travelGuildId = null;
  loc.travelStartedAt = null;
  loc.lastAutohuntAt = null;
  return true;
}

function regionIdForArea(areaId: string): string {
  return findWorldArea(areaId)?.regionId ?? "starting-lands";
}

/** How many monsters can be encountered in an area (its pool size). */
export function monsterPoolCount(area: WorldArea): number {
  if (area.regionId === "starting-lands") return monstersInArea(area.id).length;
  let n = 0;
  for (const t of area.tiers) n += monstersOfTier(t).length;
  return n;
}

// ---------------------------------------------------------------------------
// Map rendering
// ---------------------------------------------------------------------------

type MapView = string; // "world" or a region id

function areaLine(
  area: WorldArea,
  opts: { level: number; currentId: string; originId: string | null; marks: Set<string>; detailed: boolean },
): string {
  const icons: string[] = [];
  if (area.id === opts.currentId) icons.push("🔴");
  if (opts.originId !== null && area.id === opts.originId) icons.push("○");
  if (opts.marks.has(area.id)) icons.push("📌");
  if (opts.level < area.unlockLevel && area.id !== opts.currentId) icons.push("🔒");
  const icon = icons.length > 0 ? icons.join("") : "·";
  const suffix =
    area.id === opts.currentId
      ? " — You are here"
      : opts.originId !== null && area.id === opts.originId
        ? " — Started here"
        : "";
  const base =
    `${icon} ${area.name}${suffix} · Lv ${area.unlockLevel} · ${area.tiers.join(", ")} · ` +
    `${monsterPoolCount(area)} monsters`;
  if (!opts.detailed) return base;
  return `${base} · wild Lv ${area.wildLevels[0]}–${area.wildLevels[1]} · ${area.blurb}`;
}

function travelStatusLine(loc: LocationState | null, nowMs: number): string | null {
  if (!isTravelling(loc, nowMs) || !loc?.travellingTo) return null;
  const dest = findWorldArea(loc.travellingTo);
  const mins = Math.max(0, Math.ceil(((loc.travelEndsAt ?? nowMs) - nowMs) / 60_000));
  return (
    `🚶 Travelling to ${dest?.name ?? loc.travellingTo} — arrives in ${mins} min · ` +
    `auto-hunt ${loc.autoHunt ? "on" : "off"}`
  );
}

export async function renderMap(
  db: SelenaDb,
  guildId: string,
  userId: string,
  view: MapView,
): Promise<ReplyPayload> {
  const now = Date.now();
  const loc = await getLocation(db, userId);
  const currentId = await resolveCurrentArea(db, guildId, userId);
  const currentArea = findWorldArea(currentId) ?? WORLD_AREAS[0]!;
  const bal = await getBalance(db, guildId, userId);
  const marks = new Set(loc?.mapMarks ?? []);
  // The travel origin only marks the map while a trip is running; after
  // arrival it lives on as last_location instead.
  const originId = isTravelling(loc, now) ? loc?.travelOrigin ?? null : null;
  const status = travelStatusLine(loc, now);
  const lineOpts = { level: bal.level, currentId, originId, marks, detailed: false };

  let content: string;
  if (view !== "world") {
    const region: WorldRegion | undefined = REGIONS.find((r) => r.id === view);
    if (!region) {
      // Unknown zoom — fall back to the whole world rather than erroring.
      return renderMap(db, guildId, userId, "world");
    }
    const lines = region.areas.map((a) => areaLine(a, { ...lineOpts, detailed: true }));
    content =
      `🗺️ ${region.name} — Lv ${region.levelRange[0]}–${region.levelRange[1]} · ${region.feel}\n` +
      (status ? `${status}\n` : "") +
      `${lines.join("\n")}\n` +
      `You are level ${bal.level} · \`uwu travel <area>\` to go somewhere new.`;
  } else {
    const blocks = REGIONS.map((region) => {
      const lines = region.areas.map((a) => areaLine(a, lineOpts));
      return `— ${region.name} · Lv ${region.levelRange[0]}–${region.levelRange[1]} —\n${lines.join("\n")}`;
    });
    content =
      `🗺️ World Map — you are level ${bal.level}\n` +
      (status ? `${status}\n` : "") +
      `${blocks.join("\n")}\n` +
      `🔴 You are here · ○ Started here · 📌 Your marks · 🔒 Locked\n` +
      `Zoom in for wild levels and details. Travel with \`uwu travel <area>\`.`;
  }

  const components = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`selena:map:zoom-in:${currentArea.regionId}`)
        .setLabel("🔍 Zoom In")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(view !== "world"),
      new ButtonBuilder()
        .setCustomId("selena:map:zoom-out")
        .setLabel("🔎 Zoom Out")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(view === "world"),
      new ButtonBuilder()
        .setCustomId("selena:map:mark")
        .setLabel("📌 Mark")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("selena:map:last-location")
        .setLabel("🕰️ Last Location")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
  return { content, components };
}

// ---------------------------------------------------------------------------
// Map buttons (customIds `selena:map:<action>[:<arg>]`, handler key
// "selena:map" — one handler dispatching on the parts, same pattern as
// the hunt buttons). Every press EDITS the map message to re-render
// the new view; presses never move the player.
// ---------------------------------------------------------------------------

async function handleMapButton(inv: any, ctx: CommandContext): Promise<void> {
  const parts = String(inv.customId ?? "").split(":");
  const action = parts[2] ?? "";
  const arg = parts[3] ?? "";
  const userId = String(inv.user?.id ?? "");
  if (!userId) {
    try {
      await inv.reply({ content: "Couldn't tell who pressed that — try `uwu map` again.", ephemeral: true });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    const loc = (await getLocation(ctx.db, userId)) ?? defaultLocation(userId);
    let view = loc.mapZoom || "world";
    if (action === "zoom-in") {
      const region = REGIONS.find((r) => r.id === arg);
      view = region ? region.id : regionIdForArea(await resolveCurrentArea(ctx.db, ctx.guildId, userId));
    } else if (action === "zoom-out") {
      view = "world";
    } else if (action === "mark") {
      // Toggle a 📌 pin on the presser's CURRENT area.
      const current = await resolveCurrentArea(ctx.db, ctx.guildId, userId);
      const marks = new Set(loc.mapMarks);
      if (marks.has(current)) marks.delete(current);
      else marks.add(current);
      loc.mapMarks = [...marks];
    } else if (action === "last-location") {
      // Focus the view on the area the presser travelled from (working
      // reading of the design's "last something" — view focus only,
      // never movement).
      const last = loc.lastLocation;
      const area = last ? findWorldArea(last) : undefined;
      view = area ? area.regionId : regionIdForArea(await resolveCurrentArea(ctx.db, ctx.guildId, userId));
    } else {
      await inv.reply({ content: "Unknown map action.", ephemeral: true });
      return;
    }
    loc.mapZoom = view;
    await saveLocation(ctx.db, loc);
    const rendered = await renderMap(ctx.db, ctx.guildId, userId, view);
    await inv.update(rendered);
  } catch (e) {
    console.error("uwu: map button failed:", e instanceof Error ? e.message : e);
    try {
      await inv.reply({ content: "Couldn't update the map — try `uwu map` again.", ephemeral: true });
    } catch {
      /* already replied / interaction gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const commands: Command[] = [
  {
    name: "map",
    description: "Show the world map — regions, areas, where you are and where you started.",
    aliases: ["areas"],
    async execute(inv, ctx) {
      try {
        const loc = (await getLocation(ctx.db, inv.user.id)) ?? defaultLocation(inv.user.id);
        loc.mapZoom = "world";
        await saveLocation(ctx.db, loc);
        await inv.reply(await renderMap(ctx.db, ctx.guildId, inv.user.id, "world"));
      } catch (e) {
        console.error("uwu: map failed:", e instanceof Error ? e.message : e);
        await inv.reply({ content: "Couldn't load the map — try again in a bit." });
      }
    },
  },
  {
    name: "travel",
    description: "Travel to an area in real time, or check your travel status.",
    aliases: ["go"],
    args: [{ name: "area", type: "string", rest: true }],
    async execute(inv, ctx) {
      const now = Date.now();
      const input = inv.options.getString("area");
      try {
        if (!input) {
          // Status: where you are, where you're going, minutes left, auto-hunt.
          const loc = await getLocation(ctx.db, inv.user.id);
          const currentId = await resolveCurrentArea(ctx.db, ctx.guildId, inv.user.id);
          const current = findWorldArea(currentId) ?? WORLD_AREAS[0]!;
          if (!isTravelling(loc, now)) {
            await inv.reply({
              content:
                `You are in ${current.name}.\n` +
                `You're not travelling right now. Auto-hunt is ${loc?.autoHunt ? "on" : "off"} — it only runs while travelling.\n` +
                `Travel somewhere with \`uwu travel <area>\` (see \`uwu map\` for areas).`,
            });
            return;
          }
          const dest = findWorldArea(loc!.travellingTo!) ?? null;
          const mins = Math.max(0, Math.ceil(((loc!.travelEndsAt ?? now) - now) / 60_000));
          await inv.reply({
            content:
              `You are in ${current.name}.\n` +
              `🚶 Travelling to ${dest?.name ?? loc!.travellingTo} — ${mins} min left, arriving <t:${Math.floor((loc!.travelEndsAt ?? now) / 1000)}:t>.\n` +
              `Auto-hunt is ${loc!.autoHunt ? "on" : "off"}${loc!.autoHunt ? ` — ${fmt(AUTOHUNT_GOLD_PER_HOUR)} gold/hour while it runs` : " — turn it on with `uwu autohunt on` to catch monsters on the way"}.`,
          });
          return;
        }

        const dest = findWorldArea(input);
        if (!dest) {
          await inv.reply({ content: `No area called "${input}" — try \`uwu map\` to see the areas.` });
          return;
        }
        const bal = await getBalance(ctx.db, ctx.guildId, inv.user.id);
        if (bal.level < dest.unlockLevel) {
          await inv.reply({
            content: `🔒 ${dest.name} unlocks at level ${dest.unlockLevel} — you're level ${bal.level}. Keep chatting to gain XP!`,
          });
          return;
        }
        let loc = (await getLocation(ctx.db, inv.user.id)) ?? defaultLocation(inv.user.id);
        // Settle an overdue trip first so a stale row never blocks new travel.
        if (settleOverdueTravel(loc, now)) {
          // currentArea is now the old destination; the new trip starts there.
        }
        const currentId = findWorldArea(loc.currentArea) ? loc.currentArea : await resolveCurrentArea(ctx.db, ctx.guildId, inv.user.id);
        loc.currentArea = currentId;
        if (dest.id === currentId) {
          await inv.reply({ content: `You're already in ${dest.name}.` });
          return;
        }
        if (isTravelling(loc, now)) {
          const going = findWorldArea(loc.travellingTo!) ?? null;
          const mins = Math.max(0, Math.ceil(((loc.travelEndsAt ?? now) - now) / 60_000));
          await inv.reply({
            content:
              `You're already travelling to ${going?.name ?? loc.travellingTo} — you arrive in ${mins} min ` +
              `(<t:${Math.floor((loc.travelEndsAt ?? now) / 1000)}:t>). Wait until you get there, or check \`uwu travel\`.`,
          });
          return;
        }
        const from = findWorldArea(currentId) ?? WORLD_AREAS[0]!;
        const minutes = travelMinutes(from, dest);
        const endsAt = now + minutes * 60_000;
        loc.travellingTo = dest.id;
        loc.travelEndsAt = endsAt;
        loc.travelOrigin = currentId;
        loc.lastLocation = currentId;
        loc.travelChannelId = inv.channelId ?? null;
        loc.travelGuildId = ctx.guildId;
        loc.travelStartedAt = now;
        loc.lastAutohuntAt = now;
        await saveLocation(ctx.db, loc);
        const dist = distanceKm(from, dest);
        await inv.reply({
          content:
            `🚶 Travelling to ${dest.name} — ${dist} km, about ${minutes} min. ` +
            `You'll arrive <t:${Math.floor(endsAt / 1000)}:t>.\n` +
            (loc.autoHunt
              ? `Auto-hunt is on — it'll catch roaming monsters on the way (${fmt(AUTOHUNT_GOLD_PER_HOUR)} gold/hour).`
              : `Auto-hunt is off — turn it on with \`uwu autohunt on\` to catch monsters on the way (200 gold/hour).`),
        });
      } catch (e) {
        console.error("uwu: travel failed:", e instanceof Error ? e.message : e);
        await inv.reply({ content: "Couldn't start that trip — try again in a bit." });
      }
    },
  },
  {
    name: "autohunt",
    description: "Toggle auto-hunt while travelling — 200 gold/hour, catches roaming monsters.",
    aliases: ["auto-hunt"],
    args: [{ name: "mode", type: "string" }],
    async execute(inv, ctx) {
      const mode = (inv.options.getString("mode") ?? "").trim().toLowerCase();
      if (mode !== "on" && mode !== "off") {
        await inv.reply({ content: "Usage: `uwu autohunt on|off` — auto-hunt only runs while you're travelling." });
        return;
      }
      try {
        const now = Date.now();
        const loc = (await getLocation(ctx.db, inv.user.id)) ?? defaultLocation(inv.user.id);
        if (mode === "on") {
          if (!isTravelling(loc, now)) {
            await inv.reply({
              content: "Auto-hunt only runs while travelling — start a trip with `uwu travel <area>` first.",
            });
            return;
          }
          if (loc.autoHunt) {
            await inv.reply({ content: "Auto-hunt is already on — it'll catch roaming monsters until you arrive." });
            return;
          }
          loc.autoHunt = true;
          loc.lastAutohuntAt = now;
          await saveLocation(ctx.db, loc);
          await inv.reply({
            content:
              `Auto-hunt on — roaming monsters will be caught automatically while you travel ` +
              `(${fmt(AUTOHUNT_GOLD_PER_HOUR)} gold/hour, charged as you go).`,
          });
          return;
        }
        if (!loc.autoHunt) {
          await inv.reply({ content: "Auto-hunt is already off." });
          return;
        }
        loc.autoHunt = false;
        await saveLocation(ctx.db, loc);
        await inv.reply({ content: "Auto-hunt off — you'll hunt manually again when you arrive." });
      } catch (e) {
        console.error("uwu: autohunt failed:", e instanceof Error ? e.message : e);
        await inv.reply({ content: "Couldn't change auto-hunt — try again in a bit." });
      }
    },
  },
];

export const buttonHandlers: Record<string, (inv: any, ctx: CommandContext) => Promise<void>> = {
  "selena:map": handleMapButton,
};

export const modalHandlers: Record<string, (...args: never[]) => Promise<void>> = {};

// ---------------------------------------------------------------------------
// Sweeps (called from the 60s due-task sweep in src/index.ts — this
// module does NOT wire itself in; the coordinator adds the calls).
// Both never throw out of the sweep.
// ---------------------------------------------------------------------------

/** Minimal client surface the sweeps need (a real discord.js Client fits). */
export interface SweepClient {
  channels: { fetch: (id: string) => Promise<unknown> };
}

async function sendToChannel(client: SweepClient | null, channelId: string | null, content: string): Promise<void> {
  if (!client || !channelId) return;
  try {
    const channel = (await client.channels.fetch(channelId)) as unknown;
    if (channel && typeof channel === "object" && "send" in channel) {
      const send = (channel as { send?: unknown }).send;
      if (typeof send === "function") await (send as (msg: unknown) => Promise<unknown>)({ content });
    }
  } catch {
    /* skip silently — a missing channel never breaks the sweep */
  }
}

interface TravelRow {
  user_id: unknown;
  travelling_to: unknown;
  travel_channel_id: unknown;
}

/**
 * Arrive every user whose trip has ended: current_area becomes the
 * destination, travel fields clear (last_location keeps the origin),
 * and "You arrived at <Area>." is sent to the travel channel.
 *
 * Optional `onArrival` hook: called after the arrival UPDATE succeeds
 * for a user, with (userId, destination area id). When it returns a
 * non-null line, that line is appended to the arrival message on its
 * own line. A hook that throws (or returns null) never breaks the
 * arrival — the player still arrives and the plain arrival line still
 * sends. The hook is injected by the caller (index.ts wires it to the
 * tower-discovery roll); this module stays tower-free and never
 * imports lib/towers.ts.
 */
export async function travelDueSweep(
  db: SelenaDb,
  client: SweepClient | null,
  onArrival?: (userId: string, areaId: string) => Promise<string | null>,
): Promise<void> {
  const now = Date.now();
  let rows: TravelRow[];
  try {
    rows = (await db
      .prepare(
        "SELECT user_id, travelling_to, travel_channel_id FROM user_location " +
          "WHERE travelling_to IS NOT NULL AND travel_ends_at <= ?",
      )
      .all(now)) as unknown as TravelRow[];
  } catch (e) {
    console.error("uwu: travel sweep query failed:", e instanceof Error ? e.message : e);
    return;
  }
  for (const r of rows) {
    const userId = String(r.user_id);
    const destId = String(r.travelling_to);
    const dest = findWorldArea(destId);
    try {
      await db
        .prepare(
          "UPDATE user_location SET current_area = ?, travelling_to = NULL, travel_ends_at = NULL, " +
            "travel_origin = NULL, travel_channel_id = NULL, travel_guild_id = NULL, " +
            "travel_started_at = NULL, last_autohunt_at = NULL WHERE user_id = ?",
        )
        .run(destId, userId);
    } catch (e) {
      console.error(`uwu: travel sweep arrival failed for ${userId}:`, e instanceof Error ? e.message : e);
      continue;
    }
    let extra: string | null = null;
    if (onArrival) {
      try {
        extra = await onArrival(userId, destId);
      } catch {
        extra = null;
      }
    }
    await sendToChannel(
      client,
      r.travel_channel_id == null ? null : String(r.travel_channel_id),
      `You arrived at ${dest?.name ?? destId}.` + (extra ? `\n${extra}` : ""),
    );
  }
}

interface AutohuntRow {
  user_id: unknown;
  travelling_to: unknown;
  travel_ends_at: unknown;
  travel_channel_id: unknown;
  travel_guild_id: unknown;
  last_autohunt_at: unknown;
  auto_hunt_seconds: unknown;
  auto_hunt_charged: unknown;
}

/**
 * Run auto-hunt ticks for everyone travelling with auto-hunt on.
 * One tick per 30s of travel since last_autohunt_at, capped at the
 * trip's end. Each tick encounters a monster from the DESTINATION
 * area's pool and attempts the Phase 1 catch; catches are awarded via
 * awardMonster (source 'hunt', so the per-server caps apply) and
 * failures flee. Gold is charged pro-rata at 200/hour as ticks run;
 * when the user's balance cannot cover the next charge, auto-hunt
 * turns OFF and ticking stops for that user — gold never goes
 * negative (the balance is checked before every deduction, and
 * addPoints refuses negatives atomically too).
 *
 * The guild catch bonus applies to every catch attempt in the loop
 * (design §5.2, capped at +30pp combined — the guild bonus tops out
 * at +17pp, so it is the whole bonus here). A guild lookup failure
 * fails soft to +0: auto-hunt never dies on a guilds query error.
 */
export async function processAutoHuntTicks(
  db: SelenaDb,
  client: SweepClient | null,
  nowMs: number,
  rand: () => number = secureFloat,
): Promise<void> {
  let rows: AutohuntRow[];
  try {
    rows = (await db
      .prepare(
        "SELECT user_id, travelling_to, travel_ends_at, travel_channel_id, travel_guild_id, " +
          "last_autohunt_at, auto_hunt_seconds, auto_hunt_charged FROM user_location " +
          "WHERE travelling_to IS NOT NULL AND auto_hunt = 1 " +
          "AND travel_ends_at IS NOT NULL AND last_autohunt_at IS NOT NULL",
      )
      .all()) as unknown as AutohuntRow[];
  } catch (e) {
    console.error("uwu: autohunt sweep query failed:", e instanceof Error ? e.message : e);
    return;
  }
  for (const r of rows) {
    try {
      await processOneAutohuntUser(db, client, r, nowMs, rand);
    } catch (e) {
      console.error(
        `uwu: autohunt failed for ${String(r.user_id)}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
}

async function processOneAutohuntUser(
  db: SelenaDb,
  client: SweepClient | null,
  r: AutohuntRow,
  nowMs: number,
  rand: () => number,
): Promise<void> {
  const userId = String(r.user_id);
  const guildId = r.travel_guild_id == null ? "" : String(r.travel_guild_id);
  const destId = String(r.travelling_to);
  const endsAt = Number(r.travel_ends_at);
  const lastAt = Number(r.last_autohunt_at);
  const end = Math.min(nowMs, endsAt);
  const ticks = Math.floor((end - lastAt) / AUTOHUNT_TICK_MS);
  if (ticks <= 0) return;
  const dest = findWorldArea(destId);

  // No guild to charge against, or an unknown destination: advance the
  // clock to the end of the window and stop — never spin forever.
  if (!guildId || !dest) {
    try {
      await db
        .prepare("UPDATE user_location SET last_autohunt_at = ?, auto_hunt = ? WHERE user_id = ?")
        .run(end, guildId ? 1 : 0, userId);
    } catch {
      /* next sweep retries */
    }
    return;
  }

  let seconds = Number(r.auto_hunt_seconds ?? 0);
  let charged = Number(r.auto_hunt_charged ?? 0);
  let autoHunt = true;
  let processed = 0;
  const caught = new Map<number, { monster: Monster; count: number }>();
  let fled = 0;
  let chargedThisRun = 0;
  // Guild catch bonus (design §5.2, capped +30pp combined). Fail soft
  // to +0 on a guilds lookup error — auto-hunt must never die here.
  let catchBonus = 0;
  try {
    catchBonus = Math.min(await getGuildCatchBonus(db, userId), 30);
  } catch {
    catchBonus = 0;
  }

  for (let i = 0; i < ticks; i++) {
    const monster = encounterMonsterInWorldArea(dest, rand);
    if (attemptCatch(monster.tier, rand, catchBonus)) {
      try {
        const awarded = await awardMonster(
          db,
          guildId,
          userId,
          monster.tier,
          "hunt",
          (t: Tier) => (t === monster.tier ? monster : drawMonsterFromWorldArea(dest, t, rand)),
          nowMs,
        );
        const entry = caught.get(awarded.monster.id) ?? { monster: awarded.monster, count: 0 };
        entry.count += 1;
        caught.set(awarded.monster.id, entry);
      } catch {
        // Fail closed: a failed award counts as fled, never granted.
        fled += 1;
      }
    } else {
      fled += 1;
    }

    // Charge pro-rata for this tick's 30s — but only after the balance
    // check passes; when it cannot cover the charge, auto-hunt turns
    // off and ticking stops here (the tick's catch, if any, stands).
    const newSeconds = seconds + AUTOHUNT_TICK_MS / 1000;
    const due = Math.floor((newSeconds * AUTOHUNT_GOLD_PER_HOUR) / 3600) - charged;
    if (due > 0) {
      let balance: number;
      try {
        balance = (await getBalance(db, guildId, userId)).points;
      } catch {
        autoHunt = false;
        break;
      }
      if (balance < due) {
        autoHunt = false;
        break;
      }
      try {
        await addPoints(db, guildId, userId, -due, "autohunt");
      } catch {
        autoHunt = false;
        break;
      }
      charged += due;
      chargedThisRun += due;
    }
    seconds = newSeconds;
    processed += 1;
  }

  const newLastAt = lastAt + processed * AUTOHUNT_TICK_MS;
  try {
    await db
      .prepare(
        "UPDATE user_location SET last_autohunt_at = ?, auto_hunt = ?, auto_hunt_seconds = ?, auto_hunt_charged = ? WHERE user_id = ?",
      )
      .run(newLastAt, autoHunt ? 1 : 0, seconds, charged, userId);
  } catch {
    /* clock update failed; the next sweep retries the same window */
  }

  if (caught.size > 0 && r.travel_channel_id != null) {
    const entries = [...caught.values()];
    const lines = entries.slice(0, 10).map((e) => `${monsterEmoji(e.monster)} ${e.monster.name} ×${e.count}`);
    const extra = entries.length > 10 ? ` …and ${entries.length - 10} more kinds` : "";
    const fledText = fled > 0 ? ` · ${fled} fled` : "";
    await sendToChannel(
      client,
      String(r.travel_channel_id),
      `Auto-hunt caught: ${lines.join(", ")}${extra}${fledText} · -${fmt(chargedThisRun)} gold`,
    );
  }
}
