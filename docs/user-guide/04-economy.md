# 04 — Economy & loot

**Status: LIVE.** Phase 2 (shop, auction, fusion, towers, guilds, battles,
crates, announcements/logs, spawn cooldowns) was built 2026-11-07 and
deployed — commits `c640afe` / `7f43a63` / `654bb73`, tests 593/593. Every
section below is live code; working defaults from the design doc are marked
as such. Two honest gaps remain: **no `uwu use` command** (shop consumables
cannot be used yet) and **no `sacrifice` command** (gems cannot be earned
that way).

## 4.1 Sell prices — LIVE

Monster sell prices (exact, from `TIERS.sellPrice` in `src/lib/hunt.ts`):

| Tier | Sell price |
|---|---|
| Common | 25 gold |
| Uncommon | 60 gold |
| Rare | 150 gold |
| Epic | 400 gold |
| Legendary | 1,500 gold |
| Mythic | 5,000 gold |
| UwU | 25,000 gold |

- Selling is one copy per `uwu sell <monster>` command; last-copy sales ask
  for confirmation first. Full rules in
  [03-hunt-world.md §3.7](03-hunt-world.md#37-sell--uwu-sell-monster).
- **Weapons and pets cannot be sold** — no code path exists. They *can* be
  auctioned (§4.4).
- Gold also moves via `uwu give` (1:1, no fee), `uwu daily` (100 gold /
  rolling 24h), casino payouts, trivia (+25 gold), and battle rewards
  (winner 100 gold, loser 25 gold).

## 4.2 Sacrifice & gems — LIVE (gems exist; sacrifice does not)

- **Gem yields exist as data only** (Common 1 → UwU 500 in the tier table).
  Nothing reads the field. It is dead data.
- **No `sacrifice` command exists.** There is no way to earn gems by
  sacrificing monsters.
- **Gems ARE a live currency** (`user_wallet` table, `src/lib/market.ts`):
  `uwu gems` shows the balance and how to earn them; `uwu bal` shows gems
  on the same one-liner. **Earned from:** crate drops, tower final-boss
  clears (Small 5 / Big 15 / Main 50 gems), and **daily quest rewards**
  (§4.11). **Spent on:** rare shop items
  — the Evolution Stone costs 30 gems (the shop's only gem-priced item).
- A `gem` custom emoji exists (animated, fallback 💎) as a generic economy
  emoji; no hunt command uses it.

## 4.3 Shop — LIVE

Source: `docs/hunt-world-phase2-design.md` §9.1. Commands `uwu shop`,
`uwu shop buy <item> [qty]` (`src/commands/market.ts`, `src/lib/market.ts`).

- `uwu shop` — shows today's stock, plain text. **Refreshes daily at
  midnight UTC; same stock for everyone** — stock is pure date-seeded
  generation (FNV-1a of the UTC date → mulberry32), so it changes with no
  sweep.
- **Limited quantity per item per player** (3 of each item per player per
  day, tracked in `user_shop_buys`).
- Daily stock (built): 2 potions (rotating), Lure Bait (300 gold), Tower
  Key (1,000 gold), Roll Ticket (450 gold — a free `uwu roll`, does not
  count toward the 20/day roll cap), Skill Book (800 gold), 1 crate
  (weighted Wooden 40 / Iron 35 / Silver 15 / Golden 10; 500–5,000 gold by
  tier), 1 material bundle (rotating, 200 gold), plus an occasional slot
  ~3 days/week: a random weapon (Common 150 → Legendary 8,000 gold), a Pet
  Egg (1,500 gold), or an Evolution Stone (**30 gems**).
- **Gold for most items, gems for the rare ones** (Ron's rule); the shop is
  the first gem sink.
- ⚠️ **GAP — no `uwu use` command exists.** Potions, Lure Bait, Tower Key,
  Roll Ticket, Skill Book, and Pet Egg can be *bought* but not *used* — they
  sit in `user_items` inventory until a use command is built. The roll
  ticket, Tower Key effect, and pet-egg hatching are all blocked on this.

### 4.3a Profile backgrounds — LIVE

Commands `uwu shop bg`, `uwu shop buy bg <name>`, `uwu bg <name>`,
`uwu profile`, `uwu about <text>` (`src/commands/market.ts` shop wiring,
`src/commands/profile.ts`, `src/lib/profile.ts`, `src/lib/profileBgs.ts`).
Tables: `user_profiles` (about + equipped bg, global per user),
`user_backgrounds` (ownership, global per user).

- **30 backgrounds, permanent catalogue — never rotates, never part of
  the daily stock:** **10 static** images (low price, roughly 10,000–
  20,000 gold) + **20 animated GIFs** (high price, roughly 25,000–50,000
  gold). Prices come from the manifest (`assets/profile-bgs/manifest.json`,
  entries `{ id, name, file, price, type, source_url }` where `type` is
  `"static"` or `"animated"`); nothing hardcodes a price.
- **Default is free** — every user starts on it, it always equips, and it
  is never sold.
- `uwu shop bg` — lists all 30 in the **OwO big-list shop format**
  (numbered rows 1–30 in manifest order, dotted leader to a compact
  price like `12K`, `[static]`/`[GIF]` trailing mark, `✓ owned` /
  `★ equipped` marks; **10 per page, 3 pages**, `Page X/Y` footer with
  ◀ N ▶ buttons; `uwu shop bg <page>` jumps to a page). `uwu shop buy
  bg <number|name>` — buys by list number or name with **guild-scoped
  gold** (the guild the purchase ran in, same as every shop buy); one
  transaction — unknown / already-owned / can't-afford all refuse
  before any gold moves. Ownership is **global**: a background bought in one
  server is yours everywhere.
- `uwu bg <name>` (alias `background`) — equips a background you own, by
  name or id (prefix match works); `uwu profile bg <name>` does the same.
  Equipping one you don't own refuses with the price and the buy command.
- `uwu profile` (alias `p`) — your profile card as an **400×250 animated
  GIF image attachment** (`profile.gif`): level + XP bar (existing curve in
  `src/lib/levels.ts`), **global rank** (total XP summed across all guilds),
  gold, gems, About Me, monsters caught, guild name. On any render failure
  the command falls back to a plain-text error — never a crash, never a
  broken file.
- `uwu about <text>` (alias `aboutme`) — sets the About Me line (max **100
  chars**); empty shows the current line. `@everyone`/`@here` mentions and
  Discord invite links are stripped before storing, so a stored About Me
  can never ping anyone.

## 4.4 Auction house — LIVE

Source: `docs/hunt-world-phase2-design.md` §8. Commands
`uwu auction sell <item> <price>` / `bid <id> <amount>` / `list` /
`info <id>` / `cancel <id>` / `mine` (alias `auctions`).

- **Global** across Discord. Any owned monster, weapon, pet, crate, or
  item; minimum starting price **100 gold**. Monster level/fuse is preserved
  in the listing (`id:level:fuse`), so the winner gets the exact copy.
- **Duration: fixed 24 hours**, no extensions. At close (60 s sweep), the
  highest bid wins; the seller receives the winning bid **minus a 5%
  auction fee** (`floor(bid × 5%)` — e.g. 500 → seller gets 475); unsold
  items return to the seller free. Winner + seller are DM'd when a client
  is present.
- **Escrow:** a bid holds the bidder's gold immediately; outbid → instant
  refund in the same transaction; the winner's held gold goes to the seller
  (minus fee). Minimum raise **+10% over the current bid**. The seller may
  cancel **only while it has no bids**. **No self-bidding.**
- **No cap on buying/owning** — anyone may buy anything, including a second
  UwU for their server (per-server caps apply to catching/rolling only).
- Open question: shill protection (none in Phase 2).

## 4.5 Fusion (combining duplicates) — LIVE

Source: `docs/hunt-world-phase2-design.md` §6.4. Command
`uwu fuse <monster>` (alias `combine`).

- **2 of the same monster at the same fuse level → 1 stronger monster.**
  Keeps the higher level, gains **+10% stats** per fuse level, **max +6** —
  **64 copies** to max one monster (2⁶, 63 fuses).
- Unlocks: **+1** extra effect slot; **+2** signature-move trigger +10 pp;
  **+3** second signature effect; **+4** trigger +10 pp again; **+5** +20%
  stats on that step (instead of +10%); **+6** third signature effect
  (capstone). Extra effects come from a thematic per-type table
  (`TYPE_EFFECTS`), deterministic — first candidate not already carried.
- **Fusion cost (gold):** Common 100, Uncommon 250, Rare 500, Epic 1,000,
  Legendary 2,500, Mythic 5,000, UwU 25,000. Deducted in the same
  transaction; insufficient copies/gold or maxed +6 refuses before anything
  is consumed.
- Fusion never changes tier and can only *reduce* a server's owned count
  (2 → 1), never break a cap.
- `uwu zoo <name>` lists every instance with level, fusion, XP progress,
  and leveled stats/effects.
- Open questions: all fusion numbers/effect unlocks are working defaults to
  confirm/tune.

## 4.6 Towers — LIVE

Source: `docs/hunt-world-phase2-design.md` §4. Command `uwu tower`
(alias `towers`): bare `uwu tower` lists; `enter <name>`, `climb`, `leave`.
New: `uwu explore` (alias `discover`) — explore your current area to
discover hidden towers.

- **MYSTERY (built 2026-11-07, Ronit's correction): towers are hidden
  until discovered.** `uwu tower` shows undiscovered towers as
  `??? · undiscovered tower — explore the area to find it` (no name, no
  area, no floors, no level requirement); the header shows only how many
  you discovered on that page, never the total. Discovery is per-user
  (Supabase `user_tower_discoveries`): **`uwu explore`** in your current
  area — **40% chance** per explore, **60 s cooldown**, no level gate
  (a level-0 player can discover the Meadow tower); if the area has no
  undiscovered tower left, exploring finds **5–15 gold**. **Travel
  arrival:** 25% chance to stumble on an undiscovered tower in the
  arrival area. **Detail/enter require discovery** — naming an
  undiscovered tower replies that no such tower is known to you (never
  confirms it exists). **Floors unlock progressively:** detail shows
  only cleared floors + the current floor (type, rewards, boss label);
  future floors are `???` until the floor before them is cleared.
- **30 towers** across the world, **seeded deterministic placement**
  (seed `20261107`): **18 Small / 11 big / 1 Main**. Types: **Small 10
  floors, Big 20 floors, Main 50 floors** (one Main tower, location
  **hidden, never revealed** — never listed, fuzzy name guesses never match
  it, area renders as `???` everywhere).
- **Party size is a recommended minimum, not a cap:** Small **2**, Big **4**,
  Main **6**; solo allowed (hard) and larger parties allowed. Checkpoint is
  per user; the active party is whoever enters together (resume your own
  party → join the most recent active party → start a new one as leader).
  A climb fights with the **combined top-3 across all party members'
  rosters**; on a win the climber and every entered party member advance.
- **Checkpoints on every floor** — stop anytime, resume later, change party
  members between sessions (stored in Supabase). Mini-boss every **5th
  floor**; final boss on the top floor is a better-tier monster that
  **cannot be caught**, fought for drops only.
- Floor scaling (built): monster level = area unlock + floor (cap 100);
  base stats × (1 + 5%/floor above 1), on top of +2%/level. Mini-boss:
  one tier above the area's top tier (cap UwU), HP ×3, ATK/DEF ×1.5.
  Final boss: Small Epic, Big Legendary, Main Mythic; HP ×2, ATK/DEF ×1.0.
- Entry (working defaults): Small = area level, Big = area level +5,
  Main = level 60.
- **Tower-wide clear cooldowns:** Small **6 h**, Big **12 h**, Main **7
  days**. After expiry the checkpoint resets to floor 0 on re-enter.
- Rewards: gold Small 20+10/floor, Big 30+15/floor, Main 50+25/floor
  (final floor doubled); XP 50 + 5×floor. Crates: mini-boss Golden
  (Small/Big) / Crystal (Main); final Silver (Small) / Crystal (Big) /
  Void (Main); normal floors 10% Wooden/Iron/Silver. Final-clear bonus:
  gems 5/15/50, materials, plus a `tower-clear-<id>` badge. All settled in
  one transaction — fail-closed.
- ⚠️ **Deviation from the design:** no `uwu party invite` command — party
  members join by entering the same tower. The hidden Main tower is
  entered only by exact name/id (word of mouth) — it is never
  discoverable by exploring or travel. Open questions: tower entry level
  numbers; the explore/arrival discovery rates (40% / 25%) and the 60 s
  explore cooldown are working defaults to confirm/tune.

## 4.7 Guilds & 1v1 battles — LIVE

Source: `docs/hunt-world-phase2-design.md` §3 and §5.

- **Guilds:** max **20 members**, 1 guild per player at a time, membership
  global across Discord. Roles: Leader, Officer (can invite), Member.
  Create: `uwu guild create <name>`, **5,000 gold**. Guild XP (built and
  wired): **10 per hunt catch, 10 per roll pull, 50 per battle win, 100
  per tower floor cleared** — the award is best-effort and never breaks
  the command that earned it. **Guild levels max 10** (Lv 2 at 1,000 XP,
  Lv 3 at 3,000, Lv 4 at 6,000, Lv 5 at 10,000, then +5,000/level).
  Ranking board (`uwu guild rank`): by level, then XP, then total guild
  power. Perks scale with level (built): catch bonus 0/2/7/17pp at levels
  1/2/6/10; sell-gold bonus 0/5/15% at levels 1/4/8; XP bonus 5% at level
  10. Combined catch-chance bonus (guild + pet buffs) capped at **+30%**.
  The guild catch bonus applies to hunts, rolls, and auto-hunt. No guild
  stat bonus inside towers.
- **1v1 battles:** `uwu battle @user` (aliases `fight`, `duel`; optional
  wager `uwu battle @user <amount>`). Opponent gets Accept/Decline buttons,
  **60 seconds** to answer. **Cooldown: 1 minute** between battles per
  player. Auto-battle, **top-3 monsters** each side (manual team pick
  unconfirmed — auto top-3 is the working default). One message edited
  through the rounds (750 ms between edits): an **opening card** (round 0,
  both teams at full HP), then **one battle card image per round** — each
  side's fighters with HP bars, level, and active status effects; a
  fainted monster shows as fainted, the currently fighting monster is
  marked active — with the round's last action as the caption. The final
  card carries a **footer: winner name, rounds fought, winner XP, and
  the winner's win streak**. If a card ever fails to render, that round
  (or the final result) falls back to the old plain-text edit — the
  battle always settles first, display never blocks rewards.
  Winner **100 gold + XP** (40 + avg enemy team level × 2), loser **25
  gold** + half the winner's XP, **loser never loses gold**. Draw: both get
  25 gold + half-XP, wagers refunded. **Win streaks (global per user):**
  a win is **+1**, a loss **resets to 0**, a draw leaves both streaks
  unchanged. Streaks live in `user_battle_streaks`, so they survive
  redeploys. Optional wager, cap **1,000 gold**
  per player per battle, escrowed at accept; winner takes the pot (2×).
- Open questions: guild create cost / XP / thresholds / perks (all working
  defaults); battle team pick (auto vs manual `uwu team`); whether the 1-min
  cooldown is the right anti-farming lever.

## 4.8 Crates — LIVE

Source: `docs/hunt-world-phase2-design.md` §9.2–9.3. Commands
`uwu crates` / `uwu open <crate>` (alias `opencrate`).

- **Name: "Crate"** (decided by Ronit 2026-11-07 — not "Cache" or "Hoard").
  Tiers: **Wooden** (Common), **Iron** (Uncommon), **Silver** (Rare),
  **Golden** (Epic), **Crystal** (Legendary), **Void** (Mythic — Main
  tower final boss only).
- Opening consumes the crate and reveals contents in plain text, random
  within the crate's tier band. Every crate always gives gold + shards
  (Wooden 50–150g/1–3 shards → Void 2,500–5,000g/50–80 shards); gems
  Wooden 8% (1–2) → Crystal/Void always (8–15 / 15–30); plus potions,
  material bundles, tier-matched weapons (2%→40%), pets one tier down
  (Silver+), monsters of the crate's tier (Silver 2% → Void 5%, owned not
  caught — no cap), skill books, tower keys, roll tickets, evolution
  stones, pet eggs, and crate-in-crate one tier down (Golden+).
- **Drop sources (built): tower floors only** — mini-boss + final-boss
  crates fixed by tower size (§4.6), normal floors 10% Wooden/Iron/Silver.
  ⚠️ The design's "~5% of hunts" drop is **NOT built** — hunts drop no
  crates. Crates can also be bought in the shop (§4.3).
- Drops list: shards, potions, weapons, monster cores,
  scales/fangs/feathers/crystals/ores, gems, pet eggs, skill books/scrolls,
  **evolution stones** (the stone exists as an item; the evolve mechanic —
  one stone + shards + gold evolves a +6 monster up one tier — is **NOT
  built**), keys, roll tickets, badges/trophies, runes. ⚠️ **Armor /
  accessories do not exist** (design §12 item 12, not built).

## 4.9 Announcements & logs — LIVE

Source: `docs/hunt-world-phase2-design.md` §11. Commands
`uwu announcements`, `uwu announce <title> | <text>` (admin only),
`uwu logs [global]` (alias `rarelogs`), `uwu setlogchannel #channel`
(alias `setlogs`).

- **`uwu announcements`** — the update feed (new monsters/weapons/pets/areas/
  features, balance changes, events); newest first, latest 10, plain text.
  Posted by server admins (`Administrator` permission); stored in the
  database, never hard-coded. Scope: **global**. Announcements are **not**
  auto-posted to servers.
- **`uwu logs`** — the rare-catch feed: every **Epic+** monster caught/rolled
  and every Epic+ weapon obtained, with player, item, tier, source
  (hunt/roll/auction/trade/shop), and time. Default scope: your Discord
  server's recent catches (latest 10); `uwu logs global` for all-Discord.
  Common/Uncommon/Rare are **not** logged. Entries are automatic. **No
  opt-out** (open question). A 60 s sweep auto-posts new entries to the
  server's log channel when one is set.
- Optional server log channel (`uwu setlogchannel #channel`, admin only):
  Epic+ catches auto-posted there. Off by default.
- Note: the **live** Legendary/Mythic/UwU catch announcements (§3.9 of
  [03-hunt-world.md](03-hunt-world.md)) are a different, already-built
  feature — `uwu logs` is the history view of those events.

## 4.10 Spawn cooldowns & caps (Phase 2) — LIVE

Source: `docs/hunt-world-phase2-design.md` §7. (The Phase 1 per-server
caps — Mythic 3, UwU 1 — **are** live; see
[03-hunt-world.md §3.10](03-hunt-world.md#310-caps--mythic-3--uwu-1-per-server).)

- After a high-tier monster is caught (hunt, roll, or auto-hunt — any
  source), it **stops spawning globally** until its cooldown ends:
  Legendary **12 hours**, Mythic **3 days**, UwU-tier **14 days**. During
  cooldown it cannot be encountered or rolled; a roll re-draws to the next
  tier down and the player is told why ("…is resting — it will return in
  2 days"). Common–Epic have **no** spawn cooldown. A failed cooldown read
  fails closed — never grants.
- Per-server caps apply to **catching/rolling only** (Mythic 3 owned per
  server; UwU-tier 1 per server **at a time** — the Phase 1 "1 per server,
  ever" is dropped in Phase 2; the UwU embed copy was updated to match).
  **NO cap on buying/owning** via auction or trade.
- **Pity is Epic EXACTLY** — fixed in Phase 2 (the old code leaked ~20% of
  pity rolls into Legendary+). Proven by a 500-seed test.

## 4.11 Daily quests — LIVE

Commands `uwu quests` (alias `q`), `uwu quests claim`, plus the 🎁 Claim
button on the quest log (`src/commands/quests.ts`, `src/lib/quests.ts`).
Tables: `user_quest_progress`, `user_quest_claims` (both keyed by user +
UTC date + quest id; appended to `SCHEMA` in `src/lib/db.ts` at merge).

- **Daily + global: the same 3 quests for everyone, on every server.**
  The set is picked deterministically from a 16-quest pool, seeded by the
  UTC date (FNV-1a → mulberry32 — the same date-seed pattern as the shop
  stock, §4.3), so every process picks the same 3. Each user tracks their
  **own** progress against the shared set; progress and claims are global
  per user (follow you across servers, like the profile).
- **Reset at midnight UTC** (same as the shop refresh). The log embed
  shows a countdown ("Next quests in Xh Ym"). A new day starts fresh:
  no progress or claims carry over.
- **Rewards are gold + gems only — no new currency.** Easy quests pay
  500 gold; medium 1,000–2,000 gold; hard 2,500–5,000 gold + gems (up to
  5 gems). Gold is paid in the guild the claim ran in (gold is
  guild-scoped); gems are global (`user_wallet`).
- **Claims pay once per quest per day, in one transaction.** `uwu quests
  claim` (or the Claim button) claims every completed-but-unclaimed quest;
  a second claim pays nothing. The button updates the quest message in
  place — claimed quests show ✅ Claimed on the refreshed embed.
- **No reroll, no lock in v1** — a shared global set makes per-user reroll
  wrong, so there is none. Progress is recorded by the action handlers
  themselves (hunt catch, roll, battle win, casino win, explore discovery,
  background purchase, daily claim, fuse, tower floor clear, About Me set)
  via `recordQuestProgress` — best-effort, wrapped in try/catch so a quest
  failure never breaks the action. (Fixed 2026-11-07 during the build:
  the first version capped progress with `MIN(...)`, which is an aggregate
  in Postgres — the scalar form `LEAST(...)` is used instead; see
  §6.7 finding 16, now closed.)

## Verified

- **Tests:** `npm test` 2026-11-07 — 755/755 passed (29 files), including
  `test/market.test.ts` (38), `test/towers.test.ts` (31),
  `test/towerDiscovery.test.ts` (22), `test/guilds.test.ts` (37+3),
  `test/battle.test.ts` (47), `test/hunt.test.ts` (76),
  `test/feeds.test.ts` (20), `test/world.test.ts` (25). Quests
  (2026-11-07): `test/quests.test.ts` 22/22 (lib, commands, Claim
  button) + `test/questHooks.test.ts` 27/27 (all 10 progress hooks).
- **Code read:** `src/lib/market.ts`, `src/commands/market.ts`,
  `src/lib/towers.ts`, `src/commands/towers.ts`, `src/lib/guilds.ts`,
  `src/commands/guilds.ts`, `src/lib/battle.ts`, `src/commands/battle.ts`,
  `src/lib/feeds.ts`, `src/commands/feeds.ts`, `src/lib/huntDb.ts`
  (spawn cooldowns, pity, instances, fusion), `src/lib/hunt.ts`
  (`TIERS` sell prices, gem yields).
- **Live Discord check: NOT DONE** (no browser access in this session).
  To verify live in `#🤖-miya-bot`: `uwu shop`, `uwu auction list`,
  `uwu crates`, `uwu gems`, `uwu guild`, `uwu battle @user`,
  `uwu tower`, `uwu announcements`, `uwu logs`, `uwu fuse <monster>`.
