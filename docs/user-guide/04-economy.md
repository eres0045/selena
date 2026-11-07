# 04 — Economy & loot

**Status: MIXED.** §1–§2 are **LIVE** (sell prices, and the honest state of
sacrifice/gems). **Everything from §3 onward is DESIGNED — NOT BUILT** — it
exists only in `docs/hunt-world-phase2-design.md`, is not in the code, and
is not playable. Each such section is labelled.

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
- **Weapons and pets cannot be sold** — no code path exists.
- Gold also moves via `uwu give` (1:1, no fee), `uwu daily` (100 gold /
  rolling 24h), casino payouts, trivia (+25 gold), and battle rewards
  (Phase 2 design only — not live).

## 4.2 Sacrifice & gems — LIVE status: they do not exist

- **Gem yields exist as data only** (Common 1 → UwU 500 in the tier table).
  Nothing reads the field. It is dead data.
- **No `sacrifice` command, no gem currency, no gem balance, no gem shop,
  no gem uses.** There is no way to earn, hold, or spend gems in the live bot.
- A `gem` custom emoji exists (animated, fallback 💎) as a generic economy
  emoji; no hunt command uses it.
- Anything about gems beyond this paragraph is Phase 2 design, not live
  behaviour — see §4.8 and
  [05-phase2-design-index.md](05-phase2-design-index.md).

## 4.3 Shop — DESIGNED — NOT BUILT

Source: `docs/hunt-world-phase2-design.md` §9.1. **Not in the code.**

- `uwu shop` — shows today's stock, plain text. **Refreshes daily at
  midnight UTC; same stock for everyone** (one shared world shop).
- **Limited quantity per item per player** (working default: 3 of each item
  per player per day); stock is per-player limited, never globally sold out.
- Daily stock (working defaults): 2 potions (Heal/Catch, rotating XP/Antidote;
  100–500 gold), 1 bait (Lure Bait, +catch chance next hunt; 300 gold),
  1 key (Tower Key, unlocks one tower floor entry without the level
  requirement — working default, unconfirmed; 1,000 gold), 1 crate (random
  tier; 500–5,000 gold by tier), 1 roll ticket (a free `uwu roll`, does not
  count toward the 20/day roll cap — working default, unconfirmed; 450 gold),
  and occasionally (2–3 days/week) a random weapon or pet egg.
- **Gold for most items, gems for the rare ones** (Ron's rule); gem prices
  unconfirmed — the shop is the first gem sink.
- Consumables used via `uwu use <item>` (working default command, unconfirmed).
- Open questions: Tower Key effect/existence, roll ticket vs the 20/day cap,
  `uwu use` mechanics.

## 4.4 Auction house — DESIGNED — NOT BUILT

Source: `docs/hunt-world-phase2-design.md` §8. **Not in the code.**

- **Global** across Discord. `uwu auction <thing> <starting price>` lists
  any owned monster, weapon, pet, crate, or material; minimum starting price
  **100 gold** (working default). `uwu auctions` browses (plain text,
  grouped, with time left); `uwu bid <id> <amount>` — minimum increment
  **10% over the current bid** (working default).
- **Duration: fixed 24 hours**, no extensions. At close, the highest bid
  wins; the seller receives the winning bid **minus a 5% auction fee**
  (gold sink); unsold items return to the seller free.
- **Escrow:** a bid holds the bidder's gold immediately; outbid → instant
  refund; the winner's held gold goes to the seller (minus fee). The seller
  may cancel **only while it has no bids**. **No self-bidding.**
- **No cap on buying/owning** — anyone may buy anything, including a second
  UwU for their server (per-server caps apply to catching/rolling only).
- Open question: shill protection (none in Phase 2).

## 4.5 Fusion (combining duplicates) — DESIGNED — NOT BUILT

Source: `docs/hunt-world-phase2-design.md` §6.4. **Not in the code.**

- **2 of the same monster → 1 stronger monster** (same species only).
  Keeps the higher level, gains **+10% stats** per fuse level, **max +6** —
  **64 copies** to max one monster (2⁶).
- Unlocks: **+1** extra effect slot; **+2** signature-move trigger +10 pp;
  **+3** second signature effect; **+4** trigger +10 pp again; **+5** +20%
  stats on that step (instead of +10%); **+6** third signature effect
  (capstone).
- **Fusion cost (gold, working defaults):** Common 100, Uncommon 250,
  Rare 500, Epic 1,000, Legendary 2,500, Mythic 5,000, UwU 25,000.
- Fusion never changes tier and can only *reduce* a server's owned count
  (2 → 1), never break a cap.
- Open questions: all fusion numbers/effect unlocks are working defaults to
  confirm/tune.

## 4.6 Towers — DESIGNED — NOT BUILT

Source: `docs/hunt-world-phase2-design.md` §4. **Not in the code.**

- **30 towers** across the world, placed **randomly**. Types: **Small 10
  floors, Big 20 floors, Main 50 floors** (one Main tower, location **hidden,
  never revealed**).
- **Party size is a recommended minimum, not a cap:** Small **2**, Big **4**,
  Main **6**; solo allowed (hard) and larger parties allowed.
- **Checkpoints on every floor** — stop anytime, resume later, change party
  members between sessions (stored in Supabase). Mini-boss every **5th
  floor** (working default); final boss on the top floor is a better-tier
  monster that **cannot be caught**, fought for drops only.
- Entry (working defaults, unconfirmed): Small = area level, Big = area
  level +5, Main = level 60.
- **Tower-wide clear cooldowns (global, per tower):** Small **6 h**, Big
  **12 h**, Main **7 days**. Once any party clears a tower, it is on cooldown
  for everyone.
- Commands (working defaults): `uwu towers`, `uwu tower <name>`,
  `uwu party invite @user`, `uwu tower enter <name>`, `uwu tower leave`.
- Open questions: how the hidden Main tower is first discovered; whether
  mini-bosses are catchable (working default: no); tower entry level numbers.

## 4.7 Guilds & 1v1 battles — DESIGNED — NOT BUILT

Source: `docs/hunt-world-phase2-design.md` §3 and §5. **Not in the code.**

- **Guilds:** max **20 members**, 1 guild per player at a time, membership
  global across Discord. Roles: Leader, Officer (can invite), Member.
  Create: `uwu guild create <name>`, **5,000 gold** (working default).
  Guild XP (working defaults): 10 per hunt, 10 per roll, 50 per battle win,
  100 per tower floor cleared. **Guild levels max 10** (Lv 2 at 1,000 XP,
  Lv 3 at 3,000, Lv 4 at 6,000, Lv 5 at 10,000, then +5,000/level).
  Ranking board (`uwu guild rank`): by level, then total guild power.
  Perks scale with level (working defaults): Lv 2 +2% catch chance; Lv 4 +5%
  gold from sells; Lv 6 +5% catch; Lv 8 +10% sell gold; Lv 10 +10% catch and
  +5% XP. Combined catch-chance bonus (guild + pet buffs) capped at **+30%**.
  No guild stat bonus inside towers.
- **1v1 battles:** `uwu battle @user` (optional wager
  `uwu battle @user <amount>`). Opponent gets Accept/Decline buttons,
  **60 seconds** to answer. **Cooldown: 1 minute** between battles per
  player. Auto-battle, **top-3 monsters** each side (manual team pick
  unconfirmed — auto top-3 is the working default). Winner **100 gold + XP**,
  loser **25 gold** (consolation), **loser never loses gold**. Optional
  wager, cap **1,000 gold** per player per battle; winner takes the pot.
- Open questions: guild create cost / XP / thresholds / perks (all working
  defaults); battle team pick (auto vs manual `uwu team`); whether the 1-min
  cooldown is the right anti-farming lever.

## 4.8 Crates — DESIGNED — NOT BUILT

Source: `docs/hunt-world-phase2-design.md` §9.2–9.3. **Not in the code.**

- **Name: "Crate"** (decided by Ronit 2026-11-07 — not "Cache" or "Hoard").
  Crates drop from tower floors, final bosses, and occasionally
  hunts/battles. Tiers: **Wooden** (Common), **Iron** (Uncommon), **Silver**
  (Rare), **Golden** (Epic), **Crystal** (Legendary), **Void** (Mythic —
  Main tower final boss only).
- Opening (`uwu open <crate>` — working default command, unconfirmed)
  consumes the crate and reveals contents in plain text, random within the
  crate's tier band (a Wooden Crate never contains Mythic loot; a Void Crate
  never contains Commons).
- **Drop rates unconfirmed** — working defaults: ~10% of tower floor clears,
  ~5% of hunts, 100% from final bosses (one crate of the tower's tier).
- Drops list (working defaults): shards, potions, weapons,
  armor/accessories (new slot — unconfirmed), monster cores,
  scales/fangs/feathers/crystals/ores, gems, pet eggs, skill books/scrolls,
  **evolution stones** (new mechanic — unconfirmed: one stone + shards +
  gold evolves a +6 monster up one tier; Main tower / Mythic crates), keys,
  roll tickets, treasure chests (final bosses only), badges/trophies, runes.
  Exact drop rates per source are unconfirmed — tuned after live data.

## 4.9 Announcements & logs — DESIGNED — NOT BUILT

Source: `docs/hunt-world-phase2-design.md` §11. **Not in the code.**

- **`uwu announcements`** — the update feed (new monsters/weapons/pets/areas/
  features, balance changes, events); newest first, latest 10, plain text.
  Posted by bot owner / server admins with
  `uwu announce <title> | <text>` (exact permission set unconfirmed);
  stored in the database, never hard-coded. Scope: **global**. Announcements
  are **not** auto-posted to servers.
- **`uwu logs`** — the rare-catch feed: every **Epic+** monster caught/rolled
  and every Epic+ weapon obtained, with player, item, tier, source
  (hunt/roll/auction/trade/shop), and time. Default scope: your Discord
  server's recent catches (latest 10); `uwu logs global` for all-Discord.
  Common/Uncommon/Rare are **not** logged. Entries are automatic. **No
  opt-out in this design** (flagged as an open question).
- Optional server log channel (`uwu setlogchannel #channel` — unconfirmed
  whether it exists at all): Epic+ catches auto-posted there.
- Note: the **live** Legendary/Mythic/UwU catch announcements (§3.9 of
  [03-hunt-world.md](03-hunt-world.md)) are a different, already-built
  feature — `uwu logs` is the history view of those events, and it is not
  built yet.

## 4.10 Spawn cooldowns & caps (Phase 2) — DESIGNED — NOT BUILT

Source: `docs/hunt-world-phase2-design.md` §7. **Not in the code.** (The
Phase 1 per-server caps — Mythic 3, UwU 1 — **are** live; see
[03-hunt-world.md §3.10](03-hunt-world.md#310-caps--mythic-3--uwu-1-per-server).)

- After a high-tier monster is caught (hunt, roll, or auto-hunt — any
  source), it **stops spawning globally** until its cooldown ends:
  Legendary **12 hours**, Mythic **3 days**, UwU-tier **14 days**. During
  cooldown it cannot be encountered or rolled; a roll re-draws to the next
  tier down and the player is told why. Common–Epic have **no** spawn
  cooldown.
- Per-server caps apply to **catching/rolling only** (Mythic 3 owned per
  server; UwU-tier 1 per server **at a time** — the Phase 1 "1 per server,
  ever" is dropped in Phase 2). **NO cap on buying/owning** via auction or
  trade.

## Verified

- **Tests:** `npm test` 2026-11-07 — 357/357 passed (15 files).
- **Code read (§1–§2):** `src/lib/hunt.ts` (`TIERS` sell prices, gem
  yields), `src/commands/hunt.ts` (sell), `src/lib/economy.ts`,
  `src/commands/economy.ts`. Confirmed by grep: no `sacrifice` command, no
  gem balance/currency/shop code exists in `src/`.
- **Design doc read (§3–§10):** `docs/hunt-world-phase2-design.md` (§3–§11).
  Every system in §3–§10 is labelled DESIGNED — NOT BUILT with its source
  section cited.
- **Live Discord check: NOT DONE** (no browser access in this session).
  §1–§2 can be verified live with `uwu sell <monster>` and `uwu inv`;
  §3–§10 have nothing live to check.
