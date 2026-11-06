# Selena — Discord bot for Zenith Esports (MLBB)

Selena is a custom Discord bot (discord.js v14 + TypeScript, Node 24) for the
Zenith Esports MLBB server: a fun-only points economy, casino,
squad/scrim management, gacha, games, moderation, levels/XP, and utility
commands. **No real money anywhere** — points are fun-only, and there are no
anime actions and no hunting features.

All output is text/embeds — no image generation (no canvas in this
environment).

## Commands (58 total)

### Economy — `/balance`, `/daily`, `/give`, `/leaderboard`
Points wallet, daily claim, tipping, points leaderboard.

### Casino — `/slots`, `/blackjack`, `/roulette`, `/coinflip`, `/highlow`, `/scratch`
Fun-only points gambling with buttons (blackjack hit/stand). No real money.

### Fun — `/8ball`, `/meme`, `/ship`, `/rate`, `/joke`, `/roast`, `/compliment`, `/wouldyourather`, `/truthordare`, `/uwu`, `/profile`
Profile cards, jokes, shipping, and party commands.

### Games — `/tictactoe`, `/connect4`, `/rps`, `/trivia`, `/wordchain`, `/guesshero`, `/giveaway`, `/poll`
Button-driven board games, trivia, giveaways (auto-ended by the bot timer),
and polls.

### Manage — `/squad`, `/lineup`, `/scrim`, `/tryout`, `/bracket`, `/report-match`, `/draft`
Squads, lineups, scrims + RSVPs, tryouts, tournament brackets, match
reports, and hero drafts.

### Gacha — `/roll`, `/collection`, `/trade`, `/gacha-leaderboard`
Card rolls with pity, collections, trading, and a gacha leaderboard.

### Moderation — `/warn`, `/mute`, `/timeout`, `/kick`, `/ban`, `/unban`, `/warnings`, `/modlog`, `/ticket`, `/reactionrole`
Warnings and mod actions are recorded in SQLite (`warnings` /
`mod_actions`). `/mute` and `/timeout` apply a Discord timeout; `/kick`,
`/ban`, `/unban` use the Discord API; every mutating command requires the
matching permission (`ModerateMembers` / `KickMembers` / `BanMembers` /
`ManageRoles`) and records the action even if the live Discord call fails.
`/ticket` opens/closes support tickets, `/reactionrole` maps an emoji on a
message to a role (reactions grant/remove it automatically), and the
starboard posts messages that reach the star threshold (default 3 ⭐).

### Utility — `/userinfo`, `/avatar`, `/serverstats`, `/afk`, `/remind`, `/rank`, `/leaderboard-xp`
User info, avatars, server stats + top XP/points, AFK status (stored in
`users`), reminders (`/remind <minutes> <text>`, delivered by the bot's
60-second sweep), rank cards, and the XP leaderboard (top 10 by XP — the
points `/leaderboard` is separate).

### Help — `/help [category]`
Lists every command grouped by category, generated from the live command
registry — never a hardcoded list, so it stays in sync automatically.

## Levels & XP

- Chatting earns **5–15 XP per message** with a **60-second per-user
  cooldown**. Level-ups are announced in the channel.
- XP curve (cumulative XP to reach a level): `xpForLevel(0) = 0`,
  `xpForLevel(level) = 5·level² + 50·level + 100` for level ≥ 1 — so L1 = 155,
  L2 = 220, L3 = 295, L5 = 475, L10 = 1100. The gap between levels grows
  linearly, so levelling slows down gently.
- `/rank` shows a text progress bar; `/leaderboard-xp` shows the top 10.

## Auto-mod

Runs on every message (configurable defaults in `src/index.ts`):
banned-word list (common English profanity), spam detection (5+ messages in
5s), and a link filter (links flagged unless the host is allow-listed, e.g.
`discord.gg`). Violations delete the message; `warnOnly` mode warns instead.
Pure functions live in `src/lib/automod.ts` (`containsBannedWord`,
`isSpam`, `containsLink`, `checkMessage`) plus the starboard helper
`checkStarboard`.

## How to run

```bash
npm install
cp .env.example .env   # then fill in DISCORD_TOKEN (see below)
npm run dev            # tsx src/index.ts
# or production:
npm run build
npm start              # node dist/index.js
```

Environment variables (`.env` file, or real env vars — `.env` never
overrides real env):

| Variable | Required | Notes |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token from the Discord Developer Portal |
| `GUILD_ID` | no | Guild-scoped slash commands (instant); without it, commands register globally (up to ~1h to appear) |
| `DATABASE_PATH` | no | SQLite file (default `./selena.db`) |

Without `DISCORD_TOKEN` the bot prints
`Selena: no DISCORD_TOKEN set — skipping login (commands validated only)`
and exits 0 without attempting a login.

Tests: `npm test` (vitest) and `npx tsc --noEmit`.

## How to deploy on Render

1. Push the repo to GitHub (private is fine).
2. Render → **New → Web Service**, connect the repo.
3. **Build command:** `npm install && npm run build`
4. **Start command:** `npm start`
5. **Environment variables:** `DISCORD_TOKEN` (required), `GUILD_ID`
   (optional). Use a persistent disk or accept that the free tier's
   ephemeral filesystem resets the SQLite file on each deploy/restart —
   for real persistence, use Render's persistent disk or an external DB.
6. Honest note: **Render free sleeps after 15 minutes idle**, so the bot
   will go offline until the next HTTP request wakes it. Either ping the
   service's URL every 5 minutes with UptimeRobot (free) or use a **$7/mo
   Starter** instance, which never sleeps.

## Discord setup still owed (token / invite steps)

1. Discord Developer Portal → **New Application** named **Selena**.
2. **Bot** → **Reset Token** → copy the token into the `DISCORD_TOKEN`
   env var (Render, or local `.env`). Never commit it.
3. **Bot → Privileged Gateway Intents:** enable **Server Members Intent**
   and **Message Content Intent** (Selena needs both: member events for
   reaction roles, message content for XP/auto-mod).
4. **OAuth2 → URL Generator:** scopes `bot` + `applications.commands`;
   bot permissions: Send Messages, Manage Messages, Read Message History,
   Add Reactions, Manage Roles, Kick Members, Ban Members, Moderate
   Members (timeout), Manage Channels (ticket channels), Embed Links,
   Use External Emojis.
5. Open the generated URL, pick the Zenith Esports server, authorize.
6. Optional: set `GUILD_ID` to the server ID for instant command sync
   while developing.

## Project layout

```
src/
  index.ts            entrypoint: client, routing, XP/auto-mod, reactions,
                      starboard, 60s reminder/giveaway sweep
  lib/                db.ts (SQLite), rng.ts, command.ts (Command type +
                      embeds), testkit.ts (fakes), levels.ts (XP curve),
                      automod.ts (auto-mod + starboard), <feature libs>
  commands/           one file per feature area + index.ts (registry:
                      allCommands / allButtonHandlers / allModalHandlers /
                      HELP_GROUPS)
test/                 vitest suites, one per feature area + boot.test.ts
```

## Known issues (as of 2026-11-06)

1. **MLBB stats module — removed 2026-11-06.** `/hero`, `/counter`,
   `/register-mlbb`, `/verify-mlbb`, `/mlbbprofile` and `/rankrole` were
   built on a static hero snapshot, but win/pick/ban rates, counters,
   builds, live profiles and Moonton verification cannot be verified
   (there is no official public MLBB API), so the whole module was
   removed rather than shipped with unverifiable claims. What stays
   MLBB-flavoured is all Selena's own: the gacha card catalogue
   (hero names + Selena-assigned rarities, `src/data/heroes.ts`),
   `/guesshero`, MLBB trivia, the tryout form (self-reported IGN/rank),
   and the draft helper's hero-name list. `boot.test.ts` asserts
   command-name uniqueness.
2. **`npm test` vs `node:sqlite` — fixed via alias.** Root cause (verified in
   `node_modules/vite-node`): vite-node 2.1's `isNodeBuiltin` strips the
   `node:` prefix and then looks up the bare name in a set that only
   contains `node:sqlite` — `node:sqlite` is the only builtin with no bare
   form, so it was never recognised as a builtin and Vite tried to load a
   package literally called `sqlite`. Every suite failed identically
   (including a minimal `import { DatabaseSync } from "node:sqlite"` probe).
   Fix: `vitest.config.ts` aliases the stripped specifier `sqlite` to
   `vitest.sqlite-shim.mjs`, which pulls the real builtin in at runtime via
   `createRequire`. This survives reinstalls (no `node_modules` patching).
   The long-term fix is upgrading vitest to v3 (Vite 6, fixed upstream).
