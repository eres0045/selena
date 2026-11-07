# Hunt emoji art — sources

Collected 2026-11-07 for the uwu bot's hunt world (100 monsters, 50 weapons, 20 pets).
**170/170 matched, 0 unmatched** (2026-11-07: Thorn Hedgehog was replaced by Spike Puffer — every hedgehog emoji on emoji.gg is Sonic-franchise, so the monster itself was swapped for a pufferfish with clean animated art).
Every file is a GIF, animated, ≤128×128 px, under 262,144 bytes (Discord's limit), verified with PIL.
Per-file source URL + licence is in `manifest.json` (and the per-category fragments).

## Sources used

### Monsters (100/100) + Pets (20/20) — emoji.gg (free, user uploads)
- Animated listings scraped: `emoji.gg/emojis/<category>?sort=animated` — creature (40+ pages),
  monster, demon, horror, magic, plus targeted categories (slime, dragon, wolf, fox, slime, phoenix, etc.).
- Downloaded from the CDN `cdn3.emoji.gg/emojis/<id>-<slug>.gif` (IDs taken from listing/per-emoji
  pages, never guessed; each download verified 200 + `image/gif` first).
- **Licence:** emoji.gg user uploads — Basic licence (free use where the user is not charged for
  access). Per-emoji pages confirm user-uploaded origin; a few list glitter-graphics.com as source.
- **Excluded as franchise rips:** Pokémon, MapleStory, Minecraft, Sonic the Hedgehog, My Little Pony,
  Dungeons & Dragons, Shrek, Pusheen, Tom & Jerry, Monster Hunter, Elden Ring, Hello Kitty/Sanrio,
  Wolfenstein logos, Family Guy, Rimuru, Toothless, Sailor Moon, Bugcat/Catbug memes.
- Resizing: 39 monster files were downscaled and/or frame-halved to fit 256 KB; 5 pet files were
  resized with ffmpeg (palettegen/paletteuse, transparency preserved). Frame counts in the manifest
  are post-processing actuals.

### Weapons (50/50) — game-icons.net, animated in-house
- emoji.gg's animated sword/weapon listings were unusable: dominated by franchise rips (Minecraft
  swords, Zelda Master Sword, Wolfenstein) plus green-screen backgrounds and unclear provenance.
- All 50 weapons are game-icons.net SVG icons, rendered with cairosvg and animated with PIL
  (bounce / brightness pulse / glow pulse; 8 frames each; higher tiers get stronger glow and a
  slightly larger render). Re-runnable script: `scripts/animate_weapons.py`.
- **Licence:** CC BY 3.0 — game-icons.net, per-icon author credited in each manifest entry
  (`CC BY 3.0 — game-icons.net, author <Name>. Animated in-house with PIL.`).
- Note: `game-icons.net` itself is unreachable from this VM (curl 000) — icons came from the
  official GitHub mirror (`raw.githubusercontent.com/game-icons/icons`). Icon-page URLs
  (`game-icons.net/1x1/<author>/<name>.html`) were verified via browser fetch.
- See `SOURCES-weapons.md` for the full per-weapon source table.

### Sources tried and not needed
- Kenney (CC0) — 403 via the VM proxy; not needed.
- myEmotes — not needed; emoji.gg covered all 20 pets.
- discordemoji.com / emotes.net — not used (small/stale, or paid static packs).

## Unmatched
- None. The former unmatched entry (Thorn Hedgehog, monster, Common) was **replaced 2026-11-07 by Spike Puffer** (monster, Common, Water, Woods): every hedgehog emoji found on emoji.gg is Sonic-franchise, so the monster was swapped rather than forcing a bad fit. Art: emoji.gg `4215-pufferfish` (animated GIF, 56×56, 100 frames, 176,955 bytes, Basic licence) — a real pufferfish eating a carrot; see `manifest.json`.

## Weak stand-ins (for the tier re-check before launch)
Some emoji.gg art is a concept stand-in, not an exact match: Root Mole → hamster; Iron Rhino →
dinosaur; Static Eel → swimming fish; Ember Ant → spinning caterpillar; Bark/Dew Beetle → generic
bugs; Pebble Golemlet → a rock; Crystal Titan → a crystal gem (not a creature); Frost Queen → ghost
queen; Storm Emperor → storm cloud; Nature Warden → Christmas tree; Frost Falcon / Thunder Godbird
→ phoenixes. Pets: Storm Chick (plain chick), Thunder Pup (plain puppy), Crystal Fox (plain fox
face), Ember Mouse (mouse + ramen) — right creature, elemental flavour only implied.

## Upload notes (for the next step)
- Application emoji cap is 2,000 per app; this set is 169 files (~6.4 MB total), well within it.
- Upload via the application-emoji endpoint with the bot token, or manually in the Developer Portal.
  Emoji-creation routes are per-guild rate-limited with 429s — upload with backoff.
- Emoji names must be 2–32 chars, alphanumeric + underscore: use the roster snake-case names.
