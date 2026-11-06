"""Shared GIF writer for Selena's animated cards.

Saves a list of RGBA frames as a GIF that:
  * plays EXACTLY ONCE (no NETSCAPE2.0 loop extension), and
  * has a TRANSPARENT background (GIF 1-bit transparency) instead of a
    solid box, so the card blends into Discord's dark embed.

Transparency uses palette index 0 (magenta, never a real card colour):
pixels with alpha < 128 become index 0, everything else is quantized
against one shared 255-colour palette built from the first (back) and
last (face) frames, then shifted to indices 1..255.

The card's rounded corners are also masked out explicitly: during the
flip the card lifts (scale 1.08, translateY -9%), so for a couple of
mid-flip frames the card is bigger than its box and the box corners
show card interior instead of transparency. A rounded-rectangle mask
with the card's own corner radii (6.4% / 4.6%, as in playing-cards.html)
forces those corners transparent in every frame.
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


def save_transparent_gif(
    frames: list[Image.Image],
    dest: Path,
    duration_ms: int,
) -> None:
    """Save RGBA frames as a play-once GIF with a transparent background.

    No loop extension (plays exactly once) and GIF 1-bit transparency
    (index 0 = magenta, never a real colour): pixels with alpha < 128
    become index 0, everything else is quantized against one shared
    255-colour palette built from the first and last frames, then
    shifted to indices 1..255.
    """
    if not frames:
        raise ValueError("no frames to save")
    w, h = frames[0].size
    rgba = [f.convert("RGBA") for f in frames]

    # One shared palette from the back (frame 0) and face (last frame).
    combo = Image.new("RGB", (w * 2, h))
    combo.paste(rgba[0].convert("RGB"), (0, 0))
    combo.paste(rgba[-1].convert("RGB"), (w, 0))
    palette_img = combo.convert("P", palette=Image.ADAPTIVE, colors=255)
    base_palette = palette_img.getpalette() or []
    base_palette = (base_palette + [0] * 768)[: 255 * 3]
    full_palette = list(TRANSPARENT_RGB) + base_palette

    pal_frames: list[Image.Image] = []
    for frame in rgba:
        # Binary transparency: soft edge pixels become fully transparent
        # below the threshold, fully opaque above it — no dark fringe.
        alpha = frame.getchannel("A")
        mask = alpha.point(lambda a: 255 if a < 128 else 0)
        q = frame.convert("RGB").quantize(palette=palette_img)
        # Shift real colours to indices 1..255, reserving 0 for transparency.
        q = q.point(lambda i: i + 1)
        q.putpalette(full_palette)
        q.paste(0, mask=mask)
        pal_frames.append(q)

    # optimize=False on purpose: Pillow's palette optimizer can remap
    # indices and break the transparency index.
    pal_frames[0].save(
        dest,
        save_all=True,
        append_images=pal_frames[1:],
        duration=duration_ms,
        transparency=0,
        optimize=False,
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
