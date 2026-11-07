import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import type { Command, CommandContext, CommandInvocation, ReplyPayload } from "../lib/command.js";
import { emoji } from "../lib/emoji.js";
import { errorEmbed, fmt } from "../lib/command.js";
import { addPoints, getBalance } from "../lib/economy.js";
import {
  AREAS,
  DAILY_ROLL_CAP,
  HUNT_COOLDOWN_MS,
  MONSTER_BY_ID,
  PET_BY_ID,
  ROLL10_COST,
  ROLL10_COUNT,
  ROLL_COST,
  TIER_INDEX,
  TIERS,
  WEAPON_BY_ID,
  attemptCatch,
  drawMonsterOfTier,
  encounterMonster,
  findArea,
  findMonsterByName,
  monsterEmoji,
  monstersInArea,
  petBuffText,
  petEmoji,
  pityTier,
  rollTier,
  sellPriceFor,
  shouldUsePity,
  tierAnnouncement,
  weaponEmoji,
  type Area,
  type Monster,
  type Tier,
} from "../lib/hunt.js";
import {
  fusedEffects,
  fuseUnlockText,
  huntReward,
  leveledStats,
} from "../lib/monsterLevels.js";
import {
  addMonsterXp,
  applyFuse,
  awardMonster,
  getFusePlan,
  getHuntState,
  getOwnedCount,
  getRollState,
  getUserInstances,
  getUserMonsters,
  getUserPets,
  getUserWeapons,
  grantPlayerXp,
  removeOneMonster,
  setHuntState,
  utcDayString,
  type AwardResult,
} from "../lib/huntDb.js";
import { findWorldArea, wildLevelForArea } from "../lib/world.js";
import { awardGuildXpBestEffort } from "../lib/guilds.js";
import { secureFloat } from "../lib/rng.js";

/**
 * Hunt world — Phase 1 commands (design docs/hunt-world-design.md):
 * `uwu hunt` / `uwu roll` / `uwu map` / `uwu zoo` / `uwu inv` / `uwu sell`.
 *
 * Plain-text OwO-style replies everywhere, like the rest of the bot.
 * Errors use the small red errorEmbed (existing pattern). The ONLY
 * embed in this module is the Mythic/UwU special announcement embed —
 * the one embed exception the design allows (design §1.1).
 *
 * NOTE: hunt/roll catches grant XP + gold that scale with the caught
 * monster's level (Phase 2 §6.3, huntReward in monsterLevels.ts).
 * NOTE: rolls award monsters only. Weapons/pets exist in the catalogue
 * but have no acquisition path in Phase 1 (no weapon/pet rolls), so
 * `uwu inv` starts empty for everyone.
 */

type Inv = CommandInvocation;

async function replyError(inv: Inv, message: string): Promise<void> {
  await inv.reply({ embeds: [errorEmbed(message).toJSON()], ephemeral: true });
}

function monsterLine(m: Monster, level?: number, fuseLevel?: number): string {
  const tag =
    level !== undefined ? ` · Lv ${level}${fuseLevel ? ` +${fuseLevel}` : ""}` : "";
  return `${monsterEmoji(m)} ${m.name} (${m.tier})${tag}`;
}

function monsterStatsLine(m: Monster, level = 1, fuseLevel = 0): string {
  const s = leveledStats(m, level, fuseLevel);
  const effects = fusedEffects(m, fuseLevel);
  const effectText = effects.length > 0 ? ` — ${m.move} (${effects.join(", ")})` : ` — ${m.move}`;
  return `HP ${s.hp} · ATK ${s.atk} · DEF ${s.def}${effectText}`;
}

/** "in 2 days", "in 5h", "in 30m" — for spawn-cooldown messages. */
function fmtCooldownIn(ms: number): string {
  const totalMin = Math.max(1, Math.ceil(ms / 60_000));
  if (totalMin < 60) return `in ${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)} days`;
}

// ---------------------------------------------------------------------------
// Announcements (design §1.1). Legendary = server-wide plain text.
// Mythic = server-wide + special embed. UwU = server-wide + embed.
// Phase 2 §1.2: the UwU cap is 1 per server AT A TIME (not 1 ever) with
// a 14-day global spawn cooldown — the copy says so. (True bot-wide
// broadcast to OTHER guilds needs client access in commands — not wired;
// the catching server still gets the full announcement.)
// ---------------------------------------------------------------------------

interface AnnounceTarget {
  followUp(payload: ReplyPayload): Promise<void>;
}

function mythicEmbed(monster: Monster, userId: string): EmbedBuilder {
  const color = monster.tier === "UwU" ? 0xf472b6 : 0xec4899;
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${monster.tier === "UwU" ? "🌈 UwU-tier!" : "🌟 Mythic!"}`)
    .setDescription(
      `<@${userId}> caught ${monsterEmoji(monster)} **${monster.name}**!\n${monsterStatsLine(monster)}`,
    )
    .setFooter({ text: monster.tier === "UwU" ? "One at a time per server — the next UwU can appear in 14 days." : "Limited to 3 copies per server." });
}

async function announceCatch(target: AnnounceTarget, monster: Monster, userId: string): Promise<void> {
  const kind = tierAnnouncement(monster.tier);
  if (kind === "none") return;
  try {
    if (kind === "server") {
      await target.followUp({
        content: `📣 <@${userId}> caught a Legendary — ${monsterLine(monster)}!`,
      });
    } else if (kind === "server-embed") {
      await target.followUp({
        content: `📣 <@${userId}> caught a Mythic — ${monsterLine(monster)}!`,
        embeds: [mythicEmbed(monster, userId).toJSON()],
      });
    } else {
      await target.followUp({
        content: `🌈 <@${userId}> pulled ${monsterLine(monster)} — the UwU-tier monster! Only one at a time in this server — the next one can appear in 14 days.`,
        embeds: [mythicEmbed(monster, userId).toJSON()],
      });
    }
  } catch {
    /* announcements are best-effort — a failed one never breaks the catch */
  }
}

// ---------------------------------------------------------------------------
// Hunt encounters (in-memory, like the casino's open games). An encounter
// is only a pending button press — the real state (zoo, caps, pity) is
// all in Supabase, so a redeploy stranding an encounter just makes its
// buttons say "expired", same as an open blackjack hand.
// ---------------------------------------------------------------------------

interface HuntEncounter {
  id: string;
  guildId: string;
  userId: string;
  monster: Monster;
  areaId: string;
  /** Wild level rolled for this encounter (Phase 2 §6.1, by area). */
  level: number;
  createdAt: number;
}

const huntEncounters = new Map<string, HuntEncounter>();
const ENCOUNTER_TTL_MS = 5 * 60_000;

/** Clear all pending encounters (tests / restarts). */
export function resetHuntEncounters(): void {
  huntEncounters.clear();
}

function storeEncounter(enc: HuntEncounter): void {
  // Prune stale encounters and keep the map bounded.
  const now = Date.now();
  for (const [id, e] of huntEncounters) {
    if (now - e.createdAt > ENCOUNTER_TTL_MS) huntEncounters.delete(id);
  }
  if (huntEncounters.size > 200) {
    const oldest = [...huntEncounters.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) huntEncounters.delete(oldest[0]);
  }
  huntEncounters.set(enc.id, enc);
}

function huntButtons(encounterId: string): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`selena:hunt:catch:${encounterId}`).setLabel("Catch").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`selena:hunt:run:${encounterId}`).setLabel("Run").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function huntText(area: Area, monster: Monster, level: number): string {
  return (
    `You wander into the ${area.name}...\n` +
    `A wild ${monsterLine(monster, level)} appeared!\n` +
    `${monsterStatsLine(monster, level)}`
  );
}

async function handleHuntButton(inv: any, ctx: CommandContext): Promise<void> {
  const parts = String(inv.customId ?? "").split(":");
  const action = parts[2] ?? "";
  // Catch / Run: parts = selena:hunt:<action>:<encounterId>
  // Sell confirm / cancel: selena:hunt:<action>:<userId>:<monsterId>
  if (action === "sell-confirm" || action === "sell-cancel") {
    await handleSellButton(inv, ctx, parts);
    return;
  }
  const encId = parts[3] ?? "";
  const enc = huntEncounters.get(encId);
  if (!enc) {
    await inv.reply({ content: "This hunt has expired — go `uwu hunt` for a new one.", ephemeral: true });
    return;
  }
  if (inv.user?.id !== enc.userId) {
    await inv.reply({ content: "Only the hunter who started this hunt can use these buttons.", ephemeral: true });
    return;
  }
  if (action !== "catch" && action !== "run") {
    await inv.reply({ content: "Unknown hunt action.", ephemeral: true });
    return;
  }
  await inv.deferUpdate();
  huntEncounters.delete(encId);
  const area = AREAS.find((a) => a.id === enc.areaId) ?? AREAS[0]!;
  if (action === "run") {
    await inv.editReply({
      content: `You ran away from the ${monsterLine(enc.monster)}...`,
      components: [],
    });
    return;
  }
  // Catch: roll the tier's catch rate.
  if (!attemptCatch(enc.monster.tier, secureFloat)) {
    await inv.editReply({
      content: `It slipped away... ${monsterEmoji(enc.monster)} ${enc.monster.name} fled back into the ${area.name}. (30s cooldown)`,
      components: [],
    });
    return;
  }
  // Caught — award with the per-guild cap check + global spawn
  // cooldown (fail closed: a failed count/cooldown query refuses the
  // award instead of granting a capped/resting monster). The catch also
  // pays XP + gold scaled to the monster's level (Phase 2 §6.3): the
  // same XP goes to the player and to the caught monster instance.
  const nowMs = Date.now();
  let awarded: AwardResult & {
    reward: { xp: number; coins: number };
    playerLeveledUp: boolean;
    playerLevel: number;
    monsterLevelsGained: number;
    monsterLevel: number;
    balance: number;
  };
  try {
    awarded = await ctx.db.transaction(async (tx) => {
      const res = await awardMonster(
        tx,
        enc.guildId,
        enc.userId,
        enc.monster.tier,
        "hunt",
        (t) => (t === enc.monster.tier ? enc.monster : drawMonsterOfTier(t, secureFloat)),
        nowMs,
        enc.level,
      );
      const reward = huntReward(res.level, secureFloat);
      const playerXp = await grantPlayerXp(tx, enc.guildId, enc.userId, reward.xp);
      const balance = await addPoints(tx, enc.guildId, enc.userId, reward.coins, `hunt ${res.monster.name}`);
      const monXp = await addMonsterXp(tx, res.instanceId, reward.xp);
      return {
        ...res,
        reward,
        playerLeveledUp: playerXp.leveledUp,
        playerLevel: playerXp.level,
        monsterLevelsGained: monXp.levelsGained,
        monsterLevel: monXp.level,
        balance,
      };
    });
  } catch (e) {
    console.error("uwu: hunt award failed:", e instanceof Error ? e.message : e);
    await inv.editReply({
      content: `You caught the ${monsterLine(enc.monster)} — but something went wrong saving it. Try \`uwu zoo\` to check, or hunt again.`,
      components: [],
    });
    return;
  }
  // Guild XP (Phase 2 §3.2): 10 per hunt catch, best-effort — the catch
  // already succeeded, so this never throws into the reply.
  await awardGuildXpBestEffort(ctx.db, enc.userId, 10);
  const capNote =
    awarded.downgradedFrom !== null && awarded.downgradedReason === "cap"
      ? ` (the ${awarded.downgradedFrom} you found is maxed out in this server, so you got this one instead)`
      : awarded.downgradedFrom !== null && awarded.downgradedReason === "cooldown"
        ? ` (the ${awarded.downgradedFrom} you found is resting — it will return ${fmtCooldownIn((awarded.cooldownAvailableAt ?? nowMs) - nowMs)}, so you got this one instead)`
        : "";
  const levelNote =
    awarded.monsterLevelsGained > 0 ? ` ${awarded.monster.name} reached Lv ${awarded.monsterLevel}!` : "";
  const playerNote = awarded.playerLeveledUp ? ` You reached level ${awarded.playerLevel}!` : "";
  await inv.editReply({
    content:
      `Caught it! ${monsterLine(awarded.monster, awarded.level)} joined your zoo.${capNote}\n` +
      `+${awarded.reward.xp} XP, +${awarded.reward.coins} gold (balance: ${fmt(awarded.balance)} gold).${levelNote}${playerNote}`,
    components: [],
  });
  await announceCatch(inv, awarded.monster, enc.userId);
}

async function handleSellButton(inv: any, ctx: CommandContext, parts: string[]): Promise<void> {
  const action = parts[2] ?? "";
  const ownerId = parts[3] ?? "";
  const monsterId = Number(parts[4] ?? 0);
  const monster = MONSTER_BY_ID.get(monsterId);
  if (!monster) {
    await inv.reply({ content: "That monster doesn't exist anymore.", ephemeral: true });
    return;
  }
  if (inv.user?.id !== ownerId) {
    await inv.reply({ content: "Only the owner can sell this monster.", ephemeral: true });
    return;
  }
  await inv.deferUpdate();
  if (action === "sell-cancel") {
    await inv.editReply({ content: `Okay, keeping your ${monsterLine(monster)}.`, components: [] });
    return;
  }
  // Confirm: sell one copy (re-check ownership — it may have changed).
  const owned = await getOwnedCount(ctx.db, ctx.guildId, ownerId, monster.id);
  if (owned <= 0) {
    await inv.editReply({ content: `You don't own any ${monsterLine(monster)} anymore.`, components: [] });
    return;
  }
  const price = sellPriceFor(monster.tier);
  const balance = await ctx.db.transaction(async (tx) => {
    await removeOneMonster(tx, ctx.guildId, ownerId, monster.id);
    return await addPoints(tx, ctx.guildId, ownerId, price, `sell ${monster.name}`);
  });
  await inv.editReply({
    content: `Sold your only ${monsterLine(monster)} for ${emoji("gold")} ${fmt(price)} gold! Balance: ${fmt(balance)} gold.`,
    components: [],
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const commands: Command[] = [
  {
    name: "hunt",
    description: "Go hunting for monsters in your current area (30s cooldown).",
    aliases: ["catch"],
    args: [{ name: "area", type: "string", rest: true }],
    async execute(inv, ctx) {
      const now = Date.now();
      const areaInput = inv.options.getString("area");
      let area: Area | undefined;
      if (areaInput) {
        area = findArea(areaInput);
        if (!area) {
          await replyError(inv, `No area called "${areaInput}" — try \`uwu map\` to see the areas.`);
          return;
        }
      } else {
        const state = await getHuntState(ctx.db, ctx.guildId, inv.user.id);
        area = (state.currentArea ? findArea(state.currentArea) : undefined) ?? AREAS[0]!;
      }
      const bal = await getBalance(ctx.db, ctx.guildId, inv.user.id);
      if (bal.level < area.unlockLevel) {
        await replyError(
          inv,
          `🔒 ${area.name} unlocks at level ${area.unlockLevel} — you're level ${bal.level}. Keep chatting to gain XP!`,
        );
        return;
      }
      const state = await getHuntState(ctx.db, ctx.guildId, inv.user.id);
      if (state.lastHuntAt !== null && now - state.lastHuntAt < HUNT_COOLDOWN_MS) {
        const wait = Math.ceil((HUNT_COOLDOWN_MS - (now - state.lastHuntAt)) / 1000);
        await replyError(inv, `You're still catching your breath — try again in ${wait}s.`);
        return;
      }
      await setHuntState(ctx.db, ctx.guildId, inv.user.id, now, area.id);
      const monster = encounterMonster(area, secureFloat);
      // Wild level for the area (Phase 2 §6.1 — Meadow 1–5, Woods 5–15,
      // Peaks 10–25, Hollow 15–40). The caught instance spawns at it.
      const worldArea = findWorldArea(area.id);
      const level = worldArea ? wildLevelForArea(worldArea, secureFloat) : 1;
      const id = `${Date.now().toString(36)}-${Math.floor(secureFloat() * 1e9).toString(36)}`;
      storeEncounter({ id, guildId: ctx.guildId, userId: inv.user.id, monster, areaId: area.id, level, createdAt: now });
      await inv.reply({ content: huntText(area, monster, level), components: huntButtons(id) });
    },
  },
  {
    name: "roll",
    description: "Roll the gacha for a monster — 500 gold, or 10 rolls for 4,500.",
    aliases: ["gacha", "summon"],
    args: [{ name: "count", type: "integer" }],
    async execute(inv, ctx) {
      const countRaw = inv.options.getInteger("count");
      const count = countRaw ?? 1;
      if (count !== 1 && count !== ROLL10_COUNT) {
        await replyError(inv, "Use `uwu roll` for one pull or `uwu roll 10` for ten.");
        return;
      }
      const cost = count === ROLL10_COUNT ? ROLL10_COST : ROLL_COST;
      const now = Date.now();
      const today = utcDayString(now);
      const bal = await getBalance(ctx.db, ctx.guildId, inv.user.id);
      if (bal.points < cost) {
        await replyError(
          inv,
          `You need ${emoji("gold")} ${fmt(cost)} gold to roll ${count === 10 ? "10 times" : "once"} — you have ${fmt(bal.points)} gold.`,
        );
        return;
      }
      const preState = await getRollState(ctx.db, ctx.guildId, inv.user.id);
      const preToday = preState.rollDay === today ? preState.rollsToday : 0;
      if (preToday + count > DAILY_ROLL_CAP) {
        await replyError(
          inv,
          `Daily roll cap: you've used ${preToday}/${DAILY_ROLL_CAP} rolls today — you can roll ${DAILY_ROLL_CAP - preToday} more.`,
        );
        return;
      }
      // The whole roll is one transaction: gold out, pulls + pity +
      // daily counts in. A failure anywhere rolls everything back.
      // Each pull also pays XP + gold scaled to the pulled monster's
      // level (Phase 2 §6.3 — rolled monsters spawn at level 1).
      let pulls: { monster: Monster; tier: Tier; pity: boolean; downgradedFrom: Tier | null }[];
      let rewardTotals: { xp: number; coins: number };
      try {
        const out = await ctx.db.transaction(async (tx) => {
          // Atomic re-check of the daily cap inside the transaction.
          const st0 = await getRollState(tx, ctx.guildId, inv.user.id);
          const today0 = st0.rollDay === today ? st0.rollsToday : 0;
          if (today0 + count > DAILY_ROLL_CAP) throw new Error("Daily roll cap reached");
          await addPoints(tx, ctx.guildId, inv.user.id, -cost, count === 10 ? "roll10" : "roll");
          let sinceEpic = st0.rollsSinceEpic;
          let totalXp = 0;
          let totalCoins = 0;
          const results: { monster: Monster; tier: Tier; pity: boolean; downgradedFrom: Tier | null }[] = [];
          for (let i = 0; i < count; i++) {
            const pity = shouldUsePity(sinceEpic);
            const tier = pity ? pityTier(secureFloat) : rollTier(secureFloat);
            const awarded = await awardMonster(
              tx,
              ctx.guildId,
              inv.user.id,
              tier,
              "roll",
              (t) => drawMonsterOfTier(t, secureFloat),
              now,
            );
            // Pity is Epic EXACTLY (Phase 1 §1.2 / §9 rule 9, Phase 2
            // §7.1): a pity pull can never be Legendary+. The reward
            // below is for the monster actually awarded.
            const reward = huntReward(awarded.level, secureFloat);
            await grantPlayerXp(tx, ctx.guildId, inv.user.id, reward.xp);
            await addPoints(tx, ctx.guildId, inv.user.id, reward.coins, `roll ${awarded.monster.name}`);
            await addMonsterXp(tx, awarded.instanceId, reward.xp);
            totalXp += reward.xp;
            totalCoins += reward.coins;
            if (TIER_INDEX[awarded.monster.tier] >= TIER_INDEX.Epic) sinceEpic = 0;
            else sinceEpic += 1;
            results.push({ monster: awarded.monster, tier, pity, downgradedFrom: awarded.downgradedFrom });
          }
          await tx
            .prepare(
              "INSERT INTO user_roll (guild_id, user_id, rolls_since_epic, rolls_today, roll_day) VALUES (?, ?, ?, ?, ?) " +
                "ON CONFLICT (guild_id, user_id) DO UPDATE SET rolls_since_epic = EXCLUDED.rolls_since_epic, rolls_today = EXCLUDED.rolls_today, roll_day = EXCLUDED.roll_day",
            )
            .run(ctx.guildId, inv.user.id, sinceEpic, today0 + count, today);
          return { results, totals: { xp: totalXp, coins: totalCoins } };
        });
        pulls = out.results;
        rewardTotals = out.totals;
      } catch (e) {
        if (e instanceof Error && (e.message === "Insufficient gold" || e.message === "Daily roll cap reached")) {
          await replyError(
            inv,
            e.message === "Insufficient gold"
              ? `Not enough gold — you need ${emoji("gold")} ${fmt(cost)} gold for this roll.`
              : "Daily roll cap reached — come back tomorrow.",
          );
          return;
        }
        throw e;
      }
      const newBal = await getBalance(ctx.db, ctx.guildId, inv.user.id);
      // Guild XP (Phase 2 §3.2): 10 per roll pull, best-effort.
      await awardGuildXpBestEffort(ctx.db, inv.user.id, 10 * count);
      const lines = pulls.map((p, i) => {
        const mark = TIER_INDEX[p.monster.tier] >= TIER_INDEX.Epic ? "✨ " : "";
        const pityNote = p.pity ? " (pity!)" : "";
        const capNote =
          p.downgradedFrom !== null
            ? ` — the ${p.downgradedFrom} was maxed out in this server, so you got this instead`
            : "";
        return `${i + 1}. ${mark}${monsterLine(p.monster)}${pityNote}${capNote}`;
      });
      const rollsToday = preToday + count;
      await inv.reply({
        content:
          `🎰 Roll ×${count} — ${emoji("gold")} ${fmt(cost)} gold\n` +
          `${lines.join("\n")}\n` +
          `+${rewardTotals.xp} XP, +${rewardTotals.coins} gold from your catches\n` +
          `Balance: ${fmt(newBal.points)} gold · Rolls today: ${rollsToday}/${DAILY_ROLL_CAP}`,
      });
      // Announcements for Legendary+ pulls (one message per pull).
      for (const p of pulls) {
        await announceCatch(inv, p.monster, inv.user.id);
      }
    },
  },
  {
    name: "fuse",
    description: "Fuse 2 copies of a monster into 1 stronger one (up to +6).",
    aliases: ["combine"],
    args: [{ name: "monster", type: "string", rest: true, required: true }],
    async execute(inv, ctx) {
      const name = inv.options.getString("monster");
      if (!name) {
        await replyError(inv, "Tell me which monster to fuse: `uwu fuse <name>`.");
        return;
      }
      const monster = findMonsterByName(name);
      if (!monster) {
        await replyError(inv, `No monster called "${name}" — check the name with \`uwu zoo\`.`);
        return;
      }
      const now = Date.now();
      // Fail-closed: the plan check refuses when there aren't 2 copies
      // or the best copy is already +6 — before any gold moves.
      const plan = await getFusePlan(ctx.db, ctx.guildId, inv.user.id, monster.id, now);
      if (!plan.ok || plan.cost === undefined) {
        await replyError(inv, plan.error ?? "You can't fuse that monster.");
        return;
      }
      const bal = await getBalance(ctx.db, ctx.guildId, inv.user.id);
      if (bal.points < plan.cost) {
        await replyError(
          inv,
          `Fusing ${monsterLine(monster)} costs ${emoji("gold")} ${fmt(plan.cost)} gold — you have ${fmt(bal.points)} gold.`,
        );
        return;
      }
      // One transaction: gold out + fuse. A failure anywhere (including
      // a race that leaves fewer than 2 copies) rolls everything back.
      let fused: { newFuseLevel: number; newLevel: number };
      try {
        fused = await ctx.db.transaction(async (tx) => {
          await addPoints(tx, ctx.guildId, inv.user.id, -plan.cost!, `fuse ${monster.name}`);
          return await applyFuse(tx, ctx.guildId, inv.user.id, monster.id, now);
        });
      } catch (e) {
        if (e instanceof Error && e.message === "Insufficient gold") {
          await replyError(inv, `Not enough gold — fusing ${monsterLine(monster)} costs ${emoji("gold")} ${fmt(plan.cost)} gold.`);
          return;
        }
        throw e;
      }
      const remaining = await getOwnedCount(ctx.db, ctx.guildId, inv.user.id, monster.id);
      const stats = leveledStats(monster, fused.newLevel, fused.newFuseLevel);
      const effects = fusedEffects(monster, fused.newFuseLevel);
      await inv.reply({
        content:
          `🔥 Fused! ${monsterLine(monster, fused.newLevel, fused.newFuseLevel)} — one copy consumed, ${remaining} left.\n` +
          `HP ${stats.hp} · ATK ${stats.atk} · DEF ${stats.def} — ${monster.move} (${effects.join(", ") || "no effect"})\n` +
          `Unlocked: ${fuseUnlockText(fused.newFuseLevel)} · Cost: ${emoji("gold")} ${fmt(plan.cost)} gold`,
      });
    },
  },
  {
    name: "zoo",
    description: "Show your caught monsters, or detail on one monster.",
    aliases: ["monsters"],
    args: [{ name: "name", type: "string", rest: true }],
    async execute(inv, ctx) {
      const name = inv.options.getString("name");
      const owned = await getUserMonsters(ctx.db, ctx.guildId, inv.user.id);
      if (name) {
        const monster = findMonsterByName(name);
        if (!monster) {
          await replyError(inv, `No monster called "${name}" — check the name with \`uwu zoo\`.`);
          return;
        }
        const entry = owned.find((o) => o.monster.id === monster.id);
        if (!entry) {
          await replyError(inv, `You haven't caught ${monsterLine(monster)} yet — go \`uwu hunt\` or \`uwu roll\`!`);
          return;
        }
        const area = AREAS.find((a) => a.id === { M: "meadow", W: "woods", P: "peaks", H: "hollow" }[monster.area])!;
        const instances = await getUserInstances(ctx.db, ctx.guildId, inv.user.id, monster.id);
        const best = instances[0];
        const detailLines = instances.map((inst, i) => {
          const s = leveledStats(monster, inst.level, inst.fuseLevel);
          const fx = fusedEffects(monster, inst.fuseLevel);
          const xpNeed = inst.level >= 100 ? "MAX" : `${inst.xp}/${100 * inst.level} XP`;
          return `${i + 1}. Lv ${inst.level}${inst.fuseLevel > 0 ? ` +${inst.fuseLevel}` : ""} · HP ${s.hp} · ATK ${s.atk} · DEF ${s.def} · ${xpNeed}${fx.length > 0 ? ` · ${fx.join(", ")}` : ""}`;
        });
        if (detailLines.length === 0) {
          // Caught before monster instances existed (pre-Phase-2 count
          // row, no instance row): the monster is Lv 1 until it earns XP.
          const s = leveledStats(monster, 1, 0);
          detailLines.push(`1. Lv 1 · HP ${s.hp} · ATK ${s.atk} · DEF ${s.def} · 0/100 XP`);
        }
        await inv.reply({
          content:
            `${monsterLine(monster, best?.level ?? 1, best?.fuseLevel ?? 0)} ×${entry.count}\n` +
            `Type ${monster.type} · ${monsterStatsLine(monster, best?.level ?? 1, best?.fuseLevel ?? 0)}\n` +
            `Found in: ${area.name} · Caught via ${entry.source}\n` +
            `${detailLines.join("\n")}`,
        });
        return;
      }
      if (owned.length === 0) {
        await inv.reply({ content: "Your zoo is empty — go `uwu hunt` or `uwu roll` to catch your first monster!" });
        return;
      }
      const total = owned.reduce((s, o) => s + o.count, 0);
      const allInstances = await getUserInstances(ctx.db, ctx.guildId, inv.user.id);
      const bestByMonster = new Map<number, { level: number; fuseLevel: number }>();
      for (const inst of allInstances) {
        if (!bestByMonster.has(inst.monsterId)) {
          bestByMonster.set(inst.monsterId, { level: inst.level, fuseLevel: inst.fuseLevel });
        }
      }
      const lines: string[] = [];
      for (const tier of ["Common", "Uncommon", "Rare", "Epic", "Legendary", "Mythic", "UwU"] as const) {
        const group = owned.filter((o) => o.monster.tier === tier);
        if (group.length === 0) continue;
        lines.push(`— ${tier} —`);
        for (const o of group) {
          const best = bestByMonster.get(o.monster.id);
          // No instance row (caught before instances existed) means Lv 1 —
          // every monster in the zoo shows a level, never a bare name.
          const tag = ` · Lv ${best?.level ?? 1}${best && best.fuseLevel > 0 ? ` +${best.fuseLevel}` : ""}`;
          lines.push(`${monsterEmoji(o.monster)} ${o.monster.name} ×${o.count}${tag}`);
        }
      }
      const MAX_LINES = 40;
      const shown = lines.slice(0, MAX_LINES);
      if (lines.length > MAX_LINES) shown.push(`…and ${lines.length - MAX_LINES} more lines — use \`uwu zoo <name>\` for one monster.`);
      await inv.reply({
        content: `🦁 Your zoo — ${fmt(total)} monsters (${owned.length} unique)\n${shown.join("\n")}`,
      });
    },
  },
  {
    name: "inv",
    description: "Show your weapons and pets.",
    aliases: ["inventory", "bag"],
    async execute(inv, ctx) {
      const weapons = await getUserWeapons(ctx.db, ctx.guildId, inv.user.id);
      const pets = await getUserPets(ctx.db, ctx.guildId, inv.user.id);
      const weaponLines = weapons.map((w) => {
        const def = WEAPON_BY_ID.get(w.weaponId);
        if (!def) return null;
        const effects = def.effects.length > 0 ? ` (${def.effects.join(", ")})` : "";
        return `${weaponEmoji(def)} ${def.name} (+${def.atk} ATK) ×${w.count}${w.equipped ? " — equipped" : ""}${effects}`;
      });
      const petLines = pets.map((p) => {
        const def = PET_BY_ID.get(p.petId);
        if (!def) return null;
        return `${petEmoji(def)} ${def.name} (${def.tier}) — ${petBuffText(def)} ×${p.count}${p.active ? " — following you" : ""}`;
      });
      const weaponText = weaponLines.filter(Boolean).join("\n") || "No weapons yet.";
      const petText = petLines.filter(Boolean).join("\n") || "No pets yet.";
      await inv.reply({
        content: `🎒 Inventory\n— Weapons —\n${weaponText}\n— Pets —\n${petText}`,
      });
    },
  },
  {
    name: "sell",
    description: "Sell a monster from your zoo for gold.",
    aliases: ["selldup"],
    args: [{ name: "monster", type: "string", rest: true, required: true }],
    async execute(inv, ctx) {
      const name = inv.options.getString("monster");
      if (!name) {
        await replyError(inv, "Tell me which monster to sell: `uwu sell <name>`.");
        return;
      }
      const monster = findMonsterByName(name);
      if (!monster) {
        await replyError(inv, `No monster called "${name}" — check the name with \`uwu zoo\`.`);
        return;
      }
      const owned = await getOwnedCount(ctx.db, ctx.guildId, inv.user.id, monster.id);
      if (owned <= 0) {
        await replyError(inv, `You don't own any ${monsterLine(monster)}.`);
        return;
      }
      const price = sellPriceFor(monster.tier);
      if (owned === 1) {
        // Last copy — confirm first (design §2.4): never silently delete
        // a user's only copy.
        await inv.reply({
          content: `That's your only ${monsterLine(monster)} — sell it for ${emoji("gold")} ${fmt(price)} gold?`,
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`selena:hunt:sell-confirm:${inv.user.id}:${monster.id}`)
                .setLabel("Sell it")
                .setStyle(ButtonStyle.Danger),
              new ButtonBuilder()
                .setCustomId(`selena:hunt:sell-cancel:${inv.user.id}:${monster.id}`)
                .setLabel("Keep it")
                .setStyle(ButtonStyle.Secondary),
            ),
          ],
        });
        return;
      }
      const balance = await ctx.db.transaction(async (tx) => {
        await removeOneMonster(tx, ctx.guildId, inv.user.id, monster.id);
        return await addPoints(tx, ctx.guildId, inv.user.id, price, `sell ${monster.name}`);
      });
      await inv.reply({
        content: `Sold ${monsterLine(monster)} for ${emoji("gold")} ${fmt(price)} gold! You have ${owned - 1} left. Balance: ${fmt(balance)} gold.`,
      });
    },
  },
];

export const buttonHandlers: Record<string, (inv: any, ctx: CommandContext) => Promise<void>> = {
  "selena:hunt": handleHuntButton,
};

export const modalHandlers: Record<string, (...args: never[]) => Promise<void>> = {};
