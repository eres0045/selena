# Selena visual-game assets (`assets/games/`)

Built by `scripts/render_visual_games.py` (PIL only, no browser).
Every visual has a **transparent background** and was composite-checked on
Discord dark (`#313338`) before shipping — no white squares, halos, or smears.

## Layout

- `coinflip/flip.gif` — 700x360, 16 frames, looping. The $ coin spinning
  (squash-spin, same motion as the server's coin emoji, rebuilt big).
- `coinflip/heads.png` — 700x360, the landed heads face ($ coin).
- `coinflip/tails.png` — 700x360, the landed tails face (star-emboss disc).
- `slots/spin.gif` — 700x460, 16 frames, looping. Reels scrolling through
  the real symbol set; never settles on a combination (the settled strip
  is composed at reply time from the actual result).
- `slots/machine.gif` — 700x460, the machine frame with TRANSPARENT reel
  windows at x = 85/275/465, y = 120, each 150x170.
- `slots/tiles/<key>.gif` — 150x170 symbol tiles: cherry, lemon, grape,
  bell, star, diamond, clover, seven.
- `roulette/spin.gif` — 700x560, 12 frames, looping. The 37-pocket
  European wheel turning + ball orbiting.
- `roulette/wheel-<00..36>.png` — 700x560, the wheel with the ball on that
  number's pocket. Wheel order (clockwise from 0):
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5,
  24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26.
  The build script asserts the ball sits on the right pocket for all 37.
- `scratch/tiles/<key>.gif` — 190x220 revealed tiles: cherry, star,
  diamond, seven. `cover.gif` is the silver foil "?" tile.
- `twemoji/` — cached Twemoji PNGs (see below), the build inputs.
- `verify/contact-sheet.png` — composite-check sheet (all games on dark).

## Sources

- **Symbol art: Twemoji** (twitter/twemoji, CC-BY 4.0) — cherry 🍒, lemon
  🍋, grape 🍇, bell 🔔, star ⭐, diamond 💎, clover 🍀, downloaded as
  72x72 PNGs from cdn.jsdelivr.net (twemoji 14.0.2) and cached in
  `twemoji/`. The "7" is PIL-drawn (Twemoji has no keycap-7 file in
  14.0.2) and the coin faces / wheel / machine / foil are PIL originals.
- **Coin heads:** PIL-drawn clean $ disc. The emoji.gg $ face
  (`assets/emoji-animated/coin.gif`) carries a faint stock watermark
  across the $ — invisible at 22px emoji size, but plainly visible once
  the face is shown 320px big as the landed coin — so heads is a redraw
  in the same gold-disc style, not a reuse of that art.

## How the bot uses them (`src/lib/visualgames.ts`)

- Suspense (~2.4s) → reveal: the bot defers, edits in the spin/flip
  animation with neutral text, waits, then edits the SAME reply to the
  settled visual + result. Game logic, bets and payouts are untouched.
- Slots settled strip and scratch strips are composed at reply time from
  the real result symbols (machine frame + tiles); if any asset is
  missing or the wrong size the composer returns null and the command
  falls back to the old text-only reply.
- Roulette settled image is chosen by the rolled number
  (`wheel-<nn>.png`); the pocket angle is
  `-90 + (index + 0.5) * 360/37` degrees (0 deg = 3 o'clock, clockwise).
