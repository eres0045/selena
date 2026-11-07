import { addPoints, getBalance } from "./economy.js";
import { WEAPON_BY_ID, type Monster } from "./hunt.js";
import { getUserMonsters, getUserWeapons } from "./huntDb.js";
import { levelFromXp } from "./levels.js";
import {
  battleWinXp,
  leveledStats,
  MONSTER_LEVEL_CAP,
  monsterXpForLevel,
  powerBudgetOf,
} from "./monsterLevels.js";
import type { SelenaDb } from "./db.js";

/**
 * 1v1 monster battles (Phase 2, design docs/hunt-world-phase2-design.md §5).
 *
 * Turn-based auto-battle: each side fields its 3 strongest zoo monsters
 * by power budget (design §5.2, auto-pick working default — §12 item 9).
 * Highest-ATK monster acts first each round; damage per the Phase 1
 * formula (max(1, ATK − DEF÷2), crit 1.5×, base crit 10%); all 15
 * status effects apply with their Phase 1 trigger chances, durations
 * and counters (design docs/hunt-world-design.md §4), plus the Phase 1
 * balance rules: max 2 effects per target, no control chains, DoT cap
 * 12%/turn (§3.3 rules 4–7). Monster levels scale stats +2%/level
 * (monsterLevels.ts); the equipped weapon's ATK bonus + effects back
 * whichever of your monsters is currently fighting (working default —
 * the Phase 1 doc says a weapon applies to your battles, §2.5, but
 * never says which monster; the active one is the only sane reading).
 *
 * The engine is pure + deterministic given an injected `rand`, so
 * tests drive exact outcomes with mulberry32. All persistence lives
 * in Supabase (battle_challenges + user_battle tables, created by
 * db.ts SCHEMA) — never in-memory.
 */

// ---------------------------------------------------------------------------
// Locked numbers (design §5)
// ---------------------------------------------------------------------------

/** A challenge lives 60s; no answer = it expires, no penalty. */
export const BATTLE_CHALLENGE_TTL_MS = 60_000;
/** 1 minute between battles per player (either side). */
export const BATTLE_COOLDOWN_MS = 60_000;
/** Winner / loser gold (design §5.3). No gold is ever lost. */
export const BATTLE_WIN_GOLD = 100;
export const BATTLE_LOSE_GOLD = 25;
/** Optional wager cap per player per battle (design §5.3). */
export const WAGER_CAP = 1_000;
/** Safety valve: a battle that cannot end (two unkillable walls) is
 * decided on remaining HP instead of running forever. */
export const MAX_BATTLE_ROUNDS = 100;
/** Base crit chance (design §3.1) + Crit Up bonus (design §4.4). */
export const BASE_CRIT_CHANCE = 0.1;
export const CRIT_UP_BONUS = 0.25;

// ---------------------------------------------------------------------------
// Status effects (design docs/hunt-world-design.md §4 — exact numbers)
// ---------------------------------------------------------------------------

export type EffectName =
  | "Burn"
  | "Poison"
  | "Bleed"
  | "Stun"
  | "Freeze"
  | "Paralyze"
  | "Sleep"
  | "Confuse"
  | "Attack Down"
  | "Defense Down"
  | "Regen"
  | "Lifesteal"
  | "Shield"
  | "Crit Up"
  | "Evasion Up";

export const DOT_EFFECTS: readonly EffectName[] = ["Burn", "Poison", "Bleed"];
export const CONTROL_EFFECTS: readonly EffectName[] = ["Stun", "Freeze", "Paralyze", "Sleep", "Confuse"];
export const DEBUFF_EFFECTS: readonly EffectName[] = ["Attack Down", "Defense Down"];
export const BUFF_EFFECTS: readonly EffectName[] = ["Regen", "Lifesteal", "Shield", "Crit Up", "Evasion Up"];

/** DoT damage, % of max HP per turn (Burn 5 / Poison 4 / Bleed 3). */
export const DOT_PCT: Record<string, number> = { Burn: 5, Poison: 4, Bleed: 3 };

/** On-hit trigger chance, % (design §4). Buffs trigger on use (100%). */
export const TRIGGER_CHANCE: Record<string, number> = {
  Burn: 25,
  Poison: 30,
  Bleed: 25,
  Stun: 15,
  Freeze: 12,
  Paralyze: 20,
  Sleep: 15,
  Confuse: 20,
  "Attack Down": 35,
  "Defense Down": 30,
};

/** Duration in turns (design §4). */
export const EFFECT_DURATION: Record<string, number> = {
  Burn: 3,
  Poison: 4,
  Bleed: 3,
  Stun: 1,
  Freeze: 2,
  Paralyze: 2,
  Sleep: 2,
  Confuse: 2,
  "Attack Down": 3,
  "Defense Down": 3,
  Regen: 3,
  Lifesteal: 3,
  Shield: 2,
  "Crit Up": 3,
  "Evasion Up": 2,
};

/**
 * On-hit trigger chance for one effect, with the fusion bonus
 * (design §6.4: +10pp at fuse +2, another +10pp at +4).
 */
export function triggerChanceFor(effect: string, fuseLevel: number): number {
  const base = TRIGGER_CHANCE[effect] ?? 0;
  const bonus = (fuseLevel >= 2 ? 10 : 0) + (fuseLevel >= 4 ? 10 : 0);
  return Math.min(100, base + bonus);
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export interface TeamMemberInput {
  monster: Monster;
  level: number;
  fuseLevel?: number;
}

/** Top 3 by power budget (leveled + fused), strongest first. */
export function pickTeam(members: readonly TeamMemberInput[]): TeamMemberInput[] {
  return [...members]
    .sort(
      (a, b) =>
        powerBudgetOf(b.monster, b.level, b.fuseLevel ?? 0) -
        powerBudgetOf(a.monster, a.level, a.fuseLevel ?? 0),
    )
    .slice(0, 3);
}

/** One line for a team member, as shown in challenge / result text. */
export function teamLine(m: TeamMemberInput): string {
  const fuse = (m.fuseLevel ?? 0) > 0 ? ` +${m.fuseLevel}` : "";
  return `${m.monster.name} · Lv ${m.level} · ${m.monster.tier}${fuse}`;
}

// ---------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------

export interface ActiveEffect {
  name: EffectName;
  turnsLeft: number;
  /** Shield absorb pool (20% max HP at application); 0 otherwise. */
  shieldHp: number;
}

export interface BattleFighter {
  monster: Monster;
  level: number;
  fuseLevel: number;
  ownerId: string;
  ownerName: string;
  maxHp: number;
  hp: number;
  atk: number;
  def: number;
  power: number;
  effects: ActiveEffect[];
  /** Turns of immunity to control effects after Stun/Freeze/Sleep ends
   * (design §3.3 rule 5). Decremented at the end of the bearer's turn. */
  controlImmuneTurns: number;
}

export interface BattleSideInput {
  ownerId: string;
  ownerName: string;
  team: readonly TeamMemberInput[];
  /** Equipped weapon ATK bonus (backs the active monster). */
  weaponAtk?: number;
  /** Equipped weapon on-hit effects (back the active monster). */
  weaponEffects?: readonly string[];
}

interface SideState {
  ownerId: string;
  ownerName: string;
  fighters: BattleFighter[];
  weaponAtk: number;
  weaponEffects: readonly string[];
}

export interface BattleRoundLog {
  n: number;
  lines: string[];
  /** Standings snapshot after the round, for the replay display. */
  aLine: string;
  bLine: string;
}

export interface BattleResult {
  winner: "A" | "B" | "draw";
  rounds: BattleRoundLog[];
  /** Flat log (all round lines, in order). */
  log: string[];
  roundsFought: number;
  finalBlow: { attackerName: string; move: string; targetName: string } | null;
  aRemainingHp: number;
  bRemainingHp: number;
}

function fighterName(f: BattleFighter): string {
  return f.monster.name;
}

function makeFighter(
  m: TeamMemberInput,
  ownerId: string,
  ownerName: string,
): BattleFighter {
  // leveledStats is imported via monsterLevels — see buildSide below.
  return {
    monster: m.monster,
    level: m.level,
    fuseLevel: m.fuseLevel ?? 0,
    ownerId,
    ownerName,
    maxHp: 0,
    hp: 0,
    atk: 0,
    def: 0,
    power: powerBudgetOf(m.monster, m.level, m.fuseLevel ?? 0),
    effects: [],
    controlImmuneTurns: 0,
  };
}

function hasEffect(f: BattleFighter, name: EffectName): boolean {
  return f.effects.some((e) => e.name === name);
}

function getEffect(f: BattleFighter, name: EffectName): ActiveEffect | undefined {
  return f.effects.find((e) => e.name === name);
}

/**
 * Remove one effect. When a control effect (Stun/Freeze/Sleep) ends for
 * any reason, the target is immune to all control effects for 1 turn
 * (design §3.3 rule 5).
 */
function removeEffect(f: BattleFighter, name: EffectName): boolean {
  const i = f.effects.findIndex((e) => e.name === name);
  if (i < 0) return false;
  f.effects.splice(i, 1);
  if (name === "Stun" || name === "Freeze" || name === "Sleep") {
    f.controlImmuneTurns = 1;
  }
  return true;
}

/**
 * Apply an effect to a target. Re-applying the same effect refreshes
 * its duration (never stacks). Max 2 effects per target — a third
 * replaces the oldest (design §3.3 rule 4). Returns false when the
 * effect could not apply (control immunity, Stun on a controlled
 * target, Shield blocking Defense Down).
 */
function applyEffect(f: BattleFighter, name: EffectName, log: string[]): boolean {
  const existing = getEffect(f, name);
  if (existing) {
    existing.turnsLeft = EFFECT_DURATION[name] ?? 1;
    if (name === "Shield") existing.shieldHp = Math.max(1, Math.floor(f.maxHp * 0.2));
    return true;
  }
  if ((CONTROL_EFFECTS as readonly string[]).includes(name)) {
    if (f.controlImmuneTurns > 0) return false;
    if (name === "Stun" && f.effects.some((e) => (CONTROL_EFFECTS as readonly string[]).includes(e.name))) {
      return false; // Stun never triggers on a target with a control effect.
    }
  }
  if (name === "Defense Down" && hasEffect(f, "Shield")) {
    return false; // A Shield blocks Defense Down from applying.
  }
  if (f.effects.length >= 2) {
    const oldest = f.effects.shift()!;
    if (oldest.name === "Stun" || oldest.name === "Freeze" || oldest.name === "Sleep") {
      f.controlImmuneTurns = 1;
    }
    log.push(`(${oldest.name} on ${fighterName(f)} wore off to make room.)`);
  }
  f.effects.push({
    name,
    turnsLeft: EFFECT_DURATION[name] ?? 1,
    shieldHp: name === "Shield" ? Math.max(1, Math.floor(f.maxHp * 0.2)) : 0,
  });
  return true;
}

/** Effective ATK after Bleed (−10%), Attack Down (−25%), Paralyze acting (+10%). */
function effAtk(f: BattleFighter, paralyzeBoost: boolean): number {
  let mult = 1;
  if (hasEffect(f, "Bleed")) mult *= 0.9;
  if (hasEffect(f, "Attack Down")) mult *= 0.75;
  if (paralyzeBoost) mult *= 1.1;
  return Math.max(1, Math.floor(f.atk * mult));
}

/** Effective DEF after Freeze (−20%) and Defense Down (−30%). */
function effDef(f: BattleFighter): number {
  let mult = 1;
  if (hasEffect(f, "Freeze")) mult *= 0.8;
  if (hasEffect(f, "Defense Down")) mult *= 0.7;
  return Math.max(1, Math.floor(f.def * mult));
}

/**
 * Deal damage to a fighter. Shield absorbs first (up to its pool);
 * Bleed damage ignores Shield (design §4.1). Any HP damage wakes a
 * sleeping target immediately. Returns HP damage actually dealt.
 */
function dealDamage(f: BattleFighter, amount: number, ignoreShield: boolean, log: string[]): number {
  let remaining = Math.max(0, Math.floor(amount));
  if (remaining <= 0) return 0;
  if (!ignoreShield) {
    const shield = getEffect(f, "Shield");
    if (shield && shield.shieldHp > 0) {
      const absorbed = Math.min(shield.shieldHp, remaining);
      shield.shieldHp -= absorbed;
      remaining -= absorbed;
      if (shield.shieldHp <= 0) removeEffect(f, "Shield");
    }
  }
  const dealt = Math.min(f.hp, remaining);
  f.hp -= dealt;
  if (dealt > 0 && hasEffect(f, "Sleep")) {
    removeEffect(f, "Sleep");
    log.push(`💤 ${fighterName(f)} woke up!`);
  }
  return dealt;
}

function heal(f: BattleFighter, amount: number): number {
  const healed = Math.min(f.maxHp - f.hp, Math.max(0, Math.floor(amount)));
  f.hp += healed;
  return healed;
}

/**
 * Start of a fighter's turn: DoT ticks (capped at 12% max HP/turn,
 * design §3.3 rule 7), Regen heal (cancelled by any active Poison or
 * Burn — DoT beats healing, design §4.3), then the control checks.
 * Returns whether the fighter may act this turn.
 */
function beginTurn(
  f: BattleFighter,
  rand: () => number,
  log: string[],
): { canAct: boolean; paralyzeBoost: boolean; fainted: boolean } {
  const no = { canAct: false, paralyzeBoost: false, fainted: false };
  // DoT tick (Burn 5% + Poison 4% + Bleed 3%, capped at 12%).
  const dots = f.effects.filter((e) => (DOT_EFFECTS as readonly string[]).includes(e.name));
  if (dots.length > 0) {
    const rawTotal = dots.reduce((s, e) => s + (DOT_PCT[e.name] ?? 0), 0);
    const scale = rawTotal > 12 ? 12 / rawTotal : 1;
    let otherDmg = 0;
    let bleedDmg = 0;
    for (const dot of dots) {
      const dmg = Math.max(1, Math.floor((f.maxHp * (DOT_PCT[dot.name] ?? 0) * scale) / 100));
      if (dot.name === "Bleed") bleedDmg += dmg;
      else otherDmg += dmg;
    }
    let dealt = 0;
    if (otherDmg > 0) dealt += dealDamage(f, otherDmg, false, log);
    if (bleedDmg > 0) dealt += dealDamage(f, bleedDmg, true, log);
    if (dealt > 0) {
      log.push(`🩸 ${fighterName(f)} takes ${dealt} damage from ${dots.map((d) => d.name).join(" + ")}.`);
    }
    if (f.hp <= 0) return { ...no, fainted: true };
  }
  // Regen heals 6% max HP/turn — unless Poison or Burn is active.
  if (hasEffect(f, "Regen") && !hasEffect(f, "Burn") && !hasEffect(f, "Poison")) {
    const healed = heal(f, Math.floor(f.maxHp * 0.06));
    if (healed > 0) log.push(`💚 ${fighterName(f)} regenerates ${healed} HP.`);
  }
  if (hasEffect(f, "Stun")) return no;
  // Freeze: 1-turn skip (the first turn, turnsLeft 2) + DEF −20% for 2 turns.
  if (hasEffect(f, "Freeze") && (getEffect(f, "Freeze")?.turnsLeft ?? 0) >= 2) return no;
  if (hasEffect(f, "Sleep")) return no;
  let paralyzeBoost = false;
  if (hasEffect(f, "Paralyze")) {
    if (rand() < 0.5) return no;
    paralyzeBoost = true; // Shaky but angry: +10% ATK on a turn it acts.
  }
  if (hasEffect(f, "Confuse")) {
    if (rand() < 0.3) {
      const selfDmg = Math.max(1, Math.floor(f.atk / 2));
      const dealt = dealDamage(f, selfDmg, false, log);
      log.push(`😵 ${fighterName(f)} is confused and hurts itself for ${dealt}!`);
      if (f.hp <= 0) return { ...no, fainted: true };
      return no;
    }
  }
  return { canAct: true, paralyzeBoost, fainted: false };
}

/** End of a round: every alive fighter's durations tick down; expired
 * control effects set the 1-turn immunity (see removeEffect). Durations
 * count rounds, not bearer actions — a "2-turn" Shield stays up for
 * two rounds of combat, including the round it was raised in. */
function ageEffects(f: BattleFighter): void {
  let freshImmunity = false;
  const priorImmunity = f.controlImmuneTurns;
  for (const e of [...f.effects]) {
    e.turnsLeft -= 1;
    if (e.turnsLeft <= 0) {
      const wasControl = e.name === "Stun" || e.name === "Freeze" || e.name === "Sleep";
      removeEffect(f, e.name);
      if (wasControl) freshImmunity = true;
    }
  }
  if (!freshImmunity && priorImmunity > 0) f.controlImmuneTurns = priorImmunity - 1;
}

function standingsLine(side: SideState): string {
  const active = side.fighters.find((f) => f.hp > 0);
  const left = side.fighters.filter((f) => f.hp > 0).length;
  if (!active) return `${side.ownerName}: all fainted`;
  return `${side.ownerName}: ${fighterName(active)} ${active.hp}/${active.maxHp} HP · ${left} left`;
}

function buildSide(input: BattleSideInput): SideState {
  const fighters = input.team.slice(0, 3).map((m) => {
    const f = makeFighter(m, input.ownerId, input.ownerName);
    const s = leveledStats(m.monster, m.level, m.fuseLevel ?? 0);
    f.maxHp = s.hp;
    f.hp = s.hp;
    f.atk = s.atk;
    f.def = s.def;
    return f;
  });
  return {
    ownerId: input.ownerId,
    ownerName: input.ownerName,
    fighters,
    weaponAtk: input.weaponAtk ?? 0,
    weaponEffects: input.weaponEffects ?? [],
  };
}

/**
 * One fighter's action against the opposing active fighter. Mutates
 * both sides; appends lines to `log`. Returns the fainted defender
 * (if the attack KO'd it), else null. A fighter that faints from its
 * own DoT/confusion logs its own faint line and returns null — the
 * round loop's sideAlive check ends the battle.
 */
function takeTurn(
  actor: BattleFighter,
  defender: BattleFighter,
  side: SideState,
  rand: () => number,
  log: string[],
): BattleFighter | null {
  const began = beginTurn(actor, rand, log);
  if (began.fainted) {
    log.push(`💀 ${fighterName(actor)} fainted!`);
    return null;
  }
  if (!began.canAct) {
    return null;
  }
  // Self-buffs (on use, 100%): apply any of the monster's buff effects
  // that is not already active, as a free action before attacking.
  for (const eff of actor.monster.effects) {
    if ((BUFF_EFFECTS as readonly string[]).includes(eff) && !hasEffect(actor, eff as EffectName)) {
      if (applyEffect(actor, eff as EffectName, log)) {
        log.push(`✨ ${fighterName(actor)} uses ${eff}!`);
      }
    }
  }
  // Evasion: +20% dodge, unless the dodger is Stunned/Frozen/Asleep.
  if (
    hasEffect(defender, "Evasion Up") &&
    !hasEffect(defender, "Stun") &&
    !hasEffect(defender, "Freeze") &&
    !hasEffect(defender, "Sleep") &&
    rand() < 0.2
  ) {
    log.push(`💨 ${fighterName(defender)} dodged ${fighterName(actor)}'s ${actor.monster.move}!`);
    return null;
  }
  const crit = rand() < BASE_CRIT_CHANCE + (hasEffect(actor, "Crit Up") ? CRIT_UP_BONUS : 0);
  const atkEff = effAtk(actor, began.paralyzeBoost) + side.weaponAtk;
  const defEff = effDef(defender);
  let dmg = Math.max(1, Math.floor(atkEff - defEff / 2));
  if (crit) dmg = Math.max(1, Math.floor(dmg * 1.5));
  const dealt = dealDamage(defender, dmg, false, log);
  log.push(
    `⚔️ ${fighterName(actor)} used ${actor.monster.move} — ${dealt} damage to ${fighterName(defender)}${crit ? " 💥 CRIT!" : ""}`,
  );
  // Lifesteal heals 30% of the damage actually dealt.
  if (hasEffect(actor, "Lifesteal") && dealt > 0) {
    const healed = heal(actor, Math.floor(dealt * 0.3));
    if (healed > 0) log.push(`🩸 ${fighterName(actor)} drains ${healed} HP.`);
  }
  // Landing a crit ends Attack Down early.
  if (crit) removeEffect(actor, "Attack Down");
  // Landing a successful hit ends Confuse early.
  if (hasEffect(actor, "Confuse")) removeEffect(actor, "Confuse");
  if (defender.hp <= 0) {
    return defender;
  }
  // Counters that fire on a landed hit.
  if (actor.monster.type === "Water" && hasEffect(defender, "Burn")) {
    removeEffect(defender, "Burn");
    log.push(`💧 Water washed the Burn off ${fighterName(defender)}!`);
  }
  if (actor.monster.type === "Fire" && hasEffect(defender, "Freeze")) {
    removeEffect(defender, "Freeze");
    log.push(`🔥 Fire thawed ${fighterName(defender)}!`);
  }
  // On-hit effects (monster signature + weapon), each with its trigger
  // chance (fusion adds +10pp at +2 / +4).
  const onHit: string[] = [
    ...actor.monster.effects.filter((e) => !(BUFF_EFFECTS as readonly string[]).includes(e)),
    ...side.weaponEffects,
  ];
  for (const eff of onHit) {
    if (rand() * 100 >= triggerChanceFor(eff, actor.fuseLevel)) continue;
    const name = eff as EffectName;
    if (applyEffect(defender, name, log)) {
      log.push(`🌀 ${fighterName(defender)} is ${name}!`);
      if (name === "Burn" && hasEffect(defender, "Freeze")) {
        removeEffect(defender, "Freeze");
        log.push(`🔥 Burn thawed ${fighterName(defender)}!`);
      }
    }
  }
  return null;
}

/**
 * Simulate a full 1v1 battle. Deterministic given `rand`.
 * `a` is the challenger, `b` the opponent. Teams are already the
 * top-3 picks (see pickTeam / getBattleTeam).
 */
export function simulateBattle(
  a: BattleSideInput,
  b: BattleSideInput,
  rand: () => number = Math.random,
): BattleResult {
  const sideA = buildSide(a);
  const sideB = buildSide(b);
  const rounds: BattleRoundLog[] = [];
  const flat: string[] = [];
  let finalBlow: BattleResult["finalBlow"] = null;

  const alive = (s: SideState): BattleFighter | undefined => s.fighters.find((f) => f.hp > 0);
  const sideAlive = (s: SideState): boolean => s.fighters.some((f) => f.hp > 0);

  let n = 0;
  while (n < MAX_BATTLE_ROUNDS && sideAlive(sideA) && sideAlive(sideB)) {
    n += 1;
    const lines: string[] = [];
    const aF = alive(sideA)!;
    const bF = alive(sideB)!;
    // Highest-ATK acts first each round (weapon ATK counts); ties are
    // broken by the injected rand so seeded runs stay deterministic.
    const aAtk = aF.atk + sideA.weaponAtk;
    const bAtk = bF.atk + sideB.weaponAtk;
    const aFirst = aAtk !== bAtk ? aAtk > bAtk : rand() < 0.5;
    const order: Array<{ actor: BattleFighter; def: BattleFighter; side: SideState }> = aFirst
      ? [
          { actor: aF, def: bF, side: sideA },
          { actor: bF, def: aF, side: sideB },
        ]
      : [
          { actor: bF, def: aF, side: sideB },
          { actor: aF, def: bF, side: sideA },
        ];
    for (const step of order) {
      if (!sideAlive(sideA) || !sideAlive(sideB)) break;
      if (step.actor.hp <= 0) continue; // Fainted from DoT/confusion before acting.
      const currentDef = alive(step.def === bF ? sideB : sideA);
      if (!currentDef) break;
      const ko = takeTurn(step.actor, currentDef, step.side, rand, lines);
      if (ko) {
        finalBlow = { attackerName: fighterName(step.actor), move: step.actor.monster.move, targetName: fighterName(ko) };
        lines.push(`💀 ${fighterName(ko)} fainted!`);
      }
    }
    // Durations tick down once per round, for every fighter still standing.
    for (const f of [...sideA.fighters, ...sideB.fighters]) {
      if (f.hp > 0) ageEffects(f);
    }
    flat.push(...lines);
    rounds.push({ n, lines, aLine: standingsLine(sideA), bLine: standingsLine(sideB) });
  }

  let winner: BattleResult["winner"];
  if (sideAlive(sideA) && !sideAlive(sideB)) winner = "A";
  else if (sideAlive(sideB) && !sideAlive(sideA)) winner = "B";
  else if (!sideAlive(sideA) && !sideAlive(sideB)) winner = "draw";
  else {
    // Round cap: most remaining HP (fraction of team max) wins.
    const frac = (s: SideState): number => {
      const max = s.fighters.reduce((t, f) => t + f.maxHp, 0);
      const cur = s.fighters.reduce((t, f) => t + Math.max(0, f.hp), 0);
      return max > 0 ? cur / max : 0;
    };
    const fa = frac(sideA);
    const fb = frac(sideB);
    winner = fa > fb ? "A" : fb > fa ? "B" : "draw";
    flat.push(`⏱️ ${MAX_BATTLE_ROUNDS} rounds — decided on remaining HP.`);
    rounds[rounds.length - 1]?.lines.push(`⏱️ ${MAX_BATTLE_ROUNDS} rounds — decided on remaining HP.`);
  }

  return {
    winner,
    rounds,
    log: flat,
    roundsFought: n,
    finalBlow,
    aRemainingHp: sideA.fighters.reduce((t, f) => t + Math.max(0, f.hp), 0),
    bRemainingHp: sideB.fighters.reduce((t, f) => t + Math.max(0, f.hp), 0),
  };
}

// ---------------------------------------------------------------------------
// Persistence — challenges, cooldowns, teams, rewards
// (battle_challenges + user_battle, db.ts SCHEMA; fail closed)
// ---------------------------------------------------------------------------

export interface ChallengeRow {
  id: number;
  challengerId: string;
  opponentId: string;
  wager: number;
  status: string;
  channelId: string;
  guildId: string;
  createdAt: number;
  expiresAt: number;
}

function toChallengeRow(r: Record<string, unknown>): ChallengeRow {
  return {
    id: Number(r.id),
    challengerId: String(r.challenger_id),
    opponentId: String(r.opponent_id),
    wager: Number(r.wager),
    status: String(r.status),
    channelId: String(r.channel_id),
    guildId: String(r.guild_id),
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
  };
}

export async function createChallenge(
  db: SelenaDb,
  input: { challengerId: string; opponentId: string; wager: number; channelId: string; guildId: string; nowMs: number },
): Promise<ChallengeRow> {
  const res = await db
    .prepare(
      "INSERT INTO battle_challenges (challenger_id, opponent_id, wager, status, channel_id, guild_id, created_at, expires_at) " +
        "VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)",
    )
    .run(
      input.challengerId,
      input.opponentId,
      input.wager,
      input.channelId,
      input.guildId,
      input.nowMs,
      input.nowMs + BATTLE_CHALLENGE_TTL_MS,
    );
  const row = await getChallenge(db, Number(res.lastInsertRowid));
  if (!row) throw new Error("createChallenge: challenge row not found after insert");
  return row;
}

export async function getChallenge(db: SelenaDb, id: number): Promise<ChallengeRow | null> {
  const row = (await db
    .prepare("SELECT * FROM battle_challenges WHERE id = ?")
    .get(id)) as Record<string, unknown> | undefined;
  return row ? toChallengeRow(row) : null;
}

export async function setChallengeStatus(db: SelenaDb, id: number, status: string): Promise<void> {
  await db.prepare("UPDATE battle_challenges SET status = ? WHERE id = ?").run(status, id);
}

/**
 * Expire every pending challenge past its deadline. Exported for the
 * coordinator to wire into the 60s due-task sweep in src/index.ts.
 * Never throws out of the sweep — a failed expiry pass just retries
 * next sweep (the button handler re-checks expiry anyway).
 */
export async function expireBattleChallenges(db: SelenaDb, nowMs: number): Promise<ChallengeRow[]> {
  try {
    const rows = (await db
      .prepare("SELECT * FROM battle_challenges WHERE status = 'pending' AND expires_at <= ?")
      .all(nowMs)) as Record<string, unknown>[];
    const expired = rows.map(toChallengeRow);
    for (const c of expired) {
      await setChallengeStatus(db, c.id, "expired");
    }
    return expired;
  } catch (e) {
    console.error("uwu: expireBattleChallenges failed:", e instanceof Error ? e.message : e);
    return [];
  }
}

/** Ms of battle cooldown left for a user (0 = free to battle). */
export async function getBattleCooldownRemainingMs(db: SelenaDb, userId: string, nowMs: number): Promise<number> {
  const row = (await db
    .prepare("SELECT last_battle_at FROM user_battle WHERE user_id = ?")
    .get(userId)) as { last_battle_at: number | null } | undefined;
  const last = row?.last_battle_at ?? null;
  if (last === null) return 0;
  return Math.max(0, BATTLE_COOLDOWN_MS - (nowMs - Number(last)));
}

export async function setBattleTimestamp(db: SelenaDb, userId: string, nowMs: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO user_battle (user_id, last_battle_at) VALUES (?, ?) " +
        "ON CONFLICT (user_id) DO UPDATE SET last_battle_at = EXCLUDED.last_battle_at",
    )
    .run(userId, nowMs);
}

/**
 * A player's battle team: their 3 strongest zoo monsters by power
 * budget. Levels/fuse come from user_monster_instances when a row
 * exists for that monster (fusion system), else level 1 / +0 — the
 * zoo itself (user_monsters) is the source of truth for ownership.
 */
export async function getBattleTeam(
  db: SelenaDb,
  guildId: string,
  userId: string,
): Promise<TeamMemberInput[]> {
  const owned = await getUserMonsters(db, guildId, userId);
  const instRows = (await db
    .prepare("SELECT monster_id, level, fuse_level FROM user_monster_instances WHERE guild_id = ? AND user_id = ?")
    .all(guildId, userId)) as { monster_id: number; level: number; fuse_level: number }[];
  const best = new Map<number, { level: number; fuseLevel: number }>();
  for (const r of instRows) {
    const id = Number(r.monster_id);
    const cur = best.get(id);
    const cand = { level: Number(r.level), fuseLevel: Number(r.fuse_level) };
    if (!cur || cand.level > cur.level || (cand.level === cur.level && cand.fuseLevel > cur.fuseLevel)) {
      best.set(id, cand);
    }
  }
  const members: TeamMemberInput[] = owned.map((o) => ({
    monster: o.monster,
    level: best.get(o.monster.id)?.level ?? 1,
    fuseLevel: best.get(o.monster.id)?.fuseLevel ?? 0,
  }));
  return pickTeam(members);
}

/** Equipped weapon's battle contribution (ATK bonus + on-hit effects). */
export async function getEquippedWeapon(
  db: SelenaDb,
  guildId: string,
  userId: string,
): Promise<{ atk: number; effects: readonly string[] } | null> {
  const weapons = await getUserWeapons(db, guildId, userId);
  const equipped = weapons.find((w) => w.equipped);
  if (!equipped) return null;
  const def = WEAPON_BY_ID.get(equipped.weaponId);
  return def ? { atk: def.atk, effects: def.effects } : null;
}

/**
 * Player XP from a battle — direct table update, NOT levels.awardXp
 * (that one has a 60s chat-XP cooldown which would silently swallow
 * battle XP). Returns the new totals.
 */
export async function awardBattleXp(
  db: SelenaDb,
  guildId: string,
  userId: string,
  amount: number,
): Promise<{ xp: number; level: number; leveledUp: boolean }> {
  await db.prepare("INSERT OR IGNORE INTO users (guild_id, user_id) VALUES (?, ?)").run(guildId, userId);
  const row = (await db
    .prepare("SELECT xp, level FROM users WHERE guild_id = ? AND user_id = ?")
    .get(guildId, userId)) as { xp: number; level: number } | undefined;
  const before = Number(row?.level ?? 0);
  const xp = Number(row?.xp ?? 0) + Math.max(0, Math.floor(amount));
  const level = levelFromXp(xp);
  await db.prepare("UPDATE users SET xp = ?, level = ? WHERE guild_id = ? AND user_id = ?").run(xp, level, guildId, userId);
  return { xp, level, leveledUp: level > before };
}

/**
 * Monster XP (design §6.3): a monster that fought gains the same XP
 * its player did; it levels up when its XP crosses 100 × its level
 * (cap 100). Only applies when the monster already has an instance
 * row (the fusion system owns instance creation) — returns null when
 * there is nothing to update, so battles never invent instance rows.
 */
export async function grantMonsterXp(
  db: SelenaDb,
  guildId: string,
  userId: string,
  monsterId: number,
  amount: number,
): Promise<{ leveledUp: boolean; newLevel: number } | null> {
  const row = (await db
    .prepare(
      "SELECT id, level, xp FROM user_monster_instances WHERE guild_id = ? AND user_id = ? AND monster_id = ? " +
        "ORDER BY level DESC, xp DESC LIMIT 1",
    )
    .get(guildId, userId, monsterId)) as { id: number; level: number; xp: number } | undefined;
  if (!row) return null;
  let level = Number(row.level);
  let xp = Number(row.xp) + Math.max(0, Math.floor(amount));
  let leveledUp = false;
  while (level < MONSTER_LEVEL_CAP && xp >= monsterXpForLevel(level)) {
    xp -= monsterXpForLevel(level);
    level += 1;
    leveledUp = true;
  }
  await db.prepare("UPDATE user_monster_instances SET level = ?, xp = ? WHERE id = ?").run(level, xp, Number(row.id));
  return { leveledUp, newLevel: level };
}

export interface BattleSettlement {
  aGold: number;
  bGold: number;
  aXp: number;
  bXp: number;
  /** "Name reached Lv N!" lines for monsters that levelled up. */
  monsterLevelUps: string[];
  aLeveledUp: boolean;
  bLeveledUp: boolean;
}

/**
 * Settle one finished battle: gold + player XP + fighting-monster XP.
 * Winner 100 gold + XP (40 + avg enemy team level × 2, design §6.3);
 * loser 25 gold + half the winner's XP. Draw: both get 25 gold and
 * half-XP each (working default — the design never prices a draw).
 * Wager: winner takes the pot (2× wager); on a draw both wagers are
 * refunded. Only ever ADDS gold here — escrow was deducted at accept,
 * so a failure mid-settle can never drive a balance negative.
 */
export async function settleBattle(
  db: SelenaDb,
  input: {
    guildId: string;
    aId: string;
    bId: string;
    winner: "A" | "B" | "draw";
    wager: number;
    aTeam: readonly TeamMemberInput[];
    bTeam: readonly TeamMemberInput[];
  },
): Promise<BattleSettlement> {
  const avgLevel = (team: readonly TeamMemberInput[]): number =>
    team.length === 0 ? 1 : team.reduce((s, m) => s + m.level, 0) / team.length;
  const aWinXp = battleWinXp(avgLevel(input.bTeam));
  const bWinXp = battleWinXp(avgLevel(input.aTeam));
  let aGold: number;
  let bGold: number;
  let aXp: number;
  let bXp: number;
  if (input.winner === "A") {
    aGold = BATTLE_WIN_GOLD + 2 * input.wager;
    bGold = BATTLE_LOSE_GOLD;
    aXp = aWinXp;
    bXp = Math.floor(aWinXp / 2);
  } else if (input.winner === "B") {
    aGold = BATTLE_LOSE_GOLD;
    bGold = BATTLE_WIN_GOLD + 2 * input.wager;
    aXp = Math.floor(bWinXp / 2);
    bXp = bWinXp;
  } else {
    aGold = BATTLE_LOSE_GOLD + input.wager;
    bGold = BATTLE_LOSE_GOLD + input.wager;
    aXp = Math.floor(aWinXp / 2);
    bXp = Math.floor(bWinXp / 2);
  }

  const monsterLevelUps: string[] = [];
  const grantTeamXp = async (
    tx: SelenaDb,
    userId: string,
    team: readonly TeamMemberInput[],
    xp: number,
  ): Promise<void> => {
    for (const m of team) {
      const res = await grantMonsterXp(tx, input.guildId, userId, m.monster.id, xp);
      if (res?.leveledUp) monsterLevelUps.push(`🌟 ${m.monster.name} reached Lv ${res.newLevel}!`);
    }
  };

  const out = await db.transaction(async (tx) => {
    const a = await awardBattleXp(tx, input.guildId, input.aId, aXp);
    const b = await awardBattleXp(tx, input.guildId, input.bId, bXp);
    await grantTeamXp(tx, input.aId, input.aTeam, aXp);
    await grantTeamXp(tx, input.bId, input.bTeam, bXp);
    await addPoints(tx, input.guildId, input.aId, aGold, "battle");
    await addPoints(tx, input.guildId, input.bId, bGold, "battle");
    return { aLeveledUp: a.leveledUp, bLeveledUp: b.leveledUp };
  });
  return { aGold, bGold, aXp, bXp, monsterLevelUps, aLeveledUp: out.aLeveledUp, bLeveledUp: out.bLeveledUp };
}

/** Read a user's gold balance (fail closed: a read error propagates). */
export async function getGold(db: SelenaDb, guildId: string, userId: string): Promise<number> {
  return (await getBalance(db, guildId, userId)).points;
}
