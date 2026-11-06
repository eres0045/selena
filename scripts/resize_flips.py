#!/usr/bin/env python3
"""Shrink the rendered flip GIFs to small OwO-style cards (~60px wide).

Reads assets/cards/flips/<CODE>.gif (150x210, 10-12 frames) and rewrites
each in place at 60x84, keeping every frame animated. Each GIF is
re-quantized against one palette built from its first (back) and last
(face) frames so colours stay consistent across the flip.

Usage: python3 scripts/resize_flips.py [--width 60]
"""
import argparse
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
FLIPS = ROOT / "assets" / "cards" / "flips"


def resize_gif(path: Path, width: int) -> tuple[int, int, int, int]:
    src = Image.open(path)
    frames: list[Image.Image] = []
    for i in range(src.n_frames):
        src.seek(i)
        frames.append(src.convert("RGB"))
    src_w, src_h = frames[0].size
    height = round(src_h * width / src_w)
    small = [f.resize((width, height), Image.LANCZOS) for f in frames]
    # One shared palette from the back and face frames.
    combo = Image.new("RGB", (width * 2, height))
    combo.paste(small[0], (0, 0))
    combo.paste(small[-1], (width, 0))
    palette = combo.convert("P", palette=Image.ADAPTIVE, colors=256)
    pal = [im.quantize(palette=palette) for im in small]
    duration = src.info.get("duration", 95)
    pal[0].save(
        path,
        save_all=True,
        append_images=pal[1:],
        duration=duration,
        loop=0,
        optimize=True,
    )
    return len(frames), src_w, src_h, path.stat().st_size


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, default=60)
    args = ap.parse_args()
    total = 0
    for path in sorted(FLIPS.glob("*.gif")):
        n, w, h, size = resize_gif(path, args.width)
        total += size
        print(f"{path.name}: {w}x{h} -> 60x{round(h * 60 / w)}, {n} frames, {size} bytes", flush=True)
    print(f"total: {total} bytes across {len(list(FLIPS.glob('*.gif')))} GIFs")


if __name__ == "__main__":
    main()
