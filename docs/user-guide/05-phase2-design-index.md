# 05 — Phase 2 Design Index

**Status: LIVE — BUILT 2026-11-07.** Every system on this page is now
implemented, tested, and deployed: commits `c640afe` (Wave 1) /
`7f43a63` (Wave 2) / `654bb73` (Wave 3), deploy
`dep-dbnjiie7bikc73cnve90` live, health 200, tests **593/593 (21 files)**.
Live Discord verification is still pending (no browser access in this
session) — the commands below are proven by tests, not yet by Discord.

Source: [`../hunt-world-phase2-design.md`](../hunt-world-phase2-design.md)
(12 sections + appendix). It builds on the Phase 1 design; Phase 1 numbers
stand except the five changes in §1.2 below.

## What Phase 2 adds (one line each)

| System | Design doc | In one line | Status |
|---|---|---|---|
| World map + travel | §2 | One shared world across all of Discord; 5 regions, 16 areas; travel 5 min/km; auto-hunt 200 gold/hour while travelling | LIVE |
| Towers | §4 | 30 towers, seeded random placement; Small 10F / Big 20F / Main 50F hidden; checkpoints every floor; tower cooldowns 6h / 12h / 7d | LIVE |
| Guilds | §3 | Max 20 members, levels to 10, ranking board, perks (catch chance / sell gold) | LIVE |
| 1v1 battles | §5 | `uwu battle @user`, auto top-3, winner 100 gold + XP, loser 25, wager cap 1,000, 1-min cooldown | LIVE |
| Monster levels + fusion | §6 | Level cap 100; fusion 2 same → stronger, max +6 (64 copies) | LIVE |
| Spawn cooldowns | §7.1 | Legendary 12h, Mythic 3d, UwU 14d — global, after any catch | LIVE |
| Caps (revised) | §7.2 | Per-server catch/roll: Mythic 3, UwU 1 at a time; NO cap on buying | LIVE |
| Auction house | §8 | Global, 24h, 5% fee, binding bids with escrow | LIVE |
| Shop | §9.1 | Daily refresh midnight UTC, same stock for everyone, gold + gems | LIVE |
| Crates | §9.2–9.3 | Name "Crate", Wooden→Void tiers, drops incl. evolution stones | LIVE |
| Announcements + logs | §11 | `uwu announcements` (update feed), `uwu logs` (Epic+ catch feed) | LIVE |

## Phase 2 vs Phase 1 — what changed

| # | Phase 1 said | Phase 2 decides (supersedes) |
|---|---|---|
| 1 | UwU-tier cap: "1 per server, **ever**" | **1 per server at a time**, plus a 14-day **global spawn cooldown**. A server's UwU can be caught again after the cooldown — "ever" is dropped. The UwU embed copy was updated to match. |
| 2 | Battle sketch: winner takes 5% of the loser's gold (cap 500) | **Winner 100 gold + XP, loser 25 gold, no gold lost.** Optional wager up to 1,000 gold. |
| 3 | Bosses sketch: area boss every 6 h, world boss weekly | **Replaced by the tower system.** Area/world bosses are out; towers are the boss content. |
| 4 | Guilds sketch: no size given, +10% boss-damage bonus per member (cap +50%) | **Max 20 members.** Perks are catch chance / gold from sells, scaling with guild level. Boss-damage bonus dropped with the boss system. |
| 5 | Monsters have no level | Monsters now have **levels**. Phase 1 roster stats are the **level-1 base stats**. |

Everything else in Phase 1 stands (roll 500 gold, pity 50 → Epic min, daily
roll cap 20, catch rates 90/75/60/45/30/15/10, hunt cooldown 30 s, tier
rates, Mythic cap 3/server, sell prices, pet buffs, the 15 status effects,
damage formula, power budget, stat bands).

## System summaries

### World map + travel (§2) — LIVE

One shared world across **all of Discord** (every server with the bot), not
Zenith-only. **5 regions, 16 areas** (built — the design said "~20 areas"):
Region 1 Starting Lands (Lv 0–15), Region 2 Shifting Dunes (15–30),
Region 3 Frozen Reaches (30–45), Region 4 Shadowlands (45–60), Region 5
Sky Isles endgame (60–70, incl. **The Void Rift at Lv 70**, Mythic/UwU).
`uwu map` shows the world in plain text, current location marked **red**,
travel origin marked. **4 buttons:** Zoom In, Zoom Out, Mark (drop a pin),
Last Location (returns to your previous location/view). Buttons change only
the view; movement is `uwu travel <area>`.
**Travel: 5 min/km** (2 km = 10 min; 10 km = 50 min), free (time is the
cost). **Auto-hunt** (`uwu autohunt on|off`): runs only while travelling,
on the 30 s hunt cadence, uses Phase 1 catch rates **plus your guild catch
bonus**, costs **200 gold/hour** of travel pro-rata (~33 gold per 10-min
trip); when the balance can't cover the next charge, auto-hunt turns off.
No separate daily cap — travel time is the cap. Roaming monsters come from
the destination area's pool. Travel arrivals + auto-hunt ticks run on the
60 s due-task sweep.

### Towers (§4) — LIVE

**30 towers**, **seeded deterministic placement** (seed `20261107`):
**18 small / 11 big / 1 main**. **Small 10 floors, Big 20 floors,
Main 50 floors** (one Main tower, location **hidden, never revealed** —
never listed, fuzzy name guesses never match it, area renders as `???`).
**Party size is a recommended minimum, not a cap:** Small **2**, Big **4**,
Main **6**; solo allowed (hard) and larger parties allowed. **Checkpoints
on every floor** — stop anytime, resume later, change party members
between sessions. Mini-boss every **5th floor**; final boss **cannot be
caught**, fought for drops only. Entry: Small = area level, Big = area
level +5, Main = level 60.
**Tower-wide clear cooldowns:** Small **6 h**, Big **12 h**, Main **7 days**
(after expiry the checkpoint resets to floor 0).
Commands (built): `uwu tower` (list), `uwu tower enter <name>`,
`uwu tower climb`, `uwu tower leave`. ⚠️ **Deviation:** no
`uwu party invite` — party members join by entering the same tower.
Floor scaling (built): monster level = area unlock + floor (cap 100);
stats × (1 + 5%/floor above 1) on top of +2%/level. Mini-boss: one tier
above the area's top tier (cap UwU), HP ×3, ATK/DEF ×1.5. Final boss:
Small Epic, Big Legendary, Main Mythic; HP ×2. Rewards: gold
20+10/30+15/50+25 per floor (final doubled), XP 50 + 5×floor, crates
(mini-boss Golden/Crystal, final Silver/Crystal/Void, normal floors 10%
Wooden/Iron/Silver), final-clear gems 5/15/50 + materials + a
`tower-clear-<id>` badge.

### Guilds (§3) — LIVE

**Max 20 members**, 1 guild per player at a time, membership global across
Discord. Roles: Leader, Officer (can invite), Member. Create:
`uwu guild create <name>`, **5,000 gold**. Guild XP (built and wired —
best-effort, never breaks the command that earned it): **10 per hunt
catch, 10 per roll pull, 50 per battle win, 100 per tower floor cleared**.
**Guild levels max 10** (Lv 2 at 1,000 XP, Lv 3 at 3,000, Lv 4 at 6,000,
Lv 5 at 10,000, then +5,000/level). Ranking board (`uwu guild rank`): by
level, then XP, then total guild power. Perks scale with level (built):
catch bonus 0/2/7/17pp at levels 1/2/6/10; sell-gold bonus 0/5/15% at
levels 1/4/8; XP bonus 5% at level 10. Combined catch-chance bonus (guild
+ pet buffs) capped at **+30%**. The guild catch bonus applies to hunts,
rolls, and auto-hunt. No guild stat bonus inside towers.

### 1v1 battles (§5) — LIVE

`uwu battle @user` (aliases `fight`, `duel`; optional wager
`uwu battle @user <amount>`). Opponent gets Accept/Decline buttons,
**60 seconds** to answer; no answer = expiry (60 s sweep marks it), no
penalty. **Cooldown: 1 minute** between battles per player.
**Auto-battle, top-3 monsters each side** (manual team pick unconfirmed).
Turn-based, highest-ATK first; Phase 1 damage formula
(`max(1, ATK − DEF ÷ 2)`, crit 1.5×, base crit 10%) and all 15 status
effects apply. One message edited through the rounds (750 ms between
edits, last 8 log lines + standings), then a plain-text result line.
**Winner 100 gold + XP** (40 + avg enemy team level × 2);
**loser 25 gold** + half the winner's XP; **loser never loses gold**.
Draw: both get 25 gold + half-XP, wagers refunded.
**Optional wager, cap 1,000 gold** per player; winner takes the pot
(2× amount); wager gold held in escrow at accept time. Fighting monsters
gain XP against their instance rows (level-ups announced).

### Monster levels + fusion (§6) — LIVE

**Monster level cap: 100**. Wild monsters spawn at a level set by area
(Meadow 1–5, Woods 5–15, Ember Peaks 10–25, Hollow Deep 15–40, Region 2
15–30, Region 3 30–45, Region 4 45–60, Region 5 60–100 — wild level ranges
built per area). **Rolled monsters spawn at level 1.** Stats scale
**+2% HP/ATK/DEF per level above 1**: Lv 20 ≈ 1.38× base, Lv 100 ≈ 3×.
Level gates use the *player's* level, not a monster's. XP/coins (built):
hunt catch XP = 10 + (monster level × 2) ±20%, coins = 5 + (monster level
× 3) ±20% — the same XP goes to the player and the caught instance;
battle win XP = 40 + (avg enemy team level × 2), coins fixed 100 gold;
tower floor XP = 50 + (floor × 5). Monster levels up when its XP crosses
**100 × current level**. `uwu zoo` shows best `Lv N +F`; detail lists
every instance with level, fusion, XP progress, leveled stats/effects.
**Fusion** (`uwu fuse <monster>`, alias `combine`): 2 of the same monster
**at the same fuse level** → 1 stronger, keeps the higher level,
**+10% stats** per fuse level, **max +6 (64 copies, 63 fuses)**. Unlocks:
+1 extra effect slot; +2 trigger +10 pp; +3 second signature effect; +4
trigger +10 pp again; +5 +20% stats on that step; +6 third signature
effect. Fusion cost (gold): Common 100, Uncommon 250, Rare 500,
Epic 1,000, Legendary 2,500, Mythic 5,000, UwU 25,000. Fusion never
changes tier and can only reduce a server's owned count.

### Spawn cooldowns (§7.1) — LIVE

After a high-tier monster is caught (hunt, roll, or auto-hunt — any source),
it **stops spawning globally** until its cooldown ends: Legendary **12
hours**, Mythic **3 days**, UwU-tier **14 days**. During cooldown it cannot
be encountered or rolled; a roll re-draws to the next tier down and the
player is told why ("…is resting — it will return in 2 days"). A failed
cooldown read fails closed — never grants. Common–Epic have **no** spawn
cooldown. **Pity is Epic EXACTLY** (fixed — the old code leaked ~20% of
pity rolls into Legendary+; proven by a 500-seed test).

### Caps (§7.2) — LIVE

Per-server caps apply to **catching/rolling only**: **Mythic 3 owned per
server**; **UwU-tier 1 per server at a time**. At cap, re-roll down a tier
and tell the user why; fail closed on a count-query error. **NO cap on
buying/owning** via auction or trade — a server may end up with 2 UwUs if
one is bought in. Fairness reasoning in the doc: per-server caps give every
server its own shot; global cooldowns keep rarity real world-wide; "ever"
was dropped because a hard global one-ever would lock out latecomers
forever. Residual unfairness stated honestly: a 5-player server gets the
same 1 UwU as a 1,000-player server — accepted, since size-scaled caps
would punish small friend servers.

### Auction house (§8) — LIVE

**Global** across Discord. `uwu auction sell <item> <price>` (alias
`auctions` for list), `uwu auction bid <id> <amount>`, `list`, `info <id>`,
`cancel <id>`, `mine` — minimum starting price **100 gold**. Minimum
increment **10% over the current bid**. **Duration: fixed 24 hours**, no
extensions. Seller receives the winning bid **minus a 5% auction fee**;
unsold items return free. **Escrow:** bids hold gold immediately; outbid →
instant refund. Seller may cancel **only while it has no bids**. **No
self-bidding.** Monster level/fuse is preserved in the listing. No shill
protection beyond escrow in Phase 2 (flagged as a possible follow-up).

### Shop (§9.1) — LIVE

`uwu shop` (alias `store`), `uwu shop buy <item> [qty]` —
**refreshes daily at midnight UTC; same stock for everyone** (pure
date-seeded generation, no sweep). **Limited quantity per item per player**
(3 of each item per player per day). Daily stock (built): 2 potions
(rotating), Lure Bait (300 gold), Tower Key (1,000 gold), Roll Ticket
(450 gold, a free roll that does not count toward the 20/day cap), Skill
Book (800 gold), 1 crate (weighted Wooden 40 / Iron 35 / Silver 15 /
Golden 10), 1 material bundle (rotating, 200 gold), plus an occasional slot
~3 days/week: random weapon (Common 150 → Legendary 8,000 gold), Pet Egg
(1,500 gold), or Evolution Stone (**30 gems**). **Gold for most items,
gems for the rare ones**; the shop is the first gem sink. ⚠️ **GAP — no
`uwu use` command exists:** bought consumables cannot be used yet.

### Crates (§9.2–9.3) — LIVE

**Name: "Crate"** (decided by Ronit 2026-11-07). Tiers: **Wooden**
(Common), **Iron** (Uncommon), **Silver** (Rare), **Golden** (Epic),
**Crystal** (Legendary), **Void** (Mythic — Main tower final boss only).
Opening (`uwu open <crate>`, alias `opencrate`; `uwu crates` to list)
consumes the crate and reveals contents in plain text, random within the
crate's tier band. Every crate always gives gold + shards; gems Wooden 8%
→ Crystal/Void always; plus potions, material bundles, tier-matched
weapons (2%→40%), pets one tier down (Silver+), monsters of the crate's
tier (Silver 2% → Void 5%, owned not caught — no cap), skill books, tower
keys, roll tickets, evolution stones, pet eggs, crate-in-crate one tier
down (Golden+). **Drop sources (built): tower floors only** (mini-boss +
final-boss crates fixed, normal floors 10% Wooden/Iron/Silver) and the
shop. ⚠️ The design's "~5% of hunts" drop is **NOT built**. **Evolution
stones exist as items, but the evolve mechanic is NOT built** (no command
evolves a +6 monster up one tier). **Armor/accessories do not exist.**

### Announcements + logs (§11) — LIVE

**`uwu announcements`** — the update feed (new monsters/weapons/pets/areas/
features, balance changes, events); newest first, latest 10, plain text.
Posted by server admins with `uwu announce <title> | <text>` (alias
`broadcast`; `Administrator` permission); stored in the database. Scope:
**global**. Announcements are **not** auto-posted to servers.
**`uwu logs`** (alias `rarelogs`) — the rare-catch feed: every **Epic+**
monster caught/rolled and every Epic+ weapon obtained, with player, item,
tier, source, and time. Default scope: your Discord server's recent
catches (latest 10); `uwu logs global` for all-Discord. Common/Uncommon/
Rare are **not** logged. Entries are automatic. **No opt-out.**
Optional server log channel (`uwu setlogchannel #channel`, alias
`setlogs`, admin only): Epic+ catches auto-posted there by the 60 s sweep.
Off by default.

## Data model (§10) — LIVE, 22 new tables

Built (all `CREATE TABLE IF NOT EXISTS` at startup): `user_location`,
`towers`, `tower_parties`, `tower_progress`, `tower_cooldowns`,
`spawn_cooldowns`, `guilds`, `guild_members`, `user_monster_instances`,
`user_wallet`, `auctions`, `auction_bids`, `shop_stock`,
`user_shop_buys`, `user_crates`, `user_materials`, `user_items`,
`user_badges`, `announcements`, `rare_logs`, `battle_challenges`,
`user_battle`. (The design sketched 14; the build added 8 more for
instances, wallet, bids, buys, items, badges, challenges, and battle
cooldowns.) Enforcement: caps and escrow fail-closed; auction escrow,
tower checkpoints, travel state, and spawn cooldowns survive redeploys
(database, never in-memory).

## Open questions (§12) — status after the build

**Built with working defaults (still need Ronit's confirm/tune):** #1 "Last
Location" button · #2 tower counts (30, seeded) · #3 Region 2–5 names/areas/
levels · #4 "Void Rift" (built as a Lv 70 Region 5 area, not Lv 20) · #5
travel time 5 min/km · #6 auto-hunt abuse cap (none) · #7 monster level cap
100 · #8 level scaling + XP/coin formulas · #9 battle team pick (auto
top-3) · #10 fusion numbers · #13 mini-bosses catchable (no) · #15 tower
entry levels · #16 guild cost/XP/thresholds · #18 crate drop rates (towers;
hunt rate not built) · #19 shop details (partly — `uwu use` missing) · #21
battle-farming lever (1 min) · #23 guild perk numbers · #24 Tower Key
(item exists; use effect needs `uwu use`) · #25 announce permissions ·
#26 logs scope/opt-out · #27 server log channel.

**Still open (not built):** #11 evolution stones (mechanic) · #12
armor/accessories slot · #14 Main tower discovery · #20 drop rates per
source (tune after live data) · #22 auction shill protection. Plus the
two built-but-unusable gaps: **`uwu use`** (shop consumables) and the
**evolution-stone mechanic**.

## Verified

- **Tests:** `npm test` 2026-11-07 — **593/593 passed, 21 files**
  (`test/world.test.ts` 22, `test/guilds.test.ts` 40, `test/feeds.test.ts`
  20, `test/hunt.test.ts` 76, `test/battle.test.ts` 47,
  `test/towers.test.ts` 22, `test/market.test.ts` 38, plus the 15
  pre-existing files).
- **Deploys:** Wave 1 `dep-dbnj45hsrm7s739j5fj0` (commit `c640afe`), Wave 2
  `dep-dbnjb6e417fc73du42p0` (commit `7f43a63`), Wave 3
  `dep-dbnjiie7bikc73cnve90` (commit `654bb73`) — all live, health 200.
- **Code check:** every command name above was verified against
  `src/commands/index.ts` (57 commands) and the module sources.
- **Live Discord check: NOT DONE** — no browser access in this session.
  To verify live in `#🤖-miya-bot`: `uwu map`, `uwu travel`, `uwu autohunt
  on`, `uwu guild`, `uwu battle @user`, `uwu fuse <monster>`, `uwu tower`,
  `uwu shop`, `uwu auction list`, `uwu crates`, `uwu announcements`,
  `uwu logs`.
