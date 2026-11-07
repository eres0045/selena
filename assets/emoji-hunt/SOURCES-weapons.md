# Weapon emoji sources

All 50 weapon GIFs were animated in-house with PIL from static icons — no
direct animated GIFs were used.

## Source 1 (attempted, rejected)

- emoji.gg animated sword listings (https://emoji.gg/emojis/sword?sort=animated):
  the listing is dominated by franchise rips (Minecraft swords, Zelda Master
  Sword, Wolfenstein logos) which are skipped per the licensing rule. The only
  non-franchise candidates found (157087-gothic-sword, 554979-coppersword)
  were also rejected: the gothic sword has a solid green-screen background and
  the copper sword is a Minecraft-style pixel sprite of unclear provenance.
  cdn3.emoji.gg downloads work with a Referer header; the site itself is fine,
  the art just isn't usable/licensable.

## Source 2 (used for all 50)

- game-icons.net, CC BY 3.0. Icons fetched as SVG from the official GitHub
  mirror (https://github.com/game-icons/icons, branch master) because
  game-icons.net itself is not reachable from this VM. Per-icon page URLs and
  authors are recorded in manifest-weapons.json.
- Authors used: Lorc, Delapouite, Willdabeast.
- Animation: scripts/animate_weapons.py (re-runnable) — bounce for common,
  bounce + brightness pulse for uncommon, bounce + glow pulse for rare,
  bounce + strong glow + brightness for epic/legendary/mythic/uwu.
  Rendered with cairosvg (pip package; system libcairo present), animated
  with PIL. All files verified: GIF, 128x128, 8 frames, transparent
  background, largest file 16,725 bytes (limit 262,144).
