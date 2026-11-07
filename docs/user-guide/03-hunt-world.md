# 03 — Hunt World, Phase 1

**Status: LIVE.** Hunt, roll/gacha, map, zoo, inv, and sell are implemented,
covered by tests, and deployed (commit `091c9c4` onwards; current live
deploy `dep-dbniifbm8hqs73calr10`, commit `3653bd4`).

> **Scope note:** code wins over the design doc. Where the code and
> `docs/hunt-world-design.md` disagree, this guide documents the code and
> lists the disagreement in §12.

## 3.1 Rarity tiers

| Tier | Roll rate | Catch rate | Sell price | Gem yield* | Colour | Cap per server | Announcement |
|---|---|---|---|---|---|---|---|
| Common | 60% | 90% | 25 gold | 1 | Gray | — | none |
| Uncommon | 25% | 75% | 60 gold | 2 | Green | — | none |
| Rare | 10% | 60% | 150 gold | 5 | Blue | — | none |
| Epic | 4% | 45% | 400 gold | 12 | Purple | — | none |
| Legendary | 0.9% | 30% | 1,500 gold | 40 | Gold | — | server-wide text |
| Mythic | 0.09% | 15% | 5,000 gold | 150 | Red/Pink | 3 copies | server-wide text + embed |
| UwU | 0.01% | 10% | 25,000 gold | 500 | Rainbow | 1 copy | server-wide text + embed |

Roll rates sum to 100%. Tier colours are data only — no code colours any
message by tier (hunt messages are plain text; only the Mythic/UwU embed
uses hardcoded pink colours).
\* Gem yield is a data field only. There is **no gem currency, no sacrifice
command, no gem shop** — see §3.8.

## 3.2 Hunt — `uwu hunt [area]`

| | |
|---|---|
| Aliases | `uwu catch` |
| Cooldown | **30 seconds** |

- `uwu hunt <area>` hunts in that area (exact id, exact full name, or
  name-prefix match; case-insensitive). Unknown area:
  > No area called "<input>" — try uwu map
- Bare `uwu hunt` uses your stored current area (the last area you hunted
  in); if none is stored, it defaults to the Meadow.
- **Level gate is checked before the cooldown.** If your chat level is below
  the area's unlock level:
  > 🔒 {area} unlocks at level {n} — you're level {level}. Keep chatting to gain XP!
  Hunt itself grants **no XP** — area unlocks progress via chat XP
  (`uwu rank`).
- The 30 s cooldown **starts when the hunt starts**, not when you press
  Catch — so a Run or a missed catch also consumes it. (The miss message's
  "(30s cooldown)" overstates the remaining wait by the time already spent
  on the encounter.)
- Encounter text:
  ```
  You wander into the {area}...
  A wild {emoji} {name} ({tier}) appeared!
  HP {hp} · ATK {atk} · DEF {def} — {move} ({effects})
  ```
- **Catch** (Primary) and **Run** (Secondary) buttons. Only the hunter who
  started it can press them. Encounters are in-memory only, **TTL 5 minutes**;
  an expired encounter replies `This hunt has expired — go uwu hunt for a
  new one.`
- **A miss costs nothing except the cooldown.** No gold, no item — the
  monster simply flees: `It slipped away... (30s cooldown)`.
- On a catch (awarded inside a DB transaction, cap-checked):
  > Caught it! {emoji} {name} ({tier}) joined your zoo.

## 3.3 Roll / gacha — `uwu roll [count]`

| | |
|---|---|
| Aliases | `uwu gacha`, `uwu summon` |
| Single roll | **500 gold** |
| 10 rolls | **4,500 gold** (`uwu roll 10`) |
| Pity | **50 rolls without Epic+ → next roll guaranteed Epic minimum** |
| Daily cap | **20 rolls per user per UTC day** |

- Form is `uwu roll` (one) or `uwu roll 10` (ten). Any other count:
  > Use uwu roll for one pull or uwu roll 10 for ten.
  There is **no** separate `uwu roll10` command (the design doc describes
  one; the code has only `roll 10`).
- **Pity:** the counter `rollsSinceEpic` is per user, resets to 0 on any
  awarded monster of tier Epic or higher, otherwise +1 per pull. At 50, the
  next pull draws from Epic/Legendary/Mythic/UwU **weighted by their roll
  rates** (4 / 0.9 / 0.09 / 0.01) — i.e. a pity pull is ~80% Epic, ~18%
  Legendary, ~1.8% Mythic, ~0.2% UwU.
  **⚠️ Code vs design doc:** the design doc (§3.3 rule 9) says pity is
  Epic-only and can never produce Legendary+. The code can. Code wins until
  Ronit rules otherwise — see §12.
- **Daily cap:** 20 rolls per user per **UTC calendar day**. Pre-checked
  before the transaction and re-checked atomically inside it. A 10-roll
  counts as 10. Exceeding it:
  > Daily roll cap: you've used {n}/20 rolls today — you can roll {20-n} more.
  > Daily roll cap reached — come back tomorrow.
- The whole roll runs in **one DB transaction**: gold deducted first
  (insufficient gold aborts everything), then each pull is drawn and awarded
  (cap-checked), then the pity/cap counters are upserted. Any failure rolls
  everything back.
- Reply format:
  ```
  🎰 Roll ×{count} — {gold} {cost} gold
  1. ✨ {emoji} {name} ({tier}) (pity!)
  ...
  Balance: {n} gold · Rolls today: {n}/20
  ```
  Epic+ pulls get a ✨ prefix; pity pulls get `(pity!)`; cap-downgraded pulls
  get a note. Each Legendary+ pull triggers an announcement (§3.9).

## 3.4 Map — `uwu map`

| | |
|---|---|
| Aliases | `uwu areas` |

The 4 areas (Phase 1). Unlock levels are **chat-XP levels**.

| Area | Unlock level | Tier pool (code) | Monsters |
|---|---|---|---|
| Meadow of Beginnings | **0** | Common, Uncommon | 26 |
| Whispering Woods | **5** | Common, Uncommon, Rare | 29 |
| Ember Peaks | **10** | Uncommon, Rare, Epic | 21 |
| The Hollow Deep | **15** | Rare, Epic, Legendary, Mythic, UwU | 24 |

- **Meadow unlocks at level 0, not 1** (design doc says 1; code comment:
  level 0 is the starting level, so unlock 1 would lock brand-new players
  out entirely).
- **Area tier pools are widened in code** vs the design doc, deliberately,
  so no roster monster is stranded anywhere: Woods adds Common (14 Commons
  are assigned to Woods), Peaks adds Uncommon (10), Hollow adds Rare
  (weight 5; 4 Rares assigned to Hollow). All 100 monsters are encounterable.
- Encounter weighting per area (weights apply only to tiers that have
  monsters in the area, then renormalised; within a tier the monster is
  uniform-random):

  | Area | Common | Uncommon | Rare | Epic | Legendary | Mythic | UwU |
  |---|---|---|---|---|---|---|---|
  | Meadow | 80 | 20 | — | — | — | — | — |
  | Woods | 20 | 55 | 25 | — | — | — | — |
  | Peaks | — | 20 | 55 | 25 | — | — | — |
  | Hollow | — | — | 5 | 65 | 25 | 4.5 | 0.5 |

- `uwu map` shows `🗺️ Hunt Map — you are level {n}` + one line per area:
  `{🔒|📍} {name} — Level {n} · {tiers} · {pool} monsters · {blurb}`, then
  `Hunt with uwu hunt or uwu hunt <area>.`
- The Hollow Deep is the **only** place Mythic and UwU can be encountered.
  Rolls can produce them anywhere.

## 3.5 Zoo — `uwu zoo [name]`

| | |
|---|---|
| Aliases | `uwu monsters` |

- **List** (`uwu zoo`): grouped by tier in fixed order Common → Uncommon →
  Rare → Epic → Legendary → Mythic → UwU; empty tiers omitted. Header:
  `🦁 Your zoo — {total} monsters ({unique} unique)`; each line
  `{emoji} {name} ×{count}`. Truncated at **40 lines**; overflow adds
  `…and {n} more lines — use uwu zoo <name> for one monster.`
  Empty zoo: `Your zoo is empty — go uwu hunt or uwu roll to catch your
  first monster!`
- **Detail** (`uwu zoo <name>`, exact-name match, case-insensitive):
  `{emoji} {name} ({tier}) ×{count}` +
  `Type {type} · HP {hp} · ATK {atk} · DEF {def} — {move} ({effects})` +
  `Found in: {area name} · Caught via {source}` (source = `hunt` or `roll`,
  from the latest acquisition). Not owned:
  `You haven't caught {...} yet — go uwu hunt or uwu roll!`

## 3.6 Inventory — `uwu inv`

| | |
|---|---|
| Aliases | `uwu inventory`, `uwu bag` |

- Shows **Weapons** (`{emoji} {name} (+{atk} ATK) ×{count}`) and **Pets**
  (`{emoji} {name} ({tier}) — {buff text} ×{count}`), or `No weapons yet.`
  / `No pets yet.`
- **Weapons and pets have NO acquisition path in Phase 1.** Rolls award
  monsters only. There is no code anywhere that writes to `user_weapons` /
  `user_pets` (only reads); there is no `equip` command and no `pets`/`pet`
  command. The tables exist in the schema (with `equipped`/`active`
  columns) but are never written to. **`uwu inv` starts empty for everyone.**
  The design doc's `uwu pets`, `uwu equip`, and `uwu pet <name>` commands
  are **not implemented**.
- Pet buffs (displayed in `uwu inv`): Common +3%, Uncommon +5%, Rare +8%,
  Epic +12%, Legendary +18%, Mythic +25% — buff types `gold-sells` /
  `catch` / `gold-hunts` / `xp`. **Pet buffs are display-only in Phase 1:
  no code applies them to catch rates or gold.**

## 3.7 Sell — `uwu sell <monster>`

| | |
|---|---|
| Aliases | `uwu selldup` |

- Sells **monsters only**, one copy per command, by exact name. Prices are
  the tier sell prices in §3.1 (Common 25 → UwU 25,000 gold).
- **Last-copy confirm:** if you own exactly 1 copy, the bot asks
  `That's your only {...} — sell it for {gold} {price} gold?` with
  **Sell it** / **Keep it** buttons (only you can press them). Confirm
  re-checks ownership, then sells in a transaction. Cancel keeps it.
  If you own ≥ 2, the sale is immediate, no confirm:
  `Sold {...} for {gold} {price} gold! You have {owned-1} left. Balance: {n} gold.`
- **Weapons/pets cannot be sold** — no code path exists. (The design doc's
  "pets sell for half monster price" is not implemented.)

## 3.8 Sacrifice & gems — what actually exists

- **Gem yields exist as data only:** Common 1, Uncommon 2, Rare 5, Epic 12,
  Legendary 40, Mythic 150, UwU 500 (`TIERS.gemYield`). Nothing reads this
  field anywhere outside the tier table — it is dead data.
- **No `sacrifice` command exists.** The only occurrence of the word
  "sacrifice" in hunt code is a doc-comment.
- **No gem currency exists.** No gem balance, wallet, ledger, table, or
  gem-adding function anywhere in `src/`. There is no way to earn, hold, or
  spend gems. Gem uses are undesigned (design doc §10 item 7).
- A `gem` custom emoji exists (animated, fallback 💎) as a generic economy
  emoji; it is never used by any hunt command. The only custom emoji hunt
  messages use is `gold` (static) in roll/sell messages.
- Gem mechanics belong to Phase 2 design, not Phase 1 — see
  [05-phase2-design-index.md](05-phase2-design-index.md).

## 3.9 Announcements (Legendary+ catches)

Best-effort (a failure never breaks the catch). Triggered for hunt catches
and for each Legendary+ roll pull.

- **Legendary** (plain text, same server only):
  > 📣 <@user> caught a Legendary — {emoji} {name} ({tier})!
- **Mythic** (text + embed): same text pattern + an embed titled
  `🌟 Mythic!` (pink `0xec4899`), description with the monster's stats and
  move, footer `Limited to 3 copies per server.`
- **UwU** (text + embed): text
  > 🌈 <@user> pulled {emoji} {name} ({tier}) — the UwU-tier monster! Only one will ever exist in this server.
  + an embed titled `🌈 UwU-tier!` (pink `0xf472b6`), footer
  `Only one will ever exist in this server.`
- **Code vs design doc:** the doc promises the UwU announcement is
  **server-wide + bot-wide (all servers)**. The code returns `"bot-wide"`
  from `tierAnnouncement()` but `announceCatch` handles it identically to
  Mythic — **one follow-up in the catching server only**. The code comment
  states: "True bot-wide broadcast to OTHER guilds needs client access in
  commands — not wired in Phase 1." No other guild is notified.
- The Mythic/UwU embed is the **only embed in the hunt module**; everything
  else is plain text.

## 3.10 Caps — Mythic 3 / UwU 1 per server

- Constants: `MYTHIC_CAP_PER_GUILD = 3`, `UWU_CAP_PER_GUILD = 1`.
  All other tiers are uncapped.
- **The cap is per monster, not per tier:** enforced by counting
  `user_monsters` rows per guild for that specific monster. Three different
  Mythics can each exist 3× in a guild (9 Mythic copies total); the UwU cap
  is 1 copy of The UwU Sovereign per guild.
- When a capped monster would be awarded, the award **steps one tier down**
  and re-picks/re-checks (Common downgrades to itself, so the loop always
  terminates). The user is told, e.g.:
  > (the Mythic you found is maxed out in this server, so you got this one instead)
- **Fail-closed:** if the count query throws, the award is refused — the
  catch is not granted. The cap check runs inside the same transaction as
  the award for both hunt and roll.

## 3.11 Roster — 100 monsters / 50 weapons / 20 pets

Counts verified by counting code (`MONSTER_ROWS` / `WEAPON_ROWS` /
`PET_ROWS` in `src/lib/hunt.ts`) and the manifest; tier splits match the
design doc exactly.

| Category | Total | Common | Uncommon | Rare | Epic | Legendary | Mythic | UwU |
|---|---|---|---|---|---|---|---|---|
| Monsters | 100 | 40 | 25 | 15 | 10 | 6 | 3 | 1 |
| Weapons | 50 | 20 | 12 | 8 | 5 | 3 | 1 | 1 |
| Pets | 20 | 6 | 5 | 4 | 2 | 2 | 1 | 0 (no UwU pet) |

- **Monster stat bands (actual, computed from the roster)** — every monster
  sits inside its tier's design band (budget = HP + 4×ATK + 3×DEF):

  | Tier | HP | ATK | DEF | Budget |
  |---|---|---|---|---|
  | Common | 40–70 | 8–12 | 4–8 | 97–130 |
  | Uncommon | 75–110 | 14–19 | 8–12 | 171–204 |
  | Rare | 118–155 | 22–27 | 13–17 | 264–294 |
  | Epic | 180–225 | 30–36 | 19–24 | 380–418 |
  | Legendary | 260–315 | 43–49 | 26–32 | 530–583 |
  | Mythic | 380–445 | 55–62 | 36–42 | 736–791 |
  | UwU | 500 | 72 | 46 | 926 |

  The UwU monster is **The UwU Sovereign** (#100, Spirit, 500/72/46,
  `Sovereign's Decree`, Sleep+Lifesteal, Hollow).
- **Weapon ATK bands (actual):** Common +2–+5, Uncommon +6–+9, Rare +11–+14,
  Epic +16–+19, Legendary +24–+27, Mythic +35, UwU +48. (Actual minima are
  slightly higher than the design doc's band floors for Uncommon/Rare:
  +6 not +5, +11 not +9.)
- **Monster types:** Fire, Water, Earth, Wind, Nature, Ice, Lightning,
  Shadow, Light, Spirit. **Status-effect tags** on monsters/weapons (tags
  only — no battle/effect mechanics exist in Phase 1): Burn 19, Freeze 8,
  Paralyze 8, Bleed 7, Poison 5, Stun 5, Confuse 5, Attack Down 4, Shield 4,
  Regen 4, Lifesteal 4, Sleep 4, Crit Up 3, Defense Down 2. Max 2 effects
  per monster. The full 15-effect catalogue (including Evasion Up) lives
  only in the design doc; Evasion Up appears in no roster row.
- **Thorn Hedgehog → Spike Puffer:** slot #35 was Thorn Hedgehog (no usable
  emoji — every hedgehog out there is Sonic-franchise art). It is now
  **Spike Puffer** (Water, Common, 60 HP / 10 ATK / 7 DEF, `Spike Roll`,
  area Woods), replaced in commit `3653bd4` (code, design doc, and manifest).
  There is no "Thorn Hedgehog" anywhere in the code, manifest, or design doc.

## 3.12 Emoji — collected, uploaded, not yet wired in

- **Manifest:** `assets/emoji-hunt/manifest.json` — **170/170 matched**
  (100 monsters, 50 weapons, 20 pets; tier splits identical to code; zero
  name/tier mismatches). Every entry is an animated GIF with a source URL
  and licence.
- **Upload:** `assets/emoji-hunt/emoji-ids.json` holds **170 uploaded
  application-emoji IDs** (upload completed 2026-11-07 via
  `scripts/upload_application_emoji.py`). Application emoji are usable by
  the bot in any server with no server slots used.
- **Not yet wired in:** Phase 1 messages use **Unicode placeholders, not
  application emoji**. `monsterEmoji()` matches keywords in the name
  (dragon→🐉, wolf→🐺, cat→🐱, ~75 keywords) falling back to the type emoji
  (Fire 🔥, Water 💧, Earth 🪨, Wind 🌬️, Nature 🌿, Ice ❄️, Lightning ⚡,
  Shadow 🌑, Light ✨, Spirit 👻). Weapons map kind → Unicode
  (⚔️🗡️🏹🔨🪄🪓🪢🔱🦴); pets fall back to 🐾. **No hunt code reads
  `emoji-ids.json`.** Wiring the uploaded IDs into hunt/roll/zoo replies is
  a remaining step, not part of Phase 1 as shipped.

## 3.13 Persistence (Supabase tables)

| Table | Key columns | Purpose |
|---|---|---|
| `user_monsters` | guild_id, user_id, monster_id, count, source (`hunt`/`roll`), caught_at | Zoo ownership; cap-counting source |
| `user_weapons` | guild_id, user_id, weapon_id, count, equipped | Exists, **never written in Phase 1** |
| `user_pets` | guild_id, user_id, pet_id, count, active | Exists, **never written in Phase 1** |
| `user_hunt` | guild_id, user_id, last_hunt_at, current_area | 30 s cooldown + remembered area |
| `user_roll` | guild_id, user_id, rolls_since_epic, rolls_today, roll_day | Pity counter + daily cap |

No `user_pity` table (the design doc's sketch) — pity lives in
`user_roll.rolls_since_epic`. No gems table. No static catalogue tables in
the DB — rosters live in code (`src/lib/hunt.ts`). Tables are created by the
bot at startup (`CREATE TABLE IF NOT EXISTS`).

## 3.14 Code vs design doc disagreements

1. **Pity can produce Legendary+ in code; doc §3.3 rule 9 says Epic-only.**
   The largest functional divergence.
2. **Meadow unlock 0 in code vs 1 in doc.** Deliberate, commented (level 0
   is the starting level).
3. **Area tier pools widened in code** (Woods +Common, Peaks +Uncommon,
   Hollow +Rare) vs doc §2.1 — deliberate, so no roster monster is stranded.
4. **`uwu roll 10` in code vs a separate `uwu roll10` command in doc.**
5. **UwU announcement is catching-server-only in code; doc promises
   bot-wide.** Not wired in Phase 1, commented.
6. **Hunt has Catch + Run buttons in code; doc shows Catch only.**
7. **No sacrifice, equip, `uwu pets` / `uwu pet` commands in code**,
   although the doc describes them as Phase 1. Gem yields exist as dead
   data only.
8. **Pet buffs are display-only** in code; the doc implies they apply.
9. Cooldown starts at hunt initiation in code; the miss message's
   "(30s cooldown)" overstates the remainder.
10. Minor: weapon ATK minima slightly above doc band floors (Uncommon +6
    vs +5, Rare +11 vs +9); all within bands.

## Verified

- **Tests:** `npm test` 2026-11-07 — 357/357 passed (15 files), including
  `test/hunt.test.ts` (36 hunt tests), `test/emoji.test.ts`.
- **Code read:** `src/commands/hunt.ts`, `src/lib/hunt.ts`,
  `src/lib/huntDb.ts`, `src/lib/emoji.ts` (hunt parts),
  `assets/emoji-hunt/manifest.json` (170 entries counted), `src/lib/db.ts`
  (schema). Every number above is copied from the code as cited.
- **Live Discord check: NOT DONE** (no browser access in this session).
  To verify live in `#🤖-miya-bot`: `uwu hunt`, `uwu roll`, `uwu map`,
  `uwu zoo`, `uwu inv`, `uwu sell <monster>`, `uwu help` (Hunt category).
  Note: earlier live checks (2026-11-07 ~17:48) confirmed a Stone Beetle
  catch, a Shadow Panther roll, and the zoo listing — those predate this
  guide and were not re-run for it.
