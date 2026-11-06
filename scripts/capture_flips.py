#!/usr/bin/env python3
"""Render assets/cards/playing-cards.html in headless Chromium and capture
each card's 3D flip (back -> flip -> face) as an animated GIF.

Usage:
  python3 scripts/capture_flips.py            # all 52 cards
  python3 scripts/capture_flips.py --only AS  # one card (smoke test)

Output: assets/cards/flips/<CODE>.gif, e.g. AS.gif, 10H.gif, KD.gif.
The GIFs are the source of the animated cards Selena attaches to
/blackjack and /highlow replies (Discord cannot render the HTML itself).
Captures run at 2x resolution (300px wide) so the later downscale to
the ~100px cards stays crisp ("4k" sharp, not blurry). Screenshots use
omit_background, so the card's rounded corners are TRANSPARENT — no
green felt box around the card. After capturing, run
scripts/resize_flips.py to shrink them.
The GIFs play ONCE (no loop extension) — they stop on the face.
"""
import argparse
import io
import sys
import time
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gifutil import save_play_once_gif

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "assets" / "cards" / "playing-cards.html"
OUT = ROOT / "assets" / "cards" / "flips"

RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]
SUITS = ["S", "H", "D", "C"]
SUIT_NAMES = {"S": "spades", "H": "hearts", "D": "diamonds", "C": "clubs"}

CARD_WIDTH_PX = 150
CAPTURE_SCALE = 2       # device_scale_factor: screenshots come out at
                        # 300x420 so the downscale to 100px stays sharp
FRAMES = 12            # t=0 (back) + 11 during the 950 ms flip
INTERVAL_S = 0.01     # element screenshots take ~90 ms each, so the
                      # effective interval is ~100 ms — about 10 distinct
                      # frames across the flip
FRAME_MS = 95         # per-frame GIF duration ≈ the real capture interval


def capture_codes(page, codes: list[str], outdir: Path) -> None:
    loc = page.locator("#stage-card")
    for code in codes:
        rank = code[:-1]
        suit = SUIT_NAMES[code[-1]]
        page.evaluate(
            "([rank, suit]) => { window.__card.set(rank, suit); }",
            [rank, suit],
        )
        # Make sure the card starts face-down.
        if page.evaluate("window.__card.faceUp"):
            page.evaluate("window.__card.hide()")
            page.wait_for_timeout(1100)
        frames: list[bytes] = [loc.screenshot(omit_background=True)]  # t=0: the back
        page.evaluate("window.__card.flip(); 'go'")
        for _ in range(FRAMES - 1):
            time.sleep(INTERVAL_S)
            frames.append(loc.screenshot(omit_background=True))
        page.wait_for_timeout(300)  # let the flip finish before the next card

        imgs = [Image.open(io.BytesIO(b)).convert("RGBA") for b in frames]
        dest = outdir / f"{code}.gif"
        # Play-once + transparent background (see scripts/gifutil.py).
        save_play_once_gif(imgs, dest, FRAME_MS)
        w, h = imgs[0].size
        print(f"{code}: {dest.stat().st_size} bytes, {len(imgs)} frames, {w}x{h}", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="capture a single code, e.g. AS")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()
    codes = [args.only] if args.only else [r + s for s in SUITS for r in RANKS]
    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-gpu"])
        page = browser.new_page(
            viewport={"width": 400, "height": 400},
            device_scale_factor=CAPTURE_SCALE,
        )
        page.goto(HTML.as_uri())
        page.wait_for_function("!!customElements.get('playing-card')")
        # omit_background only hides the DEFAULT background; the page's
        # own html/body gradient would still show through the card's
        # rounded corners, so make those transparent too.
        page.evaluate(
            "() => { document.documentElement.style.background = 'transparent';"
            " document.body.style.background = 'transparent'; }"
        )
        page.evaluate(
            """() => {
              const stage = document.createElement('div');
              stage.id = 'stage';
              // No background: screenshots use omit_background, so the
              // card's rounded corners stay transparent (no felt box).
              stage.style.cssText = 'position:fixed;top:0;left:0;z-index:9999;';
              const c = document.createElement('playing-card');
              c.id = 'stage-card';
              c.style.setProperty('--card-width', '150px');
              stage.appendChild(c);
              document.body.appendChild(stage);
              window.__card = c;
            }"""
        )
        page.wait_for_timeout(200)
        capture_codes(page, codes, outdir)
        browser.close()


if __name__ == "__main__":
    main()
