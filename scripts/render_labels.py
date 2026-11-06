#!/usr/bin/env python3
"""Render the strip labels as crisp transparent GIF sprites.

The strip image carries its own labels (Discord embeds put the
description ABOVE the image, which read badly), so each row is labelled
in-image: a word ("DEALER" / "YOU" / "FIRST" / "NEXT") over the row's
total ("17", "?" while hidden). The sprites are rendered with PIL at 4x
(DejaVu Sans Bold, white with a dark outline so the text reads on both
Discord's dark and light themes) and Lanczos-downscaled to their
display size, then pasted into the strip by src/lib/handstrip.ts.

Words are whole sprites (fixed strings); totals are composed at reply
time from the digit glyphs 0-9 plus "?" (digit-q.gif).

Output: assets/cards/labels/word-<lower>.gif, digit-<ch>.gif
  (digit "?" is digit-q.gif). Word sprites are 14px tall, digits 17px
  (sized for the ~28px cards: the word is half a card wide in height,
  so the labels stay readable at the small size).

Usage: python3 scripts/render_labels.py
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gifutil import save_transparent_gif

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "cards" / "labels"

FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
SCALE = 4  # render at 4x, Lanczos-downscale to display size
WORD_FONT_PX = 11  # display size; cap height ~8px (cards are ~28px now)
DIGIT_FONT_PX = 13  # display size; cap height ~9px
WORD_H = 14  # fixed sprite height (display px)
DIGIT_H = 17
STROKE_PX = 1  # dark outline, display px (reads on light theme too)
WHITE = (255, 255, 255, 255)
DARK = (32, 34, 37, 255)  # Discord-ish dark, for the outline

WORDS = ["DEALER", "YOU", "FIRST", "NEXT"]
DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "?"]


def render_text(text: str, font_px: int, height: int) -> Image.Image:
    """One text sprite: fixed height, ink vertically centred, trimmed
    horizontally to the ink (plus a small side pad)."""
    font = ImageFont.truetype(FONT_PATH, font_px * SCALE)
    # Wide canvas; the ink box is measured and trimmed below.
    canvas = Image.new("RGBA", (len(text) * font_px * SCALE, height * SCALE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    draw.text(
        (0, 0),
        text,
        font=font,
        fill=WHITE,
        stroke_width=STROKE_PX * SCALE,
        stroke_fill=DARK,
        anchor="la",
    )
    alpha = canvas.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        raise ValueError(f"no ink rendered for {text!r}")
    left, top, right, bottom = bbox
    # Centre the ink vertically in the fixed-height canvas.
    ink_h = bottom - top
    shift_y = (height * SCALE - ink_h) // 2 - top
    centred = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    centred.paste(canvas, (0, shift_y))
    # Trim left/right to the ink, keeping a small side pad.
    pad = 2 * SCALE
    left = max(0, left - pad)
    right = min(canvas.width, right + pad)
    cropped = centred.crop((left, 0, right, height * SCALE))
    # Downscale to display size with Lanczos (crisp, not blurry).
    return cropped.resize(
        (max(1, cropped.width // SCALE), height), Image.LANCZOS
    )


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for word in WORDS:
        img = render_text(word, WORD_FONT_PX, WORD_H)
        dest = OUT / f"word-{word.lower()}.gif"
        save_transparent_gif([img], dest, 95)
        print(f"{dest.name}: {img.size[0]}x{img.size[1]}, {dest.stat().st_size} bytes", flush=True)
    for ch in DIGITS:
        img = render_text(ch, DIGIT_FONT_PX, DIGIT_H)
        name = "q" if ch == "?" else ch
        dest = OUT / f"digit-{name}.gif"
        save_transparent_gif([img], dest, 95)
        print(f"{dest.name}: {img.size[0]}x{img.size[1]}, {dest.stat().st_size} bytes", flush=True)


if __name__ == "__main__":
    main()
