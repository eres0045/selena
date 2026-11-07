/**
 * Sample battle-card renders: simulates a seeded 3v3 battle and
 * renders three cards — opening, a middle round, and the final card
 * with the winner footer — into scripts/battle-card-samples/.
 * Run: npx tsx scripts/render_battle_sample.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MONSTER_BY_ID, type Monster } from "../src/lib/hunt.js";
import { mulberry32 } from "../src/lib/rng.js";
import { simulateBattle, type BattleFighterSnapshot, type TeamMemberInput } from "../src/lib/battle.js";
import { battleWinXp } from "../src/lib/monsterLevels.js";
import {
  renderBattleCard,
  type BattleCardFighter,
  type BattleCardInput,
} from "../src/lib/battleCard.js";

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "battle-card-samples");

function mon(id: number): Monster {
  const m = MONSTER_BY_ID.get(id);
  if (!m) throw new Error(`unknown monster id ${id}`);
  return m;
}

function team(ids: Array<[number, number]>): TeamMemberInput[] {
  return ids.map(([id, level]) => ({ monster: mon(id), level }));
}

function toCardFighters(snaps: BattleFighterSnapshot[]): BattleCardFighter[] {
  return snaps.map((s) => ({
    monsterId: s.monsterId,
    name: s.name,
    level: s.level,
    hp: s.hp,
    maxHp: s.maxHp,
    alive: s.alive,
    active: s.active,
    effects: s.effects,
  }));
}

async function renderAndWrite(
  name: string,
  input: BattleCardInput,
): Promise<{ file: string; bytes: number; ms: number }> {
  const started = performance.now();
  const buf = await renderBattleCard(input);
  const ms = performance.now() - started;
  const file = path.join(OUT_DIR, name);
  await writeFile(file, buf);
  console.log(`${name}: ${file} (${buf.length} bytes, ${ms.toFixed(0)} ms)`);
  return { file, bytes: buf.length, ms };
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  // Seeded 3v3: effect-heavy rosters so chips show up on the cards.
  const aTeam = team([
    [46, 5], // Shadow Panther
    [3, 3], // Cinder Mouse (Burn)
    [41, 4], // Thorn Wolf (Bleed)
  ]);
  const bTeam = team([
    [26, 4], // Stone Beetle
    [62, 5], // Venom Spider (Poison)
    [66, 3], // Crystal Wolf (Freeze)
  ]);
  const result = simulateBattle(
    { ownerId: "user-ronit", ownerName: "Ronit", team: aTeam },
    { ownerId: "user-udita", ownerName: "Udita", team: bTeam },
    mulberry32(42),
  );
  console.log(
    `battle: winner=${result.winner} rounds=${result.roundsFought} ` +
      `finalBlow=${result.finalBlow ? `${result.finalBlow.attackerName} -> ${result.finalBlow.targetName}` : "none"}`,
  );

  const base = {
    aName: "Ronit",
    bName: "Udita",
    roundsTotal: result.roundsFought,
    wager: 100,
  };

  // 1. Opening frame (full HP, round 0).
  await renderAndWrite("round-0.png", {
    ...base,
    aFighters: toCardFighters(result.opening.aFighters),
    bFighters: toCardFighters(result.opening.bFighters),
    round: 0,
    actionLine: "The battle begins!",
  });

  // 2. A middle round where at least one fighter has taken damage.
  let midIndex = Math.floor(result.rounds.length / 2);
  for (let i = 0; i < result.rounds.length; i++) {
    const r = result.rounds[i] as (typeof result.rounds)[number];
    const damaged = [...r.aFighters, ...r.bFighters].some((f) => f.hp < f.maxHp);
    if (damaged && i >= Math.floor(result.rounds.length / 2)) {
      midIndex = i;
      break;
    }
  }
  const mid = result.rounds[midIndex] as (typeof result.rounds)[number];
  await renderAndWrite("round-mid.png", {
    ...base,
    aFighters: toCardFighters(mid.aFighters),
    bFighters: toCardFighters(mid.bFighters),
    round: mid.n,
    actionLine: mid.lines[mid.lines.length - 1] ?? "",
  });

  // 3. Final card with the winner footer.
  const last = result.rounds[result.rounds.length - 1] as (typeof result.rounds)[number];
  const winnerName =
    result.winner === "A" ? "Ronit" : result.winner === "B" ? "Udita" : "No one";
  const avgEnemyLevel =
    (result.winner === "A" ? bTeam : aTeam).reduce((s, m) => s + m.level, 0) / 3;
  await renderAndWrite("round-final.png", {
    ...base,
    aFighters: toCardFighters(last.aFighters),
    bFighters: toCardFighters(last.bFighters),
    round: last.n,
    actionLine: last.lines[last.lines.length - 1] ?? "",
    footer: {
      winnerName,
      roundsFought: result.roundsFought,
      winnerXp: battleWinXp(avgEnemyLevel),
      winnerStreak: 3,
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
