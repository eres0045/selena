"""Shared GIF writer for Selena's animated cards.

Saves a list of RGBA frames as a GIF that:
  * plays EXACTLY ONCE (no NETSCAPE2.0 loop extension),
  * has a TRANSPARENT background (GIF 1-bit transparency) instead of a
    solid box, so the card blends into Discord's dark embed, and
  * uses disposal method 2 (restore to background) with FULL frames:
    every frame is a complete image and the canvas is cleared before
    the next frame is drawn. Without this, Pillow crops each frame to
    its changed region and writes disposal 0 (keep), so every decoder —
    Discord included — composites each frame on top of the previous
    ones and the flip smears instead of flipping (the back never goes
    away mid-flip; that was the "looks bad when it moves" bug).

Transparency uses palette index 0 (magenta, never a real card colour):
pixels with alpha < 128 become index 0. Each frame gets its OWN
adaptive 255-colour palette (Pillow writes a local colour table per
frame), which keeps tiny downscaled cards sharp instead of posterised
by one shared palette.

The card's rounded corners are also masked out explicitly: a
rounded-rectangle mask with the card's own corner radii (6.4% / 4.6%,
as in playing-cards.html) forces those corners transparent in every
frame, so no box edge ever shows.
"""
from pathlib import Path

from PIL import Image, ImageDraw

TRANSPARENT_RGB = (255, 0, 255)  # magenta — never appears on a real card
CORNER_RX = 0.064  # card border-radius, horizontal (from playing-cards.html)
CORNER_RY = 0.046  # card border-radius, vertical


def _rounded_rect_mask(size: tuple[int, int]) -> Image.Image:
    """'L' mask, 255 inside the card's rounded rect, 0 outside it."""
    w, h = size
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(
        [0, 0, w - 1, h - 1],
        radius=int(min(w * CORNER_RX, h * CORNER_RY)),
        fill=255,
    )
    return mask


def _quantize_frame(frame: Image.Image) -> Image.Image:
    """One RGBA frame -> a 'P' frame with its own adaptive palette.

    Index 0 is magenta = transparent; the frame's own colours live at
    indices 1..255. Pixels with alpha < 128 become index 0.
    """
    alpha = frame.getchannel("A")
    mask = alpha.point(lambda a: 255 if a < 128 else 0)
    q = frame.convert("RGB").quantize(colors=255)
    base_palette = (q.getpalette() or []) + [0] * 768
    full_palette = list(TRANSPARENT_RGB) + base_palette[: 255 * 3]
    q = q.point(lambda i: i + 1)
    q.putpalette(full_palette)
    q.paste(0, mask=mask)
    return q


def save_transparent_gif(
    frames: list[Image.Image],
    dest: Path,
    duration_ms: int,
) -> None:
    """Save RGBA frames as a play-once GIF with a transparent background.

    No loop extension (plays exactly once), GIF 1-bit transparency
    (index 0 = magenta, never a real colour), disposal 2 on every frame
    (see the module docstring — without it the flip smears), and a
    per-frame adaptive palette so small cards stay sharp.
    """
    if not frames:
        raise ValueError("no frames to save")
    rgba = [f.convert("RGBA") for f in frames]
    pal_frames = [_quantize_frame(f) for f in rgba]

    # optimize=False on purpose: Pillow's palette optimizer can remap
    # indices and break the transparency index. disposal=2 on every
    # frame: full frames, canvas cleared before each frame (see above).
    pal_frames[0].save(
        dest,
        save_all=True,
        append_images=pal_frames[1:],
        duration=duration_ms,
        transparency=0,
        optimize=False,
        disposal=2,
    )


def save_play_once_gif(
    frames: list[Image.Image],
    dest: Path,
    duration_ms: int,
) -> None:
    """Save RGBA frames as a play-once GIF with a transparent background."""
    if not frames:
        raise ValueError("no frames to save")
    w, h = frames[0].size
    rgba = [f.convert("RGBA") for f in frames]
    # Force the rounded corners transparent in every frame (see above).
    corner_mask = _rounded_rect_mask((w, h))
    rgba = [
        Image.composite(f, Image.new("RGBA", (w, h), (0, 0, 0, 0)), corner_mask)
        for f in rgba
    ]
    save_transparent_gif(rgba, dest, duration_ms)
