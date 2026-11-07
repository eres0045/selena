#!/usr/bin/env python3
"""Shrink the rendered flip GIFs to the cards the bot ships (~100px wide).

Reads assets/cards/flips/<CODE>.gif (1200x1680 at 8x capture, 12 frames)
and rewrites each in place at 100x140 with a high-quality Lanczos
downscale, so the cards stay crisp instead of blurry, plus an unsharp
pass on the colour channels only (alpha untouched) to restore the
edge crispness the 12x downscale softens. Transparency is preserved
(the card's rounded corners stay transparent — no felt box), and the
GIFs play ONCE (no loop extension) with disposal 2 — they stop on the
face and never smear mid-flip (see scripts/gifutil.py).

Why 100px, not 40px (v7): Discord displays the strip at ~message
width (~620px on Ronit's phone), so the v6 40px cards were upscaled
~2.5x on screen and went blurry. A 100px card in a ~700px strip
displays ~1:1, so the pips, ranks and labels stay crisp and realistic.

Why 8x + radius 2.0 unsharp: the 8x source (1200x1680) gives the 12x
downscale far more detail to average, and radius 2.0 / 100% keeps
rank/pip edges tight at 100px. Compared by eye at 2x zoom on A/K/10:
2.0 is a touch crisper than the v6 radius 1.2 with no halo; 150%
was already shown to fringe at 40px, so it was not retried here.
GIF total stays ~6.5 MB across all 52.

Usage: python3 scripts/resize_flips.py [--width 100]
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
# untouched): radius 2.0, 100% — the v7 sharpness pick (see module
# docstring). Compared by eye at 2x zoom against radius 1.2 (the v6
# setting): 2.0 is visibly a touch crisper on face cards and pips,
# with no halo.
UNSHARP_RADIUS = 2.0
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
    ap.add_argument("--width", type=int, default=100)
    args = ap.parse_args()
    total = 0
    for path in sorted(FLIPS.glob("*.gif")):
        n, w, h, size = resize_gif(path, args.width)
        total += size
        print(f"{path.name}: {w}x{h} -> {args.width}x{round(h * args.width / w)}, {n} frames, {size} bytes", flush=True)
    print(f"total: {total} bytes across {len(list(FLIPS.glob('*.gif')))} GIFs")


if __name__ == "__main__":
    main()
