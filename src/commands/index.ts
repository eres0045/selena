import type { Command } from "../lib/command.js";

// Registry aggregating ALL Selena commands.
//
// Each worker module is imported as a namespace so a module that does not
// export `buttonHandlers`/`modalHandlers` still contributes its commands
// (the `?? {}` fallback below). Do NOT add stub files for other workers:
// import only modules that exist on disk.
//
// Status at registry time (2026-11-06): nine command modules. The MLBB
// stats module was removed the same day (no verifiable stats exist — no
// official MLBB API).
// 2026-11-07: ALL MLBB features removed on Ronit's order (the bot is
// becoming an OwO alternative) — gacha (/roll, /collection, /trade,
// /gacha-leaderboard), squads/lineups/scrims/tryouts/brackets/matches/
// draft, /guesshero and the MLBB trivia category are gone, with their
// lib/data/tests. The Supabase tables stay (dormant, no data deleted).
// Each module must export `commands: Command[]` and (optionally)
// `buttonHandlers` / `modalHandlers`.
import * as economy from "./economy.js";
import * as casino from "./casino.js";
import * as fun from "./fun.js";
import * as games from "./games.js";
import * as mod from "./mod.js";
import * as utility from "./utility.js";
import * as help from "./help.js";

/** Command modules that do not exist yet (empty when the registry is complete). */
export const PENDING_MODULES: readonly string[] = [];

export interface HelpGroup {
  category: string;
  commands: { name: string; description: string; aliases: string[] }[];
}

const CATEGORY_LABELS: Record<string, string> = {
  mod: "Moderation",
  utility: "Utility",
  help: "Help",
  economy: "Economy",
  casino: "Casino",
  fun: "Fun",
  games: "Games",
};

interface CommandModule {
  commands?: Command[];
  buttonHandlers?: Record<string, (...args: never[]) => Promise<unknown>>;
  modalHandlers?: Record<string, (...args: never[]) => Promise<unknown>>;
}

const MODULES: { key: string; module: CommandModule }[] = [
  { key: "economy", module: economy },
  { key: "casino", module: casino },
  { key: "fun", module: fun },
  { key: "games", module: games },
  { key: "mod", module: mod },
  { key: "utility", module: utility },
  { key: "help", module: help },
];

function toHelpGroup(key: string, cmds: Command[]): HelpGroup {
  return {
    category: CATEGORY_LABELS[key] ?? key,
    commands: cmds.map((c) => ({ name: c.name, description: c.description, aliases: c.aliases })),
  };
}

export const allCommands: Command[] = MODULES.flatMap((m) => m.module.commands ?? []);

export const allButtonHandlers: Record<string, (...args: never[]) => Promise<unknown>> = Object.assign(
  {},
  ...MODULES.map((m) => m.module.buttonHandlers ?? {}),
);

export const allModalHandlers: Record<string, (...args: never[]) => Promise<unknown>> = Object.assign(
  {},
  ...MODULES.map((m) => m.module.modalHandlers ?? {}),
);

/** Grouped command list for `uwu help` — built from the live registry, never hardcoded. */
export const HELP_GROUPS: HelpGroup[] = MODULES.filter((m) => (m.module.commands?.length ?? 0) > 0).map((m) =>
  toHelpGroup(m.key, m.module.commands ?? []),
);
