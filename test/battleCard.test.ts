import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { mulberry32 } from "../src/lib/rng.js";
import { MONSTER_BY_ID, type Monster } from "../src/lib/hunt.js";
import {
  MAX_BATTLE_ROUNDS,
  simulateBattle,
  type BattleFighterSnapshot,
  type TeamMemberInput,
} from "../src/lib/battle.js";
import {
  buildBattleCardSvg,
  hpBarColor,
  hpBarFraction,
  renderBattleCard,
  type BattleCardFighter,
  type BattleCardInput,
} from "../src/lib/battleCard.js";

function mon(id: number): Monster {
  return MONSTER_BY_ID.get(id)!;
}

function team(ids: Array<[number, number]>): TeamMemberInput[] {
  return ids.map(([id, level]) => ({ monster: mon(id), level }));
}

/** The same seeded 3v3 the sample script renders. */
function seededBattle() {
  return simulateBattle(
    {
      ownerId: "user-ronit",
      ownerName: "Ronit",
      team: team([
        [46, 5], // Shadow Panther
        [3, 3], // Cinder Mouse (Burn)
        [41, 4], // Thorn Wolf (Bleed)
      ]),
    },
    {
      ownerId: "user-udita",
      ownerName: "Udita",
      team: team([
        [26, 4], // Stone Beetle
        [62, 5], // Venom Spider (Poison)
        [66, 3], // Crystal Wolf (Freeze)
      ]),
    },
    mulberry32(42),
  );
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

function openingInput(): BattleCardInput {
  const result = seededBattle();
  return {
    aName: "Ronit",
    bName: "Udita",
    aFighters: toCardFighters(result.opening.aFighters),
    bFighters: toCardFighters(result.opening.bFighters),
    round: 0,
    roundsTotal: result.roundsFought,
    actionLine: "The battle begins!",
    wager: 100,
  };
}

function fighter(over: Partial<BattleCardFighter> = {}): BattleCardFighter {
  return {
    monsterId: 46,
    name: "Shadow Panther",
    level: 5,
    hp: 86,
    maxHp: 86,
    alive: true,
    active: true,
    effects: [],
    ...over,
  };
}

function smallInput(over: Partial<BattleCardInput> = {}): BattleCardInput {
  return {
    aName: "Ronit",
    bName: "Udita",
    aFighters: [fighter()],
    bFighters: [fighter({ monsterId: 26, name: "Stone Beetle", level: 4, hp: 72, maxHp: 72 })],
    round: 1,
    roundsTotal: 10,
    actionLine: "Shadow Panther hit Stone Beetle for 12!",
    ...over,
  };
}

describe("battleCard", () => {
  it("renders a 900x560 PNG under 1 MB in under 1s for a full 3v3", async () => {
    const started = performance.now();
    const buf = await renderBattleCard(openingInput());
    const ms = performance.now() - started;
    expect(ms).toBeLessThan(1000);
    expect(buf.length).toBeLessThan(1024 * 1024);
    const meta = await sharp(buf).metadata();
    expect(meta.width).toBe(900);
    expect(meta.height).toBe(560);
    expect(meta.format).toBe("png");
  });

  it("hpBarFraction clamps to 0..1", () => {
    expect(hpBarFraction(50, 100)).toBe(0.5);
    expect(hpBarFraction(100, 100)).toBe(1);
    expect(hpBarFraction(0, 100)).toBe(0);
    expect(hpBarFraction(150, 100)).toBe(1);
    expect(hpBarFraction(-5, 100)).toBe(0);
    expect(hpBarFraction(10, 0)).toBe(0);
    expect(hpBarFraction(10, -3)).toBe(0);
  });

  it("hpBarColor is green >50%, yellow >25%, red at or below 25%", () => {
    expect(hpBarColor(1.0)).toBe("#4ade80");
    expect(hpBarColor(0.75)).toBe("#4ade80");
    expect(hpBarColor(0.51)).toBe("#4ade80");
    expect(hpBarColor(0.5)).toBe("#facc15");
    expect(hpBarColor(0.26)).toBe("#facc15");
    expect(hpBarColor(0.25)).toBe("#ef4444");
    expect(hpBarColor(0.0)).toBe("#ef4444");
  });

  it("SVG fill width is proportional to the HP fraction", () => {
    // Bar is 215px wide: 50% HP -> 108px fill (215 * 0.5 = 107.5, rounded).
    const svg = buildBattleCardSvg(
      smallInput({
        aFighters: [fighter({ hp: 43, maxHp: 86 })],
        bFighters: [fighter({ monsterId: 26, name: "Stone Beetle", level: 4, hp: 72, maxHp: 72 })],
      }),
    );
    expect(svg).toMatch(/<rect id="hpFillA0"[^>]*width="108"/);
    // Full HP fills the whole bar.
    expect(svg).toMatch(/<rect id="hpFillB0"[^>]*width="215"/);
    // A fainted fighter gets no fill rect at all.
    const koSvg = buildBattleCardSvg(
      smallInput({ aFighters: [fighter({ hp: 0, alive: false, active: false })] }),
    );
    expect(koSvg).not.toContain('id="hpFillA0"');
  });

  it("fainted fighter gets a KO label, greyed name, and a different portrait", async () => {
    const alive = smallInput();
    const fainted = smallInput({
      aFighters: [
        fighter({ hp: 0, alive: false, active: false }),
        fighter({ monsterId: 3, name: "Cinder Mouse", level: 3, hp: 47, maxHp: 47, active: true }),
      ],
    });
    const svg = buildBattleCardSvg(fainted);
    expect(svg).toContain(">KO<");
    // Exactly one KO label — only the one fainted fighter has it.
    expect(svg.split(">KO<").length - 1).toBe(1);
    const aliveBuf = await renderBattleCard(alive);
    const faintedBuf = await renderBattleCard(fainted);
    expect(faintedBuf.equals(aliveBuf)).toBe(false);
  });

  it("renders both teams with all 6 fighters named in the SVG", () => {
    const svg = buildBattleCardSvg(openingInput());
    for (const name of [
      "Shadow Panther",
      "Cinder Mouse",
      "Thorn Wolf",
      "Stone Beetle",
      "Venom Spider",
      "Crystal Wolf",
    ]) {
      expect(svg).toContain(name);
    }
    expect(svg).toContain("Ronit");
    expect(svg).toContain("Udita");
    expect(svg).toContain("Battle Start");
  });

  it("missing monster art falls back to a '?' placeholder instead of throwing", async () => {
    const input = smallInput({
      aFighters: [fighter({ monsterId: 999999, name: "No Such Monster", hp: 10, maxHp: 10 })],
    });
    const svg = buildBattleCardSvg(input);
    expect(svg).toContain(">?</text>");
    const buf = await renderBattleCard(input);
    expect(buf.length).toBeGreaterThan(0);
    const meta = await sharp(buf).metadata();
    expect(meta.width).toBe(900);
  });

  it("final card SVG contains the winner footer with turns, XP and streak", () => {
    const svg = buildBattleCardSvg(
      smallInput({
        round: 18,
        roundsTotal: 18,
        actionLine: "Thorn Wolf fainted!",
        footer: { winnerName: "Udita", roundsFought: 18, winnerXp: 48, winnerStreak: 3 },
      }),
    );
    expect(svg).toContain("Udita won in 18 turns!");
    expect(svg).toContain("+48 xp");
    expect(svg).toContain("Streak: 3");
  });

  it("renders every round of a full seeded battle; HP stays in range and the battle ends", async () => {
    const result = seededBattle();
    const frames: BattleCardInput[] = [
      {
        aName: "Ronit",
        bName: "Udita",
        aFighters: toCardFighters(result.opening.aFighters),
        bFighters: toCardFighters(result.opening.bFighters),
        round: 0,
        roundsTotal: result.roundsFought,
        actionLine: "The battle begins!",
      },
      ...result.rounds.map((r) => ({
        aName: "Ronit",
        bName: "Udita",
        aFighters: toCardFighters(r.aFighters),
        bFighters: toCardFighters(r.bFighters),
        round: r.n,
        roundsTotal: result.roundsFought,
        actionLine: r.lines[r.lines.length - 1] ?? "",
      })),
    ];
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      for (const f of [...frame.aFighters, ...frame.bFighters]) {
        expect(f.hp).toBeGreaterThanOrEqual(0);
        expect(f.hp).toBeLessThanOrEqual(f.maxHp);
      }
      const buf = await renderBattleCard(frame);
      expect(buf.length).toBeGreaterThan(0);
      expect(buf.length).toBeLessThan(1024 * 1024);
    }
    const last = result.rounds[result.rounds.length - 1] as (typeof result.rounds)[number];
    const anyFainted = [...last.aFighters, ...last.bFighters].some((f) => !f.alive);
    expect(anyFainted || result.roundsFought === MAX_BATTLE_ROUNDS).toBe(true);
  });
});
