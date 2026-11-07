import { type Command, type CommandContext, type CommandInvocation } from "../lib/command.js";
import { awardGuildXpBestEffort } from "../lib/guilds.js";
import {
  climbFloor,
  ensureTowersSeeded,
  enterTower,
  findTower,
  formatCooldown,
  getPlayerLevel,
  getProgress,
  getTowerCooldown,
  getUserParty,
  leaveTower,
  listVisibleTowers,
  RECOMMENDED_PARTY,
  towerAreaLabel,
  towerCooldownRemainingMs,
  towerSizeLabel,
  type TowerRow,
} from "../lib/towers.js";

/**
 * Towers (Phase 2, design docs/hunt-world-phase2-design.md §4).
 *
 * `uwu tower` — list the known towers (the hidden Main tower is
 * NEVER listed, and its area never appears anywhere).
 * `uwu tower <name>` — detail for one tower (floors, level req,
 * recommended party, cooldown timer, your checkpoint).
 * `uwu tower enter <tower>` — start or resume a run from your
 * checkpoint floor. Your party is whoever enters together; members
 * join the active run with the same command.
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

function towerLine(t: TowerRow, cooldownMs: number, checkpoint: number | null): string {
  const cd = cooldownMs > 0 ? ` · ⏳ resets in ${formatCooldown(cooldownMs)}` : " · ✅ ready";
  const cp = checkpoint !== null && checkpoint > 0 ? ` · 📍 you're at floor ${checkpoint}/${t.floors}` : "";
  return (
    `🗼 ${t.name} — ${towerSizeLabel(t)} · ${t.floors} floors · ${towerAreaLabel(t)} · ` +
    `Lv ${t.levelReq}+ · party ${RECOMMENDED_PARTY[t.type]}+ recommended${cd}${cp}`
  );
}

async function listText(ctx: CommandContext, userId: string): Promise<string> {
  const towers = await listVisibleTowers(ctx.db);
  if (towers.length === 0) return "No towers stand in this world yet — strange. Try again in a bit.";
  const now = Date.now();
  const lines: string[] = [
    `🗼 Towers of the world — ${towers.length} known towers (party sizes are recommended minimums — solo is allowed, just hard):`,
  ];
  for (const t of towers) {
    const cd = await towerCooldownRemainingMs(ctx.db, t.towerId, now);
    const progress = await getProgress(ctx.db, userId, t.towerId);
    lines.push(towerLine(t, cd, progress ? progress.floorReached : null));
  }
  lines.push("Enter one with `uwu tower enter <name>` — or see one in detail with `uwu tower <name>`.");
  return lines.join("\n");
}

async function detailText(ctx: CommandContext, userId: string, tower: TowerRow): Promise<string> {
  const now = Date.now();
  const cd = await getTowerCooldown(ctx.db, tower.towerId);
  const cdMs = cd ? Math.max(0, cd.resetsAt - now) : 0;
  const progress = await getProgress(ctx.db, userId, tower.towerId);
  const party = await getUserParty(ctx.db, userId, tower.towerId);
  const lines = [
    `🗼 ${tower.hidden ? "A hidden tower" : tower.name} — ${towerSizeLabel(tower)} tower · ${tower.floors} floors`,
    `📍 Area: ${towerAreaLabel(tower)}`,
    `🔒 Entry: level ${tower.levelReq}+`,
    `👥 Recommended party: ${RECOMMENDED_PARTY[tower.type]}+ (solo allowed, but hard — bigger parties allowed too)`,
    `💪 Mini-boss every 5th floor · 👑 final boss on floor ${tower.floors} (uncatchable — drops only)`,
    cdMs > 0
      ? `⏳ Cleared — resets in ${formatCooldown(cdMs)}`
      : "✅ Ready to climb",
    progress && progress.floorReached > 0
      ? `📍 Your checkpoint: floor ${progress.floorReached}/${tower.floors}`
      : "📍 You haven't started this tower yet",
  ];
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

      // `uwu tower` with nothing after it: the list.
      if (!action) {
        await runAction(inv, () => listText(ctx, inv.user.id));
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
        return detailText(ctx, inv.user.id, tower);
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

export const buttonHandlers: Record<string, (...args: never[]) => Promise<void>> = {};

export const modalHandlers: Record<string, (...args: never[]) => Promise<void>> = {};
