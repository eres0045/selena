#!/usr/bin/env python3
"""Shrink the rendered flip GIFs to the cards the bot ships (~50px wide).

Reads assets/cards/flips/<CODE>.gif (600x840 at 4x capture, 12 frames)
and rewrites each in place at 50x70 with a high-quality Lanczos
downscale, so the cards stay crisp instead of blurry. Transparency is
preserved (the card's rounded corners stay transparent — no felt box),
and the GIFs play ONCE (no loop extension) — they stop on the face.

Why 50px, and why the strip is ~280px wide: Ronit wants the whole
thing half the size of the 560px version. The strip file stays
proportional to the cards, and the 4x capture (600x840 -> 50x70, a 12x
downscale) keeps the small cards sharp.

Usage: python3 scripts/resize_flips.py [--width 50]
"""
import argparse
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gifutil import save_play_once_gif

ROOT = Path(__file__).resolve().parent.parent
FLIPS = ROOT / "assets" / "cards" / "flips"


def resize_gif(path: Path, width: int) -> tuple[int, int, int, int]:
    src = Image.open(path)
    frames: list[Image.Image] = []
    for i in range(src.n_frames):
        src.seek(i)
        # P -> RGBA honours the transparency index (alpha 0 in corners).
        frames.append(src.convert("RGBA"))
    src_w, src_h = frames[0].size
    height = round(src_h * width / src_w)
    small = [f.resize((width, height), Image.LANCZOS) for f in frames]
    duration = src.info.get("duration", 95)
    save_play_once_gif(small, path, duration)
    return len(frames), src_w, src_h, path.stat().st_size


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, default=50)
    args = ap.parse_args()
    total = 0
    for path in sorted(FLIPS.glob("*.gif")):
        n, w, h, size = resize_gif(path, args.width)
        total += size
        print(f"{path.name}: {w}x{h} -> {args.width}x{round(h * args.width / w)}, {n} frames, {size} bytes", flush=True)
    print(f"total: {total} bytes across {len(list(FLIPS.glob('*.gif')))} GIFs")


if __name__ == "__main__":
    main()
