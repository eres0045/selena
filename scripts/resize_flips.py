#!/usr/bin/env python3
"""Shrink the rendered flip GIFs to the cards the bot ships (~40px wide).

Reads assets/cards/flips/<CODE>.gif (1200x1680 at 8x capture, 12 frames)
and rewrites each in place at 40x56 with a high-quality Lanczos
downscale, so the cards stay crisp instead of blurry, plus an unsharp
pass on the colour channels only (alpha untouched) to restore the
edge crispness the 30x downscale softens. Transparency is preserved
(the card's rounded corners stay transparent — no felt box), and the
GIFs play ONCE (no loop extension) with disposal 2 — they stop on the
face and never smear mid-flip (see scripts/gifutil.py).

Why 8x + strong unsharp: Ronit wants visibly crisp, 4K-level cards.
The 8x source (1200x1680) gives the 30x downscale far more detail to
average than 4x did, and a stronger unsharp (radius 1.2, 100%) keeps
rank/pip edges tight at 40px. Compared by eye at 3x/6x zoom: 8x+100
is visibly crisper than 4x+60 on face cards and pips, with no halo;
pushing to 150% adds nothing and starts to fringe. GIF total stays
~1.6 MB across all 52.

Usage: python3 scripts/resize_flips.py [--width 40]
"""
import argparse
import sys
from pathlib import Path

from PIL import Image, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gifutil import save_play_once_gif

ROOT = Path(__file__).resolve().parent.parent
FLIPS = ROOT / "assets" / "cards" / "flips"

# Unsharp pass after the downscale (colour channels only, alpha
# untouched): radius 1.2, 100% — the v6 sharpness pick. Compared by eye
# at 3x/6x zoom against 4x+60% (softer) and 8x+150% (no better, starts
# to fringe); 8x+100% is visibly the crispest with no halo.
UNSHARP_RADIUS = 1.2
UNSHARP_PERCENT = 100
UNSHARP_THRESHOLD = 2


def resize_gif(path: Path, width: int) -> tuple[int, int, int, int]:
    src = Image.open(path)
    frames: list[Image.Image] = []
    for i in range(src.n_frames):
        src.seek(i)
        # P -> RGBA honours the transparency index (alpha 0 in corners).
        frames.append(src.convert("RGBA"))
    src_w, src_h = frames[0].size
    height = round(src_h * width / src_w)
    small: list[Image.Image] = []
    for f in frames:
        down = f.resize((width, height), Image.LANCZOS)
        # Unsharp on the colour channels only: restores edge crispness
        # after the 30x downscale. Alpha is left alone so no halo
        # appears around the card's transparent edges.
        rgb = down.convert("RGB").filter(
            ImageFilter.UnsharpMask(
                radius=UNSHARP_RADIUS,
                percent=UNSHARP_PERCENT,
                threshold=UNSHARP_THRESHOLD,
            )
        )
        rgb.putalpha(down.getchannel("A"))
        small.append(rgb)
    duration = src.info.get("duration", 95)
    save_play_once_gif(small, path, duration)
    return len(frames), src_w, src_h, path.stat().st_size


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, default=40)
    args = ap.parse_args()
    total = 0
    for path in sorted(FLIPS.glob("*.gif")):
        n, w, h, size = resize_gif(path, args.width)
        total += size
        print(f"{path.name}: {w}x{h} -> {args.width}x{round(h * args.width / w)}, {n} frames, {size} bytes", flush=True)
    print(f"total: {total} bytes across {len(list(FLIPS.glob('*.gif')))} GIFs")


if __name__ == "__main__":
    main()
