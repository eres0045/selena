# 05 — Phase 2 Design Index

**Status: DESIGNED — NOT BUILT. Every system on this page exists only in
`docs/hunt-world-phase2-design.md` (written 2026-11-07). No bot code, no
emoji work, no deploys. Nothing here is playable.**

Source: [`../hunt-world-phase2-design.md`](../hunt-world-phase2-design.md)
(12 sections + appendix). It builds on the Phase 1 design; Phase 1 numbers
stand except the five changes in §1.2 below.

## What Phase 2 adds (one line each)

| System | Design doc | In one line |
|---|---|---|
| World map + travel | §2 | One shared world across all of Discord; ~4–5 regions, ~20 areas; travel 5 min/km; auto-hunt 200 gold/hour while travelling |
| Towers | §4 | 30 towers, random placement; Small 10F / Big 20F / Main 50F hidden; checkpoints every floor; tower cooldowns 6h / 12h / 7d |
| Guilds | §3 | Max 20 members, levels to 10, ranking board, perks (catch chance / sell gold) |
| 1v1 battles | §5 | `uwu battle @user`, auto top-3, winner 100 gold + XP, loser 25, wager cap 1,000, 1-min cooldown |
| Monster levels + fusion | §6 | Level cap 100; fusion 2 same → stronger, max +6 (64 copies) |
| Spawn cooldowns | §7.1 | Legendary 12h, Mythic 3d, UwU 14d — global, after any catch |
| Caps (revised) | §7.2 | Per-server catch/roll: Mythic 3, UwU 1 at a time; NO cap on buying |
| Auction house | §8 | Global, 24h, 5% fee, binding bids with escrow |
| Shop | §9.1 | Daily refresh midnight UTC, same stock for everyone, gold + gems |
| Crates | §9.2–9.3 | Name "Crate", Wooden→Void tiers, drops incl. evolution stones |
| Announcements + logs | §11 | `uwu announcements` (update feed), `uwu logs` (Epic+ catch feed) |

## Phase 2 vs Phase 1 — what changed

| # | Phase 1 said | Phase 2 decides (supersedes) |
|---|---|---|
| 1 | UwU-tier cap: "1 per server, **ever**" | **1 per server at a time**, plus a 14-day **global spawn cooldown**. A server's UwU can be caught again after the cooldown — "ever" is dropped. |
| 2 | Battle sketch: winner takes 5% of the loser's gold (cap 500) | **Winner 100 gold + XP, loser 25 gold, no gold lost.** Optional wager up to 1,000 gold. |
| 3 | Bosses sketch: area boss every 6 h, world boss weekly | **Replaced by the tower system.** Area/world bosses are out; towers are the boss content. |
| 4 | Guilds sketch: no size given, +10% boss-damage bonus per member (cap +50%) | **Max 20 members.** Perks are catch chance / gold from sells, scaling with guild level. Boss-damage bonus dropped with the boss system. |
| 5 | Monsters have no level | Monsters now have **levels**. Phase 1 roster stats are the **level-1 base stats**. |

Everything else in Phase 1 stands (roll 500 gold, pity 50 → Epic min, daily
roll cap 20, catch rates 90/75/60/45/30/15/10, hunt cooldown 30 s, tier
rates, Mythic cap 3/server, sell prices, pet buffs, the 15 status effects,
damage formula, power budget, stat bands).

## System summaries

### World map + travel (§2) — DESIGNED ONLY

One shared world across **all of Discord** (every server with the bot), not
Zenith-only. ~**4–5 regions, ~20 areas**; the 4 Phase 1 areas are Region 1,
the starting region. Working-default regions (names/areas/levels
unconfirmed): Region 2 Shifting Dunes (Lv 15–30), Region 3 Frozen Reaches
(30–45), Region 4 Shadowlands (45–60), Region 5 Sky Isles endgame (60+).
`uwu map` shows the world in plain text, current location marked **red**,
travel origin marked. **4 buttons:** Zoom In, Zoom Out, Mark (drop a pin),
Last Location — the exact meaning of Last Location is **unconfirmed**
(working reading: return to previous location/view). Buttons change only the
view; movement is `uwu travel <area>`.
**Travel: 5 min/km** (2 km = 10 min; 10 km = 50 min), free (time is the
cost). **Auto-hunt** (`uwu autohunt on/off` — command name unconfirmed):
runs only while travelling, on the 30 s hunt cadence (~20 attempts per
10-min trip; no separate daily cap — travel time is the cap), uses Phase 1
catch rates, costs **200 gold/hour** of travel (~33 gold per 10-min trip).
Roaming monsters come from areas passed through, rarer in deeper regions.

### Towers (§4) — DESIGNED ONLY

**30 towers**, placed **randomly**. **Small 10 floors, Big 20 floors,
Main 50 floors** (one Main tower, location **hidden, never revealed**).
**Party size is a recommended minimum, not a cap:** Small **2**, Big **4**,
Main **6**; solo allowed (hard) and larger parties allowed. **Checkpoints on
every floor** — stop anytime, resume later, change party members between
sessions. Mini-boss every **5th floor** (working default); final boss
**cannot be caught**, fought for drops only. Entry (working defaults):
Small = area level, Big = area level +5, Main = level 60.
**Tower-wide clear cooldowns:** Small **6 h**, Big **12 h**, Main **7 days**.
Commands (working defaults): `uwu towers`, `uwu tower <name>`,
`uwu party invite @user`, `uwu tower enter <name>`, `uwu tower leave`.

### Guilds (§3) — DESIGNED ONLY

**Max 20 members**, 1 guild per player at a time, membership global across
Discord. Roles: Leader, Officer (can invite), Member. Create:
`uwu guild create <name>`, **5,000 gold** (working default). Guild XP
(working defaults): 10 per hunt, 10 per roll, 50 per battle win, 100 per
tower floor cleared. **Guild levels max 10** (Lv 2 at 1,000 XP, Lv 3 at
3,000, Lv 4 at 6,000, Lv 5 at 10,000, then +5,000/level). Ranking board
(`uwu guild rank`): by level, then total guild power. Perks scale with level
(working defaults): Lv 2 +2% catch chance; Lv 4 +5% gold from sells; Lv 6
+5% catch; Lv 8 +10% sell gold; Lv 10 +10% catch and +5% XP. Combined
catch-chance bonus (guild + pet buffs) capped at **+30%**. No guild stat
bonus inside towers.

### 1v1 battles (§5) — DESIGNED ONLY

`uwu battle @user` (optional wager `uwu battle @user <amount>`). Opponent
gets Accept/Decline buttons, **60 seconds** to answer; no answer = expiry,
no penalty. **Cooldown: 1 minute** between battles per player.
**Auto-battle, top-3 monsters each side** (manual team pick unconfirmed).
Turn-based, highest-ATK first; Phase 1 damage formula
(`max(1, ATK − DEF ÷ 2)`, crit 1.5×, base crit 10%) and all 15 status
effects apply. One message edited through the rounds, then a plain-text
result line. **Winner 100 gold + XP** (XP scales with loser's team level);
**loser 25 gold** + half the winner's XP; **loser never loses gold**.
**Optional wager, cap 1,000 gold** per player; winner takes the pot
(2× amount); wager gold held in escrow at accept time.

### Monster levels + fusion (§6) — DESIGNED ONLY

**Monster level cap: 100** (confirmed by Ronit 2026-11-07). Wild monsters
spawn at a level set by area (working defaults): Meadow 1–5, Woods 5–15,
Ember Peaks 10–25, Hollow Deep 15–40, Region 2 15–30, Region 3 30–45,
Region 4 45–60, Region 5 60–100. **Rolled monsters spawn at level 1.**
Stats scale **+2% HP/ATK/DEF per level above 1** (working default): Lv 20 ≈
1.38× base, Lv 100 ≈ 3×. Level gates use the *player's* level, not a
monster's. XP/coins (working defaults): hunt catch XP = 10 + (monster level
× 2) ±20%, coins = 5 + (monster level × 3) ±20%; battle win XP = 40 + (avg
enemy team level × 2), coins fixed 100 gold; tower floor XP = 50 + (floor
× 5). Monster levels up when its XP crosses **100 × current level**.
**Fusion:** 2 of the same monster → 1 stronger, keeps the higher level,
**+10% stats** per fuse level, **max +6 (64 copies)**. Unlocks: +1 extra
effect slot; +2 trigger +10 pp; +3 second signature effect; +4 trigger
+10 pp again; +5 +20% stats on that step; +6 third signature effect.
Fusion cost (gold, working defaults): Common 100, Uncommon 250, Rare 500,
Epic 1,000, Legendary 2,500, Mythic 5,000, UwU 25,000. Fusion never changes
tier and can only reduce a server's owned count.

### Spawn cooldowns (§7.1) — DESIGNED ONLY

After a high-tier monster is caught (hunt, roll, or auto-hunt — any source),
it **stops spawning globally** until its cooldown ends: Legendary **12
hours**, Mythic **3 days**, UwU-tier **14 days**. During cooldown it cannot
be encountered or rolled; a roll re-draws to the next tier down and the
player is told why. Common–Epic have **no** spawn cooldown.

### Caps (§7.2) — DESIGNED ONLY

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

### Auction house (§8) — DESIGNED ONLY

**Global** across Discord. `uwu auction <thing> <starting price>` — minimum
starting price **100 gold** (working default). `uwu auctions` to browse;
`uwu bid <id> <amount>` — minimum increment **10% over the current bid**
(working default). **Duration: fixed 24 hours**, no extensions. Seller
receives the winning bid **minus a 5% auction fee**; unsold items return
free. **Escrow:** bids hold gold immediately; outbid → instant refund.
Seller may cancel **only while it has no bids**. **No self-bidding.** No
shill protection beyond escrow in Phase 2 (flagged as a possible follow-up).

### Shop (§9.1) — DESIGNED ONLY

`uwu shop` — **refreshes daily at midnight UTC; same stock for everyone**.
**Limited quantity per item per player** (working default: 3 of each item
per player per day). Daily stock (working defaults): 2 potions (100–500
gold), 1 bait (300 gold), 1 key (Tower Key, 1,000 gold), 1 crate
(500–5,000 gold by tier), 1 roll ticket (450 gold, does not count toward the
20/day roll cap — working default), and occasionally (2–3 days/week) a
random weapon or pet egg. **Gold for most items, gems for the rare ones**;
gem prices unconfirmed — the shop is the first gem sink. Consumables used
via `uwu use <item>` (working default command, unconfirmed).

### Crates (§9.2–9.3) — DESIGNED ONLY

**Name: "Crate"** (decided by Ronit 2026-11-07). Tiers: **Wooden** (Common),
**Iron** (Uncommon), **Silver** (Rare), **Golden** (Epic), **Crystal**
(Legendary), **Void** (Mythic — Main tower final boss only). Opening
(`uwu open <crate>` — working default command, unconfirmed) consumes the
crate and reveals contents in plain text, random within the crate's tier
band. **Drop rates unconfirmed** — working defaults: ~10% of tower floor
clears, ~5% of hunts, 100% from final bosses. Drops list (working
defaults): shards, potions, weapons, armor/accessories (new slot —
unconfirmed), monster cores, scales/fangs/feathers/crystals/ores, gems, pet
eggs, skill books/scrolls, **evolution stones** (new mechanic — unconfirmed:
one stone + shards + gold evolves a +6 monster up one tier), keys, roll
tickets, treasure chests (final bosses only), badges/trophies, runes.

### Announcements + logs (§11) — DESIGNED ONLY

**`uwu announcements`** — the update feed (new monsters/weapons/pets/areas/
features, balance changes, events); newest first, latest 10, plain text.
Posted by bot owner / server admins with `uwu announce <title> | <text>`
(exact permission set unconfirmed); stored in the database. Scope: **global**.
Announcements are **not** auto-posted to servers. **`uwu logs`** — the
rare-catch feed: every **Epic+** monster caught/rolled and every Epic+
weapon obtained, with player, item, tier, source, and time. Default scope:
your Discord server's recent catches (latest 10); `uwu logs global` for
all-Discord. Common/Uncommon/Rare are **not** logged. Entries are automatic.
**No opt-out in this design** (flagged). Optional server log channel
(`uwu setlogchannel #channel` — unconfirmed whether it exists at all).

## Data model (§10, sketch only — designed, not built)

14 new Supabase tables sketched: `user_location`, `towers`,
`tower_progress`, `tower_cooldowns`, `spawn_cooldowns`, `guilds`,
`guild_members`, `user_monster_levels`, `auctions`, `shop_stock`,
`user_crates`, `user_materials`, `announcements`, `rare_logs`. Phase 1
tables unchanged. Enforcement notes: caps and escrow fail-closed; auction
escrow, tower checkpoints, travel state, and spawn cooldowns must survive
redeploys (database, never in-memory).

## Open questions (§12) — condensed

**Resolved 2026-11-07 (4 of 27):** #2 Tower counts — towers placed
**randomly** across the world map · #5 Travel time — **5 min/km** ·
#7 Monster level cap — **100** · #17 Crate name — just **"Crate"**.

**Still unconfirmed (23 of 27):** #1 "Last Location" button meaning ·
#3 Region 2–5 names, area lists, unlock levels · #4 "Void Rift" 5th endgame
area (exists? at what level?) · #6 auto-hunt abuse cap · #8 level stat
scaling (+2%/level) + XP/coin formulas · #9 battle team pick (auto top-3 vs
manual `uwu team`) · #10 fusion numbers · #11 evolution stones (does the
mechanic exist at all?) · #12 armor/accessories slot · #13 mini-bosses
catchable? · #14 Main tower discovery · #15 tower entry level requirements ·
#16 guild create cost / XP / thresholds / perks · #18 crate drop rates ·
#19 shop details (Tower Key, roll ticket vs 20/day cap, `uwu use`) ·
#20 drop rates per source · #21 battle-farming lever (1-min cooldown) ·
#22 auction shill protection · #23 guild perk exact numbers · #24 Tower Key
existence/effect · #25 announcements: who can post · #26 logs: default
scope, opt-out? · #27 server log channel — confirm it exists at all.

## Verified

- **Design doc read:** `docs/hunt-world-phase2-design.md` in full
  (2026-11-07). Every system above cites its source section.
- **Code check:** a grep for Phase 2 command names (`travel`, `autohunt`,
  `guild`, `battle`, `auction`, `shop`, `open`, `announce`, `logs`,
  `tower`, `party`, `use`, `fuse`) across `src/commands/` confirms **none
  of these commands exist in code** — the "not built" label is verified,
  not assumed. (Detail: `logs` appears only as the `modlog` alias in
  `src/commands/mod.ts`; `shop`/`auction`/etc. have no matches.)
- **Tests:** `npm test` 2026-11-07 — 357/357 passed; Phase 2 has no tests
  because it has no code.
- **Live Discord check: NOT APPLICABLE** — there is nothing live to check.
  Any Phase 2 command typed in Discord today returns an unknown-command
  reply (see [01-core.md](01-core.md#12-unknown-commands--human-sounding-replies)).
