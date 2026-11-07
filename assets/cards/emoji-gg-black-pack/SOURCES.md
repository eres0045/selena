# emoji.gg card packs — sources

Downloaded by Muse 2026-11-07 from emoji.gg (public CDN links; the
pack zips need a login, the individual emoji files do not). No account
was created.

- `emoji-gg-black-pack/` — "Black Playing cards Jocker and Backside"
  (pack 36874, uploader はる子, added March 2025, 849 downloads):
  28 PNGs, 200x200 RGBA. Full spades suit (13) + full clubs suit (13)
  + joker + backside. "Black" = the black suits: the faces are white
  cards with black pips/ranks. The backside (7426-playing-card-
  backside.png, blue/turquoise geometric lattice) is the bot's
  hole-card back. The joker (7882-playing-card-joker.png) is unused —
  blackjack/high-low never need it.
- `emoji-gg-red-pack/` — "red playing cards" (pack 40609, added
  February 2025, 632 downloads): 26 PNGs, 200x200 RGBA. Full diamonds
  suit (13) + full hearts suit (13). The pack itself ships 25 — the
  Jack of Hearts is NOT in it; it was fetched separately from the same
  uploader's emoji set (.Tenebris Dominus,
  5593-playing-card-hearts-jack.png), style-matched and verified by eye.
  No joker or backside in this pack.

Together the two packs cover all 52 faces + joker + backside.

File naming: '<id>-playing-card-<suit>-<rank>.png', e.g.
3606-playing-card-spades-ace.png, 5593-playing-card-hearts-jack.png.
The numeric id prefix varies; the render script matches on the
'<suit>-<rank>.png' suffix. Bot codes are uppercase (AS, KH, QC).

Each PNG is a 200x200 square canvas with the portrait card inside
transparent padding (alpha bbox (28, 0, 172, 200) for all faces, the
two kings 1px wider). scripts/render_emoji_flips.py crops each image
to its own alpha bbox and renders the flip GIFs in assets/cards/flips/.

License note: user-uploaded emoji on emoji.gg; no license stated on
the pack pages. The bot ships rendered GIFs derived from these faces.
