# 02 — Casino

**Status: LIVE.** All seven games are implemented, plain-text presented
(OwO style), covered by tests, and deployed. All multipliers below are
**total return per 1 gold bet (stake included)**; payouts are floored to
whole gold (rounding down only ever helps the house).

## Shared bet rules (all games)

- Bet must be a **positive whole integer**; otherwise:
  > Bet must be a positive whole number of gold.
- **Minimum bet: 1 gold. Maximum bet: none** — only your balance limits you.
- **No cooldowns, no daily/session loss limits, no per-user concurrent-game
  limit** on any casino game.
- Insufficient funds gives either `Insufficient gold. You have {balance} gold,
  but bet {bet}.` (blackjack / highlow / mines, which pre-check) or the bare
  `Insufficient gold.` (slots / roulette / coinflip / scratch). Bets are
  deducted atomically, so a balance can never go below 0.

## 2.1 Slots — `uwu slots <bet>`

| | |
|---|---|
| Aliases | `uwu slot`, `uwu spin` |

- 3 reels, 8 symbols equally weighted: 🍒 🍋 🍇 🔔 ⭐ 💎 🍀 7️⃣.

| Result | Payout |
|---|---|
| `7️⃣7️⃣7️⃣` jackpot | **50x** |
| Any other 3-of-a-kind | **10x** |
| Any pair (exactly 2 matching) | **2x** |
| No match | 0x |

- **House edge ~10.9%** (RTP 0.8907, stated in code).
- Presentation: `___SLOTS___` header, reels as `sym | sym | sym`. The spin
  animates through **4 frames × 450 ms ≈ 1.8 s** of random symbols, then the
  **same message is edited** to the real drawn result (the animation lands
  on the real result and freezes — never a cut to a separate final image).
  Settled line: `Bet {bet} · Multiplier {m}x · Balance {bal} gold`.
  Win: `You won **{amount} gold** ({m}x)!` Loss: `No match — better luck
  next spin.` No buttons. Instant settle, no open state.

## 2.2 Blackjack — `uwu blackjack <bet>`

| | |
|---|---|
| Aliases | `uwu bj`, `uwu 21` |

- Full 52-card deck, shuffled; player gets 2, dealer gets 2. Aces = 11
  (reduced by 10 while the total is over 21, per ace); J/Q/K = 10.
- **Dealer draws until 17 or more — stands on all 17s, including soft 17.**
- Cards are shown as **Unicode playing-card glyphs** (🂡 etc.); the dealer's
  hole card is hidden as 🂠 until the hand finishes.

| Outcome | Payout |
|---|---|
| Player blackjack (2-card 21) | **2.5x** (stake + 3:2 profit) |
| Win (higher total, or dealer busts) | **2x** |
| Push (tie, or both blackjack) | **1x** (stake returned) |
| Lose / dealer blackjack / player bust | 0x |

- A player bust loses **even if the dealer would also bust**.
- **House edge ~0.5% under optimal play** (stated in code).
- Flow: a natural player blackjack settles immediately, no buttons.
  Otherwise **Hit** / **Stand** buttons appear. Hitting to exactly 21
  auto-plays the dealer out; bust settles immediately. Only the player who
  started the game can press its buttons:
  > Only the player who started this game can use these buttons.
- **Open-game warning:** an open blackjack hand lives in an in-memory map.
  A redeploy strands it (bet deducted, no refund); a later button press
  replies `This blackjack game has expired or was already finished.`
  There is no expiry timer and no limit on concurrent open games.
  (See §2.8.)

## 2.3 Roulette — `uwu roulette <bet> <bet-on>`

| | |
|---|---|
| Aliases | `uwu roul` |

- **European wheel, single zero, 0–36.** Red numbers:
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36.
  0 is green.
- Accepted bets (case-insensitive): `red`, `black`, `even`, `odd`, or a
  single number `0`–`36`. **No dozen / column / split / corner / range bets.**
  Invalid bet (checked before the bet is placed):
  > Invalid bet. Bet on red, black, even, odd, or a single number 0-36.

| Bet | Win condition | Payout |
|---|---|---|
| red / black | ball colour matches | **2x** |
| even | roll ≠ 0 and even | **2x** |
| odd | roll odd (0 loses) | **2x** |
| single number 0–36 | exact roll | **36x** |
| Loss | — | 0x |

- **House edge 2.70%** (return 36/37 = 97.3% for both even-money and
  straight-up, stated in code).
- Presentation: plain text. One `Spinning…` edit, settled after 2,400 ms:
  `The ball landed on **{roll} {color}**. You bet on **{betOn}**.` + win/loss
  line + `Bet · Multiplier · Balance`. No buttons. Instant settle.

## 2.4 Coinflip — `uwu coinflip <bet> <guess>`

| | |
|---|---|
| Aliases | `uwu cf`, `uwu flip`, `uwu coin` |
| Example | `uwu cf 10 heads` |

- Guess must be **exactly `heads` or `tails`** — lowercase, exact match.
  `Heads`, `H`, `head` are rejected:
  > Heads or tails? Try `uwu cf 10 heads`.
  (Checked before the bet is placed.)
- **Win pays 1.9x total return, loss 0x.** Coin is 50/50.
  **House edge 5%** (stated in code).
- Presentation: plain text. `Flipping…`, settled after 2,400 ms:
  `You called **{guess}**. The coin landed **{result}** {face}.`
  Heads shows 🪙, tails shows ⭐. Win:
  `You won **{amount} gold** (1.9x)!` Loss: `Wrong call — you lost this flip.`

## 2.5 HighLow (streak game) — `uwu highlow <bet>`

| | |
|---|---|
| Aliases | `uwu hl` |

- One bet starts a streak. The current card rank is 1–13 (1 = Ace low …
  13 = King), uniform. Each round, guess the next card vs the current:
  **Higher** (`next > current`), **Lower** (`next < current`), or **Same**
  (`next === current`). P(Higher or Lower correct) = 6/13; P(Same) = 1/13.
  A wrong guess ends the streak and **loses the bet**. A correct guess
  advances the streak and the drawn card becomes the new current card.
  The suit shown is random, display-only.
- **Ladder** — cash-out multiplier after N correct Higher/Lower guesses:

  | Streak | 1 | 2 | 3 | 4 | 5 | 6+ |
  |---|---|---|---|---|---|---|
  | Multiplier | **1.8x** | **3.2x** | **5x** | **7.5x** | **11x** | **×1.5 per further step** (6 = 16.5x, 7 = 24.75x, …) |

  Formula for streak ≥ 6: `11 × 1.5^(streak−5)`.
- **Same:** a correct Same sets the multiplier to **at least 10x** and
  advances the streak by 1 like any correct guess. A wrong Same loses the
  bet.
- **Cash Out any time** via the Cash Out button: value =
  `floor(bet × multiplier)`. Cashing out at streak 0 returns 0. No forced
  stop, no max streak.
- The ladder is below the fair (13/6)^N at every step (stated in code).
- Presentation: plain text + 4 buttons — **Higher** / **Lower** / **Same** /
  **Cash Out**. Shows `Bet · Streak · Cash Out: {amount} ({mult}x)`, current
  card as a Unicode glyph, next card face-down (🂠). Cash-out or loss removes
  the buttons.
- **Open-game warning:** same as blackjack — in-memory only, a redeploy
  strands it (bet lost, no refund); later presses reply
  `This HighLow game has expired or was already finished.` (See §2.8.)

## 2.6 Mines — `uwu mines <bet> [mines]`

| | |
|---|---|
| Aliases | `uwu mine` |
| Mine count | 1–5, **default 3** |

- **3×3 = 9 tiles.** Outside 1–5 mines:
  > Mines must be between 1 and 5. Try `uwu mines 10 3`.
- Multiplier = fair multiplier × **0.93^k** (k = safe picks), rounded to
  2 dp. Cash-out = `floor(bet × multiplier)`.

  | Mines | 1 pick | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
  |---|---|---|---|---|---|---|---|---|
  | 1 | 1.05x | 1.11x | 1.21x | 1.35x | 1.57x | 1.94x | 2.71x | 5.04x |
  | 2 | 1.20x | 1.48x | 1.93x | 2.69x | 4.17x | 7.76x | 21.66x | — |
  | **3** | **1.40x** | **2.08x** | **3.38x** | **6.28x** | **14.61x** | **54.35x** | — | — |
  | 4 | 1.67x | 3.11x | 6.76x | 18.85x | 87.66x | — | — | — |
  | 5 | 2.09x | 5.19x | 16.89x | 94.25x | — | — | — | — |

  Max safe picks = 9 − mines.
- **Cash Out any time** via the Cash Out button. Hitting a mine **loses the
  whole bet** and reveals the board. **Clearing every safe tile banks the
  max payout automatically.** Cashing out at 0 safe picks returns 0.
- Presentation: plain text + 3 rows × 3 tile buttons (`?`) plus a
  **Cash Out** button. Revealed safe tile → 💎; revealed mine → 💣; on game
  over, unrevealed mines show 💣 and unrevealed safe tiles `?`, all disabled.
  Text line: `Bet: {bet} · Mines: {m} · Cash Out: {amount} ({mult}x) ·
  Next: {nextAmount} ({nextMult}x)`.
- **Open-game warning:** same as blackjack/highlow — in-memory only, a
  redeploy strands it (bet lost, no refund). (See §2.8.)

## 2.7 Scratch — `uwu scratch <bet>`

| | |
|---|---|
| Aliases | `uwu scratchcard`, `uwu sc` |

- 3 symbols drawn independently from 4 equally weighted symbols:
  🍒 ⭐ 💎 7️⃣.

| Result | Payout |
|---|---|
| 3 matching | **5x** |
| Exactly 2 matching | **1x** (bet returned) |
| No match | 0x |

- **House edge 12.5%** (RTP 0.875, stated in code).
- Presentation: plain text, `🎫 Scratch Card` header. `Scratching…`,
  settled after 2,400 ms with the 3 symbols and the outcome line. No buttons.
  Instant settle.

## 2.8 Open games & redeploys — read this

Blackjack, highlow, and mines keep open games in **in-memory maps**
(`blackjackGames`, `highlowGames`, `minesGames` in `src/lib/casino.ts`).
There is **no persistence, no expiry timer, no cleanup**. A redeploy or
process restart wipes the maps:

- The bet was already deducted at game start and **is not refunded**.
- A later button press replies (ephemerally):
  `This blackjack game has expired or was already finished.` (and the
  equivalent for highlow / mines).
- There is no single-open-game limit: a user can start multiple concurrent
  games of the same type, each with its own bet deducted.

Slots, roulette, coinflip, and scratch settle instantly and have no open state.

## 2.9 Casino emoji

Only three casino names have custom emoji (with Unicode fallbacks):
`slots` (animated), `roulette` (animated), `coin` (animated). Slot symbols,
coin faces, and scratch symbols are literal Unicode — there are no dedicated
custom emoji for them. Coinflip faces are hardcoded 🪙 (heads) / ⭐ (tails).

## Verified

- **Tests:** `npm test` 2026-11-07 — 593/593 passed (21 files), including
  `test/casino.test.ts`, `test/cards.test.ts`, `test/handstrip.test.ts`,
  `test/visualgames.test.ts`.
- **Code read:** `src/commands/casino.ts`, `src/lib/casino.ts`,
  `src/lib/cards.ts`, `src/lib/emoji.ts` (casino mappings). Every payout,
  ladder value, and rule above is copied from the code as cited.
- **Live Discord check: NOT DONE** (no browser access in this session).
  To verify live in `#🤖-miya-bot`: `uwu slots 10`, `uwu bj 10` (Hit, then
  Stand), `uwu roulette 10 red`, `uwu cf 10 heads`, `uwu hl 10`,
  `uwu mines 10 3`, `uwu scratch 10`. Check the animations land on the real
  result and the balances move as documented.
