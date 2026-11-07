#!/usr/bin/env python3
"""Render assets/cards/playing-cards.html in headless Chromium and capture
each card's 3D flip (back -> flip -> face) as an animated GIF.

Usage:
  python3 scripts/capture_flips.py            # all 52 cards
  python3 scripts/capture_flips.py --only AS  # one card (smoke test)

Output: assets/cards/flips/<CODE>.gif, e.g. AS.gif, 10H.gif, KD.gif.
The GIFs are the source of the animated cards Selena attaches to
/blackjack and /highlow replies (Discord cannot render the HTML itself).
Captures run at 4x resolution (600px wide) by default, or 8x (1200px
wide) with --scale 8, so the later downscale to the ~40px cards stays
crisp ("4k" sharp, not blurry). 8x is the sharpness pick for v6:
Ronit wants visibly crisp cards, and the extra source detail survives
the 30x downscale better. Screenshots use
omit_background, so the card's rounded corners are TRANSPARENT — no
green felt box around the card. After capturing, run
scripts/resize_flips.py to shrink them.
The GIFs play ONCE (no loop extension) — they stop on the face.

HOW THE FLIP IS DRIVEN (v5 — this is the fix for the wobbly crop):
The component's flip() also animates a LIFT (translateY -9%, scale
1.08, rotateZ -3deg), a shadow and a sheen. During that lift the card
is BIGGER than its own box, so its corners get clipped by the box, and
the card drifts off-centre — and while the card is edge-on the demo
page's deck grid behind it bleeds through the transparent parts of the
box ("not cropped well, looks bad when it moves"). So capture does NOT
call flip() at all. Instead it drives the flipper directly with
_setAngle(deg): a pure rotateY around the card's vertical centre axis.
The card never leaves its box, never scales or tilts, and stays
perfectly centred in every frame. The deck grid and the component's
shadow/sheen/glare are hidden for capture, so nothing can bleed
through. The rotateY IS the flip from Ronit's file — only the
lift/tilt ornaments are left out of the capture.
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
CAPTURE_SCALE = 4       # device_scale_factor: screenshots come out at
                        # 600x840 so the downscale to ~40px stays sharp.
                        # --scale 8 captures at 1200x1680 for maximum
                        # sharpness (v6: Ronit wants visibly crisp,
                        # 4K-level cards — 8x gives the downscale far
                        # more detail to work with). Capture cost grows
                        # with scale; 8x takes ~2x as long as 4x.
FRAMES = 12            # _setAngle steps, back (180deg) -> face (0deg).
                        # The steps follow the flip's own easing
                        # (cubic-bezier(.45,.05,.25,1) from
                        # playing-cards.html): small at both ends, fast in
                        # the middle — so the GIF settles onto the face
                        # instead of jumping 16deg in its last frame, and
                        # no frame lands exactly on the 90deg edge-on
                        # sliver (the closest are ~15% wide at 28px).
def _cubic_bezier_y(x: float, x1: float, y1: float, x2: float, y2: float) -> float:
    """y of the cubic-bezier curve at the given x (Newton iteration)."""
    # Solve x(t) = x for t, then return y(t). The curve is monotonic in
    # x for the easings used here, so Newton from t = x converges.
    t = x
    for _ in range(8):
        mt = 1 - t
        cx = 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t
        dcx = 3 * mt * mt * x1 + 6 * mt * t * (x2 - x1) + 3 * t * t * (1 - x2)
        if dcx == 0:
            break
        t -= (cx - x) / dcx
        t = min(1.0, max(0.0, t))
    mt = 1 - t
    return 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t


ANGLES = [
    180 * (1 - _cubic_bezier_y(i / (FRAMES - 1), 0.45, 0.05, 0.25, 1.0))
    for i in range(FRAMES)
]
FRAME_MS = 95         # per-frame GIF duration
PAINT_MS = 60         # let the browser paint after each angle step


def _opaque_stats(img: Image.Image) -> tuple[float, float, float]:
    """(centre-x of opaque pixels, opaque fraction, leftmost opaque x)."""
    import numpy as np

    a = np.array(img.getchannel("A"))
    opaque = a > 128
    count = int(opaque.sum())
    if count == 0:
        return 0.0, 0.0, 0.0
    ys, xs = np.where(opaque)
    h, w = a.shape
    return float(xs.mean()), count / (w * h), float(xs.min())


def capture_codes(page, codes: list[str], outdir: Path) -> None:
    loc = page.locator("#stage-card")
    for code in codes:
        rank = code[:-1]
        suit = SUIT_NAMES[code[-1]]
        page.evaluate(
            "([rank, suit]) => { window.__card.set(rank, suit); }",
            [rank, suit],
        )
        # Drive the flip directly: pure rotateY, no lift/tilt/shadow.
        frames: list[bytes] = []
        for angle in ANGLES:
            page.evaluate(f"window.__card._setAngle({angle}); 'go'")
            page.wait_for_timeout(PAINT_MS)
            frames.append(loc.screenshot(omit_background=True))

        imgs = [Image.open(io.BytesIO(b)).convert("RGBA") for b in frames]
        w, h = imgs[0].size
        assert all(im.size == (w, h) for im in imgs), f"{code}: frame sizes differ"
        # Verify the crop: the card must stay centred (same centre-x in
        # every frame), full-size at both ends, and a thin sliver
        # mid-flip — no wobble, no clipping, no background bleed.
        # The centre-x tolerance is 20px at 600px capture scale: a pure
        # rotateY under the scene's 1400px perspective shifts the card's
        # projected centre by up to ~9px either way mid-flip (the near
        # edge is magnified) — that is the real 3D flip, and at the ~40px
        # ship size it is under a pixel either way, invisible.
        # What must NOT happen is the old lift/tilt drift or deck
        # bleed-through.
        stats = [_opaque_stats(im) for im in imgs]
        centres = [s[0] for s in stats]
        # Tolerance scales with capture width: the perspective drift is
        # ~9px at 600px capture scale, ~18px at 1200px (8x).
        centre_tol = 5.0 * CAPTURE_SCALE
        assert max(centres) - min(centres) <= centre_tol, (
            f"{code}: card wobbles, centres {['%.1f' % c for c in centres]}"
        )
        assert abs(centres[0] - w / 2) <= 2.0, f"{code}: not centred: {centres[0]:.1f} vs {w / 2}"
        assert stats[0][1] > 0.95 and stats[-1][1] > 0.95, (
            f"{code}: ends not full card: {stats[0][1]:.2f} / {stats[-1][1]:.2f}"
        )
        assert min(s[1] for s in stats) < 0.45, f"{code}: no edge-on sliver frame"

        dest = outdir / f"{code}.gif"
        # Play-once + transparent background (see scripts/gifutil.py).
        save_play_once_gif(imgs, dest, FRAME_MS)
        print(
            f"{code}: {dest.stat().st_size} bytes, {len(imgs)} frames, {w}x{h}, "
            f"centre-x {centres[0]:.1f}..{max(centres):.1f}, "
            f"opaque {stats[0][1]:.2f} -> {min(s[1] for s in stats):.2f} -> {stats[-1][1]:.2f}",
            flush=True,
        )


def main() -> None:
    global CAPTURE_SCALE
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="capture a single code, e.g. AS")
    ap.add_argument("--codes", help="capture a comma-separated list, e.g. 7H,8H,9H")
    ap.add_argument("--scale", type=int, default=4,
                    help="capture scale (device_scale_factor); 4 = 600x840, 8 = 1200x1680")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()
    CAPTURE_SCALE = args.scale
    codes = (
        [args.only]
        if args.only
        else args.codes.split(",")
        if args.codes
        else [r + s for s in SUITS for r in RANKS]
    )
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
              // Hide EVERYTHING except the capture stage: the demo page
              // renders a 52-card deck grid behind the stage card, and
              // it used to bleed through the box whenever the card was
              // edge-on or lifted. Nothing behind the card may show.
              document.querySelectorAll('body > *:not(#stage)').forEach(
                el => { el.style.display = 'none'; });
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
              // The shadow / sheen / glare are flip ornaments: the
              // shadow sticks out of the card's box and the sheen sweeps
              // across it. They are hidden for capture so the frames
              // contain only the card itself, centred in its box.
              const sr = c.shadowRoot;
              sr.querySelectorAll('.shadow, .sheen, .glare').forEach(
                el => { el.style.display = 'none'; });
            }"""
        )
        page.wait_for_timeout(200)
        capture_codes(page, codes, outdir)
        browser.close()


if __name__ == "__main__":
    main()
