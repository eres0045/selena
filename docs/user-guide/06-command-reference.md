# 06 — Command reference (all 58) + misc live systems

**Status: LIVE.** Every command below is implemented in `src/`, in the live
registry (`src/commands/index.ts`), and deployed. Counted from the registry:
**58 commands** across 13 modules.

## 6.1 Full command table

### Economy (4) — details in [01-core.md](01-core.md)

| Command | Aliases | Args | Notes |
|---|---|---|---|
| `balance` | `bal`, `money`, `wallet` | `[user]` | One-line balance, now with gems: `🪙 N gold! (💎 M gems · XP · Level)`; starts at 0 |
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
| `hunt` | `catch` | `[area]` | 30s cooldown; Catch/Run buttons; level-gated areas; wild levels by area |
| `roll` | `gacha`, `summon` | `[count]` | 500 gold; `roll 10` = 4,500; pity 50 → **Epic exactly**; cap 20/day (UTC) |
| `zoo` | `monsters` | `[name]` | Grouped by tier, 40-line cap; detail per monster incl. level, fusion, XP |
| `inv` | `inventory`, `bag` | — | Weapons + pets |
| `sell` | `selldup` | `<monster>` | Tier prices 25–25,000; last-copy confirm |
| `fuse` | `combine` | `<monster>` | 2 same-fuse-level copies → 1 stronger, max +6 (64 copies); gold cost by tier |

### World (3) — Phase 2, details in [05-phase2-design-index.md](05-phase2-design-index.md)

| Command | Aliases | Args | Notes |
|---|---|---|---|
| `map` | `areas` | — | World map: 5 regions, 16 areas; current location 🔴; Zoom In/Out/Mark/Last Location buttons |
| `travel` | `go` | `[area]` | Travel in real time, 5 min/km; bare `uwu travel` = trip status |
| `autohunt` | `auto-hunt` | `on\|off` | Auto-hunt while travelling, 200 gold/hour pro-rata; needs an active trip |

### Guilds (1) — Phase 2

| Command | Aliases | Args | Notes |
|---|---|---|---|
| `guild` | `g` | `<action> [target] [name...]` | `create <name>` (5,000 gold), `join`, `leave`, `invite @user`, `kick @user`, `promote @user`, `disband`, `info`, `rank`; max 20 members, levels to 10 |

### Battles (1) — Phase 2

| Command | Aliases | Args | Notes |
|---|---|---|---|
| `battle` | `fight`, `duel` | `<@user> [wager]` | Accept/Decline buttons, 60 s expiry; auto top-3; winner 100 gold + XP, loser 25; wager cap 1,000 escrowed; 1-min cooldown |

### Towers (2) — Phase 2

| Command | Aliases | Args | Notes |
|---|---|---|---|
| `tower` | `towers` | `[action] [target]` | Bare = list (undiscovered towers show as `???`, Main never listed); `enter <name>`, `climb`, `leave`; detail shows only cleared floors + current floor, future floors `???`; checkpoints every floor; clear cooldowns 6h/12h/7d |
| `explore` | `discover` | — | Explore your current area — 40% to discover an undiscovered tower there, 60 s cooldown, no level gate; 5–15 gold consolation when the area is fully discovered; refused while travelling |

### Market (5) — Phase 2

| Command | Aliases | Args | Notes |
|---|---|---|---|
| `auction` | `auctions` | `<action> [args]` | `sell <item> <price>` (min 100), `bid <id> <amount>` (min +10%), `list`, `info <id>`, `cancel <id>`, `mine`; 24h, 5% fee, escrowed bids |
| `shop` | `store` | `[buy <item> [qty]]` | Daily stock, same for everyone, midnight UTC; max 3 per item per player per day; gold + gems |
| `crates` | `crate` | — | List owned crates |
| `open` | `opencrate` | `<crate>` | Open one crate, reveal loot |
| `gems` | `gem` | — | Gem balance + how to earn gems |

### Announcements (4) — Phase 2

| Command | Aliases | Args | Notes |
|---|---|---|---|
| `announcements` | `news` | — | Global update feed, latest 10 |
| `announce` | `broadcast` | `<title> \| <text>` | Admin only; posts to the global feed |
| `logs` | `rarelogs` | `[global]` | Epic+ rare-catch feed, per-server default; `uwu logs global` for all-Discord |
| `setlogchannel` | `setlogs` | `<#channel>` | Admin only; Epic+ catches auto-posted there |

### Games (7)

| Command | Aliases | Args | Notes |
|---|---|---|---|
| `tictactoe` | `ttt`, `tic` | `<opponent>` | Challenger ❌ first; no timeout, no gold reward |
| `connect4` | `c4`, `connectfour` | `<opponent>` | 6×7 board, 🔴 first; no timeout, no gold reward |
| `rps` | `rockpaperscissors`, `rock` | `<opponent>` | Best of 1; picks hidden until both in; no timeout, no reward |
| `trivia` | `quiz` | — | **+25 gold**, 30 s limit, first correct answer wins; anyone can answer; 22-question hardcoded bank; **answers are shuffled since Phase 2 (correct option is random, was always A)** |
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
| `modlog` | `mlog`, `modlogs` | ModerateMembers | `[limit]` — recent mod actions, newest first; **default limit 10**, no max validation |
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

## 6.2 Trivia — question bank quirk (FIXED in Phase 2)

The bank (`src/lib/trivia.ts`, `GENERAL_QUESTIONS`) holds **22 general-knowledge
questions, each with exactly 4 options**. It used to have `answerIndex: 0` on
every question (correct answer always option A); Phase 2 shuffles the answers
(Fisher–Yates in `pickTriviaQuestion`, answerIndex remapped) so the correct
option is random. Tests prove the distribution covers all 4 slots.

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

- One **60-second interval** runs `runDueTasks`: due reminders, due
  giveaways, **plus the Phase 2 sweeps** — travel arrivals, auto-hunt ticks,
  rare-log posts, battle challenge expiry, auction close.
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
docs might expect.

1. ~~**Trivia answers are always option A in the bank**~~ — **FIXED in
   Phase 2** (answers shuffled, correct option random; tests prove it).
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
7. ~~**Help comment is stale** ("all 36 commands fit")~~ — **FIXED in
   Phase 2** (comment now says 58; registry is 58).
8. **Starboard triggers on ANY reaction**, not just ⭐.
9. **Automod's warn branch is unreachable** with current settings (all
   violations delete).
10. **Mod DB records are written before the Discord action** — a failed
    Discord call still leaves a DB record.
11. **Ticket command has no permission check** (anyone can open a ticket).
12. **No `uwu use` command** (Phase 2 gap): shop consumables (potions,
    Lure Bait, Tower Key, Roll Ticket, Skill Book, Pet Egg) can be bought
    but not used; the evolution-stone mechanic is likewise unbuilt.
13. **No `sacrifice` command** — gems cannot be earned that way; gem
    yields in the tier table are dead data.
14. **Hunts drop no crates** — the design's "~5% of hunts" was not built;
    crates come from tower floors and the shop only.
15. **Pity is Epic EXACTLY** (Phase 2 fix) — the old code leaked ~20% of
    pity rolls into Legendary+; the design doc always said Epic-only.

## Verified

- **Tests:** `npm test` 2026-11-07 — 627/627 passed (22 files), including
  `test/games.test.ts`, `test/mod.test.ts`, `test/utility.test.ts`,
  `test/boot.test.ts`, plus the Phase 2 test files.
- **Code read:** `src/commands/games.ts`, `src/commands/mod.ts`,
  `src/commands/utility.ts`, `src/lib/games.ts`, `src/lib/trivia.ts`,
  `src/lib/automod.ts`, `src/index.ts`, plus `src/lib/db.ts`,
  `src/lib/levels.ts`, `src/lib/command.ts`, `src/commands/index.ts` for
  inventory verification. The 58-command inventory was counted from the
  live registry.
- **Live Discord check: NOT DONE** (no browser access in this session).
  To verify live in `#🤖-miya-bot`: `uwu ttt @user`, `uwu trivia`,
  `uwu poll "Q?" "A" "B"`, `uwu userinfo`, `uwu serverstats`,
  `uwu rank`, `uwu remind 1 test`, `uwu afk testing`, and a ⭐ reaction
  (×3) on a message to check the starboard. Mod commands need a staff
  member to test; do not test kick/ban on real users. Phase 2 commands:
  `uwu map`, `uwu guild`, `uwu battle @user`, `uwu tower`, `uwu shop`,
  `uwu auction list`, `uwu logs`.
