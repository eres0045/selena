# 01 — Core: prefix, help, economy basics

**Status: LIVE.** Prefix routing, the help system, and the economy basics
(balance, daily, give, leaderboard, levels/rank) are implemented in `src/`,
covered by tests, and deployed.

## 1.1 The prefix — how to talk to the bot

- The prefix is **`uwu`**, case-insensitive: `uwu bal`, `UWU bal`, `Uwu Bal`
  all work. (`src/lib/router.ts:22`, `parsePrefix` at `:116-118`.)
- The prefix must be followed by a **space or the end of the message**:
  `uwubal` is **not** a command.
- Leading spaces before `uwu` are fine. Command names are lowercased after
  parsing; aliases resolve case-insensitively.
- **Guild-only:** the bot ignores DMs, its own messages, and webhook
  messages. A handled prefix message gets **no XP and no automod check**.
- **Arguments are quote-aware:** double-quoted spans stay together as one
  token, quotes stripped — `uwu poll "Best game?" slots bj` →
  `["poll", "Best game?", "slots", "bj"]`. Single quotes have no special
  meaning. An unclosed quote just consumes to the end of input.
  (`src/lib/router.ts:78-101`.)
- **Bare `uwu`** (no command) replies:
  > Not sure what to do? Type `uwu help` to see all commands.
- **There are no slash commands.** On every startup the bot clears **all**
  application commands (global + guild), so the `/` picker stays empty.
  (`src/lib/router.ts:59`, `clearApplicationCommands` at `:363-392`.)

## 1.2 Unknown commands — human-sounding replies

Typing something the bot doesn't do **never** shows a bot-style error.
The router picks one of five casual lines at random, echoing the name typed:

1. `hmm, \`{name}\` isn't something I do — \`uwu help\` has everything I can do`
2. `` `{name}`? never heard of that one, try `uwu help`? ``
3. `nope, don't know \`{name}\` — check \`uwu help\``
4. `uhh, \`{name}\` isn't a thing… \`uwu help\` is the full list`
5. `sorry, \`{name}\` doesn't ring a bell — \`uwu help\` shows what I can do`

- If the attempted name is **empty or longer than 32 characters**, the
  generic fallback is used instead (no name echoed):
  > hmm, never heard of that one — try `uwu help`?
- (`src/lib/router.ts:28-52`.)
- If a command itself crashes, the reply is the small red error embed
  titled **"That didn't work"** with `Couldn't run that — try again in a bit.`

## 1.3 Help — `uwu help`

| | |
|---|---|
| Command | `uwu help [category or command]` |
| Aliases | `uwu h`, `uwu commands` |

- **Full list** (`uwu help`): one embed titled **"Command List"**, one field
  per category, each field showing **only the command names as `` `code` ``
  chips** — no descriptions, no aliases. The author block is the requesting
  user's display name + avatar. Categories, in order: 💰 Economy, 🎰 Casino,
  🗺️ Hunt, 🎮 Games, 🛡️ Moderation, 🔧 Utility, ❓ Help. The list is built
  from the live command registry, never hardcoded.
- **`uwu help <category>`** (e.g. `uwu help casino`): a filtered embed with
  only that category's box. Category match is checked **before** command
  match.
- **`uwu help <command>`** (e.g. `uwu help slots`): a plain-text detail —
  usage line (`` `uwu <name> <required> [optional] <rest...>` ``),
  description, and aliases line.
- **Unknown topic:** error embed —
  `Unknown command or category "<topic>". Categories: Economy, Casino, Hunt,
  Games, Moderation, Utility, Help. Try \`uwu help\` for the full list.`
- Quirk: help replies are marked `ephemeral: true` in code, but the
  text-path adapter strips interaction-only keys, so on the message path
  they post **publicly**, not ephemerally. (`src/commands/help.ts`,
  `src/lib/router.ts:287-290`.)
- If the embed ever exceeds 6,000 characters, it falls back to one embed per
  category.

## 1.4 Balance — `uwu balance`

| | |
|---|---|
| Command | `uwu balance [user]` |
| Aliases | `uwu bal`, `uwu money`, `uwu wallet` |

- **One short inline line** (plain text, OwO style):
  > Hey <@user>, you currently have 🪙 1,234 gold! (567 XP · Level 3)
- Showing another user's balance uses the same wording ("you currently
  have") with that user mentioned. No user argument = your own balance.
- **Starting balance for a new user: 0 gold, 0 XP, Level 0.**
- Balances are **per server** — your gold in one server is separate from
  another server. (`src/commands/economy.ts:15-31`, `src/lib/economy.ts`.)

## 1.5 Daily — `uwu daily`

| | |
|---|---|
| Command | `uwu daily` |
| Aliases | `uwu claim` |
| Amount | **100 gold** |
| Cooldown | **rolling 24 hours from your last claim** (not a UTC calendar day) |

- Success is an embed titled 🎁 **Daily Reward**:
  > 🪙 You claimed **100 gold**!
  > Your balance is now **<new balance> gold**. Come back tomorrow for more.
  > *Footer: uwu gold is fun-only — no real money.*
- Claiming again inside 24h gives an error embed:
  > You already claimed your daily gold. Come back <relative time>
  > (next claim <time>).
- The cooldown is per user **per server**.

## 1.6 Give — `uwu give`

| | |
|---|---|
| Command | `uwu give <user> <amount>` |
| Aliases | `uwu pay`, `uwu send`, `uwu transfer` |

- **Minimum amount: 1 gold. Maximum: none** (only your balance limits you).
- **Fee: none** — the full amount moves 1:1.
- **Self-give is blocked:** `You cannot give gold to yourself.`
- Error messages:
  - No target: `Please choose a member to give gold to.`
  - Bad amount: `Amount must be a positive whole number.`
  - Insufficient funds: `Insufficient gold.`
- Success (plain text):
  ```
  🤝 Gold Sent
  <@sender> gave 🪙 <amount> gold to <@target>.
  Your balance: <senderBal> gold · <target>'s balance: <receiverBal> gold
  ```
- The transfer is atomic (single conditional debit), so a sender can never
  go below 0, and both sides are written to the `point_ledger`.

## 1.7 Leaderboard — `uwu leaderboard`

| | |
|---|---|
| Command | `uwu leaderboard` |
| Aliases | `uwu lb`, `uwu top`, `uwu rich` |

- **Top 10 gold holders in this server**, highest first (ties broken by user
  ID ascending). Medals 🥇/🥈/🥉 for ranks 1–3, numbers after that. Each line:
  `<@user> — <points> gold (Level <level>)`.
- Empty board:
  > 🏆 Leaderboard
  > Nobody has any gold yet. Claim your `uwu daily` to get started!
- See also `uwu leaderboard-xp` (top 10 by XP) in
  [06-command-reference.md](06-command-reference.md).

## 1.8 Levels & rank — `uwu rank`

| | |
|---|---|
| Command | `uwu rank [user]` |
| Aliases | `uwu level`, `uwu xp` |

- **XP comes from chatting only: 5–15 XP per message**, with a **60-second
  cooldown per user per server**. Prefix-command messages earn no XP.
  (`src/index.ts:254-255`, `src/lib/levels.ts:64-66,103-107`.)
- **Level thresholds** (cumulative XP to reach a level; formula
  `5·L² + 50·L + 100` for L ≥ 1): L1 = **155**, L2 = **220**, L3 = **295**,
  L4 = **380**, L5 = **475**, L10 = **1,100**, L20 = **3,100**, L50 = **15,100**.
- On level-up the bot posts in the channel:
  > 🎉 <@user> leveled up to **level <n>**!
- `uwu rank` shows a plain-text card:
  ```
  Rank — <username>
  Level: <level> · XP: <totalXp> / <xpForNextLevel>
  Progress: [██████░░░░] 60%
  <xpIntoLevel> XP into this level — <xpNeeded> to go
  ```
  The progress bar is 10 cells wide. Chat level gates the hunt areas
  (see [03-hunt-world.md](03-hunt-world.md)).

## 1.9 Errors — the one error format

Every error is the same small red embed (`0xef4444`): title
**"That didn't work"**, message as the description. Normal embeds are violet
(`0x8b5cf6`). There is no per-command permission/role model on the Command
type — commands that need Discord permissions (moderation) check them
internally.

## 1.10 Startup & intents (for reference)

- Intents: `Guilds`, `GuildMessages`, `GuildMembers`, `MessageContent`.
  Partials: `Message`, `Reaction`, `User`, `Channel`, `GuildMember`.
- Startup fails fast if the database schema can't be ensured, before login.
  Login is skipped entirely when no `DISCORD_TOKEN` is set (commands are
  still validated).
- A 60-second timer runs due tasks (reminders + giveaways).

## Verified

- **Tests:** `npm test` 2026-11-07 — 357/357 passed (15 files), including
  `test/prefix.test.ts`, `test/help.test.ts`, `test/economy.test.ts`,
  `test/rename.test.ts`.
- **Code read:** `src/lib/router.ts`, `src/commands/help.ts`,
  `src/commands/economy.ts`, `src/lib/economy.ts`, `src/lib/levels.ts`,
  `src/lib/command.ts`, `src/index.ts` (scoped parts). Every number above
  cites its source file:line in the research notes; the guide states the
  number as implemented.
- **Live Discord check: NOT DONE** (no browser access in this session).
  To verify live in `#🤖-miya-bot`: `uwu`, `uwu help`, `uwu help casino`,
  `uwu bal`, `uwu daily`, `uwu give @user 1`, `uwu lb`, `uwu rank`,
  `uwu notacommand`.
