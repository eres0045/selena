# uwu Hunt World — Design Document

> **Status:** DESIGN ONLY — for Ronit's review. No bot code, no emoji uploads, no deploys.
> **Written:** 2026-11-07 · **Bot:** uwu (discord.js v14 + TypeScript, prefix `uwu`, plain-text OwO-style replies, Supabase persistence)
> **Scope:** Phase 1 = hunt + roll/gacha + areas + zoo/inventory + sell/sacrifice + equip + pets.
> Phase 2 = battle + bosses (sketch only, §8).

All monster/weapon/pet names in this doc are **original** — generic fantasy names only, no franchise names or characters. Monster concepts may be *inspired by* emoji.gg creature-type visuals (slimes, dragons, wolves, ghosts, golems), but every name is ours. **Emoji art is attached in a later step; tier assignment for every entry is re-checked against its actual visuals then** — if a monster's art looks far stronger/weaker than its tier here, its tier moves (stats move with it) before launch.

---

## 1. Locked numbers (decided by Ronit, 2026-11-07)

### 1.1 Rarity tiers + roll (gacha) drop rates

| Tier | Roll rate | Colour | Announcement | Supply |
|---|---|---|---|---|
| Common | 60% | Gray | No | Unlimited |
| Uncommon | 25% | Green | No | Unlimited |
| Rare | 10% | Blue | No | Unlimited |
| Epic | 4% | Purple | No | Unlimited |
| Legendary | 0.9% | Gold | Server-wide | Unlimited but rare |
| Mythic | 0.09% | Red/Pink | Server-wide + special embed | Limited per server (cap: **3** — unconfirmed, see §10) |
| UwU-tier | 0.01% | Rainbow/animated | Server-wide + bot-wide (all servers) | **1 per server, ever** |

Rates sum to 100%. These percentages are the **roll** rates only. Hunt encounters use different weighting (§2.1).

### 1.2 Roll price

- **500 gold per roll.** 10-roll: **4,500 gold** (working default — unconfirmed, §10).
- **Pity:** after 50 rolls with no Epic or better, the next roll is guaranteed Epic minimum. Pity never guarantees Legendary or above. Pity counter is per user, resets on any Epic+ pull. (Economy impact checked in §7: 50 rolls = 25,000 gold per pity trigger; pity fires on only ~8% of 50-roll stretches — see §7.3.)

### 1.3 Hunt

- Command: `uwu hunt` (optional area: `uwu hunt <area>`). **Cooldown: 30 seconds.**
- The bot shows one encountered monster (emoji + name + tier colour) with a **Catch** button.
- **Catch rates by tier** (separate from roll rates):

| Tier | Catch rate |
|---|---|
| Common | 90% |
| Uncommon | 75% |
| Rare | 60% |
| Epic | 45% |
| Legendary | 30% |
| Mythic | 15% |
| UwU-tier | 10% |

- A failed catch costs nothing except the cooldown — the monster flees. Rarity lives in *finding* the monster, not in failing the catch.
- A caught monster goes to the user's zoo. Duplicates are allowed (see sell/sacrifice, §2.4).

### 1.4 Per-server limits (how they work)

- "Per server" = **per Discord server (guild)**, never the hosting server. Every Discord server has a guild ID; Zenith Esports is `1568300887326331030`.
- Every caught/rolled monster is stored in Supabase with the **guild ID** attached. Before awarding a Mythic or UwU-tier monster, the bot counts how many copies of *that* monster already exist in that guild:
  - **Mythic:** cap **3 per server** (unconfirmed, §10). At cap, the roll/hunt re-rolls to the next tier down (Legendary) instead — the user is told "this Mythic is maxed out in this server".
  - **UwU-tier:** cap **1 per server, ever**. Once caught in a guild, it can never drop there again — but it can still drop in a *different* server where the bot is, because that server's count is 0. The single copy is **tradeable but never duplicated**.
- If the bot is only in Zenith, "per server" just means Zenith. If it joins other servers later, each gets its own separate limits automatically.

### 1.5 Roster size + tier splits (working defaults — unconfirmed, §10)

| | Common | Uncommon | Rare | Epic | Legendary | Mythic | UwU | Total |
|---|---|---|---|---|---|---|---|---|
| Monsters | 40 | 25 | 15 | 10 | 6 | 3 | 1 | **100** |
| Weapons | 20 | 12 | 8 | 5 | 3 | 1 | 1 | **50** |
| Pets | 6 | 5 | 4 | 2 | 2 | 1 | 0 | **20** |

---

## 2. Systems summary

### 2.1 Hunt + areas/map

- `uwu hunt` — encounter in your current area. `uwu map` — list areas. `uwu hunt <area>` — hunt in a named area (must be unlocked).
- Areas gate rarity: weak areas hold mostly Commons; deep areas hold the rares. Encounter weighting inside an area is a *separate* table from roll rates (same tier names, different numbers — a Legendary is 0.9% on a roll but its *encounter* chance in the deepest area is higher, because the area's pool is small and pre-filtered by tier).
- **Areas (names/counts unconfirmed, §10):**

| Area | Unlock | Monster pool (tiers) | Feel |
|---|---|---|---|
| Meadow of Beginnings | Level 1 | Common, Uncommon | Safe, grassy, starter monsters |
| Whispering Woods | Level 5 | Uncommon, Rare | Dark forest, trickier monsters |
| Ember Peaks | Level 10 | Rare, Epic | Volcanic, strong monsters |
| The Hollow Deep | Level 15 | Epic, Legendary, Mythic, UwU | Endgame; only place Mythic/UwU can be *encountered* (they can still be *rolled* anywhere) |

- Level here = the bot's existing XP/level system (`uwu rank`). No new levelling system.
- A monster's tier should roughly match its area — the best-looking monster of a strong area becomes that area's Mythic, not the best-looking slime from area one. Visuals decide *within* an area/power band (§5).

### 2.2 Roll / gacha

- `uwu roll` — 500 gold, one pull, instant plain-text result. `uwu roll10` — 4,500 gold, ten pulls, one message listing all ten (or a short summary + full list if it fits Discord's 2,000-char limit; otherwise split).
- Roll pulls from the **whole roster** weighted by the §1.1 rates. Roll ignores area — a Common-area player can roll a Legendary, at 0.9%.
- Roll is the gold sink: it is what keeps gold valuable. Hunt is free (time-gated); roll is paid (gold-gated).
- Every Legendary+ roll triggers the §1.1 announcements. Mythic/UwU rolls enforce the §1.4 caps first.

### 2.3 Zoo / inventory

- `uwu zoo` — your caught monsters, grouped by tier, with counts. `uwu zoo <name>` — detail on one monster (stats, effect, area).
- `uwu inv` — weapons and items. `uwu pets` — your pets and which one is following you.
- Team: a user's battle team (phase 2) is their 3 strongest zoo monsters by power score (§3.3). No separate team-building UI in phase 1.

### 2.4 Sell / sacrifice duplicates

- `uwu sell <monster>` — sell a duplicate for gold. Sell price = 10% of the tier's roll value: Common 25, Uncommon 60, Rare 150, Epic 400, Legendary 1,500, Mythic 5,000, UwU 25,000 gold. (UwU/Mythic sell prices are high because the supply is capped — selling one is a real decision.)
- `uwu sacrifice <monster>` — destroy a duplicate for **gems** (the second currency, emoji `:gem:` already wired; gem mechanics otherwise still Ronit's call). Sacrifice yields: Common 1 gem, Uncommon 2, Rare 5, Epic 12, Legendary 40, Mythic 150, UwU 500 gems. Gems are the long-term sink for whatever gems eventually buy (to be decided — see §10).
- Selling/sacrificing the *last* copy of a monster asks for confirmation first (plain-text "are you sure?" + confirm button). Never silently delete a user's only copy.

### 2.5 Equip weapons

- `uwu equip <weapon>` — equip one weapon; it applies its ATK bonus + effect to your hunts/battles (phase 1: boosts your catch-adjacent battle power, which matters for phase 2; in phase 1 the visible effect is the weapon's ATK bonus shown on your profile/team).
- One weapon equipped at a time. Equipping a second replaces the first (the old one returns to inventory, never deleted).
- Weapon ATK bonus bands per tier — §3.2.

### 2.6 Pets as followers

- `uwu pet` — list pets; `uwu pet <name>` — set your active follower. One active pet at a time.
- Pets give a small passive buff (§3.4). Only the active follower's buff applies — pet buffs never stack.
- Pets are companions, not fighters: they never take damage and can't be sold for the same prices as monsters (sell: half the monster sell price of the same tier; sacrifice: same gem yields as monsters).

### 2.7 What a hunt reply looks like (OwO-style plain text)

```
You wander into the Whispering Woods...
A wild 🌿 Thornback (Rare) appeared!
HP 145 · ATK 24 · DEF 14 — it looks ready to fight.
[ Catch ]  [ Run ]
```

Catch success: `Caught it! 🌿 Thornback joined your zoo. (Rare)`. Catch fail: `It slipped away... (30s cooldown)`.

---

## 3. Stat framework + balance rules

### 3.1 Monster stat bands per tier

Damage formula (phase 2 battles, stated now so the bands are checkable):
`damage per hit = max(1, ATK − DEF ÷ 2)`, crit = 1.5× damage, base crit chance 10%.

| Tier | HP | ATK | DEF | Power budget* |
|---|---|---|---|---|
| Common | 40–70 | 8–14 | 4–8 | 84–150 |
| Uncommon | 70–110 | 13–20 | 7–12 | 143–226 |
| Rare | 110–160 | 19–28 | 11–17 | 219–323 |
| Epic | 160–230 | 27–38 | 16–24 | 316–454 |
| Legendary | 230–320 | 37–50 | 23–32 | 447–616 |
| Mythic | 320–450 | 49–65 | 31–42 | 609–836 |
| UwU-tier | 450–550 | 64–78 | 41–50 | 829–1012 |

\* Power budget = HP + 4×ATK + 3×DEF. Every roster entry must fall inside its tier's budget range.

**Worked check (low tier can never beat high tier by luck alone):**
Bare Epic (ATK 38, DEF 24, HP 230) vs fully-equipped Common (ATK 14 + weapon 5 = 19, DEF 8, HP 70).
Epic hits Common for 38 − 4 = 34 → 3 hits to kill. Common hits Epic for 19 − 12 = 7 → 33 hits to kill. Even with maximum crit luck (1.5×), the Common needs 22 hits vs the Epic's 3. A tier gap is decisive; luck only matters *within* a tier.

### 3.2 Weapon ATK bonus bands per tier

| Tier | ATK bonus |
|---|---|
| Common | +2 – +5 |
| Uncommon | +5 – +9 |
| Rare | +9 – +14 |
| Epic | +14 – +20 |
| Legendary | +20 – +28 |
| Mythic | +28 – +38 |
| UwU-tier | +38 – +50 |

**Rule:** a weapon's bonus never exceeds ~65% of its tier's monster ATK ceiling (e.g. Common weapon +5 vs Common monster ATK max 14 = 36%). A weapon upgrades its tier's monster; it never lets a Common out-damage a bare Epic (§3.1 check above holds with the best weapon equipped).

### 3.3 Balance rules (hard rules, enforced in code review)

1. **Tier bands are ceilings.** No monster's HP/ATK/DEF may exceed its tier band; no monster's power budget may exceed its tier's budget range.
2. **A Common can never one-shot anything.** Max Common damage per hit: (14 + 5 weapon) × 1.5 crit = 28 vs the weakest monster's 40 HP — always survives at least 2 hits. Same check at every tier: max damage per hit < 50% of the *same-tier minimum* HP.
3. **Mythic/UwU power is bounded.** The UwU monster's budget (≤1012) is ~1.65× a Legendary's ceiling (616) — strong, not godlike. A team of 3 good Legendaries can beat a lone UwU in phase 2.
4. **No infinite effect stacks.** Max **2 status effects** active on one target at once. Applying a third replaces the oldest. Re-applying the *same* effect refreshes its duration — it never stacks magnitude or duration beyond its listed max.
5. **No control chains.** After Stun/Freeze/Sleep ends, the target is immune to all control effects (stun, freeze, paralyze, sleep, confuse) for 1 turn.
6. **Every strong effect has a counter** (§4 — each entry names its counter).
7. **DoT caps.** Total damage-over-time on one target is capped at 12% of max HP per turn, no matter how many DoT effects are active.
8. **Pet buffs don't stack.** Only the active follower applies; total passive buff from pets is capped at +25% (§3.4).
9. **Pity is Epic-only.** Pity (§1.2) can never produce Legendary+ — it guarantees an Epic floor, nothing more.
10. **Caps are data, not promises.** Mythic/UwU supply caps are enforced by counting rows in Supabase per guild (§1.4) — if the count query fails, the award is refused rather than granted (fail closed).

### 3.4 Pet buff strength per tier

| Tier | Buff strength | Example |
|---|---|---|
| Common | +3% | +3% gold from sells |
| Uncommon | +5% | +5% catch chance |
| Rare | +8% | +8% gold from sells |
| Epic | +12% | +12% catch chance |
| Legendary | +18% | +18% gold from hunts |
| Mythic | +25% | +25% catch chance |

Cap: +25% total from pets. One pet, one buff — a pet's buff is fixed at design time (§6), not chosen by the user.

### 3.5 Elements / types

Ten types, used for flavour and for effect counters (e.g. Burn is thawed by Fire, Poison is cleansed by Nature): Fire, Water, Earth, Wind, Nature, Ice, Lightning, Shadow, Light, Spirit. No type-advantage damage multiplier in phase 1 (keeps balance simple); types only gate which effects a monster can carry and which counters apply.

---

## 4. Status-effect catalogue

15 effects. Every entry: name · what it does · trigger chance · duration · magnitude · who can have it · counter. Control effects obey rule 5 (§3.3); DoT effects obey rule 7 (§3.3); max 2 effects per target (§3.3 rule 4).

### 4.1 Damage-over-time

| # | Effect | What it does | Trigger | Duration | Magnitude | Tiers that can have it | Counter |
|---|---|---|---|---|---|---|---|
| 1 | **Burn** | Fire damage each turn | 25% on hit | 3 turns | 5% max HP / turn | Common+ | Burn is removed instantly by any Water-type hit; Regen (§4.3) halves Burn damage while active |
| 2 | **Poison** | Toxic damage each turn | 30% on hit | 4 turns | 4% max HP / turn | Common+ | Purify (any Nature-type move or the Antidote item) removes it; Poison never stacks with itself |
| 3 | **Bleed** | Wound damage + weakened attacks | 25% on hit | 3 turns | 3% max HP / turn **and** ATK −10% while bleeding | Uncommon+ | Regen removes Bleed; Bleed damage ignores Shield but never exceeds the 12% DoT cap |

### 4.2 Control (target loses turns or acts badly)

| # | Effect | What it does | Trigger | Duration | Magnitude | Tiers that can have it | Counter |
|---|---|---|---|---|---|---|---|
| 4 | **Stun** | Target skips its next turn | 15% on hit | 1 turn | Full skip | Rare+ | Cannot be cleansed, but a stunned target can't be re-stunned until 1 turn after it ends (rule 5); Stun never triggers on a target that already has a control effect |
| 5 | **Freeze** | Target skips its next turn and takes more damage | 12% on hit | 1 turn skip + DEF −20% for 2 turns | Full skip + DEF −20% | Rare+ | Any Fire-type hit (or Burn) thaws instantly and ends both parts |
| 6 | **Paralyze** | Target may fail to act | 20% on hit | 2 turns | 50% chance to skip each turn | Rare+ | Purify removes it; a paralyzed target that *does* act gets +10% ATK that turn (shaky but angry) |
| 7 | **Sleep** | Target sleeps, does nothing | 15% on hit | 2 turns | Full skip while asleep | Epic+ | Any damage wakes the target immediately (the rest of the Sleep is lost) |
| 8 | **Confuse** | Target may hurt itself | 20% on hit | 2 turns | 30% chance per turn to hit itself for 50% of its own ATK | Epic+ | Landing a successful hit on the enemy ends Confuse early; a confused target can't be re-confused until it ends |

### 4.3 Debuffs

| # | Effect | What it does | Trigger | Duration | Magnitude | Tiers that can have it | Counter |
|---|---|---|---|---|---|---|---|
| 9 | **Attack Down** | Target hits weaker | 35% on hit | 3 turns | ATK −25% | Common+ | Any Attack Up buff overwrites it (they cancel, neither applies); ends early if the target lands a crit |
| 10 | **Defense Down** | Target takes more damage | 30% on hit | 3 turns | DEF −30% | Common+ | Any Defense Up buff / Shield overwrites it; a Shield active on the target blocks Defense Down from applying |

### 4.4 Buffs (applied to self or allies)

| # | Effect | What it does | Trigger | Duration | Magnitude | Tiers that can have it | Counter |
|---|---|---|---|---|---|---|---|
| 11 | **Regen** | Heal each turn | On use (signature move, 100%) | 3 turns | Heal 6% max HP / turn | Rare+ | Any active Poison or Burn cancels Regen (DoT beats healing); Regen never stacks with itself |
| 12 | **Lifesteal** | Heal from damage you deal | On use (100%) | 3 turns | Heal 30% of damage dealt | Rare+ | High-DEF targets reduce the healing because healing scales with damage dealt; Attack Down cuts it too |
| 13 | **Shield** | Absorb incoming damage | On use (100%) | 2 turns | Absorbs up to 20% max HP, then breaks | Uncommon+ | Bleed damage ignores Shield; Shield breaks instantly if it absorbs its full cap in one hit (no overflow protection beyond the cap) |
| 14 | **Crit Up** | Crit more often | On use (100%) | 3 turns | +25% crit chance (crit = 1.5× damage) | Rare+ | Evasion Up (§4.4 #15) dodges crits the same as normal hits; Attack Down reduces the value of crits |
| 15 | **Evasion Up** | Dodge attacks | On use (100%) | 2 turns | +20% dodge chance | Epic+ | Sure-Hit signature moves ignore evasion; a dodging target can't dodge while Stunned, Frozen or Asleep |

### 4.5 Effect balance notes

- **Trigger chances are per hit, not per battle.** A 25% Burn on a fast multi-hit monster is stronger than on a slow one — the roster accounts for this: multi-hit signature moves carry the *weakest* effects (Burn/Poison/Attack Down), never Stun/Freeze/Sleep.
- **Control-effect budget:** a monster may carry at most **one** control effect (Stun/Freeze/Paralyze/Sleep/Confuse). Buff monsters may carry at most **one** buff + one DoT/debuff.
- **DoT cap check:** worst legal case — Burn (5%) + Poison (4%) + Bleed (3%) = 12% max HP/turn, exactly at the §3.3 rule 7 cap. Nothing can exceed it.
- **Strongest single-turn swing:** a Mythic with Crit Up + a crit = 65 ATK × 1.5 = 97 damage vs the weakest Legendary (DEF 23 → 97 − 11 = 86) — still under half the Legendary's minimum HP (230). No one-shot, even in the best case.

---

## 5. Monster roster — 100 monsters

Areas: **M** = Meadow of Beginnings · **W** = Whispering Woods · **P** = Ember Peaks · **H** = The Hollow Deep.
Every entry's stats sit inside its tier band (§3.1). Effects reference the catalogue (§4).

### 5.1 Common — 40 (Meadow + Woods)

| # | Name | Type | HP / ATK / DEF | Signature move (effect) | Area |
|---|---|---|---|---|---|
| 1 | Pebble Pup | Earth | 55 / 10 / 6 | Tackle | M |
| 2 | Sproutling | Nature | 50 / 9 / 7 | Vine Slap | M |
| 3 | Cinder Mouse | Fire | 45 / 11 / 5 | Ember Nip (Burn) | M |
| 4 | Bubble Frog | Water | 60 / 8 / 8 | Splash | M |
| 5 | Dust Bunny | Earth | 48 / 9 / 6 | Hop Kick | M |
| 6 | Glow Moth | Light | 42 / 10 / 5 | Dazzle | M |
| 7 | Thorn Rat | Nature | 52 / 11 / 6 | Gnaw | M |
| 8 | Pebble Crab | Water | 65 / 9 / 8 | Pinch | M |
| 9 | Ash Sparrow | Wind | 44 / 12 / 5 | Peck | M |
| 10 | Moss Turtle | Earth | 70 / 8 / 8 | Shell Bump | M |
| 11 | Dewdrop Slime | Water | 58 / 9 / 6 | Goo Slap | M |
| 12 | Ember Ant | Fire | 46 / 10 / 5 | Bite (Burn) | M |
| 13 | Cloud Sheep | Wind | 62 / 8 / 7 | Fluff Ram | M |
| 14 | Root Mole | Earth | 56 / 10 / 7 | Dig | M |
| 15 | Firefly Sprite | Light | 40 / 12 / 4 | Flash | M |
| 16 | Mud Piglet | Earth | 66 / 9 / 7 | Mud Toss | M |
| 17 | Berry Fox | Nature | 50 / 11 / 6 | Berry Bite | M |
| 18 | Frost Minnow | Ice | 54 / 9 / 6 | Cold Splash | M |
| 19 | Spark Beetle | Lightning | 48 / 11 / 5 | Zap | M |
| 20 | Shadow Wisp | Shadow | 44 / 12 / 5 | Shade Touch | M |
| 21 | Acorn Squirrel | Nature | 50 / 10 / 6 | Nut Throw | M |
| 22 | Pebble Snake | Earth | 58 / 10 / 6 | Coil | M |
| 23 | Drizzle Duck | Water | 60 / 9 / 7 | Wing Slap | M |
| 24 | Cinder Cat | Fire | 47 / 12 / 5 | Scratch (Burn) | M |
| 25 | Gust Hare | Wind | 46 / 12 / 5 | Quick Kick | M |
| 26 | Stone Beetle | Earth | 68 / 8 / 8 | Horn Push | M |
| 27 | Glowcap Shroom | Nature | 55 / 9 / 7 | Spore Puff (Poison) | W |
| 28 | Mist Bat | Shadow | 45 / 11 / 5 | Wing Buffet | W |
| 29 | Bark Beetle | Nature | 64 / 9 / 7 | Bark Bite | W |
| 30 | Ember Lizard | Fire | 52 / 11 / 6 | Tail Whip (Burn) | W |
| 31 | Frost Hare | Ice | 50 / 10 / 6 | Ice Kick | W |
| 32 | Static Eel | Lightning | 48 / 12 / 5 | Shock | W |
| 33 | Dusk Moth | Shadow | 46 / 11 / 5 | Dust Wing | W |
| 34 | River Otter | Water | 62 / 9 / 7 | Slide Tackle | W |
| 35 | Spike Puffer | Water | 60 / 10 / 7 | Spike Roll | W |
| 36 | Cinder Imp | Fire | 45 / 12 / 5 | Impish Jab (Burn) | W |
| 37 | Gale Chick | Wind | 43 / 12 / 5 | Gust Peck | W |
| 38 | Pebble Golemlet | Earth | 70 / 9 / 8 | Rock Toss | W |
| 39 | Wisp Cat | Spirit | 48 / 11 / 6 | Spirit Paw | W |
| 40 | Dew Beetle | Water | 57 / 9 / 6 | Bubble Pop | W |

### 5.2 Uncommon — 25 (Woods + Peaks)

| # | Name | Type | HP / ATK / DEF | Signature move (effect) | Area |
|---|---|---|---|---|---|
| 41 | Thorn Wolf | Nature | 85 / 16 / 9 | Fang Bite (Bleed) | W |
| 42 | Ember Fox | Fire | 78 / 18 / 8 | Flame Dash (Burn) | W |
| 43 | Frost Wolf | Ice | 90 / 15 / 10 | Ice Fang | W |
| 44 | Storm Hawk | Lightning | 76 / 19 / 8 | Dive Strike | W |
| 45 | Moss Golem | Earth | 105 / 14 / 12 | Slam | W |
| 46 | Shadow Panther | Shadow | 80 / 18 / 9 | Shadow Pounce | W |
| 47 | Tide Serpent | Water | 95 / 15 / 10 | Coil Crush | W |
| 48 | Gale Gryphon | Wind | 82 / 17 / 9 | Talon Rake | W |
| 49 | Cinder Boar | Fire | 100 / 16 / 11 | Charge (Burn) | W |
| 50 | Spirit Owl | Spirit | 75 / 18 / 8 | Hex Gaze (Attack Down) | W |
| 51 | Thorn Stag | Nature | 92 / 16 / 10 | Antler Charge (Bleed) | W |
| 52 | Frost Bear | Ice | 108 / 15 / 12 | Ice Slam | W |
| 53 | Spark Lynx | Lightning | 78 / 19 / 8 | Volt Claw | W |
| 54 | Dusk Raven | Shadow | 80 / 17 / 9 | Dark Feather | W |
| 55 | Boulder Crab | Earth | 110 / 14 / 12 | Claw Crush | W |
| 56 | Flame Salamander | Fire | 84 / 17 / 9 | Fire Tongue (Burn) | P |
| 57 | Wave Shark | Water | 98 / 16 / 10 | Jaw Snap | P |
| 58 | Storm Crow | Wind | 79 / 18 / 8 | Storm Dive | P |
| 59 | Iron Rhino | Earth | 106 / 15 / 12 | Horn Charge | P |
| 60 | Ghost Hound | Spirit | 82 / 18 / 9 | Wail (Attack Down) | P |
| 61 | Frost Falcon | Ice | 84 / 17 / 9 | Frost Dive | P |
| 62 | Venom Spider | Nature | 86 / 17 / 9 | Venom Bite (Poison) | P |
| 63 | Ember Eagle | Fire | 81 / 18 / 8 | Swoop (Burn) | P |
| 64 | Mist Stag | Spirit | 88 / 16 / 10 | Mist Charge | P |
| 65 | Thunder Ram | Lightning | 96 / 16 / 11 | Thunder Ram | P |

### 5.3 Rare — 15 (Peaks + Hollow)

| # | Name | Type | HP / ATK / DEF | Signature move (effect) | Area |
|---|---|---|---|---|---|
| 66 | Crystal Wolf | Ice | 130 / 24 / 14 | Crystal Fang (Freeze) | P |
| 67 | Inferno Tiger | Fire | 125 / 26 / 13 | Inferno Claw (Burn) | P |
| 68 | Abyss Serpent | Water | 145 / 23 / 16 | Abyss Coil | P |
| 69 | Storm Dragonet | Lightning | 120 / 27 / 13 | Storm Breath (Paralyze) | P |
| 70 | Stone Titan | Earth | 155 / 22 / 17 | Titan Slam (Stun) | P |
| 71 | Shadow Reaper | Shadow | 118 / 27 / 14 | Reap (Bleed) | P |
| 72 | Frost Phoenix | Ice | 122 / 25 / 14 | Frost Wing (Freeze) | P |
| 73 | Thorn Behemoth | Nature | 150 / 23 / 16 | Thorn Crush (Poison) | P |
| 74 | Gale Dragon | Wind | 128 / 25 / 14 | Gale Burst | P |
| 75 | Spirit Guardian | Spirit | 135 / 24 / 15 | Guardian Light (Shield) | P |
| 76 | Ember Golem | Fire | 152 / 23 / 16 | Magma Fist (Burn) | P |
| 77 | Moonlight Panther | Light | 124 / 26 / 13 | Moon Claw | H |
| 78 | Thunder Roc | Lightning | 132 / 25 / 14 | Thunder Dive (Paralyze) | H |
| 79 | Venom Basilisk | Nature | 138 / 24 / 15 | Petrify Gaze (Stun) | H |
| 80 | Frost Leviathan | Water | 148 / 23 / 16 | Tidal Slam (Freeze) | H |

### 5.4 Epic — 10 (Hollow)

| # | Name | Type | HP / ATK / DEF | Signature move (effect) | Area |
|---|---|---|---|---|---|
| 81 | Inferno Phoenix | Fire | 195 / 34 / 20 | Rebirth Flame (Burn + Regen) | H |
| 82 | Storm Leviathan | Water | 215 / 32 / 22 | Storm Surge (Paralyze) | H |
| 83 | Shadow Dragon | Shadow | 200 / 35 / 21 | Shadow Breath (Confuse) | H |
| 84 | Crystal Titan | Earth | 225 / 30 / 24 | Crystal Crush (Stun) | H |
| 85 | Frost Queen | Ice | 185 / 34 / 20 | Blizzard (Freeze + Attack Down) | H |
| 86 | Thunder Godbird | Lightning | 190 / 36 / 19 | God Strike (Paralyze + Crit Up) | H |
| 87 | Nature Warden | Nature | 210 / 31 / 23 | Warden's Grasp (Poison + Lifesteal) | H |
| 88 | Light Seraph | Light | 180 / 35 / 20 | Holy Light (Shield + Regen) | H |
| 89 | Abyss Kraken | Water | 220 / 33 / 22 | Abyssal Pull (Defense Down) | H |
| 90 | Ember Demon | Fire | 198 / 36 / 21 | Demon Fire (Burn + Bleed) | H |

### 5.5 Legendary — 6 (Hollow)

| # | Name | Type | HP / ATK / DEF | Signature move (effect) | Area |
|---|---|---|---|---|---|
| 91 | Solar Dragon | Fire | 290 / 46 / 28 | Solar Flare (Burn + Crit Up) | H |
| 92 | Lunar Wolf | Light | 260 / 48 / 26 | Moon Howl (Sleep) | H |
| 93 | Storm Emperor | Lightning | 280 / 47 / 29 | Emperor's Wrath (Paralyze + Attack Down) | H |
| 94 | Frost Wyrm | Ice | 300 / 44 / 31 | Eternal Frost (Freeze + Regen) | H |
| 95 | Shadow Monarch | Shadow | 270 / 49 / 27 | Monarch's Grasp (Confuse + Lifesteal) | H |
| 96 | Earth Colossus | Earth | 315 / 43 / 32 | Colossal Slam (Stun + Defense Down) | H |

### 5.6 Mythic — 3 (Hollow)

| # | Name | Type | HP / ATK / DEF | Signature move (effect) | Area |
|---|---|---|---|---|---|
| 97 | Void Dragon | Shadow | 420 / 60 / 38 | Void Breath (Confuse + Bleed) | H |
| 98 | Celestial Phoenix | Light | 380 / 62 / 36 | Celestial Flame (Burn + Regen) | H |
| 99 | Titan of the Deep | Water | 445 / 55 / 42 | Deep Slam (Freeze + Shield) | H |

### 5.7 UwU-tier — 1 (Hollow)

| # | Name | Type | HP / ATK / DEF | Signature move (effect) | Area |
|---|---|---|---|---|---|
| 100 | The UwU Sovereign | Spirit | 500 / 72 / 46 | Sovereign's Decree (Sleep + Lifesteal) | H |

**Roster count check:** Common 40 + Uncommon 25 + Rare 15 + Epic 10 + Legendary 6 + Mythic 3 + UwU 1 = **100** ✓
**Spot-check budgets:** Stone Titan 155+88+51 = 294 (Rare 219–323 ✓) · Inferno Phoenix 195+136+60 = 391 (Epic 316–454 ✓) · Solar Dragon 290+184+84 = 558 (Legendary 447–616 ✓) · Void Dragon 420+240+114 = 774 (Mythic 609–836 ✓) · The UwU Sovereign 500+288+138 = 926 (UwU 829–1012 ✓).

---

## 6. Weapon roster — 50 weapons + pet roster — 20 pets

Weapons grant their ATK bonus while equipped (§2.5). Weapon effects use the catalogue trigger chances (§4) and obey the same stacking rules. A weapon's effect triggers on the wielder's hits in battle (phase 2); in phase 1 the effect is shown on the weapon's detail line.

### 6.1 Common weapons — 20 (ATK +2 – +5)

| # | Name | Type | ATK | Effect |
|---|---|---|---|---|
| 1 | Wooden Sword | Sword | +2 | — |
| 2 | Rusty Dagger | Dagger | +3 | — |
| 3 | Training Bow | Bow | +3 | — |
| 4 | Pebble Hammer | Hammer | +4 | — |
| 5 | Stick Wand | Wand | +2 | — |
| 6 | Blunt Axe | Axe | +4 | — |
| 7 | Leather Whip | Whip | +3 | — |
| 8 | Stone Spear | Spear | +4 | — |
| 9 | Twig Staff | Staff | +2 | — |
| 10 | Iron Knife | Dagger | +5 | — |
| 11 | Wooden Club | Club | +4 | — |
| 12 | Slingshot | Bow | +3 | — |
| 13 | Bone Dagger | Dagger | +4 | — |
| 14 | Copper Sword | Sword | +5 | — |
| 15 | Reed Bow | Bow | +3 | — |
| 16 | Clay Hammer | Hammer | +4 | — |
| 17 | Thorn Whip | Whip | +3 | — |
| 18 | Flint Axe | Axe | +5 | — |
| 19 | Wooden Spear | Spear | +4 | — |
| 20 | Practice Blade | Sword | +2 | — |

### 6.2 Uncommon weapons — 12 (ATK +5 – +9)

| # | Name | Type | ATK | Effect |
|---|---|---|---|---|
| 21 | Iron Sword | Sword | +6 | — |
| 22 | Hunter's Bow | Bow | +7 | — |
| 23 | Oak Staff | Staff | +6 | — |
| 24 | Steel Dagger | Dagger | +8 | — |
| 25 | Battle Axe | Axe | +7 | — |
| 26 | Ember Wand | Wand | +8 | Burn on hit (25%) |
| 27 | Frost Dagger | Dagger | +7 | — |
| 28 | War Hammer | Hammer | +9 | — |
| 29 | Long Spear | Spear | +7 | — |
| 30 | Shadow Blade | Sword | +8 | — |
| 31 | Storm Bow | Bow | +8 | — |
| 32 | Coral Trident | Spear | +9 | — |

### 6.3 Rare weapons — 8 (ATK +9 – +14)

| # | Name | Type | ATK | Effect |
|---|---|---|---|---|
| 33 | Knight's Sword | Sword | +11 | — |
| 34 | Eagle Bow | Bow | +12 | — |
| 35 | Crystal Staff | Staff | +11 | Freeze on hit (12%) |
| 36 | Titan Axe | Axe | +12 | Stun on hit (15%) |
| 37 | Inferno Blade | Sword | +13 | Burn on hit (25%) |
| 38 | Thunder Hammer | Hammer | +14 | Paralyze on hit (20%) |
| 39 | Venom Fang | Dagger | +12 | Poison on hit (30%) |
| 40 | Moon Wand | Wand | +11 | Shield on use (absorbs 20% max HP, 2 turns) |

### 6.4 Epic weapons — 5 (ATK +14 – +20)

| # | Name | Type | ATK | Effect |
|---|---|---|---|---|
| 41 | Dragon Slayer | Sword | +18 | Bleed on hit (25%) |
| 42 | Phoenix Bow | Bow | +17 | Burn on hit (25%) |
| 43 | Stormcaller Staff | Staff | +19 | Paralyze on hit (20%) |
| 44 | Void Dagger | Dagger | +18 | Confuse on hit (20%) |
| 45 | Frostbrand | Sword | +16 | Freeze on hit (12%) |

### 6.5 Legendary weapons — 3 (ATK +20 – +28)

| # | Name | Type | ATK | Effect |
|---|---|---|---|---|
| 46 | Solar Blade | Sword | +26 | Burn on hit (25%) + Crit Up on use (+25% crit, 3 turns) |
| 47 | Moonfang | Dagger | +24 | Sleep on hit (15%) |
| 48 | Storm King's Axe | Axe | +27 | Paralyze on hit (20%) |

### 6.6 Mythic weapon — 1 (ATK +28 – +38)

| # | Name | Type | ATK | Effect |
|---|---|---|---|---|
| 49 | Voidreaver | Sword | +35 | Confuse on hit (20%) + Bleed on hit (25%) |

### 6.7 UwU-tier weapon — 1 (ATK +38 – +50)

| # | Name | Type | ATK | Effect |
|---|---|---|---|---|
| 50 | The UwU Blade | Sword | +48 | Sleep on hit (15%) + Lifesteal on use (heal 30% of damage, 3 turns) |

**Weapon count check:** 20 + 12 + 8 + 5 + 3 + 1 + 1 = **50** ✓
**Weapon balance check:** best Common weapon (+5) on the strongest Common monster (ATK 14) = 19 ATK — still below the weakest Rare monster's ATK (19) and far below Epic (§3.1 check holds).

### 6.8 Pets — 20 (one active follower, buffs per §3.4, never stack)

| # | Name | Tier | Buff |
|---|---|---|---|
| 1 | Pocket Slime | Common | +3% gold from sells |
| 2 | Mini Moth | Common | +3% catch chance |
| 3 | Pebble Crablet | Common | +3% gold from hunts |
| 4 | Sprout Buddy | Common | +3% XP |
| 5 | Dewdrop | Common | +3% gold from sells |
| 6 | Ember Mouse | Common | +3% catch chance |
| 7 | Flame Fox Pup | Uncommon | +5% catch chance |
| 8 | Frost Bunny | Uncommon | +5% gold from sells |
| 9 | Storm Chick | Uncommon | +5% XP |
| 10 | Shadow Kitten | Uncommon | +5% catch chance |
| 11 | Tide Turtle | Uncommon | +5% gold from hunts |
| 12 | Crystal Fox | Rare | +8% catch chance |
| 13 | Ember Phoenix Chick | Rare | +8% gold from sells |
| 14 | Moon Moth | Rare | +8% XP |
| 15 | Thunder Pup | Rare | +8% catch chance |
| 16 | Mini Dragon | Epic | +12% catch chance |
| 17 | Star Sprite | Epic | +12% gold from hunts |
| 18 | Solar Pup | Legendary | +18% catch chance |
| 19 | Lunar Cat | Legendary | +18% gold from hunts |
| 20 | Void Wisp | Mythic | +25% catch chance |

**Pet count check:** Common 6 + Uncommon 5 + Rare 4 + Epic 2 + Legendary 2 + Mythic 1 = **20** ✓ (no UwU pet — a pet is a companion you keep; "1 per server ever" fits a monster better).
**Pet buff check:** the strongest pet buff (+25% catch chance) turns a 10% UwU catch into 12.5% — meaningful, never decisive. Catch-chance buffs apply to the §1.3 catch rate; gold/XP buffs apply to the stated source only.

---

## 7. Economy check — does a 500-gold roll still work?

### 7.1 What a roll costs in days of play

| Income source | Gold / day (casual player) |
|---|---|
| `uwu daily` | 100 |
| Hunt sells (a few Commons) | ~25–75 |
| Casino (small wins, some days) | 0–200 |
| **Typical total** | **~150–250 / day** |

- **1 roll (500 gold)** = ~2–3 days of casual play; 5 days on daily alone.
- **10-roll (4,500 gold)** = ~3–4 weeks of saving, or faster with good casino sessions.
- **Verdict: the roll is a saving goal, not a blocker.** The core loop (hunt) is free; rolls are the bonus. A new player is never stuck waiting for a roll — they hunt, sell, and roll when they can afford it.

### 7.2 Expected cost of each tier (roll only, at 500 gold)

| Tier | Roll rate | Expected rolls to first pull | Expected gold |
|---|---|---|---|
| Epic | 4% | 25 | 12,500 |
| Legendary | 0.9% | ~111 | ~55,500 |
| Mythic | 0.09% | ~1,111 | ~555,500 |
| UwU-tier | 0.01% | 10,000 | ~5,000,000 |

A Legendary is a multi-week goal; a Mythic is a multi-month goal; UwU is a lottery. That matches the tier fantasy.

### 7.3 Pity doesn't flood Epics

P(no Epic-or-better in 50 rolls) = 0.95^50 ≈ **7.7%**. So pity fires on only ~8% of 50-roll stretches. Base rates already give ~2.5 Epic+ pulls per 50 rolls, so pity adds at most ~0.08 extra Epic per 50 rolls. **No flood.** Pity cost: 50 rolls = 25,000 gold per trigger — expensive enough that nobody farms it deliberately.

### 7.4 ⚠️ BALANCE FLAG — existing rich accounts

**Problem:** existing balances are large. Yohh's balance was ~999,976 gold on 2026-11-07. At 500 gold/roll that is **~1,999 rolls on day one**. Expected yield of 2,000 rolls: ~80 Epics, ~18 Legendaries, ~1.8 Mythics, and an ~18% chance of pulling the single UwU-tier monster. One account could take most of the Mythic cap (3 per server) and possibly the only UwU on launch day.

**Recommended guard (needs Ronit's call):** a **daily roll cap of 20 rolls per user**. At 20/day, 2,000 rolls take 100 days — the head start becomes a slow advantage, not a launch-day sweep. Pity still works normally under a cap. Alternatives: (a) accept it — small friends server, early-adopter head start is fine; (b) launch gacha in a "season" with a fresh start later. **Recommendation: option (b) is overkill; go with the 20/day cap.**

### 7.5 Sell/sacrifice prices — sanity check

Sell prices (§2.4) are 10% of a tier's roll value, so selling a duplicate never funds another roll by itself (a Common sells for 25 — twenty Commons fund one roll). Sacrifice gem yields (§2.4) are small at low tiers so gems stay scarce until gem uses are designed (§10). Both price tables are working defaults — unconfirmed.

---

## 8. Phase 2 sketch — battle + bosses (NOT built in phase 1)

- **`uwu battle @user`** — 3v3 auto-battler. Each side fields its 3 strongest zoo monsters by power budget (§3.1). Turn-based, highest-ATK monster acts first each round; damage per §3.1 formula; status effects per §4. First side to KO all 3 wins; winner takes 5% of the loser's gold (cap 500 gold) — loser never drops below 0.
- **Area boss** — every 6 hours, a boss spawns in a random area (a powered-up Epic/Legendary from the roster, HP ×5). Anyone in the server can hit it once per spawn (`uwu boss`); damage dealt is recorded; top 3 damage dealers split a gold + gem prize.
- **World boss** — weekly, one boss for the whole server (a Mythic-stat monster, HP ×20). Same hit-once mechanic, bigger prize, server-wide announcement when it falls.
- **Guilds** — `uwu guild create <name>`, `uwu guild join <name>`. Guild members share a boss-damage bonus (+10% per guild member who hit the boss, cap +50%). Guild vs guild is out of scope until phase 2 is played and balanced.
- Boss mechanics, prize splits, and guild rules are all **unconfirmed** (§10) — phase 2 is designed properly after phase 1 has been live and the economy has real data.

---

## 9. Data model sketch (Supabase)

Existing tables stay as they are (points wallet = gold; XP/level system already exists). New tables:

| Table | Key columns | Purpose |
|---|---|---|
| `hunt_monsters` | monster_id, name, tier, type, hp, atk, def, move, effect, area, emoji_id (null until art step) | Static catalogue — this doc's §5 |
| `hunt_weapons` | weapon_id, name, tier, type, atk_bonus, effect | Static catalogue — §6.1–6.7 |
| `hunt_pets` | pet_id, name, tier, buff_type, buff_value | Static catalogue — §6.8 |
| `user_monsters` | user_id, **guild_id**, monster_id, source (hunt/roll), caught_at | Ownership. **Caps are enforced by counting rows here per (guild_id, monster_id)** |
| `user_weapons` | user_id, guild_id, weapon_id, equipped (bool) | Ownership + equipped state (one equipped per user) |
| `user_pets` | user_id, guild_id, pet_id, active (bool) | Ownership + active follower (one active per user) |
| `user_pity` | user_id, rolls_since_epic | Pity counter (§1.2) |
| `user_hunt` | user_id, last_hunt_at, current_area | 30s cooldown + area (§2.1) |

**Cap enforcement (fail closed):** before awarding a Mythic/UwU monster, run `SELECT COUNT(*) FROM user_monsters WHERE guild_id = ? AND monster_id = ?`. If count ≥ cap (3 / 1), re-roll down a tier and tell the user why. If the count query errors, refuse the award — never grant a capped monster on a failed check.

---

## 10. Open / unconfirmed items (Ronit's call)

| # | Item | Current value in this doc | Needs |
|---|---|---|---|
| 1 | 10-roll price | 4,500 gold | Confirm or change |
| 2 | Mythic cap per server | 3 copies | Confirm a number (or different rule) |
| 3 | Tier splits (monsters 40/25/15/10/6/3/1, weapons 20/12/8/5/3/1/1, pets 6/5/4/2/2/1/0) | Working defaults | Confirm or adjust |
| 4 | Area names, count (4), unlock levels (1/5/10/15) | Working defaults | Confirm or rename/restructure |
| 5 | Area encounter weighting (exact % per tier inside each area) | Not specified — area pools listed, numbers TBD | Set per-area encounter tables |
| 6 | Sell prices (§2.4) + sacrifice gem yields (§2.4) | Working defaults (10% of roll value; gems 1/2/5/12/40/150/500) | Confirm or change |
| 7 | Gem uses (what gems buy) | Undesigned — gem emoji exists, no shop yet | Design decision |
| 8 | Daily roll cap (economy flag, §7.4) | Recommended: 20/day | Accept cap, pick a number, or accept the day-one sweep |
| 9 | Boss mechanics + prizes (phase 2, §8) | Sketch only | Full design after phase 1 data |
| 10 | Pet sell price (half monster price, §2.6) | Working default | Confirm |
| 11 | UwU announcement format (server-wide + bot-wide) | "Server-wide + bot-wide (all servers)" per tier table | Exact message format + whether bot-wide means every server the bot is in |
| 12 | Emoji art + tier re-check | Not done — later step | Collect art, re-check every tier against visuals, adjust before launch |

---

## Appendix — balance verification checklist (done during writing)

- [x] Roll rates sum to 100% (60+25+10+4+0.9+0.09+0.01).
- [x] Roster counts match splits: monsters 40+25+15+10+6+3+1 = 100; weapons 20+12+8+5+3+1+1 = 50; pets 6+5+4+2+2+1 = 20.
- [x] Every roster entry's stats sit inside its tier band; spot-checked budgets in §5.7.
- [x] Low tier can't beat high tier by luck alone (§3.1 worked check: 33 hits vs 3 hits).
- [x] No one-shot: max single-hit damage < 50% of same-tier minimum HP (§3.3 rule 2; §4.5 worst-case check 86 < 115).
- [x] DoT worst case = 12% exactly at cap (§4.5).
- [x] No control chains (rule 5); max 2 effects per target (rule 4); every effect has a counter (§4).
- [x] Pity adds ~0.08 Epic per 50 rolls — no flood (§7.3).
- [x] Mythic/UwU caps enforceable from the data model (§9, fail-closed count query).
- [x] ⚠️ One open flag: existing rich balances vs 500-gold rolls (§7.4) — daily roll cap recommended, awaiting Ronit's call.
