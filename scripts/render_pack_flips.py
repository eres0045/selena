#!/usr/bin/env python3
"""Render each card's 3D flip (back -> flip -> face) as an animated GIF,
from Ronit's own card pack (assets/cards/real-pack/, 4K PNGs).

This SUPERSEDES scripts/capture_flips.py + playing-cards.html for the
card faces: the pack is a classic realistic design (big bold corner
ranks, large centre pips) that reads far better at phone size than the
HTML web-component art, and rendering from PNGs is deterministic — no
browser, no capture flakiness. playing-cards.html stays in the repo as
a reference only.

Usage:
  python3 scripts/render_pack_flips.py            # all 52 cards
  python3 scripts/render_pack_flips.py --only AS  # one card (smoke test)

Output: assets/cards/flips/<CODE>.gif, e.g. AS.gif, 10H.gif, KD.gif.
The GIFs are the source of the animated cards Selena attaches to
/blackjack and /highlow replies (Discord cannot render the PNGs as
animations). The GIFs play ONCE (no loop extension) — they stop on
the face.

HOW THE FLIP IS BUILT (same rotateY-only motion as the v5/v6 capture):
The face and the blue back are downscaled from the 4K PNGs to the
100x140 ship size (Lanczos + the v7 unsharp: radius 2.0, 100%), then
each frame squashes the visible side horizontally by |cos(angle)|,
centred on the card's vertical axis, swapping back -> face at 90 deg.
No lift, tilt, shadow, sheen or glare — the card never leaves its box,
never scales or drifts, and stays perfectly centred in every frame.
The frame angles follow the flip's own easing (cubic-bezier
(.45,.05,.25,1), the same easing the HTML component used): small steps
at both ends, fast in the middle, so the GIF settles onto the face
instead of jumping in its last frame. Frames are full-size with
disposal 2 and a transparent background (see scripts/gifutil.py), so
the flip never smears mid-flip.

Pack naming: rank letter + suit letter, e.g. As.png, Qh.png, Tc.png
(T = 10); bot codes are uppercase (AS, KH, QC) — T maps to 10. The
blue back (back_blue.png) is the one the bot uses; back_red.png is
also in the pack but unused.
"""
import argparse
import math
import sys
from pathlib import Path

from PIL import Image, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gifutil import save_play_once_gif

ROOT = Path(__file__).resolve().parent.parent
PACK = ROOT / "assets" / "cards" / "real-pack" / "png4k"
OUT = ROOT / "assets" / "cards" / "flips"

RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]
SUITS = ["S", "H", "D", "C"]

CARD_W = 100
CARD_H = 140
FRAMES = 12            # back (180deg) -> face (0deg), eased (see below)
FRAME_MS = 95         # per-frame GIF duration

# Unsharp pass after the downscale (colour channels only, alpha
# untouched): radius 2.0, 100% — the v7 sharpness pick, compared by eye
# at 2x zoom against radius 1.2 (a touch softer, no halo either way).
UNSHARP_RADIUS = 2.0
UNSHARP_PERCENT = 100
UNSHARP_THRESHOLD = 2


def _cubic_bezier_y(x: float, x1: float, y1: float, x2: float, y2: float) -> float:
    """y of the cubic-bezier curve at the given x (Newton iteration)."""
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


def pack_name(code: str) -> str:
    """Bot code -> pack filename stem: 'AS' -> 'As', '10D' -> 'Td'."""
    rank = code[:-1]
    suit = code[-1]
    return ("T" if rank == "10" else rank) + suit.lower()


def prep_image(path: Path) -> Image.Image:
    """4K PNG -> 100x140 RGBA with the v7 unsharp (RGB only)."""
    im = Image.open(path).convert("RGBA")
    small = im.resize((CARD_W, CARD_H), Image.LANCZOS)
    rgb = small.convert("RGB").filter(
        ImageFilter.UnsharpMask(
            radius=UNSHARP_RADIUS,
            percent=UNSHARP_PERCENT,
            threshold=UNSHARP_THRESHOLD,
        )
    )
    rgb.putalpha(small.getchannel("A"))
    return rgb


def flip_frames(face: Image.Image, back: Image.Image) -> list[Image.Image]:
    """12 frames of the flip: squash by |cos(angle)|, swap at 90 deg."""
    frames: list[Image.Image] = []
    for angle in ANGLES:
        visible = back if angle > 90 else face
        factor = abs(math.cos(math.radians(angle)))
        w = max(2, round(CARD_W * factor))
        squashed = visible.resize((w, CARD_H), Image.LANCZOS)
        canvas = Image.new("RGBA", (CARD_W, CARD_H), (0, 0, 0, 0))
        canvas.paste(squashed, ((CARD_W - w) // 2, 0), squashed)
        frames.append(canvas)
    return frames


def _opaque_stats(img: Image.Image) -> tuple[float, float]:
    """(centre-x of opaque pixels, opaque fraction)."""
    import numpy as np

    a = np.array(img.getchannel("A"))
    opaque = a > 128
    count = int(opaque.sum())
    if count == 0:
        return 0.0, 0.0
    _, xs = np.where(opaque)
    return float(xs.mean()), count / (a.shape[0] * a.shape[1])


def render_codes(codes: list[str]) -> None:
    back = prep_image(PACK / "back_blue.png")
    for code in codes:
        face = prep_image(PACK / f"{pack_name(code)}.png")
        frames = flip_frames(face, back)
        # Verify the flip: centred in every frame, full-size at both
        # ends, a thin sliver mid-flip — no wobble, no clipping.
        stats = [_opaque_stats(f) for f in frames]
        centres = [s[0] for s in stats]
        assert max(centres) - min(centres) <= 2.0, (
            f"{code}: card wobbles, centres {['%.1f' % c for c in centres]}"
        )
        assert abs(centres[0] - CARD_W / 2) <= 1.0, (
            f"{code}: not centred: {centres[0]:.1f} vs {CARD_W / 2}"
        )
        assert stats[0][1] > 0.95 and stats[-1][1] > 0.95, (
            f"{code}: ends not full card: {stats[0][1]:.2f} / {stats[-1][1]:.2f}"
        )
        assert min(s[1] for s in stats) < 0.45, f"{code}: no edge-on sliver frame"
        dest = OUT / f"{code}.gif"
        save_play_once_gif(frames, dest, FRAME_MS)
        print(
            f"{code}: {dest.stat().st_size} bytes, {len(frames)} frames, "
            f"{CARD_W}x{CARD_H}, centre-x {centres[0]:.1f}..{max(centres):.1f}, "
            f"opaque {stats[0][1]:.2f} -> {min(s[1] for s in stats):.2f} -> {stats[-1][1]:.2f}",
            flush=True,
        )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="render a single code, e.g. AS")
    ap.add_argument("--codes", help="render a comma-separated list, e.g. 7H,8H,9H")
    args = ap.parse_args()
    codes = (
        [args.only]
        if args.only
        else args.codes.split(",")
        if args.codes
        else [r + s for s in SUITS for r in RANKS]
    )
    OUT.mkdir(parents=True, exist_ok=True)
    render_codes(codes)
    total = sum(p.stat().st_size for p in OUT.glob("*.gif"))
    print(f"total: {total} bytes across {len(list(OUT.glob('*.gif')))} GIFs")


if __name__ == "__main__":
    main()
