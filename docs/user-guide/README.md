# uwu Bot — User Guide

Complete documentation of the **uwu** Discord bot (repo: `eres0045/selena`,
live on Render as `selena`, https://selena-p1sq.onrender.com), written
2026-11-07. The bot is an OwO-style economy / casino / monster-hunt bot for
the Zenith Esports server, playable in any server it is invited to.

## How to use this guide

| File | What it covers | Status |
|---|---|---|
| [01-core.md](01-core.md) | Prefix router, help system, unknown-command replies, balance / daily / give / leaderboard, levels & rank | **LIVE** |
| [02-casino.md](02-casino.md) | Slots, blackjack, roulette, coinflip, highlow, mines, scratch — rules, payouts, presentation | **LIVE** |
| [03-hunt-world.md](03-hunt-world.md) | Hunt world Phase 1: hunt, roll/gacha, map, zoo, inv, sell, rarity tiers, caps, announcements, roster | **LIVE** |
| [04-economy.md](04-economy.md) | Sell prices, sacrifice & gems (what actually exists), plus shop / auction / fusion / towers / guilds / battles / crates / announcements / logs | **MIXED** — sell/gems are live; everything from §4 onward is **DESIGNED — NOT BUILT** |
| [05-phase2-design-index.md](05-phase2-design-index.md) | Full index of the Phase 2 design: world map, towers, guilds, battles, levels/fusion, spawn cooldowns, auction, shop, crates, announcements/logs | **DESIGNED — NOT BUILT** |
| [06-command-reference.md](06-command-reference.md) | Every command (all 42) in one table, plus games, moderation, utility, starboard, automod, timers | **LIVE** |

## Reading the status labels

- **LIVE** — the system is implemented in `src/`, covered by tests, and
  deployed. Numbers are copied from the code, with file:line references.
- **DESIGNED — NOT BUILT** — the system exists only in
  `docs/hunt-world-phase2-design.md`. It is not in the code, not playable,
  and must never be presented as live. Each such section says so.
- **Verified** — every file ends with a "Verified" block stating how it was
  checked: test run, code read, or live check. **Live Discord checks were
  NOT done for this guide** (no browser access in this session); the
  commands listed for live verification are named in each file's Verified
  block so they can be checked later in `#🤖-miya-bot`.

## Verification snapshot (2026-11-07)

- **Tests:** `npm test` — **357/357 passed, 15 files**, run 2026-11-07 ~19:07 IST.
- **Live deploy:** `dep-dbniifbm8hqs73calr10`, commit `3653bd4`
  (Spike Puffer roster replacement), status `live`, health endpoint `200`,
  checked 2026-11-07 ~19:10 IST.
- **Emoji:** `assets/emoji-hunt/emoji-ids.json` holds **170 uploaded
  application-emoji IDs** (upload completed 2026-11-07). They are **not yet
  wired into hunt messages** — hunt/roll/zoo still use Unicode placeholders.
- **Roster:** 100 monsters / 50 weapons / 20 pets. Thorn Hedgehog was
  replaced by **Spike Puffer** (Common, Water, Woods) in commit `3653bd4`;
  the manifest is 170/170 matched.

## Design docs this guide is built from

- Phase 1 design: [`../hunt-world-design.md`](../hunt-world-design.md)
- Phase 2 design (design only, not built):
  [`../hunt-world-phase2-design.md`](../hunt-world-phase2-design.md)

## Known disagreements (code vs design doc)

The guide records these where they occur; the full list is in
[03-hunt-world.md §3.14](03-hunt-world.md#314-code-vs-design-doc-disagreements)
and [06-command-reference.md §6.7](06-command-reference.md#67-findings--gaps).
The largest: **pity rolls in code can produce Legendary/Mythic/UwU**,
while the Phase 1 design doc says pity is Epic-only. Code wins until
Ronit rules otherwise.
