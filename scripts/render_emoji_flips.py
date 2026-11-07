#!/usr/bin/env python3
"""Render each card's 3D flip (back -> flip -> face) as an animated GIF,
from the emoji.gg card packs (assets/cards/emoji-gg-black-pack/ and
assets/cards/emoji-gg-red-pack/, 200x200 PNGs).

This SUPERSEDES scripts/render_pack_flips.py for the card faces (the
4K real-pack art stays in the repo as a reference only): Ronit picked
this cartoon emoji style for the bot. The packs together hold all 52
faces + joker + backside; the joker is unused (blackjack/high-low
never need it).

The emoji PNGs are 200x200 SQUARE canvases with the portrait card
drawn inside transparent padding: every face's alpha bbox is
(28, 0, 172, 200) — a 144x200 card — except the two kings, whose art
extends 1px further on each side (27, 0, 173, 200). Each image is
cropped to its OWN alpha bbox (never a hardcoded box), then resized
to the 100x140 ship size (Lanczos + unsharp). The back is the blue
geometric-pattern backside from the black pack
(7426-playing-card-backside.png).

Usage:
  python3 scripts/render_emoji_flips.py            # all 52 cards
  python3 scripts/render_emoji_flips.py --only AS  # one card (smoke test)
  python3 scripts/render_emoji_flips.py --unsharp 0  # no unsharp pass

Output: assets/cards/flips/<CODE>.gif, e.g. AS.gif, 10H.gif, KD.gif.
The GIFs play ONCE (no loop extension) — they stop on the face.

HOW THE FLIP IS BUILT (same rotateY-only motion as v5/v6/v7):
The face and the back are prepped to 100x140, then each frame
squashes the visible side horizontally by |cos(angle)|, centred on
the card's vertical axis, swapping back -> face at 90 deg. No lift,
tilt, shadow, sheen or glare — the card never leaves its box, never
scales or drifts, and stays perfectly centred in every frame. The
frame angles follow the flip's own easing (cubic-bezier
(.45,.05,.25,1)): small steps at both ends, fast in the middle, so
the GIF settles onto the face instead of jumping in its last frame.
Frames are full-size with disposal 2 and a transparent background
(see scripts/gifutil.py), so the flip never smears mid-flip.

Emoji naming: files are '<id>-playing-card-<suit>-<rank>.png' with
hyphenated suit/rank names, e.g. 3606-playing-card-spades-ace.png,
5593-playing-card-hearts-jack.png. The numeric id prefix varies, so
the lookup matches on the '<suit>-<rank>.png' suffix. Bot codes are
uppercase (AS, KH, QC); '10' maps to 'ten'.
"""
import argparse
import math
import re
import sys
from pathlib import Path

from PIL import Image, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gifutil import save_play_once_gif

ROOT = Path(__file__).resolve().parent.parent
BLACK = ROOT / "assets" / "cards" / "emoji-gg-black-pack"
RED = ROOT / "assets" / "cards" / "emoji-gg-red-pack"
OUT = ROOT / "assets" / "cards" / "flips"
BACK_FILE = BLACK / "7426-playing-card-backside.png"

RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]
SUITS = ["S", "H", "D", "C"]

CARD_W = 100
CARD_H = 140
FRAMES = 12            # back (180deg) -> face (0deg), eased (see below)
FRAME_MS = 95         # per-frame GIF duration

# Unsharp pass after the downscale (colour channels only, alpha
# untouched). Default is the v7 pick (radius 2.0, 100%); the emoji
# source is only 144x200, so the downscale is small and the pass is
# gentler in effect than on the 4K pack — verified by eye at 2x zoom
# against no-unsharp (see the A/B note in the v8 report).
UNSHARP_RADIUS = 2.0
UNSHARP_PERCENT = 100
UNSHARP_THRESHOLD = 2

SUIT_NAMES = {"S": "spades", "H": "hearts", "D": "diamonds", "C": "clubs"}
RANK_NAMES = {
    "A": "ace", "2": "two", "3": "three", "4": "four", "5": "five",
    "6": "six", "7": "seven", "8": "eight", "9": "nine", "10": "ten",
    "J": "jack", "Q": "queen", "K": "king",
}


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


def build_index() -> dict[str, Path]:
    """Suffix '<suit>-<rank>.png' -> file, across both pack dirs."""
    index: dict[str, Path] = {}
    for d in (BLACK, RED):
        for p in sorted(d.glob("*.png")):
            m = re.match(r"^\d+-playing-card-(.+)\.png$", p.name)
            if m:
                index[m.group(1)] = p
    return index


INDEX = build_index()


def face_path(code: str) -> Path:
    """Bot code -> emoji PNG: 'AS' -> '...-playing-card-spades-ace.png'."""
    rank = code[:-1]
    suit = code[-1]
    key = f"{SUIT_NAMES[suit]}-{RANK_NAMES[rank]}"
    try:
        return INDEX[key]
    except KeyError:
        raise SystemExit(f"no emoji face for {code} (key {key})")


def prep_image(path: Path, unsharp_radius: float, unsharp_percent: int) -> Image.Image:
    """Emoji PNG -> cropped card -> 100x140 RGBA with unsharp (RGB only)."""
    im = Image.open(path).convert("RGBA")
    bbox = im.getchannel("A").getbbox()
    if bbox is None:
        raise SystemExit(f"{path}: fully transparent image")
    card = im.crop(bbox)
    small = card.resize((CARD_W, CARD_H), Image.LANCZOS)
    if unsharp_radius > 0:
        rgb = small.convert("RGB").filter(
            ImageFilter.UnsharpMask(
                radius=unsharp_radius,
                percent=unsharp_percent,
                threshold=UNSHARP_THRESHOLD,
            )
        )
        rgb.putalpha(small.getchannel("A"))
        return rgb
    return small


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


def render_codes(codes: list[str], unsharp_radius: float, unsharp_percent: int) -> None:
    back = prep_image(BACK_FILE, unsharp_radius, unsharp_percent)
    for code in codes:
        face = prep_image(face_path(code), unsharp_radius, unsharp_percent)
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
    ap.add_argument("--unsharp", type=float, default=UNSHARP_RADIUS,
                    help="unsharp radius (0 = off)")
    ap.add_argument("--unsharp-percent", type=int, default=UNSHARP_PERCENT)
    args = ap.parse_args()
    codes = (
        [args.only]
        if args.only
        else args.codes.split(",")
        if args.codes
        else [r + s for s in SUITS for r in RANKS]
    )
    OUT.mkdir(parents=True, exist_ok=True)
    render_codes(codes, args.unsharp, args.unsharp_percent)
    total = sum(p.stat().st_size for p in OUT.glob("*.gif"))
    print(f"total: {total} bytes across {len(list(OUT.glob('*.gif')))} GIFs")


if __name__ == "__main__":
    main()
