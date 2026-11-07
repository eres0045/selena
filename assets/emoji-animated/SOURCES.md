# Animated emoji — sources

Discord custom emoji: 128x128 recommended, 256 KB max each, GIF, loops
forever (`loop=0`). All eight files below meet that. Upload order is
the table order; the Discord emoji NAME is the file stem.

| File | What it is | Source | Frames | Size | Bytes |
| --- | --- | --- | --- | --- | --- |
| coin.gif | Gold `$` coin spinning (rotate) | emoji.gg — https://cdn3.emoji.gg/emojis/529977-coin.gif | 74 | 128x128 | 177,825 |
| trophy.gif | Gold trophy, sparkles | emoji.gg — https://cdn3.emoji.gg/emojis/30348-trophy-fixed.gif (frame-sampled 142→71 to fit 256 KB) | 71 | 100x100 | 132,623 |
| gift.gif | Pink gift box bouncing | emoji.gg — https://cdn3.emoji.gg/emojis/380114-bouncingpresent.gif | 4 | 90x90 | 4,629 |
| party.gif | Balloons + gifts | emoji.gg — https://cdn3.emoji.gg/emojis/19953-partyballoonsandgifts.gif | 6 | 75x73 | 15,345 |
| fire.gif | Cartoon flame flickering | emoji.gg — https://cdn3.emoji.gg/emojis/391906-fire.gif (frame-sampled 45→23, shrunk to 96px to fit 256 KB) | 23 | 96x96 | 106,391 |
| star.gif | White sparkles twinkling | emoji.gg — https://cdn3.emoji.gg/emojis/156016-sparkle.gif | 20 | 128x128 | 50,161 |
| slots.gif | Mini slot machine, reels scroll and settle 7-7-7, lever pulls | PIL original — `scripts/render_animated_emoji.py` (no fitting emoji.gg slot machine exists; the one found was a blurry gem in a frame) | 14 | 128x128 | 37,726 |
| roulette.gif | Roulette wheel spinning one full turn, ball orbiting the other way | PIL original — `scripts/render_animated_emoji.py` (no animated roulette wheel on emoji.gg) | 12 | 128x128 | 78,946 |
| gold (gag-sheckles-128.png) | Stacks of gold coins — the MAIN currency icon (replaces the spinning coin in balance/daily) | emoji.gg `gag_sheckles` (ID 1114) — https://cdn3.emoji.gg/emojis/1114-gag-sheckles.png, resized 591→128 | static PNG | 128x128 | 13,927 |
| gem (diamondanimated-gg.gif) | White glowing angular gem — the GEM (premium) currency icon | emoji.gg `DiamondAnimated` (see currency-candidates section) | 41 | 106x106 | 256,634 |

## Coin faces — heads / tails (2026-11-07, Ronit: tiny-emoji games)

The four visual casino games are now tiny-emoji only (no attached
pictures — Discord stretches every image to the message width on his
phone, so images can never look small). The coinflip settles on a
small custom emoji of the landed face:

| File | What it is | Source | Size | Bytes | Status |
| --- | --- | --- | --- | --- | --- |
| heads.png | Gold `$` coin face | PIL original — `scripts/render_coin_face_emoji.py` (same clean disc as the old landed close-up; the emoji.gg `$` face is NOT reused — it carries a faint stock watermark across the `$`) | 128x128 | 4,307 | NOT uploaded yet — upload as server emoji `heads`, fill the ID in `src/lib/emoji.ts` |
| tails.png | Gold disc with a star emboss | PIL original — same script, same disc construction as heads so both sides read as one coin | 128x128 | 2,182 | NOT uploaded yet — upload as server emoji `tails`, fill the ID in `src/lib/emoji.ts` |

Both are RGBA with transparent corners (verified numerically: corners
alpha 0, centre opaque) and far under the 256 KB cap. Contact sheet
`verify/coin-faces.png` (1x + 3x on #313338) viewed by eye: `$` and
star crisp and unmistakable at small size, no background/halo. Until
the IDs are filled, the bot falls back to 🪙 / ⭐ (`test/visualgames.test.ts`
asserts the fallback while the IDs are blank — update that test to
expect the `<a:heads:id>` markup once the IDs land).

Rebuild: `python3 scripts/render_coin_face_emoji.py`.

## Background fix (2026-11-07, Ronit: "no bg, make it properly")

Composited every frame of all 8 files on Discord dark (#313338) at 1x
and 2x, plus connected-component analysis. Two real problems found
and fixed; the other six were already clean cutouts and are untouched:

- **coin** (live file: `coin-big.gif`): the old file was the 58px
  emoji.gg coin Lanczos-upscaled 2.2x — the soft transparent edge
  stretched mid-spin into a wide gold speckled smear. Rebuilt by
  `scripts/fix_emoji_bg.py` from the cleanest face-on frame of the
  original: Lanczos RGB + hard-thresholded alpha, then a pure
  horizontal-squash spin (|cos|, 16 frames, 40 ms, 640 ms/spin, same
  technique as the card flips). Mid-spin is a clean thin sliver —
  verified numerically: 0 opaque pixels outside ±8px of centre.
  126,171 bytes. `coin.gif` now holds the identical rebuild (the old
  74-frame small original is superseded).
  Known imperfection, left as-is: the emoji.gg source coin carries a
  faint stock watermark across the `$`, visible only at 4x zoom —
  invisible at emoji size (22–48px). Removing it would mean
  redrawing the `$`.
- **gift**: a flat (218,218,218) grey ellipse shadow baked in under
  the box, disconnected from it. Removed by colour in all 4 frames
  (the grey exists nowhere in the box itself); 0 shadow-grey pixels
  remain. 90x90, 4,487 bytes.
- **slots / roulette** (PIL originals): drawn on a transparent canvas
  — the dark purple machine body and the wheel ARE the art, not a
  backdrop; corners transparent in every frame. Unchanged.
- **trophy / party / fire / star** (emoji.gg): single art component(s)
  only — trophy + sparkles, balloons + gifts, flame (+ one small
  inner flame tongue), scattered sparkles. No background island, no
  halo. Unchanged.

Verification: `assets/emoji-animated/verify/contact-sheet.png` — all
8 files, 4 frames each, on #313338 at 2x, viewed by eye: no box,
halo, ellipse or smear on any frame.

Rebuild: `python3 scripts/fix_emoji_bg.py` (coin + gift only).
Re-upload needed: coin + gift ONLY (new IDs) — the other six files
are byte-identical to the live uploads, so their IDs stay valid.

## Deliberately NOT animated

- Dice: no 🎲 is used anywhere in the bot (verified by grep), so a
  rolling-dice emoji would have no home. Two emoji.gg candidates were
  checked and rejected anyway (16659-dice.gif is 20x20; 39865-dice.gif
  is a meme clip, not a clean die).
- Slots / scratch reel symbols (🍒 🍋 🍇 🔔 ⭐ 💎 🍀 7️⃣): inline text
  in the reel line, kept as Unicode — one animated emoji per symbol
  would be 8 more uploads for a text row.
- UI marks (✅ ❌ ⚠️ ⭕ 🔴 🟡 ⚪ 🔗 etc.): static on purpose; animating
  a checkmark adds nothing.
- Blackjack / high-low titles (🃏 🔼🔽) and the 🎫 scratch title: the
  animated card strips ARE the visual there; the titles stay static.

## Rejected emoji.gg candidates

- 933416-goldenspincoin.gif — pixel-art coin on a black background.
- 161979-trophy.gif — not a trophy at all (cartoon face with a crown).
- 43091-slots.gif — 600x600, 577 KB, first frame is a blurry red gem
  in a gold frame; not recognisably a slot machine.
- 160148-fire.gif — 448x498, 252 KB, near the cap before any resize.
- 750892-gamba.gif — gambling meme clip, not a clean visual.
