# uwu Hunt World — Phase 2 Design Document

> **Status:** DESIGN ONLY — for Ronit's review. No bot code, no emoji work, no deploys.
> **Written:** 2026-11-07 · **Bot:** uwu (discord.js v14 + TypeScript, prefix `uwu`, plain-text OwO-style replies, Supabase persistence)
> **Builds on:** [Phase 1 design doc](./hunt-world-design.md) — hunt, roll/gacha, areas, zoo/inventory, sell/sacrifice, equip, pets, the 15 status effects, the 100/50/20 roster, and all Phase 1 numbers. Everything in Phase 1 still stands except the items listed in §1.2 below.
> **Scope:** Phase 2 = world map + travel + towers + guilds + 1v1 battles + monster levels + fusion + spawn cooldowns + auction house + shop + crates.

All names in this doc are **original** — generic fantasy names only, no franchise names or characters. Same rule as Phase 1.

**Presentation rule (from Phase 1, still in force):** game replies are plain text, OwO-style. No embed boxes — the only exception is the Mythic special embed from the Phase 1 tier table.

---

## 1. Locked numbers and decisions (decided by Ronit, 2026-11-07)

### 1.1 What Phase 2 adds, in one paragraph

One shared world across **all of Discord** (every server with the bot). The 4 Phase 1 areas are one small starting region inside a bigger world of ~4–5 regions and ~20 areas. Players travel between areas in real time and auto-hunt while travelling. **30 towers** stand across the world — small (10 floors), big (20 floors), and one hidden 50-floor main tower — cleared in parties, with checkpoints. **Guilds** hold up to 20 members, with levels and a ranking board. **1v1 battles** pit top-3 monster teams against each other. Monsters now have **levels**; duplicates **fuse** into stronger monsters; high-tier monsters have **global spawn cooldowns**; and the economy grows an **auction house** (global) and a **daily shop**.

### 1.2 Changes vs the Phase 1 doc (read this first)

| # | Phase 1 doc said | Phase 2 decides (supersedes) |
|---|---|---|
| 1 | UwU-tier cap: "1 per server, **ever**" (§1.4) | **1 per server at a time**, plus a 14-day **global spawn cooldown** (§7). A server's UwU can be caught again after the cooldown — "ever" is dropped. Ronit agreed the per-server model after the fairness discussion (see §7.3). |
| 2 | Battle (sketch, §8): winner takes 5% of the loser's gold | **Winner 100 gold + XP, loser 25 gold, no gold lost.** Optional wager up to 1,000 gold (§5). |
| 3 | Bosses (sketch, §8): area boss every 6h, world boss weekly | Replaced by the tower system (§4). Area/world bosses are out; towers are the boss content. |
| 4 | Guilds (sketch, §8): no size given, +10% boss-damage bonus per member | **Max 20 members.** Perks are catch chance / gold from sells, scaling with guild level (§3). The boss-damage bonus is dropped with the boss system. |
| 5 | Monsters have no level | Monsters now have **levels** (§6). Phase 1 roster stats are the **level-1 base stats**; levels scale them (§6.2). |

### 1.3 Decisions locked in Phase 2 (all Ronit's, 2026-11-07)

| # | Decision |
|---|---|
| 1 | One shared world across **all of Discord**, not Zenith-only. |
| 2 | The 4 Phase 1 areas are one small starting region of a ~20-area world. |
| 3 | Map tracks the user: travel origin marked, current location marked **red**. |
| 4 | Map has 4 buttons: Zoom In, Zoom Out, Mark, Last Location. |
| 5 | Travel takes real time; auto-hunt runs during travel. |
| 6 | **30 towers** across the world: Small 10 floors, Big 20 floors, Main 50 floors. |
| 7 | Main tower location is **hidden, never revealed** — players must find it. |
| 8 | Tower checkpoints on every floor: resume anytime, change party members between sessions. |
| 9 | Guild cap **20 members**, guild levels + ranking. |
| 10 | 1v1 battles: winner 100 gold + XP, loser 25 gold, optional wager capped at 1,000 gold. |
| 11 | High-tier spawn cooldowns are **global** (Legendary 12h, Mythic 3 days, UwU 14 days). |
| 12 | Caps stay **per server for catching/rolling**; **no cap on buying/owning** via auction or trade. |
| 13 | Auction house is **global** across Discord, fixed 24h, 5% fee. |
| 14 | Shop refreshes **daily at midnight UTC**, same stock for everyone. |
| 15 | Duplicates fuse: 2 of the same monster → 1 stronger monster, up to +6. |

---

## 2. World map + travel

### 2.1 World structure

- **One world, all of Discord.** Every server with the bot shares the same map, the same regions, the same towers. A player in Zenith and a player in another server are in the same world. (What stays per-server: the catch/roll caps in §7 — each server still gets its own shot at the rarest monsters.)
- **~4–5 regions, ~20 areas total.** The 4 Phase 1 areas are **Region 1, the starting region** (region name unconfirmed — §10). Regions 2–5 are sketched below as working defaults; their names, area lists, and unlock levels are unconfirmed (§10).

| Region (working name — unconfirmed) | Areas (working defaults — unconfirmed) | Level range (working default) | Feel |
|---|---|---|---|
| Region 1 — Starting Lands | Meadow of Beginnings, Whispering Woods, Ember Peaks, The Hollow Deep (Phase 1 areas, §2.1 of Phase 1 doc) | 1–15 | The Phase 1 world; every new player starts here |
| Region 2 — The Shifting Dunes | Sunken Oasis, Glass Dunes, Mirage Town (names unconfirmed) | 15–30 | Desert; Fire + Earth monsters |
| Region 3 — The Frozen Reaches | Frostbite Pass, Glacial Caverns, Aurora Fields (names unconfirmed) | 30–45 | Ice; Ice + Water monsters |
| Region 4 — The Shadowlands | Gloomwood, The Weeping Marsh, Nightfall Spire (names unconfirmed) | 45–60 | Dark; Shadow + Spirit monsters |
| Region 5 — The Sky Isles (endgame) | Cloud Terraces, Storm Citadel, The Void Rift (names unconfirmed) | 60+ | Endgame; highest-tier monsters. "Void Rift" as a level-20 area is a separate open question — §10 |

- Area unlocks stay level-gated (Phase 1: 0/5/10/15 for Region 1). Region 2+ unlock levels above are working defaults.
- Monster pools follow the Phase 1 rule: tier matches area strength (§5 of Phase 1 doc). Deeper regions hold rarer tiers; Mythic/UwU encounters stay in the deepest areas, but rolls can produce them anywhere (Phase 1 rule, unchanged).

### 2.2 The map command

- `uwu map` — shows the whole world as plain text: regions in order, areas inside each, your **current location marked red** (e.g. `📍 You are here` / red `●`), and your **travel origin** marked (where you started this journey, e.g. `○ Started here`). A player always sees where they came from and where they are.
- **4 buttons** under the map message (Discord message buttons, same pattern as the hunt Catch/Run buttons):
  - **Zoom In** — show one region in detail (its areas, monsters, towers).
  - **Zoom Out** — back to the whole-world view.
  - **Mark** — drop a pin on a spot (area or tower) to remember it; your marks show on your map.
  - **Last Location** — jump the map view back to where you were before (wording: Ronit's message said "last somthing" — the exact meaning of this button is **unconfirmed**, §10. Working reading: return to your previous location/view).
- Map buttons only change the *view*; they never move the player. Movement is `uwu travel` (§2.3).

### 2.3 Travel

- `uwu travel <area>` — start travelling to an area (must be unlocked). Travel is **not instant**: it takes real time.
  - **Travel time scales with distance: 5 minutes per kilometre** (Ron's rule — "traveling 2km in our map will be like 10 mins"). A 2 km trip takes 10 minutes; a 10 km trip takes 50 minutes. Distances are measured on the world map in km.
  - While travelling, the player is "on the road": they cannot hunt manually in the destination until they arrive, but **auto-hunt runs** (see §2.4).
  - Arriving is announced with a plain-text message ("You arrived at Ember Peaks."). The player's current area updates in the database (survives redeploys — stored, not in-memory).
- Travel is free (no gold cost). The cost is time.

### 2.4 Roaming monsters + auto-hunt

- **Roaming monsters appear on the map during travel.** While a player is travelling, the bot periodically (on the hunt cadence — every 30s, the Phase 1 hunt cooldown) shows an encountered monster from the areas being passed through. This is what auto-hunt catches: **rarer in deeper regions** (the encounter pool follows the region's tiers, §2.1).
- **Auto-hunt** (`uwu autohunt on/off` — working default command name, unconfirmed):
  - While travelling with auto-hunt on, the bot auto-attempts catches using the Phase 1 catch rates (§1.3 of Phase 1 doc) — no button press needed. Caught monsters go to the zoo; missed ones flee.
  - **Travel time is the natural cap:** a 10-minute trip allows ~20 auto-hunt attempts; a 50-minute trip allows ~100. There is no separate daily auto-hunt cap in this design — the clock limits it. (If farming abuse appears in live play, a cap is a one-line follow-up — flagged in §10.)
  - **Auto-hunt costs 200 gold per hour of travel** (Ron's rule). The cost is charged for the travelling time while auto-hunt is on — a 10-minute trip with auto-hunt on costs ~33 gold. Auto-hunt is a paid convenience, not free farming.
  - Auto-hunt only runs while travelling. Standing still, hunting is manual (`uwu hunt`, Phase 1). Auto-hunt never runs while the player is idle in an area.
- Roaming encounters use the same per-server caps and the same global spawn cooldowns (§7) as manual hunts and rolls. A Legendary on spawn cooldown cannot appear as a roaming monster either.

---

## 3. Guilds

### 3.1 Structure

| Rule | Value |
|---|---|
| Max members | **20** |
| Create | `uwu guild create <name>` — costs **5,000 gold** (working default, unconfirmed) |
| Join | `uwu guild join <name>` (open) or by invite from a leader/officer |
| Leave | `uwu guild leave` |
| Roles | Leader (1, can do everything incl. kick/disband) · Officer (can invite) · Member |
| Guilds per player | 1 at a time |

- Guild names are unique per world (first come, first served). Name rules: same as Discord-safe (no slurs; the existing moderation rules apply).
- Guild membership is **global across Discord** (the world is global — §2.1): a guild can have members from different servers. Guild chat is not a Discord channel — guild info/announcements are bot messages (`uwu guild info`).

### 3.2 Guild levels + ranking

- **Guild XP** comes from member activity: every member hunt, roll, battle win, and tower floor clear adds guild XP (working default: 10 XP per hunt, 10 per roll, 50 per battle win, 100 per tower floor cleared — unconfirmed, §10).
- **Guild level** thresholds (working defaults): Level 1 at 0 XP · Level 2 at 1,000 · Level 3 at 3,000 · Level 4 at 6,000 · Level 5 at 10,000 · then +5,000 per level after. Max level **10** (working default).
- **Guild ranking board** (`uwu guild rank`): ordered by guild level first, then by total guild power (sum of members' top-3 monster power budgets, Phase 1 §3.1). Top 10 shown, plain text.
- **Perks scale with guild level** (working defaults — small by design, never balance-breaking):
  - Level 2: +2% catch chance for members
  - Level 4: +5% gold from sells
  - Level 6: +5% catch chance (total +7% with Level 2)
  - Level 8: +10% gold from sells (total +15% with Level 4)
  - Level 10: +10% catch chance (total +17%) and +5% XP
  - Perks cap at the values above. Guild perks stack with pet buffs (§3.4 of Phase 1 doc) but the combined catch-chance bonus is capped at **+30%** — a 10% UwU catch can never exceed 13%.

### 3.3 Guilds and towers

- Towers (§4) are cleared in **parties**, and a party can be all-guild, mixed, or guildless. A full-guild party gets no extra stat bonus in Phase 2 (kept out deliberately — guild perks above are the guild advantage; tower balance is tuned without guild bonuses so solo/guildless players are never locked out).
- Guilds are what make the main tower (§4.3) realistic: a 50-floor tower is a guild-scale goal even though solo entry is allowed.

---

## 4. Towers

### 4.1 Overview

| Item | Value |
|---|---|
| Total towers | **30** across the world |
| Types | Small (10 floors) · Big (20 floors) · Main (50 floors) |
| Party | **Party size is a RECOMMENDED MINIMUM, not a cap** (Ron's rule): Small tower recommends 2 players, Big 4, Main 6 — but solo is allowed (hard) and larger parties are allowed too; it's the player's choice. Each player brings their monsters (battle team = top 3 per player, Phase 1 §2.3) |
| Solo | Allowed, but needs the level requirement and is **hard** — needs strong pets/monsters (Phase 1 stat bands apply; solo players face the same floors with 3 monsters instead of up to 12) |
| Floors | Each floor = a set of wild monsters to defeat (using Phase 1 stats + the 15 status effects). Mini-boss every **5th floor** (working default). Final boss on the top floor. |
| Checkpoints | **Every floor.** Stop anytime, resume later, change party members between sessions. Progress is stored per player/party in Supabase (survives redeploys). |
| Entry requirement | Area unlock level + a tower level requirement (working default: Small = area level, Big = area level + 5, Main = level 60 — unconfirmed, §10) |

### 4.2 Tower counts — the open arithmetic

Ron's message said "2 small tower with 10 floor and 2 big like 20 floor and one main tower". **Resolved 2026-11-07: towers are placed RANDOMLY across the world map** ("Random tower drop them") — the 30 towers (small 10-floor, big 20-floor, plus the 1 hidden 50-floor main tower) are dropped at random locations across regions, not fixed at "2 small + 2 big" per region. The per-region arithmetic question is closed by randomness; the main tower stays hidden (random location, never revealed).

### 4.3 The Main tower (50 floors)

- **One Main tower in the whole world.** Best rewards in the game.
- **Location is hidden and never revealed** — it does not appear on `uwu map`, in any list, or in help text. Players must **find it** through exploring, clues, or word of mouth. (How the first discovery works — a hint system, a rare map drop, or pure exploration — is unconfirmed, §10.)
- 50 floors, mini-boss every 5th floor, final boss on floor 50.
- Clear cooldown **7 days** (tower-wide, §4.5). Because there is only one, its cooldown is the longest in the game.

### 4.4 Tower bosses

- **Mini-bosses (every 5th floor):** a powered-up monster from the roster one tier above the floor's normal pool (working default: HP ×3, ATK/DEF as listed — a Rare floor's mini-boss is an Epic-stat monster). Mini-bosses **can** be caught if defeated? No — **bosses are never catchable** (working default, consistent with the final-boss rule below). They are fought for drops only. (Whether mini-bosses are catchable is unconfirmed — §10.)
- **Final boss (top floor):** a **better-tier monster that CANNOT be caught** — fought for **drops only**. Working defaults: Small tower final boss = one tier above the tower's pool (e.g. Epic-stat), Big = Legendary-stat, Main = Mythic-stat. Final-boss drops are the best in their tower class: crates (§9), shards, weapons, and (Main only) a chance at Mythic-tier loot. High level — the Main final boss is the hardest fight in the game.
- Boss fights use the Phase 1 battle rules: damage formula (§3.1 of Phase 1 doc), the 15 status effects, max 2 effects per target, no control chains, DoT cap 12%/turn.

### 4.5 Tower clear cooldowns (tower-wide)

| Tower | Cooldown after a clear |
|---|---|
| Small (10 floors) | **6 hours** |
| Big (20 floors) | **12 hours** |
| Main (50 floors) | **7 days** |

- Cooldown is **per tower, world-wide** (the world is global — §2.1): once any party clears a tower, that tower is on cooldown for everyone until it resets. A cleared tower shows its reset timer on `uwu map` (zoomed-in view) and on `uwu tower <name>`.
- Individual players also cannot re-enter a tower they personally cleared until its cooldown ends (same timer — one rule, not two).
- Cooldowns make clears feel like events, not farms. They also pace the best loot (§9).

### 4.6 Tower commands (working defaults)

`uwu towers` (list towers in your region with floors + cooldown status) · `uwu tower <name>` (detail: floors, requirements, cooldown timer) · `uwu party invite @user` (form a party — recommended minimum depends on the tower: Small 2, Big 4, Main 6; solo or larger parties allowed) · `uwu tower enter <name>` (start/resume a run from your checkpoint) · `uwu tower leave` (stop at a checkpoint; progress saved).

---

## 5. 1v1 battles

### 5.1 Challenge flow

- `uwu battle @user` — sends a challenge. The opponent gets **Accept / Decline** buttons and has **60 seconds** to answer. No answer = the challenge expires (no penalty, no gold moved).
- `uwu battle @user <amount>` — same, with an optional **wager** (see §5.3).
- **Cooldown: 1 minute** between battles per player (either side) so nobody spams challenges.
- Battles are **global** (the world is global — §2.1): you can challenge anyone on any server where the bot is, as long as both players have the bot in common (both must share at least one server with the bot so the bot can message both).

### 5.2 How a battle plays

- **Auto-battle, top 3 monsters each side.** Each player's team is their 3 strongest zoo monsters by power budget (Phase 1 §3.1). **Auto-pick is the working default; manual team pick (`uwu team`) is unconfirmed** (§10).
- Turn-based: highest-ATK monster acts first each round. Damage per the Phase 1 formula (`max(1, ATK − DEF ÷ 2)`, crit 1.5×, base crit 10%). All 15 status effects apply with their Phase 1 trigger chances, durations, and counters. Max 2 effects per target, no control chains, DoT cap 12%/turn (Phase 1 §3.3 rules 4–7).
- A monster that faints is replaced by the next team member. First side to KO all 3 wins.
- **Presentation:** one message, edited through the rounds (suspense → settle — the same pattern as the slots spinning frames in Phase 1), then the final result line. Plain text throughout. Example result line: `🏆 Yohh wins! Solar Dragon landed the final blow. (+100 gold, +40 XP)`.
- Monster levels (§6) apply: a level-20 monster is stronger than the same monster at level 1. Battles are how caught monsters gain XP (§6.3).

### 5.3 Rewards and wagers

| Outcome | Reward |
|---|---|
| Winner | **100 gold + XP** (XP scales with the loser's team level — §6.3) |
| Loser | **25 gold** (consolation) + half the winner's XP |
| No gold lost | The loser never loses gold. No griefing. |

- **Optional wager:** `uwu battle @user <amount>` — both players put up the amount; the **winner takes the pot** (2× amount). **Cap: 1,000 gold** per player per battle. Wager gold is held in escrow at challenge-accept time (same pattern as auction escrow, §8.2) and released on the result. A declined challenge refunds instantly.
- Wagers are opt-in on both sides: the opponent sees the wager amount on the Accept/Decline buttons and can decline a wagered challenge for free.
- Battle rewards are **not** a gold fountain: 100 gold per win against the 1-minute cooldown caps battle income at ~6,000 gold/hour of non-stop winning — and winning every battle is not realistic. (Economy note: if battle farming appears, the cooldown is the lever — flagged in §10.)

---

## 6. Monster levels

### 6.1 Where levels come from

- **Wild monsters spawn with a level set by their area** (working defaults — unconfirmed, §10):

| Area / region | Wild monster level range |
|---|---|
| Meadow of Beginnings | 1–5 |
| Whispering Woods | 5–15 |
| Ember Peaks | 10–25 |
| The Hollow Deep | 15–40 |
| Region 2 areas | 15–30 |
| Region 3 areas | 30–45 |
| Region 4 areas | 45–60 |
| Region 5 areas | 60–100 |

- **Rolled monsters** (gacha) spawn at level 1 (working default — rolls are a fresh start, not a shortcut to high levels).
- **Caught monsters level up** through battles and hunts (§6.3). A caught monster keeps its level forever (until fused — §6.4, fusion keeps the higher level).
- **Monster level cap: 100** (confirmed by Ronit 2026-11-07).

### 6.2 What a level does

- **Stats scale:** +2% HP, ATK, and DEF per level above 1 (working default, multiplicative on the Phase 1 base stats). A level-20 Common has ~1.38× its base stats — stronger, but still inside its tier's character: a max-level Common (level 100, ~3× stats) is roughly a level-1 Rare, never an Epic. Tier still dominates; level refines within a tier.
- **Level is shown everywhere a monster is shown:** zoo lines, battle messages, trade/auction listings. Format: `Stone Beetle · Lv 12 · Common`.
- **Level gates:** tower entry requirements (§4.1) and deeper areas (§2.1) are level-gated on the *player's* level (the existing XP/level system, `uwu rank`), not on any single monster's level. Monster level affects fights, not access.

### 6.3 XP and coins from battles and hunts

- **Rewards are random and scale with the monster's level** (Ron's rule). Working defaults (unconfirmed, §10):
  - **Hunt catch:** XP = 10 + (monster level × 2), rolled ±20%. Coins = 5 + (monster level × 3) gold, rolled ±20%. A level-5 Meadow catch gives ~20 XP / ~20 gold; a level-40 Hollow catch gives ~90 XP / ~125 gold.
  - **Battle win:** XP = 40 + (average enemy team level × 2). Coins: the fixed 100 gold (§5.3) — battle coins do not scale with level, XP does.
  - **Tower floor clear:** XP = 50 + (floor × 5). Coins from floor drops (§9), not a fixed amount.
- XP here is the **player's** XP (the existing `uwu rank` system). Caught-monster XP is the same number applied to the monster that fought: the monster used in a battle gains the same XP the player does; a monster levels up when its own XP crosses its threshold (threshold = 100 × current level, working default). Level-up message is plain text ("Stone Beetle reached Lv 13! ATK +1").

### 6.4 Fusion (combining duplicates)

- **2 of the same monster fuse into 1 stronger monster.** (Same species only — a Stone Beetle fuses with a Stone Beetle, never with a different monster.)
- **Result:** keeps the **higher** of the two levels, gains **+10% stats** (HP/ATK/DEF, working default) per fuse level, and **unlocks a skill/effect** at each step:
  - **+1:** unlocks one extra effect slot (the fused monster can carry one more status effect than normal, up to the 2-effect cap in battle — in practice this means it *has* a second effect to use).
  - **+2:** its signature move's trigger chance +10 percentage points (e.g. Burn 25% → 35%).
  - **+3:** gains a second signature effect (chosen from its type's effect list — working default, unconfirmed).
  - **+4:** its signature move's trigger chance +10 percentage points again.
  - **+5:** +20% stats on this fuse step (instead of +10%).
  - **+6:** gains a third signature effect (capstone — chosen from its type's effect list).
- **Max +6.** A +6 monster is shown as `Stone Beetle +6`.
- **Cost:** gold per fuse, scaling with tier (working defaults — unconfirmed, §10): Common 100 · Uncommon 250 · Rare 500 · Epic 1,000 · Legendary 2,500 · Mythic 5,000 · UwU 25,000. The fused monster keeps the better level of the two; the other copy is consumed.
- **Why fusion matters:** duplicates stop being sell fodder. A Common with 64 copies is the material for one strong +6 Common — which is still a Common (tier dominates, §6.2), but a *good* one. Fusion is the long-term sink for duplicates and the reason to keep hunting Commons.
- Fusion never changes a monster's tier, never duplicates a capped monster (fusing two Mythics still counts as the same 2 owned copies becoming 1 — the per-server cap counts *copies*, so fusion can only reduce a server's count, never increase it — §7.2).

---

## 7. Spawn cooldowns + caps (the rarity engine, revised)

### 7.1 Global spawn cooldowns

After a high-tier monster is caught (by hunt, roll, or auto-hunt — **any** source), that monster **stops spawning** until its cooldown ends. The cooldown is **global across all of Discord** (the world is global — §2.1).

| Tier | Spawn cooldown after a catch |
|---|---|
| Legendary | **12 hours** |
| Mythic | **3 days** |
| UwU-tier | **14 days** |

- During cooldown the monster cannot be **encountered** (hunt, roaming, tower floors) **or rolled** (gacha). It is truly gone from the world until the timer ends. The bot tells a player who would have rolled it: the roll re-draws to the next tier down (same as the cap rule in §7.2) — the player is told why ("Void Dragon is resting — it will return in 2 days").
- Cooldowns are tracked in Supabase (per monster_id, world-wide), not in memory — a redeploy never resets them.
- Common through Epic have **no** spawn cooldown. Only Legendary+ are scarce enough to need one.

### 7.2 Per-server caps (catching/rolling only)

| Tier | Cap (catching/rolling, per Discord server) |
|---|---|
| Mythic | **3 owned per server** (per monster — 3 copies of the same Mythic, not 3 Mythics total) |
| UwU-tier | **1 per server at a time** (supersedes Phase 1 "1 ever" — §1.2) |

- Enforced exactly as in Phase 1 §1.4/§9: count `user_monsters` rows per (guild_id, monster_id) before awarding; at cap, re-roll down a tier and tell the user why; **fail closed** on a count-query error.
- **NO CAP on buying/owning via auction or trade** (Ron's decision): a server may end up with 2 UwUs if one is bought in through the auction house (§8) or traded in. The cap limits *catching and rolling*, not *owning*. This distinction is deliberate and is stated in the auction rules (§8.3) too.
- Fusion (§6.4) can only *reduce* a server's owned count (2 copies → 1), never increase it — fusion never breaks a cap.

### 7.3 Why per-server caps + global cooldowns (the fairness reasoning)

- **Per-server caps** mean every server gets its own shot: a new server is never locked out because another server already took the world's only UwU. Competition is with the people you actually play with, and the announcement means something to your server.
- **Global cooldowns** mean rarity is real world-wide: a Mythic caught anywhere disappears everywhere for 3 days. The monster stays ultra-rare at any given moment without anyone being permanently locked out.
- **"Ever" is dropped** because a hard global "one ever" would lock out every latecomer forever — the worst version of unfair. "One at a time + long cooldown" keeps the legend while keeping the door open.
- Residual unfairness, stated honestly: a 5-player server gets the same 1 UwU as a 1,000-player server. That is accepted — the alternative (caps scaled by server size) would punish small friend servers, and this bot's home is a small friends server.

---

## 8. Auction house

### 8.1 Listing and bidding

- `uwu auction <thing> <starting price>` — list anything you own: a monster, a weapon, a pet, a crate (§9), materials. Starting price in gold, minimum **100 gold** (working default).
- `uwu auctions` — browse live listings (plain text, grouped by category, with time left). `uwu auction <id>` — detail on one listing.
- `uwu bid <id> <amount>` — place a bid. Minimum increment **10% over the current bid** (working default) so bidding stays meaningful.
- **Duration: fixed 24 hours.** When time ends, the highest bid wins. No extensions, no "going once" — the timer is the timer.
- **What happens at close:** winner pays (gold was already held — §8.2), seller receives the winning bid **minus a 5% auction fee** (the fee is a gold sink), the item moves to the winner's inventory/zoo. Unsold items (no bids) **return to the seller** automatically, free.

### 8.2 Escrow (how bids stay honest)

- A bid **holds** the bidder's gold the moment it is placed (deducted from their balance, parked in escrow). A bidder cannot bid gold they do not have.
- **Outbid → instant refund:** the moment a higher bid lands, the previous bidder's gold returns to their balance automatically.
- **Winner at close:** the held gold goes to the seller (minus the 5% fee). The winner's gold was already held, so there is no "winner can't pay" case.
- **Seller cancellation:** a seller may cancel a listing **only while it has no bids**. Once a bid exists, the listing runs to the end. (Prevents a seller pulling a listing after seeing the price go low — or high and re-listing.)
- All escrow state lives in Supabase, never in memory — a redeploy mid-auction must not lose or duplicate gold.

### 8.3 Auction rules that protect the caps

- **No cap on buying/owning** (§7.2): anyone may buy anything, including a second UwU for their server. The per-server caps limit catching/rolling only.
- **No self-bidding** (a seller cannot bid on their own listing — the bot refuses it).
- **No shill protection beyond escrow in Phase 2:** a player could bid up their own item from a second account. That is out of scope for Phase 2; if it appears in live play, the fix is a "no bids from accounts sharing a guild with the seller" rule or a bid-history check — flagged in §10.
- **Global market:** the auction house is **global across Discord** — listings and bids come from every server with the bot. A bigger market means better prices and more action. A player must share at least one server with the bot to use it (same rule as battles, §5.1).

---

## 9. Shop + drops + crates

### 9.1 Shop (daily refresh)

- `uwu shop` — shows today's stock, plain text.
- **Refreshes daily at midnight UTC.** The stock is **the same for everyone each day** — one shared shop for the whole world, so it is something to talk about ("did you see today's shop?").
- **Limited quantity per item per player** (working default: 3 of each item per player per day). Stock is per-player limited, not world-limited — the shop never "sells out" globally; it sells out *for you*.
- **Stock table (working defaults):**

| Slot (daily) | What appears | Price |
|---|---|---|
| 2 potions | Heal Potion, Catch Potion (rotates: XP Potion, Antidote) | Gold (100–500 by type) |
| 1 bait | Lure Bait (+catch chance for the next hunt) | Gold (300) |
| 1 key | Tower Key (unlocks one tower floor entry without the level requirement — working default, unconfirmed) | Gold (1,000) |
| 1 crate | A random-tier crate (§9.2) | Gold (500–5,000 by tier) |
| 1 roll ticket | A free `uwu roll` (does not count toward the 20/day roll cap — working default, unconfirmed) | Gold (450 — slightly cheaper than a 500-gold roll) |
| Occasional (2–3 days a week) | A random weapon or a pet egg | Gold (tier price) or gems (rare ones) |

- **Gold for most items, gems for the rare ones** (Ron's rule). Gem prices are unconfirmed until gem uses are fully designed — the shop is the first gem sink (Phase 1 §10 item 7, partially resolved here).
- Potions/bait/keys are **consumables**: they are used from inventory (`uwu use <item>` — working default command, unconfirmed) and are gone after use. Their exact in-battle effects follow the Phase 1 effect catalogue where one exists (Antidote = Purify, §4.1 of Phase 1 doc).

### 9.2 Crates (drops)

- **Crates drop** from tower floors, final bosses, and occasionally from hunts/battles. A crate contains a random bundle of items (§9.3).
- **Name: "Crate"** (decided by Ronit 2026-11-07 — just "Crate", not "Cache" or "Hoard").
- **Crate tiers** (same tier names as monsters):

| Crate tier | Crate name | Where it drops |
|---|---|---|
| Common | Wooden Crate | Any hunt, small tower floors |
| Uncommon | Iron Crate | Hunts, small tower floors |
| Rare | Silver Crate | Rare hunts, big tower floors |
| Epic | Golden Crate | Big tower floors, mini-bosses |
| Legendary | Crystal Crate | Big tower final boss, Main tower floors |
| Mythic | Void Crate | Main tower final boss only |

- **Opening a crate** (`uwu open <crate>` — working default command, unconfirmed): the crate is consumed and its contents are revealed in plain text. Contents are random within the crate's tier band — a Wooden Crate never contains Mythic loot; a Void Crate never contains Commons.
- Crate drop rates are unconfirmed (§10) — working default: a crate drops on ~10% of tower floor clears, ~5% of hunts, 100% from final bosses (one crate of the tower's tier).

### 9.3 Drops list (what can drop, and from where)

| Drop | What it is for | Main source |
|---|---|---|
| **Shards** | Upgrade/evolve monsters (the main grind currency) | Tower floors, bosses, hunt sells |
| **Potions** | Heal, catch boost, XP boost (consumables) | Shop, crates, tower floors |
| **Weapons** | Tiered gear (§6 of Phase 1 doc) | Rolls (Phase 1), tower drops, shop (occasional) |
| **Armor / accessories** | Defence and buffs for your team (new slot — working default, unconfirmed) | Tower drops, crates |
| **Monster cores** | Crafting material from monsters | Selling/sacrificing monsters (Phase 1 §2.4) |
| **Scales, fangs, feathers, crystals, ores** | Crafting materials, each tied to monster types | Hunt drops, tower floors |
| **Gems** | Rare currency; rare shop items, fusion of high tiers | Bosses, sacrifices (Phase 1 §2.4), crates |
| **Pet eggs** | Hatch into pets | Crates, shop (occasional), tower drops |
| **Skill books / scrolls** | Teach monsters new moves or effects | Tower drops, crates |
| **Evolution stones** | Evolve a monster to the next tier (new mechanic — working default, unconfirmed: one stone + shards + gold evolves a +6 monster up one tier) | Main tower, Mythic crates |
| **Keys** | Tower keys, chest keys | Shop, crates |
| **Roll tickets** | A free `uwu roll` | Shop, crates, quests (future) |
| **Treasure chests** | A random bundle of the above (a crate that contains crates' worth of loot — the "big" drop) | Final bosses only |
| **Badges / trophies** | Proof of clears; shown on `uwu rank` / profile | Tower clears, boss kills |
| **Runes** | Socket into weapons for bonus effects | Tower drops, crates |

- Drop sources are working defaults. Exact drop *rates* per source are unconfirmed (§10) — they are tuned after Phase 2 has live data, like the Phase 1 boss tuning note.

---

## 10. Data model additions (Supabase — sketch)

Phase 1 tables stay as they are (§9 of Phase 1 doc). New tables (all created by the bot on startup with `CREATE TABLE IF NOT EXISTS`, same pattern as Phase 1 — no direct DB access):

| Table | Key columns | Purpose |
|---|---|---|
| `user_location` | user_id, current_area, travelling_to, travel_ends_at, travel_origin, auto_hunt (bool), map_marks (json) | Position, travel state, map pins |
| `towers` | tower_id, name, type (small/big/main), region, area, floors, hidden (bool), level_req | Static catalogue (30 rows) |
| `tower_progress` | user_id / party_id, tower_id, floor_reached, checkpoint_at, party_members (json) | Checkpoints — resume anytime, change party between sessions |
| `tower_cooldowns` | tower_id, cleared_at, resets_at | Tower-wide clear cooldowns (§4.5) |
| `spawn_cooldowns` | monster_id, caught_at, available_at | Global spawn cooldowns (§7.1) |
| `guilds` | guild_id (bot guild, not Discord guild), name, leader_id, level, xp, created_at | Guilds (max 20 members) |
| `guild_members` | guild_id, user_id, role (leader/officer/member), joined_at | Membership + roles |
| `user_monster_levels` | user_id, monster_id (instance), level, xp, fuse_level (+0–+6) | Monster levels + fusion state (§6) — or columns on `user_monsters` |
| `auctions` | auction_id, seller_id, item_type, item_ref, start_price, current_bid, current_bidder, ends_at, status | Listings + escrow state (§8) |
| `shop_stock` | date, item_id, price, currency (gold/gems), qty_per_player | Daily shop (§9.1) — one row per item per day, same for everyone |
| `user_crates` | user_id, crate_tier, qty | Crate inventory (§9.2) |
| `user_materials` | user_id, material, qty | Shards, cores, scales, etc. (§9.3) |
| `announcements` | id, title, body, posted_by, posted_at | Update feed (§11.1) |
| `rare_logs` | id, user_id, guild_id (Discord server), item_type, item_ref, tier, source (hunt/roll/auction/trade/shop), caught_at | Rare-catch feed (§11.2) |

**Enforcement notes:** caps (§7.2) and escrow (§8.2) are fail-closed like Phase 1 §9: a failed count/balance query refuses the award or bid, never grants it. Auction escrow, tower checkpoints, travel state, and spawn cooldowns must all survive redeploys (database, never in-memory).

---

## 11. Announcements + logs

Added 2026-11-07 (Ron's words: "Add announcment as uwu announcement to see what we add like new monsters or whatever / And logs as uwu logs to see who got epic or legendary monster or weapons"). Doc only — NOT built yet.

### 11.1 `uwu announcements` — what's new

- **What it shows:** the update feed — new monsters, new weapons, new pets, new areas, new features, balance changes, events. Newest first, latest 10, plain text (one short line per update with its date).
- **How entries get there:** bot owner / server admins post with `uwu announce <title> | <text>` (admin-only; exact permission set unconfirmed — §12). Entries are stored in `announcements`, never hard-coded, so the feed survives redeploys.
- **Auto-entries (working default):** when a content update ships (new monsters/weapons added to the roster), the deploy notes are posted automatically as one announcement — so players see "12 new monsters added" without an admin typing it.
- **Scope:** global — the same feed for every server, because the world is one shared world (§2). A server that wants only its own news uses the log channel instead (§11.3).

### 11.2 `uwu logs` — who got the rare stuff

- **What it shows:** the rare-catch feed — every Epic, Legendary, Mythic, and UwU monster caught or rolled, and every Epic+ weapon obtained, with the player's name, the item, its tier, how they got it (hunt / roll / auction / trade / shop), and when.
- **Default scope:** your Discord server's recent catches (latest 10, plain text). `uwu logs global` shows the same feed across all of Discord.
- **What is NOT logged:** Common / Uncommon / Rare catches (too noisy). Only Epic+ — the feed stays a brag board, not a spam list.
- **How entries get there:** automatic — every qualifying catch/roll writes a `rare_logs` row at the same moment the monster is awarded (same DB transaction, so a logged catch is a real catch). Auction/trade/shop entries are written when the item changes hands. Nothing is logged by hand.
- **Privacy:** public by design — the point is showing off. A player who does not want their catches shown has no opt-out in this design (flagged in §12).

### 11.3 Optional: server log channel

- **Working default (unconfirmed):** a server admin can set a channel with `uwu setlogchannel #channel` — Epic+ catches from that server are auto-posted there as they happen (same plain-text format as `uwu logs`). Without it set, nothing is auto-posted and the feed lives only in the `uwu logs` command.
- **Announcements are NOT auto-posted to servers** — they live in `uwu announcements` only, so servers are never spammed by global update posts.

---

## 12. Open questions (Ronit's call — everything unconfirmed)

| # | Item | Working default in this doc | Needs |
|---|---|---|---|
| 1 | "Last Location" map button meaning | Return to previous location/view | Confirm what the 4th button does ("last somthing") |
| 2 | ~~Tower counts: "2 small + 2 big"~~ — RESOLVED 2026-11-07: towers placed randomly across the world map | Resolved | — |
| 3 | Region names, area lists, unlock levels (Regions 2–5) | Working defaults in §2.1 | Names, areas, levels |
| 4 | 5th endgame area ("Void Rift", level 20) | Listed as a Region 5 area | Confirm whether it exists, and at what level |
| 5 | ~~Travel time~~ — RESOLVED 2026-11-07: 5 minutes per kilometre (2 km = 10 min) | Resolved | — |
| 6 | Auto-hunt abuse cap | None — travel time is the cap; auto-hunt costs 200 gold/hour (decided 2026-11-07) | Decide if a separate cap is needed after live play |
| 7 | ~~Monster level cap~~ — RESOLVED 2026-11-07: 100 | Resolved | — |
| 8 | Monster level stat scaling (+2%/level) + XP/coin reward formulas (§6.2–6.3) | Working defaults | Confirm or tune |
| 9 | Battle team pick | Auto top-3 | Confirm auto vs manual `uwu team` pick |
| 10 | Fusion numbers: +10% stats, effect unlocks at +1..+6, gold costs by tier (§6.4) | Working defaults | Confirm or tune |
| 11 | Evolution stones (evolve a +6 monster up one tier) | Working default mechanic | Confirm the mechanic exists at all |
| 12 | Armor / accessories slot | New slot, working default | Confirm or drop |
| 13 | Mini-bosses catchable? | No — bosses are never catchable | Confirm |
| 14 | Main tower discovery (how players find a hidden tower) | Unspecified | Hint system / rare map drop / pure exploration? |
| 15 | Tower entry level requirements | Small = area level, Big = +5, Main = 60 | Confirm numbers |
| 16 | Guild create cost (5,000 gold), guild XP awards, level thresholds, max level 10 | Working defaults | Confirm or change |
| 17 | ~~Crate name: "Cache" or "Hoard"~~ — RESOLVED 2026-11-07: just **"Crate"** | Resolved | — |
| 18 | Crate drop rates (tower floors ~10%, hunts ~5%, final boss 100%) | Working defaults | Confirm or tune |
| 19 | Shop details: Tower Key effect, roll ticket vs the 20/day cap, `uwu use` command | Working defaults | Confirm mechanics |
| 20 | Drop rates per source (§9.3) | Unspecified — tune after live data | Set after Phase 2 has been live |
| 21 | Battle-farming lever (1-min cooldown) | 1 min between battles | Confirm, or tighten if farming appears |
| 22 | Auction shill protection | None in Phase 2 | Decide if/when to add |
| 23 | Guild perks exact numbers (§3.2) | Working defaults | Confirm or tune |
| 24 | Tower Key: unlocks one tower floor entry without the level requirement | Working default | Confirm the item exists and what it does |
| 25 | Announcements: who can post (`uwu announce`) | Bot owner + server admins | Confirm permission set |
| 26 | Logs: default scope server vs global; opt-out? | Default server, `uwu logs global` for all-Discord; no opt-out | Confirm scope + whether players can hide their catches |
| 27 | Server log channel (`uwu setlogchannel`) | Optional, off by default | Confirm it exists at all |

---

## Appendix — consistency checks done during writing

- [x] Phase 1 numbers reused exactly: roll 500 gold, pity 50 → Epic min, daily roll cap 20, catch rates 90/75/60/45/30/15/10, hunt cooldown 30s, tier rates 60/25/10/4/0.9/0.09/0.01, Mythic cap 3/server, sell prices, pet buffs, the 15 status effects and their counters, damage formula, power budget, stat bands.
- [x] Every Phase 2 change vs Phase 1 is listed in §1.2 (UwU "ever" → "at a time" + cooldown; battle rewards; bosses → towers; guild size/perks).
- [x] Spawn cooldowns + per-server caps + no-cap-on-buying are stated in one place (§7) and repeated in the auction rules (§8.3) so the distinction cannot be missed.
- [x] No new currency is invented: gold and gems only (gems already exist from Phase 1 §2.4). Shards/materials are inventory items, not currencies.
- [x] Every system that moves gold or items is fail-closed and database-backed (§10 table notes; §7.2, §8.2).
- [x] Open questions are all listed in §12 with their working defaults — nothing in this doc is silently decided.
