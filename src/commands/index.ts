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
import * as hunt from "./hunt.js";
import * as games from "./games.js";
import * as mod from "./mod.js";
import * as utility from "./utility.js";
import * as help from "./help.js";
import * as world from "./world.js";
import * as guilds from "./guilds.js";
import * as battle from "./battle.js";
import * as feeds from "./feeds.js";
import * as towers from "./towers.js";
import * as market from "./market.js";
import * as profile from "./profile.js";
import * as quests from "./quests.js";

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
  hunt: "Hunt",
  games: "Games",
  world: "World",
  guilds: "Guilds",
  battle: "Battles",
  feeds: "Announcements",
  towers: "Towers",
  market: "Market",
  profile: "Profile",
  quests: "Quests",
};

interface CommandModule {
  commands?: Command[];
  buttonHandlers?: Record<string, (...args: never[]) => Promise<unknown>>;
  modalHandlers?: Record<string, (...args: never[]) => Promise<unknown>>;
}

const MODULES: { key: string; module: CommandModule }[] = [
  { key: "economy", module: economy },
  { key: "casino", module: casino },
  { key: "hunt", module: hunt },
  { key: "games", module: games },
  { key: "mod", module: mod },
  { key: "utility", module: utility },
  { key: "help", module: help },
  // Phase 2: world (map/travel/auto-hunt) before feeds so `uwu map`
  // resolves to the world map; feeds after mod so `uwu logs` resolves
  // to the rare-catch feed, not mod's modlog (alias now "modlogs").
  { key: "world", module: world },
  { key: "guilds", module: guilds },
  { key: "battle", module: battle },
  { key: "feeds", module: feeds },
  { key: "towers", module: towers },
  { key: "market", module: market },
  { key: "profile", module: profile },
  { key: "quests", module: quests },
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
