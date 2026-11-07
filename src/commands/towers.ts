import { ActionRowBuilder, ButtonBuilder } from "discord.js";
import { type Command, type CommandContext, type CommandInvocation } from "../lib/command.js";
import { addPoints } from "../lib/economy.js";
import { awardGuildXpBestEffort } from "../lib/guilds.js";
import { secureFloat } from "../lib/rng.js";
import { pageButtons, shopRow } from "../lib/shopFormat.js";
import { findWorldArea, REGIONS } from "../lib/world.js";
import {
  climbFloor,
  discoverTower,
  ensureTowersSeeded,
  enterTower,
  EXPLORE_CONSOLATION_GOLD_MAX,
  EXPLORE_CONSOLATION_GOLD_MIN,
  EXPLORE_DISCOVERY_CHANCE,
  exploreCooldownRemainingMs,
  FINAL_BOSS_TIER,
  findTower,
  floorReveal,
  formatCooldown,
  getDiscoveredTowerIds,
  getPlayerLevel,
  getProgress,
  getTowerCooldown,
  getUserParty,
  isTowerDiscovered,
  leaveTower,
  listUndiscoveredTowersInArea,
  listVisibleTowers,
  NORMAL_FLOOR_CRATE,
  RECOMMENDED_PARTY,
  setExploreCooldown,
  towerAreaLabel,
  towerCooldownRemainingMs,
  towerSizeLabel,
  type TowerRow,
} from "../lib/towers.js";
import { resolveCurrentArea } from "./world.js";
import { recordQuestProgress } from "../lib/quests.js";

/**
 * Towers (Phase 2, design docs/hunt-world-phase2-design.md §4).
 *
 * MYSTERY RULES (Ronit's order, 2026-11-07): towers are mysterious.
 * Undiscovered towers show as ??? — never by name, never with an
 * area, floor count, level requirement, cooldown or checkpoint.
 * Discovery is per user: `uwu explore` in an area (40% per explore,
 * 60s cooldown) or a 25% roll on travel arrival. Floors reveal only
 * as cleared: floor N+1 is revealed once floor N is cleared, so the
 * final-boss floor stays ??? until floorReached = floors-1. The Main
 * tower stays completely hidden (never listed, never named, not even
 * as ???) and is entered only by exact name/id.
 *
 * `uwu tower` — list the known towers, paginated one region per page
 * with ◀ N ▶ buttons, in the OwO big-list shop format (numbered rows,
 * dotted leader, compact facts — src/lib/shopFormat.ts): 29 towers in
 * the old one-shot format blew past Discord's 2,000-character message
 * limit and the reply failed outright, so EVERY page is built to fit
 * (compact one-line-per-tower rows) and every page stays under the
 * limit. The header counts only the DISCOVERED towers on that page —
 * it never shows a total.
 * `uwu tower <name>` — detail for one tower, but only if you have
 * discovered it (or already have progress on it): floors, level req,
 * recommended party, cooldown timer, your checkpoint, and one line
 * per REVEALED floor — hidden floors collapse to a single ??? line.
 * `uwu explore` — explore your current area; you might discover a
 * hidden tower (60s cooldown). No level gate.
 * `uwu tower enter <tower>` — start or resume a run from your
 * checkpoint floor. Your party is whoever enters together; members
 * join the active run with the same command. Undiscovered towers
 * cannot be entered — the reply never confirms they exist.
 * `uwu tower climb` — fight the next floor through the battle
 * engine (mini-boss every 5th floor, final boss on the top floor —
 * bosses are never catchable, drops only).
 * `uwu tower leave` — exit; your checkpoint is saved.
 *
 * Plain-text OwO-style replies everywhere, no embeds. All state in
 * Supabase — never in-memory. The module does NOT wire itself into
 * src/commands/index.ts or src/index.ts (the coordinator does that);
 * it also does NOT seed at import time — seeding is lazy on the
 * first command call (idempotent), and the coordinator can call
 * seedTowers(db) at boot instead.
 */

type Inv = CommandInvocation;

async function replyError(inv: Inv, message: string): Promise<void> {
  await inv.reply({ content: message });
}

async function runAction(inv: Inv, fn: () => Promise<string>): Promise<void> {
  try {
    await inv.reply({ content: await fn() });
  } catch (e) {
    await replyError(inv, e instanceof Error ? e.message : "Something went wrong — try again in a bit.");
  }
}

/**
 * One tower row in the OwO big-list shop format (src/lib/shopFormat.ts):
 * numbered, dotted leader to the compact facts (size, floors, entry
 * level), then ready/cooldown + checkpoint. Numbers run 1–29 across
 * ALL region pages (OwO's shop numbers globally), so a number is a
 * stable list position. The old verbose row ("Small · 10 floors ·
 * party 2+ recommended · ...") ran ~130 characters per tower, so 29
 * towers blew past Discord's 2,000-character message limit and the
 * whole list reply failed — this row keeps the facts that matter in
 * the list; the rest lives in the detail view (`uwu tower <name>`).
 */
function towerLine(num: number, t: TowerRow, cooldownMs: number, checkpoint: number | null): string {
  const size = t.type === "small" ? "S" : "B";
  const status = cooldownMs > 0 ? ` ⏳ ${formatCooldown(cooldownMs)}` : " ✅";
  const cp = checkpoint !== null && checkpoint > 0 ? ` 📍 ${checkpoint}/${t.floors}` : "";
  return shopRow(num, "🗼", t.name, `${size} · ${t.floors}F · Lv ${t.levelReq}+`, status + cp);
}

/**
 * An undiscovered tower: numbered like every other row (the number
 * is just a list position and leaks nothing), but no name, no area,
 * no floors, no level, nothing.
 */
function undiscoveredLine(num: number): string {
  return shopRow(num, "", "???", "undiscovered");
}

interface TowerListPage {
  regionId: string;
  regionName: string;
  towers: TowerRow[];
}

/** Visible towers grouped by region (REGIONS order), skipping empty regions. */
async function towerListPages(ctx: CommandContext): Promise<{ pages: TowerListPage[]; total: number }> {
  const towers = await listVisibleTowers(ctx.db);
  const byRegion = new Map<string, TowerRow[]>();
  for (const t of towers) {
    const list = byRegion.get(t.region) ?? [];
    list.push(t);
    byRegion.set(t.region, list);
  }
  const pages: TowerListPage[] = [];
  for (const r of REGIONS) {
    const ts = byRegion.get(r.id) ?? [];
    if (ts.length > 0) pages.push({ regionId: r.id, regionName: r.name, towers: ts });
  }
  return { pages, total: towers.length };
}

/**
 * Render one region page of the tower list (page clamped into range).
 * Discovered towers show their compact row; undiscovered ones show
 * only the ??? line. The header counts discovered towers ON THIS
 * PAGE only — the total is never shown.
 */
async function towerPageContent(
  ctx: CommandContext,
  userId: string,
  wantedPage: number,
): Promise<{ content: string; page: number; pageCount: number }> {
  const { pages } = await towerListPages(ctx);
  if (pages.length === 0) {
    return { content: "No towers stand in this world yet — strange. Try again in a bit.", page: 0, pageCount: 0 };
  }
  const page = Math.min(Math.max(0, Math.floor(wantedPage) || 0), pages.length - 1);
  const now = Date.now();
  const region = pages[page]!;
  const discovered = await getDiscoveredTowerIds(ctx.db, userId);
  let discoveredOnPage = 0;
  const lines: string[] = [];
  const rows: string[] = [];
  // Row numbers run 1–29 across ALL region pages (OwO's shop numbers
  // globally), so count the towers on the earlier pages first.
  let num = 1;
  for (let i = 0; i < page; i++) num += pages[i]!.towers.length;
  for (const t of region.towers) {
    if (!discovered.has(t.towerId)) {
      rows.push(undiscoveredLine(num++));
      continue;
    }
    discoveredOnPage++;
    const cd = await towerCooldownRemainingMs(ctx.db, t.towerId, now);
    const progress = await getProgress(ctx.db, userId, t.towerId);
    rows.push(towerLine(num++, t, cd, progress ? progress.floorReached : null));
  }
  lines.push(`🗼 Towers — ${region.regionName} (page ${page + 1}/${pages.length} · ${discoveredOnPage} discovered):`);
  lines.push(...rows);
  lines.push("Use ◀ ▶ to flip regions · Enter one with `uwu tower enter <name>` — or see one in detail with `uwu tower <name>`.");
  lines.push("Found a ??? — explore your current area with `uwu explore` to discover its towers.");
  return { content: lines.join("\n"), page, pageCount: pages.length };
}

function towerListButtons(page: number, pageCount: number): ActionRowBuilder<ButtonBuilder>[] {
  // OwO-style ◀ N ▶ buttons (the middle button shows the current
  // page number, disabled) — same helper as the background shop.
  return pageButtons("selena:tower:list", page, pageCount);
}

async function handleTowerListButton(inv: any, ctx: CommandContext): Promise<void> {
  const parts = String(inv.customId ?? "").split(":");
  const wanted = Number.parseInt(parts[3] ?? "0", 10);
  const userId = String(inv.user?.id ?? "");
  try {
    const { content, page, pageCount } = await towerPageContent(ctx, userId, Number.isNaN(wanted) ? 0 : wanted);
    await inv.update({ content, components: pageCount > 1 ? towerListButtons(page, pageCount) : [] });
  } catch (e) {
    try {
      await inv.reply({ content: "Couldn't load that page — try `uwu tower` again.", ephemeral: true });
    } catch {
      // The interaction is already answered/expired; nothing more to do.
    }
  }
}

/**
 * Discovery gate (detail + enter). Returns the refusal text when the
 * tower is undiscovered, or null when the user may proceed. The
 * hidden Main tower bypasses the gate entirely (exact name/id entry
 * stays as it is). A tower the user has progress on proves they knew
 * it before the mystery rebuild, so the discovery is recorded
 * best-effort and they proceed. Anything else undiscovered is refused
 * WITHOUT confirming the tower exists.
 */
async function discoveryRefusal(
  ctx: CommandContext,
  userId: string,
  tower: TowerRow,
): Promise<string | null> {
  if (tower.hidden) return null;
  if (await isTowerDiscovered(ctx.db, userId, tower.towerId)) return null;
  const progress = await getProgress(ctx.db, userId, tower.towerId);
  if (progress) {
    try {
      await discoverTower(ctx.db, userId, tower.towerId, Date.now());
    } catch {
      // Best-effort only: a failed backfill never blocks entry/detail.
    }
    return null;
  }
  return "No tower by that name is known to you — explore areas to discover towers.";
}

async function detailText(ctx: CommandContext, userId: string, tower: TowerRow): Promise<string> {
  const now = Date.now();
  const cd = await getTowerCooldown(ctx.db, tower.towerId);
  const cdMs = cd ? Math.max(0, cd.resetsAt - now) : 0;
  const progress = await getProgress(ctx.db, userId, tower.towerId);
  const floorReached = progress?.floorReached ?? 0;
  const party = await getUserParty(ctx.db, userId, tower.towerId);
  const lines = [
    `🗼 ${tower.hidden ? "A hidden tower" : tower.name} — ${towerSizeLabel(tower)} tower · ${tower.floors} floors`,
    `📍 Area: ${towerAreaLabel(tower)}`,
    `🔒 Entry: level ${tower.levelReq}+`,
    `👥 Recommended party: ${RECOMMENDED_PARTY[tower.type]}+ (solo allowed, but hard — bigger parties allowed too)`,
  ];
  // Floor reveal: one line per revealed floor (floors 1..floorReached+1),
  // then a single ??? line for the hidden range. Never leak the
  // structure ("mini-boss every 5th floor" / the final-boss floor)
  // for floors the player has not earned yet.
  for (const r of floorReveal(tower, floorReached)) {
    if (!r.revealed) continue;
    const kindLabel =
      r.kind === "normal"
        ? "3 wild monsters"
        : r.kind === "mini-boss"
          ? "💪 Mini-boss"
          : `👑 Final boss (${FINAL_BOSS_TIER[tower.type]})`;
    const crate =
      r.crateTier !== null
        ? ` · 🎁 ${r.crateTier} Crate`
        : r.crateChance
          ? ` · 10% ${NORMAL_FLOOR_CRATE[tower.type]} Crate`
          : "";
    lines.push(`F${r.floor} · ${kindLabel} · +${r.gold}g · +${r.xp} XP${crate}`);
  }
  const firstHidden = floorReached + 2;
  if (firstHidden <= tower.floors) {
    lines.push(`Floors ${firstHidden}–${tower.floors} — ??? (clear floor ${floorReached + 1} to reveal more)`);
  }
  lines.push(
    cdMs > 0
      ? `⏳ Cleared — resets in ${formatCooldown(cdMs)}`
      : "✅ Ready to climb",
    progress && progress.floorReached > 0
      ? `📍 Your checkpoint: floor ${progress.floorReached}/${tower.floors}`
      : "📍 You haven't started this tower yet",
  );
  if (party) lines.push(`👥 Your party: ${party.members.length} member${party.members.length === 1 ? "" : "s"} (leader <@${party.leaderId}>)`);
  lines.push(`Enter with \`uwu tower enter ${tower.hidden ? tower.towerId : tower.name}\`.`);
  return lines.join("\n");
}

export const commands: Command[] = [
  {
    name: "tower",
    description: "Towers: list them, enter one, climb floors, or leave (checkpoints save every floor).",
    aliases: ["towers"],
    args: [
      { name: "action", type: "string" },
      { name: "target", type: "string", rest: true },
    ],
    async execute(inv, ctx) {
      await ensureTowersSeeded(ctx.db);
      const action = (inv.options.getString("action") ?? "").trim().toLowerCase();
      const target = (inv.options.getString("target") ?? "").trim();

      // `uwu tower` with nothing after it: the paginated list (page 1).
      if (!action) {
        try {
          const { content, page, pageCount } = await towerPageContent(ctx, inv.user.id, 0);
          await inv.reply({ content, components: pageCount > 1 ? towerListButtons(page, pageCount) : [] });
        } catch (e) {
          await replyError(inv, e instanceof Error ? e.message : "Something went wrong — try again in a bit.");
        }
        return;
      }

      if (action === "climb") {
        await runAction(inv, async () => {
          const progress = await findTowerProgress(ctx, inv.user.id);
          if (!progress) {
            return "You're not inside any tower — enter one first with `uwu tower enter <name>`.";
          }
          const result = await climbFloor(ctx.db, {
            guildId: ctx.guildId,
            userId: inv.user.id,
            username: inv.user.username,
            towerId: progress.towerId,
            nowMs: Date.now(),
          });
          // Guild XP (Phase 2 §3.2): 100 per tower floor cleared,
          // best-effort — the climb already settled.
          if (result.outcome === "win") {
            await awardGuildXpBestEffort(ctx.db, inv.user.id, 100);
          }
          return result.text;
        });
        return;
      }

      if (action === "leave") {
        await runAction(inv, async () => {
          const progress = await findTowerProgress(ctx, inv.user.id);
          if (!progress) return "You're not inside any tower — nothing to leave.";
          const tower = await findTower(ctx.db, progress.towerId);
          const left = await leaveTower(ctx.db, { userId: inv.user.id, towerId: progress.towerId, nowMs: Date.now() });
          if (!left.left) return "You're not inside any tower — nothing to leave.";
          return (
            `🚪 You left ${tower?.hidden ? "the tower" : (tower?.name ?? "the tower")}. ` +
            `Your checkpoint is saved at floor ${left.floorReached} — resume anytime with \`uwu tower enter ${tower?.hidden ? tower.towerId : (tower?.name ?? "")}\`.`
          );
        });
        return;
      }

      if (action === "enter") {
        if (!target) {
          await replyError(inv, "Enter which tower? `uwu tower enter <name>` — see them with `uwu tower`.");
          return;
        }
        await runAction(inv, async () => {
          const tower = await findTower(ctx.db, target);
          if (!tower) return `No tower by that name — see the known towers with \`uwu tower\`.`;
          const refused = await discoveryRefusal(ctx, inv.user.id, tower);
          if (refused) return refused;
          const level = await getPlayerLevel(ctx.db, ctx.guildId, inv.user.id);
          const entered = await enterTower(ctx.db, {
            userId: inv.user.id,
            tower,
            playerLevel: level,
            nowMs: Date.now(),
          });
          const party = entered.party;
          const warn =
            party.members.length < RECOMMENDED_PARTY[tower.type]
              ? `\n⚠️ Recommended party is ${RECOMMENDED_PARTY[tower.type]}+ — you're ${party.members.length === 1 ? "solo" : `${party.members.length} players`}, so this will be hard. Bring friends with \`uwu tower enter ${tower.hidden ? tower.towerId : tower.name}\`!`
              : "";
          const resume =
            entered.floorReached > 0
              ? `Resuming from your checkpoint at floor ${entered.floorReached}/${tower.floors}.`
              : `Starting at floor 1/${tower.floors}.`;
          return (
            `🗼 You entered ${tower.hidden ? "a hidden tower" : tower.name} (${towerSizeLabel(tower)}, ${tower.floors} floors). ${resume}\n` +
            `👥 Party: ${party.members.length} member${party.members.length === 1 ? "" : "s"}${warn}\n` +
            `Climb with \`uwu tower climb\`, or rest with \`uwu tower leave\` (checkpoint saves every floor).`
          );
        });
        return;
      }

      // Anything else is treated as a tower name → detail view.
      await runAction(inv, async () => {
        const query = [action, target].filter(Boolean).join(" ");
        const tower = await findTower(ctx.db, query);
        if (!tower) return `No tower by that name — see the known towers with \`uwu tower\`.`;
        const refused = await discoveryRefusal(ctx, inv.user.id, tower);
        if (refused) return refused;
        return detailText(ctx, inv.user.id, tower);
      });
    },
  },
  {
    name: "explore",
    description: "Explore your current area — you might discover a hidden tower (60s cooldown).",
    aliases: ["discover"],
    async execute(inv, ctx) {
      await ensureTowersSeeded(ctx.db);
      await runAction(inv, async () => {
        const now = Date.now();
        // Mid-travel: explore only once you have arrived.
        const locRow = (await ctx.db
          .prepare("SELECT travelling_to, travel_ends_at FROM user_location WHERE user_id = ?")
          .get(inv.user.id)) as { travelling_to: unknown; travel_ends_at: unknown } | undefined;
        if (
          locRow?.travelling_to != null &&
          Number(locRow.travel_ends_at ?? 0) > now
        ) {
          return "You're on the road — explore when you arrive.";
        }
        const remaining = await exploreCooldownRemainingMs(ctx.db, inv.user.id, now);
        if (remaining > 0) {
          return `⏳ You need a breather — explore again in ${Math.ceil(remaining / 1000)}s.`;
        }
        // Cooldown is set FIRST, so a failed roll still costs it.
        await setExploreCooldown(ctx.db, inv.user.id, now);
        const areaId = await resolveCurrentArea(ctx.db, ctx.guildId, inv.user.id);
        const areaName = findWorldArea(areaId)?.name ?? areaId;
        const undiscovered = await listUndiscoveredTowersInArea(ctx.db, inv.user.id, areaId);
        if (undiscovered.length === 0) {
          const gold =
            EXPLORE_CONSOLATION_GOLD_MIN +
            Math.floor(secureFloat() * (EXPLORE_CONSOLATION_GOLD_MAX - EXPLORE_CONSOLATION_GOLD_MIN + 1));
          await addPoints(ctx.db, ctx.guildId, inv.user.id, gold, "explore");
          return `🔍 You already know every tower in ${areaName} — but poking around turned up +${gold} gold.`;
        }
        if (secureFloat() < EXPLORE_DISCOVERY_CHANCE) {
          const tower = undiscovered[Math.floor(secureFloat() * undiscovered.length)]!;
          await discoverTower(ctx.db, inv.user.id, tower.towerId, now);
          try {
            await recordQuestProgress(ctx.db, inv.user.id, ["explore_discover"]);
          } catch (e) {
            console.error("uwu: quest progress failed:", e instanceof Error ? e.message : e);
          }
          return (
            `🔍 You found something! 🗼 ${tower.name} — a ${towerSizeLabel(tower)} tower, ` +
            `${tower.floors} floors, in ${areaName} · enter at level ${tower.levelReq}+. ` +
            `See it with \`uwu tower ${tower.name}\`.`
          );
        }
        return `🔍 You searched ${areaName} thoroughly but found nothing this time — the towers here stay hidden. Try again in a bit.`;
      });
    },
  },
];

/**
 * The tower the user is currently inside, if any: the most recent
 * progress row that still has a live party. Progress rows without a
 * party (left the run) don't count — the player must re-enter.
 */
async function findTowerProgress(
  ctx: CommandContext,
  userId: string,
): Promise<{ towerId: string } | null> {
  const rows = (await ctx.db
    .prepare("SELECT tower_id, party_id FROM tower_progress WHERE user_id = ? ORDER BY checkpoint_at DESC")
    .all(userId)) as { tower_id: string; party_id: string | null }[];
  for (const row of rows) {
    if (!row.party_id) continue;
    const party = await getUserParty(ctx.db, userId, String(row.tower_id));
    if (party) return { towerId: String(row.tower_id) };
  }
  return null;
}

export const buttonHandlers: Record<string, (...args: never[]) => Promise<void>> = {
  "selena:tower": handleTowerListButton as (...args: never[]) => Promise<void>,
};

export const modalHandlers: Record<string, (...args: never[]) => Promise<void>> = {};
