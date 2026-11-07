import { emoji } from "../lib/emoji.js";
import {
  fmt,
  resolveDisplayNames,
  type Command,
  type CommandContext,
  type CommandInvocation,
} from "../lib/command.js";
import { addPoints, getBalance } from "../lib/economy.js";
import {
  GUILD_CREATE_COST,
  GUILD_MAX_LEVEL,
  GUILD_MAX_MEMBERS,
  createGuild,
  disbandGuild,
  getGuildByName,
  getGuildCatchBonus,
  getGuildRank,
  getGuildSellBonus,
  getGuildXpBonus,
  getUserGuild,
  guildLevelForXp,
  inviteMember,
  joinGuild,
  kickMember,
  leaveGuild,
  promoteMember,
} from "../lib/guilds.js";

/**
 * Guilds — Phase 2 commands (design docs/hunt-world-phase2-design.md §3):
 * `uwu guild create|join|leave|info|rank|invite|kick|promote|disband`.
 *
 * Plain-text OwO-style replies everywhere, like the rest of the bot —
 * no embeds, no buttons. Guilds are global across Discord: one guild
 * per player, max 20 members, create costs 5,000 gold (charged from
 * the invoker's balance in the CURRENT Discord server, in the same
 * transaction as the guild row so a failed create never keeps the gold).
 *
 * One command, "guild" (alias "g"), with a first string arg for the
 * action — the same subcommand style the prefix router already
 * supports: the action is a plain string, the target of invite/kick/
 * promote is a user arg, and the guild name is a rest string so names
 * with spaces work (`uwu guild create My Guild`).
 */

type Inv = CommandInvocation;

async function replyError(inv: Inv, message: string): Promise<void> {
  await inv.reply({ content: message });
}

/**
 * Run one guild action and reply with its plain-text result. Lib
 * errors carry the user-facing message, so they are replied as-is
 * instead of the generic "couldn't run that" fallback.
 */
async function runAction(inv: Inv, fn: () => Promise<string>): Promise<void> {
  try {
    await inv.reply({ content: await fn() });
  } catch (e) {
    await replyError(inv, e instanceof Error ? e.message : "Something went wrong — try again in a bit.");
  }
}

/** The invoker's guild, or an error naming what they need to do. */
async function requireOwnGuild(db: CommandContext["db"], userId: string) {
  const guild = await getUserGuild(db, userId);
  if (!guild) throw new Error("You're not in a guild — join one with `uwu guild join <name>` or create one with `uwu guild create <name>`.");
  return guild;
}

function requireTarget(inv: Inv, verb: string): { id: string; username: string } {
  const target = inv.options.getUser("target");
  if (!target) throw new Error(`Mention someone to ${verb}: \`uwu guild ${verb} @user\`.`);
  return target;
}

function requireName(inv: Inv, verb: string): string {
  const name = inv.options.getString("name");
  if (!name) throw new Error(`Give me a guild name: \`uwu guild ${verb} <name>\`.`);
  return name;
}

/**
 * Smallest total XP that reaches the next level (the level thresholds
 * live in the lib — this finds the boundary by searching with
 * guildLevelForXp instead of duplicating the table). Null at max level.
 */
function xpForNextLevel(xp: number, level: number): number | null {
  if (level >= GUILD_MAX_LEVEL) return null;
  let lo = xp + 1;
  let hi = xp + 1;
  while (guildLevelForXp(hi) <= level) {
    hi = xp + (hi - xp) * 2;
    if (hi > xp + 1_000_000) return null;
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (guildLevelForXp(mid) > level) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function perkText(catchBonus: number, sellBonus: number, xpBonus: number): string {
  const parts: string[] = [];
  if (catchBonus > 0) parts.push(`+${catchBonus}% catch chance`);
  if (sellBonus > 0) parts.push(`+${sellBonus}% gold from sells`);
  if (xpBonus > 0) parts.push(`+${xpBonus}% XP`);
  return parts.length > 0 ? parts.join(" · ") : "none yet — reach Level 2 for +2% catch chance";
}

const ROLE_LABEL: Record<string, string> = { leader: "Leader", officer: "Officer", member: "Member" };
const ROLE_RANK: Record<string, number> = { leader: 0, officer: 1, member: 2 };

export const commands: Command[] = [
  {
    name: "guild",
    description: "Guilds: create, join, leave, info, rank, invite, kick, promote, disband.",
    aliases: ["g"],
    args: [
      { name: "action", type: "string" },
      { name: "target", type: "user" },
      { name: "name", type: "string", rest: true },
    ],
    async execute(inv, ctx) {
      const action = (inv.options.getString("action") ?? "").toLowerCase();
      switch (action) {
        case "create": {
          await runAction(inv, async () => {
            const name = requireName(inv, "create");
            const existing = await getUserGuild(ctx.db, inv.user.id);
            if (existing) {
              throw new Error(`You're already in "${existing.name}" — leave it before creating a new guild.`);
            }
            const bal = await getBalance(ctx.db, ctx.guildId, inv.user.id);
            if (bal.points < GUILD_CREATE_COST) {
              throw new Error(
                `Creating a guild costs ${emoji("gold")} ${fmt(GUILD_CREATE_COST)} gold — you have ${fmt(bal.points)} gold.`,
              );
            }
            const now = Date.now();
            // Create FIRST, charge second: a refused create (name taken,
            // bad name, already in a guild) then never moves any gold —
            // even on a store without rollback, no charge is left behind.
            const { balance, guild } = await ctx.db.transaction(async (tx) => {
              const guild = await createGuild(tx, inv.user.id, name, now);
              const balance = await addPoints(tx, ctx.guildId, inv.user.id, -GUILD_CREATE_COST, `guild create ${name}`);
              return { balance, guild };
            });
            return (
              `🏰 Guild "${guild.name}" created! You're the Leader.\n` +
              `It cost ${emoji("gold")} ${fmt(GUILD_CREATE_COST)} gold — balance: ${fmt(balance)} gold.\n` +
              `Invite people with \`uwu guild invite @user\` — up to ${GUILD_MAX_MEMBERS} members.`
            );
          });
          return;
        }
        case "join": {
          await runAction(inv, async () => {
            const name = requireName(inv, "join");
            const guild = await joinGuild(ctx.db, inv.user.id, name, Date.now());
            return `You joined 🏰 "${guild.name}" (Level ${guildLevelForXp(guild.xp)})! Check it with \`uwu guild info\`.`;
          });
          return;
        }
        case "leave": {
          await runAction(inv, async () => {
            const guild = await leaveGuild(ctx.db, inv.user.id);
            return `You left "${guild.name}".`;
          });
          return;
        }
        case "info": {
          await runAction(inv, async () => {
            const name = inv.options.getString("name");
            const guild = name
              ? await getGuildByName(ctx.db, name)
              : await getUserGuild(ctx.db, inv.user.id);
            if (!guild) {
              throw new Error(
                name
                  ? `No guild called "${name.trim()}" — check the name with \`uwu guild rank\`.`
                  : "You're not in a guild — join one with `uwu guild join <name>` or create one with `uwu guild create <name>`.",
              );
            }
            const level = guildLevelForXp(guild.xp);
            const next = xpForNextLevel(guild.xp, level);
            const progress =
              next === null
                ? "MAX level"
                : `${fmt(next - guild.xp)} XP to Level ${level + 1}`;
            const rows = (await ctx.db
              .prepare("SELECT user_id, role, joined_at FROM guild_members WHERE guild_id = ? ORDER BY joined_at ASC")
              .all(guild.id)) as { user_id: string; role: string; joined_at: number }[];
            const sorted = [...rows].sort(
              (a, b) =>
                (ROLE_RANK[a.role] ?? 2) - (ROLE_RANK[b.role] ?? 2) ||
                Number(a.joined_at) - Number(b.joined_at),
            );
            const names = await resolveDisplayNames(
              inv,
              sorted.map((r) => String(r.user_id)),
            );
            const memberLines = sorted.map(
              (r, i) => `${names[i] ?? String(r.user_id)} — ${ROLE_LABEL[r.role] ?? "Member"}`,
            );
            // Perks are a function of the guild: read them through any
            // member (the leader) so info on another guild is correct.
            const [catchBonus, sellBonus, xpBonus] = await Promise.all([
              getGuildCatchBonus(ctx.db, guild.leader_id),
              getGuildSellBonus(ctx.db, guild.leader_id),
              getGuildXpBonus(ctx.db, guild.leader_id),
            ]);
            return (
              `🏰 ${guild.name} — Level ${level} · ${fmt(guild.xp)} XP (${progress})\n` +
              `Members: ${rows.length}/${GUILD_MAX_MEMBERS}\n` +
              `Perks: ${perkText(catchBonus, sellBonus, xpBonus)}\n` +
              `— Members —\n${memberLines.join("\n")}`
            );
          });
          return;
        }
        case "rank": {
          await runAction(inv, async () => {
            const board = await getGuildRank(ctx.db, 10);
            if (board.length === 0) {
              return `No guilds exist yet — create the first one with \`uwu guild create <name>\` (${fmt(GUILD_CREATE_COST)} gold).`;
            }
            const lines = board.map(
              (g, i) =>
                `#${i + 1} ${g.name} — Level ${g.level} · ${fmt(g.xp)} XP · ${g.memberCount} member${g.memberCount === 1 ? "" : "s"} · Power ${fmt(g.power)}`,
            );
            return `🏆 Guild Rankings\n${lines.join("\n")}`;
          });
          return;
        }
        case "invite": {
          await runAction(inv, async () => {
            const target = requireTarget(inv, "invite");
            const guild = await requireOwnGuild(ctx.db, inv.user.id);
            await inviteMember(ctx.db, guild.id, inv.user.id, target.id);
            const [displayName] = await resolveDisplayNames(inv, [target.id]);
            return `Invited ${displayName ?? target.username} to "${guild.name}"!`;
          });
          return;
        }
        case "kick": {
          await runAction(inv, async () => {
            const target = requireTarget(inv, "kick");
            const guild = await requireOwnGuild(ctx.db, inv.user.id);
            await kickMember(ctx.db, guild.id, inv.user.id, target.id);
            const [displayName] = await resolveDisplayNames(inv, [target.id]);
            return `Kicked ${displayName ?? target.username} from "${guild.name}".`;
          });
          return;
        }
        case "promote": {
          await runAction(inv, async () => {
            const target = requireTarget(inv, "promote");
            const guild = await requireOwnGuild(ctx.db, inv.user.id);
            const { newRole } = await ctx.db.transaction(async (tx) =>
              promoteMember(tx, guild.id, inv.user.id, target.id),
            );
            const [displayName] = await resolveDisplayNames(inv, [target.id]);
            const name = displayName ?? target.username;
            if (newRole === "leader") {
              return `👑 ${name} is now the Leader of "${guild.name}" — leadership transferred from you.`;
            }
            return `${name} is now an Officer of "${guild.name}".`;
          });
          return;
        }
        case "disband": {
          await runAction(inv, async () => {
            const guild = await requireOwnGuild(ctx.db, inv.user.id);
            await ctx.db.transaction(async (tx) => disbandGuild(tx, guild.id, inv.user.id));
            return `Guild "${guild.name}" has been disbanded.`;
          });
          return;
        }
        case "": {
          await replyError(
            inv,
            "Usage: `uwu guild create <name>` · `uwu guild join <name>` · `uwu guild leave` · `uwu guild info [name]` · `uwu guild rank` · `uwu guild invite @user` · `uwu guild kick @user` · `uwu guild promote @user` · `uwu guild disband`",
          );
          return;
        }
        default: {
          await replyError(
            inv,
            `Unknown guild action "${action}" — try \`uwu guild info\`, \`uwu guild rank\`, or \`uwu guild create <name>\`.`,
          );
          return;
        }
      }
    },
  },
];

export const buttonHandlers: Record<string, (inv: never, ctx: CommandContext) => Promise<void>> = {};

export const modalHandlers: Record<string, (...args: never[]) => Promise<void>> = {};
