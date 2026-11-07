import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp, { type OverlayOptions } from "sharp";
import { slugifyName } from "./hunt.js";

/**
 * OwO-style battle card renderer (900x560 still PNG, one per round).
 *
 * Pipeline (mirrors src/lib/profileCard.ts — no native `canvas`, the
 * VM cannot build it):
 *   1. Build the overlay SVG (dark arena gradient + header + team
 *      columns + HP bars + effect chips + action line / winner banner)
 *      and render it once with sharp/librsvg.
 *   2. Composite the monster portraits on top — first frame of each
 *      monster's animated GIF via sharp (missing file -> fail-soft
 *      grey "?" box drawn in the SVG, never throws).
 *   3. Emit a PNG (the animation comes from the message being edited
 *      each round, so each card is a still image).
 *
 * Text uses DejaVu Sans via fontconfig, no custom font file shipped.
 * Emoji used here are the monochrome glyphs DejaVu/Noto render on
 * this VM (verified: ⚔️ 🏆 🔥 💀 🩸 💤 😵 🛡️ 💚 💧 🌀 👁 🗡 ☠ ★ ● ▶).
 * ⚡ ✨ ❄️ do NOT render here and are deliberately never used.
 */

export const BATTLE_CARD_WIDTH = 900;
export const BATTLE_CARD_HEIGHT = 560;
export const BATTLE_CARD_MAX_BYTES = 5 * 1024 * 1024;

export interface BattleCardFighter {
  monsterId: number;
  name: string;
  level: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  active: boolean;
  effects: string[];
}

export interface BattleCardInput {
  aName: string;
  bName: string; // plain display names, no mentions
  aFighters: BattleCardFighter[];
  bFighters: BattleCardFighter[];
  round: number; // 0 = opening, else round number
  roundsTotal: number;
  actionLine: string; // latest action (may be "")
  wager?: number; // 0 = none
  footer?: {
    winnerName: string;
    roundsFought: number;
    winnerXp: number;
    winnerStreak: number;
  } | null; // set only on the final card
}

// ---------------------------------------------------------------------------
// Layout constants (900x560)
// ---------------------------------------------------------------------------

const LEFT_X = 30;
const RIGHT_X = 465;
const COL_W = 405;
const COL_RIGHT = (x: number): number => x + COL_W;
const TEAM_LABEL_Y = 110;
const ROW_Y0 = 122;
const ROW_H = 112;
const ROW_GAP = 10;
const PORTRAIT_SIZE = 88;
const PORTRAIT_RADIUS = 20;
const TEXT_X_OFF = 100; // name / bar / chips x offset inside a column
const NAME_FONT = 21;
const BAR_W = 215;
const BAR_H = 16;
const BAR_Y_OFF = 44;
const CHIP_Y_OFF = 74;
const CHIP_H = 22;
const ACTION_Y = 512;
const BANNER_Y = 516;
const BANNER_H = 36;

// ---------------------------------------------------------------------------
// Pure helpers (exported so tests can pin the math)
// ---------------------------------------------------------------------------

/** HP as a 0..1 fraction. Exported so tests can pin the math. */
export function hpBarFraction(hp: number, maxHp: number): number {
  if (!Number.isFinite(maxHp) || maxHp <= 0) return 0;
  const cur = Number.isFinite(hp) ? hp : 0;
  return Math.min(1, Math.max(0, cur / maxHp));
}

/** Bar colour by fraction: green >50%, yellow >25%, red <=25%. */
export function hpBarColor(fraction: number): string {
  if (fraction > 0.5) return "#4ade80";
  if (fraction > 0.25) return "#facc15";
  return "#ef4444";
}

function safeInt(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/** Escape user text for embedding in SVG. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Rough per-char width factor for DejaVu Sans (bold is wider). */
function charWidth(fontSize: number, bold: boolean): number {
  return fontSize * (bold ? 0.62 : 0.52);
}

/** Truncate with an ellipsis so the text fits maxPx at the given size. */
export function truncateToWidth(text: string, maxPx: number, fontSize: number, bold = false): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length === 0) return clean;
  const w = charWidth(fontSize, bold);
  if (clean.length * w <= maxPx) return clean;
  const ellipsis = "…";
  const keep = Math.max(0, Math.floor((maxPx - w) / w));
  if (keep <= 0) return ellipsis;
  return clean.slice(0, keep).trimEnd() + ellipsis;
}

/** Estimated rendered width of a string at the given size. */
function estWidth(text: string, fontSize: number, bold = false): number {
  return text.length * charWidth(fontSize, bold);
}

// ---------------------------------------------------------------------------
// Monster art
// ---------------------------------------------------------------------------

const MONSTER_ART_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../assets/emoji-hunt/monsters",
);

function portraitPath(name: string): string {
  return path.join(MONSTER_ART_DIR, `${slugifyName(name)}.gif`);
}

function hasPortrait(name: string): boolean {
  try {
    return existsSync(portraitPath(name));
  } catch {
    return false;
  }
}

/** Crop a monster GIF's first frame to a rounded 88px square. */
async function roundedPortrait(name: string, fainted: boolean): Promise<Buffer> {
  const mask = Buffer.from(
    `<svg width="${PORTRAIT_SIZE}" height="${PORTRAIT_SIZE}">` +
      `<rect x="0" y="0" width="${PORTRAIT_SIZE}" height="${PORTRAIT_SIZE}" rx="${PORTRAIT_RADIUS}" fill="#ffffff"/>` +
      `</svg>`,
  );
  let pipeline = sharp(portraitPath(name)).resize(PORTRAIT_SIZE, PORTRAIT_SIZE, { fit: "cover" });
  if (fainted) pipeline = pipeline.modulate({ brightness: 0.45, saturation: 0 });
  return pipeline.composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
}

// ---------------------------------------------------------------------------
// Effect chips
// ---------------------------------------------------------------------------

interface EffectMeta {
  emoji: string;
  color: string;
}

/** Only glyphs verified to render on this VM (see header comment). */
const EFFECT_META: Record<string, EffectMeta> = {
  Burn: { emoji: "🔥", color: "#fb923c" },
  Poison: { emoji: "💀", color: "#a3e635" },
  Bleed: { emoji: "🩸", color: "#f87171" },
  Stun: { emoji: "😵", color: "#facc15" },
  Freeze: { emoji: "💧", color: "#7dd3fc" },
  Paralyze: { emoji: "🌀", color: "#fbbf24" },
  Sleep: { emoji: "💤", color: "#a78bfa" },
  Confuse: { emoji: "😵", color: "#f472b6" },
  "Attack Down": { emoji: "🗡", color: "#fb923c" },
  "Defense Down": { emoji: "🛡️", color: "#f87171" },
  Regen: { emoji: "💚", color: "#4ade80" },
  Lifesteal: { emoji: "🩸", color: "#f43f5e" },
  Shield: { emoji: "🛡️", color: "#60a5fa" },
  "Crit Up": { emoji: "★", color: "#facc15" },
  "Evasion Up": { emoji: "👁", color: "#34d399" },
};

function effectMeta(name: string): EffectMeta {
  return EFFECT_META[name] ?? { emoji: "●", color: "#c7d0db" };
}

// ---------------------------------------------------------------------------
// SVG builder
// ---------------------------------------------------------------------------

function fighterRowSvg(
  f: BattleCardFighter,
  side: "A" | "B",
  index: number,
  colX: number,
): string {
  const rowY = ROW_Y0 + index * (ROW_H + ROW_GAP);
  const frac = hpBarFraction(f.hp, f.maxHp);
  const fillW = Math.round(BAR_W * frac);
  const color = hpBarColor(frac);
  const nameColor = f.alive ? "#ffffff" : "#8a94a3";
  const hpText = `${safeInt(f.hp)} / ${safeInt(f.maxHp)}`;
  const parts: string[] = [];

  // Portrait slot: placeholder box when the art file is missing
  // (the real portrait is composited on top by sharp afterwards).
  if (!hasPortrait(f.name)) {
    parts.push(
      `<rect x="${colX}" y="${rowY + 4}" width="${PORTRAIT_SIZE}" height="${PORTRAIT_SIZE}" rx="${PORTRAIT_RADIUS}" fill="#3a4756"/>` +
        `<text x="${colX + PORTRAIT_SIZE / 2}" y="${rowY + 4 + 58}" text-anchor="middle" font-family="DejaVu Sans" font-size="40" font-weight="bold" fill="#c7d0db">?</text>`,
    );
  }
  // Gold frame around the active fighter's portrait.
  if (f.active && f.alive) {
    parts.push(
      `<rect x="${colX - 3}" y="${rowY + 1}" width="${PORTRAIT_SIZE + 6}" height="${PORTRAIT_SIZE + 6}" rx="${PORTRAIT_RADIUS + 2}" fill="none" stroke="#ffd54a" stroke-width="3"/>`,
    );
  }

  // Name + level. The " · Lv N" suffix is sized first so the name
  // truncates to exactly the room left in the column.
  const levelSuffix = ` · Lv ${safeInt(f.level)}`;
  const nameMaxPx = COL_W - TEXT_X_OFF - estWidth(levelSuffix, NAME_FONT, true);
  const name = truncateToWidth(f.name || "Unknown", nameMaxPx, NAME_FONT, true);
  parts.push(
    `<text x="${colX + TEXT_X_OFF}" y="${rowY + 30}" font-family="DejaVu Sans" font-size="${NAME_FONT}" font-weight="bold" fill="${nameColor}">${escapeXml(name)}${escapeXml(levelSuffix)}</text>`,
  );

  // HP bar (background + proportional fill) and numbers.
  const barX = colX + TEXT_X_OFF;
  const barY = rowY + BAR_Y_OFF;
  parts.push(
    `<rect x="${barX}" y="${barY}" width="${BAR_W}" height="${BAR_H}" rx="8" fill="#ffffff" fill-opacity="0.25"/>`,
  );
  if (fillW > 0) {
    parts.push(
      `<rect id="hpFill${side}${index}" x="${barX}" y="${barY}" width="${fillW}" height="${BAR_H}" rx="8" fill="${color}"/>`,
    );
  }
  parts.push(
    `<text x="${COL_RIGHT(colX)}" y="${rowY + 58}" text-anchor="end" font-family="DejaVu Sans" font-size="16" fill="#e8ecf1">${escapeXml(hpText)}</text>`,
  );

  // Up to 2 active-effect chips.
  let chipX = colX + TEXT_X_OFF;
  for (const eff of (f.effects ?? []).slice(0, 2)) {
    const meta = effectMeta(eff);
    const label = `${meta.emoji} ${eff}`;
    const chipW = Math.round(estWidth(label, 14, false)) + 18;
    if (chipX + chipW > COL_RIGHT(colX) - 70) break; // keep the status text clear
    parts.push(
      `<rect x="${chipX}" y="${rowY + CHIP_Y_OFF}" width="${chipW}" height="${CHIP_H}" rx="11" fill="${meta.color}" fill-opacity="0.22" stroke="${meta.color}" stroke-opacity="0.7" stroke-width="1"/>` +
        `<text x="${chipX + 9}" y="${rowY + CHIP_Y_OFF + 16}" font-family="DejaVu Sans" font-size="14" fill="${meta.color}">${escapeXml(label)}</text>`,
    );
    chipX += chipW + 8;
  }

  // Status text at the chips line's right end: ACTIVE or KO.
  if (!f.alive) {
    parts.push(
      `<text x="${COL_RIGHT(colX)}" y="${rowY + CHIP_Y_OFF + 17}" text-anchor="end" font-family="DejaVu Sans" font-size="18" font-weight="bold" fill="#ff6b6b">KO</text>`,
    );
  } else if (f.active) {
    parts.push(
      `<text x="${COL_RIGHT(colX)}" y="${rowY + CHIP_Y_OFF + 16}" text-anchor="end" font-family="DejaVu Sans" font-size="16" font-weight="bold" fill="#ffd54a">⚔ ACTIVE</text>`,
    );
  }

  return parts.join("\n");
}

/** The full overlay SVG, so tests can pin bar widths without pixel sampling. */
export function buildBattleCardSvg(input: BattleCardInput): string {
  const title = truncateToWidth(
    `⚔️ ${input.aName || "???"} vs ${input.bName || "???"}`,
    600,
    30,
    true,
  );
  const roundLabel =
    input.round <= 0
      ? "Battle Start"
      : `Round ${input.round}${input.roundsTotal > 0 ? ` / ${input.roundsTotal}` : ""}`;
  const wager = input.wager ?? 0;

  const aFighters = (input.aFighters ?? []).slice(0, 3);
  const bFighters = (input.bFighters ?? []).slice(0, 3);
  const aRows = aFighters.map((f, i) => fighterRowSvg(f, "A", i, LEFT_X)).join("\n");
  const bRows = bFighters.map((f, i) => fighterRowSvg(f, "B", i, RIGHT_X)).join("\n");

  const action = (input.actionLine ?? "").replace(/\s+/g, " ").trim();
  const actionText =
    action.length > 0
      ? truncateToWidth(action, 840, 18, false)
      : input.round <= 0
        ? "The battle begins!"
        : "";
  const actionY = input.footer ? 502 : 520;

  let footerSvg = "";
  if (input.footer) {
    const ft = input.footer;
    const line = `🏆 ${ft.winnerName} won in ${ft.roundsFought} turns!  •  +${safeInt(ft.winnerXp)} xp  •  Streak: ${safeInt(ft.winnerStreak)}`;
    const footerText = truncateToWidth(line, 820, 19, true);
    footerSvg =
      `<rect x="24" y="${BANNER_Y}" width="852" height="${BANNER_H}" rx="10" fill="#1f2937" stroke="#ffd54a" stroke-width="2"/>` +
      `<text x="450" y="${BANNER_Y + 24}" text-anchor="middle" font-family="DejaVu Sans" font-size="19" font-weight="bold" fill="#ffd54a">${escapeXml(footerText)}</text>`;
  }

  return `<svg width="${BATTLE_CARD_WIDTH}" height="${BATTLE_CARD_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="arena" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#232946"/>
      <stop offset="0.55" stop-color="#191d33"/>
      <stop offset="1" stop-color="#0e1120"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${BATTLE_CARD_WIDTH}" height="${BATTLE_CARD_HEIGHT}" fill="url(#arena)"/>
  <circle cx="820" cy="60" r="150" fill="#ffffff" fill-opacity="0.04"/>
  <circle cx="60" cy="520" r="170" fill="#ffffff" fill-opacity="0.03"/>
  <text x="30" y="48" font-family="DejaVu Sans" font-size="30" font-weight="bold" fill="#ffffff">${escapeXml(title)}</text>
  <text x="870" y="48" text-anchor="end" font-family="DejaVu Sans" font-size="24" font-weight="bold" fill="#ffffff">${escapeXml(roundLabel)}</text>
  ${wager > 0 ? `<text x="870" y="76" text-anchor="end" font-family="DejaVu Sans" font-size="16" fill="#ffd54a">Wager: ${safeInt(wager)} gold</text>` : ""}
  <line x1="30" y1="88" x2="870" y2="88" stroke="#ffffff" stroke-opacity="0.2" stroke-width="1"/>
  <text x="${LEFT_X}" y="${TEAM_LABEL_Y}" font-family="DejaVu Sans" font-size="19" font-weight="bold" fill="#7dd3fc">${escapeXml(truncateToWidth(input.aName || "???", 380, 19, true))}</text>
  <text x="${RIGHT_X}" y="${TEAM_LABEL_Y}" font-family="DejaVu Sans" font-size="19" font-weight="bold" fill="#fda4af">${escapeXml(truncateToWidth(input.bName || "???", 380, 19, true))}</text>
  ${aRows}
  ${bRows}
  ${actionText ? `<text x="30" y="${actionY}" font-family="DejaVu Sans" font-size="18" fill="#e8ecf1">${escapeXml(actionText)}</text>` : ""}
  ${footerSvg}
</svg>`;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render a 900x560 PNG battle card for one round (or the opening /
 * final frame). Missing monster art falls back to a "?" box — it
 * never throws. Throws a clear error if the PNG exceeds 5 MB.
 */
export async function renderBattleCard(input: BattleCardInput): Promise<Buffer> {
  const svg = buildBattleCardSvg(input);
  const overlayPng = await sharp(Buffer.from(svg)).png().toBuffer();

  const layers: OverlayOptions[] = [];
  const sides: Array<{ fighters: BattleCardFighter[]; colX: number }> = [
    { fighters: (input.aFighters ?? []).slice(0, 3), colX: LEFT_X },
    { fighters: (input.bFighters ?? []).slice(0, 3), colX: RIGHT_X },
  ];
  for (const { fighters, colX } of sides) {
    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i] as BattleCardFighter;
      if (!hasPortrait(f.name)) continue; // placeholder already in the SVG
      try {
        const portrait = await roundedPortrait(f.name, !f.alive);
        layers.push({
          input: portrait,
          left: colX,
          top: ROW_Y0 + i * (ROW_H + ROW_GAP) + 4,
        });
      } catch {
        // Fail-soft: the SVG placeholder stays visible instead.
        continue;
      }
    }
  }

  const png = await sharp(overlayPng).composite(layers).png().toBuffer();
  if (png.length > BATTLE_CARD_MAX_BYTES) {
    throw new Error(`Battle card exceeded 5 MB (${png.length} bytes)`);
  }
  return png;
}
