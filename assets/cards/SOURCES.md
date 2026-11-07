# Selena card visuals — candidate sources

Picked up 2026-11-07 for Ronit to choose from. NO code uses these yet.
Nothing here is generated — every file was downloaded from the web.

## 1. Real card-face set — RECOMMENDED, ready to wire

Source: **Deck of Cards API** — https://deckofcardsapi.com
Pattern: `https://deckofcardsapi.com/static/img/<CODE>.png`
Codes: rank A,2–9,0(=10),J,Q,K + suit S,H,D,C (e.g. AS, 0C, KH).
Card back: `https://deckofcardsapi.com/static/img/back.png`

Files: `assets/cards/faces/` — **53 PNGs** (52 faces + back.png).
Every file: **226 × 314 px, RGBA PNG**, verified valid. Total **1,358,997 bytes (~1.3 MB)**.
Style: classic Bicycle-style faces — white cards, red hearts/diamonds,
black spades/clubs, corner rank+suit indices, big centre pips. The back is
the classic black-and-white Bicycle rider-back design. No watermark.
Note: the API uses `0` for ten (`0C.png` = 10 of clubs; `10C.png` 404s).

## 2. Animated GIF candidates — NO clean deal/flip clip found

All of these are video clips of people handling cards, not clean
card-only animations. The three marked "borderline" are the best of them;
the rest are not usable as bot visuals.

| File | Source | Size / dims / frames | Shows | Verdict |
|---|---|---|---|---|
| `anim/tenor-cards-playing.gif` | https://tenor.com/view/cards-playing-gif-6227748 (media1.tenor.com) | 380,961 B, 498×248, 29 frames | Hands doing a cardistry flourish with a black-back deck, dark background | BORDERLINE — real cards in motion, no faces, no watermark; dark/low-res |
| `anim/tenor-casino.gif` | https://tenor.com/my/view/ejw27-casino-ejw-ejw2019-mooiactiviteiten-gif-14175135 (media1.tenor.com) | 2,558,292 B, 498×280, 33 frames | Black-and-white close-up: hand placing/flipping a card on a casino table with chips | BORDERLINE — moody B&W, slow/artistic, no watermark |
| `anim/deviantart-thumbfan.gif` | https://orig11.deviantart.net/d14d/f/2014/352/2/d/thumb_fan_by_memmo_by_world_x_movement-d8abtw2.gif | 5,430,489 B, 500×281, 106 frames | Person in a black tee doing a thumb-fan flourish, cards fanned in hand, black background | BORDERLINE — clean fan motion, no watermark, but a person's torso/arms in frame |
| `anim/makeagif-shuffle.gif` | https://i.makeagif.com/media/5-23-2016/S1KqnU.gif (makeagif.com, "how to shuffle cards like a poker dealer") | 5,198,153 B, 720×404, 72 frames | Dealer riffle-shuffling two halves on a black table | WEAK — PokerListings + MakeAGIF.com watermarks, person's torso/arms |
| `anim/tenor-poker.gif` | https://tenor.com/view/poker-gif-16403512005360663474 (media1.tenor.com) | 139,600 B, 498×498, 1 frame | Still photo of 4 men playing cards around a green table | NOT USABLE — not animated, people |
| `anim/tenor-poker-card.gif` | https://tenor.com/view/poker-card-hot-gif-19330011 (media1.tenor.com) | 4,208,432 B, 640×352, 82 frames | Close-up of a man's tense face ("poker face") — no cards at all | NOT USABLE — no cards |
| `anim/gifdb-shuffle.gif` | https://gifdb.com/gif/magician-justin-willman-card-trick-shuffle-with-baby-xm7e6g2e90291qra.html | 6,396,968 B, 889×500, 20 frames | Magician Justin Willman throwing cards in the air with a baby in a carrier (Netflix clip) | NOT USABLE — people, GIFDB.com + NETFLIX watermarks |

## Honest summary

- The **face set is complete and ready**: all 52 real card faces + back,
  consistent style, small files, no watermark.
- **No animated deal/flip GIF was found** that shows just cards sliding or
  flipping on a table. Every animated result is a clip of a person
  (cardistry, dealer shuffle, poker reaction). If Ronit wants a real deal
  animation, the realistic options are: (a) use one of the three
  borderline clips as a decorative "dealing..." moment, or (b) animate
  with the face set itself (e.g. send the back image, then edit to the
  face — a flip effect made from real images, no GIF needed).
