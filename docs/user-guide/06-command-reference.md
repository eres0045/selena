# 06 — Command reference (all 42) + misc live systems

**Status: LIVE.** Every command below is implemented in `src/`, in the live
registry (`src/commands/index.ts`), and deployed. Counted from the registry:
**42 commands** across 7 modules.

> Note: an old comment in `src/commands/help.ts:60` still says "all 36
> commands fit" — stale; the live registry is 42.

## 6.1 Full command table

### Economy (4) — details in [01-core.md](01-core.md)

| Command | Aliases | Args | Notes |
|---|---|---|---|
| `balance` | `bal`, `money`, `wallet` | `[user]` | One-line balance; starts at 0 |
| `daily` | `claim` | — | +100 gold, rolling 24h cooldown |
| `give` | `pay`, `send`, `transfer` | `<user> <amount>` | Min 1, no max, no fee, no self-give |
| `leaderboard` | `lb`, `top`, `rich` | — | Top 10 gold holders, per server |

### Casino (7) — details in [02-casino.md](02-casino.md)

| Command | Aliases | Args | Notes |
|---|---|---|---|
| `slots` | `slot`, `spin` | `<bet>` | 777 = 50x, 3-of-a-kind 10x, pair 2x |
| `blackjack` | `bj`, `21` | `<bet>` | Dealer stands on 17; blackjack 2.5x; Hit/Stand buttons |
| `roulette` | `roul` | `<bet> <bet-on>` | European 0–36; red/black/even/odd 2x, number 36x |
| `coinflip` | `cf`, `flip`, `coin` | `<bet> <guess>` | Guess exactly `heads`/`tails`; win 1.9x |
| `highlow` | `hl` | `<bet>` | Streak ladder 1.8x→11x then ×1.5/step; Same ≥10x; Cash Out button |
| `mines` | `mine` | `<bet> [mines]` | 3×3 grid, 1–5 mines (default 3); Cash Out button |
| `scratch` | `scratchcard`, `sc` | `<bet>` | 3 match 5x, 2 match 1x |

### Hunt (6) — details in [03-hunt-world.md](03-hunt-world.md)

| Command | Aliases | Args | Notes |
|---|---|---|---|
| `hunt` | `catch` | `[area]` | 30s cooldown; Catch/Run buttons; level-gated areas |
| `roll` | `gacha`, `summon` | `[count]` | 500 gold; `roll 10` = 4,500; pity 50; cap 20/day (UTC) |
| `map` | `areas` | — | 4 areas, unlock levels 0/5/10/15 |
| `zoo` | `monsters` | `[name]` | Grouped by tier, 40-line cap; detail per monster |
| `inv` | `inventory`, `bag` | — | Weapons + pets; **empty for everyone in Phase 1** |
| `sell` | `selldup` | `<monster>` | Tier prices 25–25,000; last-copy confirm |

### Games (7)

| Command | Aliases | Args | Notes |
|---|---|---|---|
| `tictactoe` | `ttt`, `tic` | `<opponent>` | Challenger ❌ first; no timeout, no gold reward |
| `connect4` | `c4`, `connectfour` | `<opponent>` | 6×7 board, 🔴 first; no timeout, no gold reward |
| `rps` | `rockpaperscissors`, `rock` | `<opponent>` | Best of 1; picks hidden until both in; no timeout, no reward |
| `trivia` | `quiz` | — | **+25 gold**, 30 s limit, first correct answer wins; anyone can answer; 22-question hardcoded bank |
| `wordchain` | `wc`, `word` | `[word]` | ≥3 letters, a–z only, start with last letter, no repeats; one chain per guild; no timeout, no end command, no reward |
| `giveaway` | `gaway`, `gw` | `<prize> <duration> <winners>` | Prize ≤200 chars; duration 1–10,080 min (7 days); winners 1–10; one entry per user; auto-draw on a 60 s sweep |
| `poll` | `vote` | `<question> <option1> <option2> [option3] [option4]` | 2–4 options, all different; one vote per person, click again to change; 10-char bars; no expiry, no close command |

### Moderation (10)

All success replies are plain text; denials/errors use the red error embed.
Permission checks use Discord permissions; denial is an error-embed reply.
**The DB record is written before the Discord action**, so a failed Discord
call still leaves a DB record.

| Command | Aliases | Permission | Args / behaviour |
|---|---|---|---|
| `warn` | `warning` | ModerateMembers | `<user> <reason...>` — records warning + mod action, reply `User warned … (#<id>)` |
| `mute` | `silence` | ModerateMembers | `<user> <duration-minutes> <reason...>` — Discord timeout `minutes × 60,000`; **no min/max validation** (no 28-day cap enforced; 0/negative not rejected) |
| `timeout` | `to` | ModerateMembers | Identical to `mute` except the action is logged as `"timeout"` |
| `kick` | `boot` | KickMembers | `<user> <reason...>` |
| `ban` | `hammer` | BanMembers | `<user> [delete-days] <reason...>` — delete-days default 0; **no max validation** |
| `unban` | `pardon` | BanMembers | `<user-id> [reason]` — takes a **string user ID, not a mention**; reason defaults to `"No reason given"` |
| `warnings` | `warns`, `infractions` | ModerateMembers | `<user>` — lists all warnings, newest first, no limit |
| `modlog` | `mlog`, `logs` | ModerateMembers | `[limit]` — recent mod actions, newest first; **default limit 10**, no max validation |
| `ticket` | `support` | **None — no permission check** | `<open\|close> [reason]` — one open ticket per user; `open` creates a channel named `ticket-<id>`; `close` closes the caller's latest open ticket; **no channel deletion/archiving** |
| `reactionrole` | `rr`, `reactrole` | ManageRoles | `<message-id> <emoji> <role>` — upserts by (guild, message, emoji); reacting grants the role, un-reacting removes it |

### Utility (7)

| Command | Aliases | Args | Notes |
|---|---|---|---|
| `userinfo` | `ui`, `whois`, `user` | `[user]` | Username, Discord ID, Level, XP, AFK. No join date, roles, or account age |
| `avatar` | `av`, `pfp` | `[user]` | Plain-text reply with the avatar URL only (no embed, no attached image) |
| `serverstats` | `serverinfo`, `stats`, `server` | — | Members, channels, Top 5 by XP, Top 5 by gold |
| `afk` | `away` | `[reason...]` | With a reason: sets AFK. **With no reason: clears AFK.** AFK is visible only via `uwu userinfo` — **no mention reply, no auto-clear** exists anywhere |
| `remind` | `reminder`, `remindme` | `<minutes> <text...>` | Due at now + minutes; delivered by the 60 s sweep as `<@user> ⏰ Reminder: <text>`; **no min/max validation** (0/negative = due immediately) |
| `rank` | `level`, `xp` | `[user]` | Level, XP, 10-cell progress bar; see [01-core.md §1.8](01-core.md#18-levels--rank--uwu-rank) |
| `leaderboard-xp` | `lbxp`, `xplb`, `top-xp` | — | Top 10 by XP |

### Help (1)

| Command | Aliases | Args | Notes |
|---|---|---|---|
| `help` | `h`, `commands` | `[category or command]` | Full list embed, category boxes, per-command detail; see [01-core.md §1.3](01-core.md#13-help--uwu-help) |

## 6.2 Trivia — question bank quirk

The bank (`src/lib/trivia.ts`, `GENERAL_QUESTIONS`) holds **22 general-knowledge
questions, each with exactly 4 options**. Notable: **every question has
`answerIndex: 0`** — the correct answer is always option A in the bank as
written (no shuffling in code). The buttons presumably shuffle display order
— this is not verified in the code read; if they don't, the answer is always
the first button. (Flagged as a finding, §6.7.)

## 6.3 Starboard — the repost embed

- **Trigger: ANY reaction, not just ⭐.** The `MessageReactionAdd` handler
  runs the starboard check for whatever reaction was added, using that
  reaction type's count. There is no emoji check.
- **Threshold: 3 reactions by default** (`starboard_threshold` from
  `guild_settings`, default 3). Posts only on the first crossing; the count
  is recorded/updated in `starboard_posts` on every qualifying add.
- **Repost contents:** an embed titled `⭐ <count> — starboard`, description
  = the original message content truncated to **2,000 characters** (or
  `"(no text)"`), footer `by <username> in #<channel>`; plus a plain-text
  jump link to the original message.
- **Where it posts:** the channel in `guild_settings.starboard_channel_id`.
  **If that is unset, nothing posts** (the count is still recorded). No update
  when the count grows further, and **no removal on reaction-remove**.
- **Is it the only embed the bot sends? No.** Other embeds: the red
  `errorEmbed` ("That didn't work"), the help embed, the daily-reward embed,
  and the Mythic/UwU catch embed. Within games/mod/utility, success replies
  are plain text and only errors are embeds.

## 6.4 Automod

Pure functions in `src/lib/automod.ts`, wired in `src/index.ts`. No settings
command exists — everything below is hardcoded.

- **Banned words (7):** `damn, hell, shit, fuck, bitch, bastard, crap`.
  Whole-word, case-insensitive match.
- **Spam:** ≥ **5 messages within 5,000 ms**.
- **Links:** flagged by default (`allowLinks: false`); allowed domains are
  **`discord.gg` and `discord.com`** (suffix match, so subdomains count).
- **Live action: DELETE.** A violation deletes the message (no XP, no
  warning reply, no DM, no `mod_actions` record). A "warn" branch exists in
  code but is unreachable with the current settings.
- **Not consulted:** `guild_settings` is not used for automod.

## 6.5 Timers & background work

- One **60-second interval** runs `runDueTasks`: due reminders + due
  giveaways.
- **Giveaway draw:** when `ends_at` passes, the row is marked ended and
  winners are picked by Fisher–Yates partial shuffle, capped at the number
  of entries (0 entries → log only, no announcement). Winners are announced
  as mentions in the giveaway channel.
- **Giveaway/poll caveat:** creation stores `channel_id = ""`, so the sweep's
  channel fetch for the announcement is expected to fail/be logged rather
  than post — the draw still marks the giveaway ended and picks winners in
  the DB path. (Flagged as a finding, §6.7.)

## 6.6 Other live behaviour

- **Message XP:** 5–15 XP per message, 60 s cooldown per user per server;
  level-up posts `🎉 <@user> leveled up to **level <n>**!` in-channel.
  Prefix-command messages earn no XP.
- **Welcome messages: none.** No `GuildMemberAdd` handler exists.
  `guild_settings.welcome_channel_id` is a schema column that is **never
  read anywhere in `src/`**. Same for `modlog_channel_id`,
  `ticket_category_id`, `staff_channel_id`, `log_channel_id` — columns only,
  no live use found.
- **Reaction roles:** role added on reaction-add, removed on reaction-remove
  (emoji key = custom-emoji ID or unicode character). No role-hierarchy check
  in code beyond the setup command's `ManageRoles`.
- **Interactions:** buttons and modals only, routed by the first two
  `selena:<feature>` customId segments.
- **No AFK mention reply or auto-clear; no goodbye handler; no auto-role on
  join.**

## 6.7 Findings / gaps

Things the code read turned up that differ from what a user or the design
docs might expect. None of these were fixed (docs-only job); they are
recorded here for Ronit.

1. **Trivia answers are always option A in the bank** (`answerIndex: 0` on
   all 22 questions; no shuffling in the bank code). Whether the buttons
   shuffle at display time was not verified.
2. **Giveaway and poll creation store `channel_id = ""`**, so their
   channel-based announcements/sweeps cannot fetch a channel as written.
3. **AFK does nothing on mention** — no auto-reply, no auto-clear; visible
   only via `uwu userinfo`.
4. **Welcome/modlog/ticket-category/staff/log channel settings are
   columns only** — never read; setting them has no effect.
5. **No timeouts/expiry** for tic-tac-toe, Connect 4, RPS, wordchain, or
   polls; no end/close command for wordchain or polls; no gold rewards for
   TTT/C4/RPS/wordchain/polls.
6. **No min/max validation** for mute/timeout minutes, ban `delete-days`,
   modlog `limit`, or remind minutes.
7. **Help comment is stale** ("all 36 commands fit") — the registry is 42.
8. **Starboard triggers on ANY reaction**, not just ⭐.
9. **Automod's warn branch is unreachable** with current settings (all
   violations delete).
10. **Mod DB records are written before the Discord action** — a failed
    Discord call still leaves a DB record.
11. **Ticket command has no permission check** (anyone can open a ticket).

## Verified

- **Tests:** `npm test` 2026-11-07 — 357/357 passed (15 files), including
  `test/games.test.ts`, `test/mod.test.ts`, `test/utility.test.ts`,
  `test/boot.test.ts`.
- **Code read:** `src/commands/games.ts`, `src/commands/mod.ts`,
  `src/commands/utility.ts`, `src/lib/games.ts`, `src/lib/trivia.ts`,
  `src/lib/automod.ts`, `src/index.ts`, plus `src/lib/db.ts`,
  `src/lib/levels.ts`, `src/lib/command.ts`, `src/commands/index.ts` for
  inventory verification. The 42-command inventory was counted from the
  live registry.
- **Live Discord check: NOT DONE** (no browser access in this session).
  To verify live in `#🤖-miya-bot`: `uwu ttt @user`, `uwu trivia`,
  `uwu poll "Q?" "A" "B"`, `uwu userinfo`, `uwu serverstats`,
  `uwu rank`, `uwu remind 1 test`, `uwu afk testing`, and a ⭐ reaction
  (×3) on a message to check the starboard. Mod commands need a staff
  member to test; do not test kick/ban on real users.
