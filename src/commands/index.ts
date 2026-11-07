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
// official MLBB API), so hero names live only in src/data/heroes.ts as a
// gacha/draft catalogue.
// Each module must export `commands: Command[]` and (optionally)
// `buttonHandlers` / `modalHandlers`.
import * as economy from "./economy.js";
import * as casino from "./casino.js";
import * as fun from "./fun.js";
import * as games from "./games.js";
import * as manage from "./manage.js";
import * as gacha from "./gacha.js";
import * as mod from "./mod.js";
import * as utility from "./utility.js";
import * as help from "./help.js";
// TEMPORARY (2026-11-07): owner-only test-points grant — remove with
// src/commands/grantpoints.ts and test/grantpoints.test.ts after the
// casino visual test.
import * as grantpoints from "./grantpoints.js";

/** Command modules that do not exist yet (empty when the registry is complete). */
export const PENDING_MODULES: readonly string[] = [];

export interface HelpGroup {
  category: string;
  commands: { name: string; description: string }[];
}

const CATEGORY_LABELS: Record<string, string> = {
  mod: "Moderation",
  utility: "Utility",
  help: "Help",
  economy: "Economy",
  casino: "Casino",
  fun: "Fun",
  games: "Games",
  manage: "Manage",
  gacha: "Gacha",
  grantpoints: "Owner",
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
  { key: "manage", module: manage },
  { key: "gacha", module: gacha },
  { key: "mod", module: mod },
  { key: "utility", module: utility },
  { key: "help", module: help },
  // TEMPORARY — remove after the casino visual test.
  { key: "grantpoints", module: grantpoints },
];

function toHelpGroup(key: string, cmds: Command[]): HelpGroup {
  return {
    category: CATEGORY_LABELS[key] ?? key,
    commands: cmds.map((c) => ({ name: c.data.name, description: c.data.description })),
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

/** Grouped command list for /help — built from the live registry, never hardcoded. */
export const HELP_GROUPS: HelpGroup[] = MODULES.filter((m) => (m.module.commands?.length ?? 0) > 0).map((m) =>
  toHelpGroup(m.key, m.module.commands ?? []),
);
