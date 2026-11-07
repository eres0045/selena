# Real card pack — sources

Supplied by Ronit, 2026-11-07 (zip `playing-cards-compact_23_7aj8.zip`, saved to `assets/cards/real-pack/`).

- 54 SVG faces/backs (`svg/`, 250×350 viewBox) + pre-rendered PNGs at 4K (2743×3840 RGBA), 400×560, 200×280, 100×140 (`png4k/`, `png400/`, `png200/`, `png100/`).
- Classic realistic card design (bold corner ranks, large centre pips). Blue back used by the bot (`back_blue`); red back also present.
- File naming: rank letter + suit letter, e.g. `As.png` (ace of spades), `Qh.png`, `Tc.png` (T = 10). Bot codes are uppercase (`AS`, `KH`, `QC`) — map T→10.
- The SVG set matches the well-known open SVG playing-cards family (LGPL-2.1, same set noted in the RadheEx casino-source vetting). Keep this note with the pack; the bot ships rendered GIFs derived from these faces, not the SVGs themselves.
- Supersedes the `playing-cards.html` web-component art for blackjack/high-low faces (Ron's own pack, his call). The HTML file is kept as a reference only.
