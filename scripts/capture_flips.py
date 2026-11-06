#!/usr/bin/env python3
"""Render assets/cards/playing-cards.html in headless Chromium and capture
each card's 3D flip (back -> flip -> face) as an animated GIF.

Usage:
  python3 scripts/capture_flips.py            # all 52 cards
  python3 scripts/capture_flips.py --only AS  # one card (smoke test)

Output: assets/cards/flips/<CODE>.gif, e.g. AS.gif, 10H.gif, KD.gif.
The GIFs are the source of the animated cards Selena attaches to
/blackjack and /highlow replies (Discord cannot render the HTML itself).
After capturing, run scripts/resize_flips.py to shrink them to the
small OwO-style 60px cards the bot actually ships.
"""
import argparse
import io
import time
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "assets" / "cards" / "playing-cards.html"
OUT = ROOT / "assets" / "cards" / "flips"

RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]
SUITS = ["S", "H", "D", "C"]
SUIT_NAMES = {"S": "spades", "H": "hearts", "D": "diamonds", "C": "clubs"}

CARD_WIDTH_PX = 150
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
        frames: list[bytes] = [loc.screenshot()]  # t=0: the back
        page.evaluate("window.__card.flip(); 'go'")
        for _ in range(FRAMES - 1):
            time.sleep(INTERVAL_S)
            frames.append(loc.screenshot())
        page.wait_for_timeout(300)  # let the flip finish before the next card

        imgs = [Image.open(io.BytesIO(b)).convert("RGB") for b in frames]
        w, h = imgs[0].size
        # One shared palette built from the back AND the face, so colours
        # stay consistent across the flip (no per-frame flicker).
        combo = Image.new("RGB", (w * 2, h))
        combo.paste(imgs[0], (0, 0))
        combo.paste(imgs[-1], (w, 0))
        palette = combo.convert("P", palette=Image.ADAPTIVE, colors=256)
        pal_imgs = [im.quantize(palette=palette) for im in imgs]
        dest = outdir / f"{code}.gif"
        pal_imgs[0].save(
            dest,
            save_all=True,
            append_images=pal_imgs[1:],
            duration=FRAME_MS,
            loop=0,
            optimize=True,
        )
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
        page = browser.new_page(viewport={"width": 400, "height": 400}, device_scale_factor=1)
        page.goto(HTML.as_uri())
        page.wait_for_function("!!customElements.get('playing-card')")
        page.evaluate(
            """() => {
              const stage = document.createElement('div');
              stage.id = 'stage';
              stage.style.cssText = 'position:fixed;top:0;left:0;z-index:9999;background:#0a2c21;';
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
