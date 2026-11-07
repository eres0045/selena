"""Fix the animated emoji backgrounds (Ronit: 'no bg, make it properly').

Two real problems, both found by compositing every frame on Discord
dark (#313338) and by connected-component analysis:

  * coin (live: coin-big.gif) — the 2.2x Lanczos upscale of the tiny
    58px coin left a soft transparent edge; squashed mid-spin that
    edge becomes a wide gold speckled smear. Rebuilt here from the
    cleanest face-on frame of the original emoji.gg coin with a HARD
    alpha edge (Lanczos RGB, thresholded alpha) and the same pure
    horizontal-squash spin as the card flips. Mid-spin is a clean
    thin sliver, no speckle.
  * gift — a white/grey (218,218,218) ellipse shadow baked in under
    the box, disconnected from the box (a transparent row separates
    them in frames 0/2; in frames 1/3 the box overlaps it). Removed
    by colour: the grey exists nowhere in the box itself.

The other six (slots, roulette, trophy, party, fire, star) were
verified clean cutouts on dark — corners transparent, no background
island, no halo — and are left byte-identical.

Usage: python3 scripts/fix_emoji_bg.py
Writes: assets/emoji-animated/coin-big.gif, coin.gif, gift.gif
        (and assets/emoji-animated/verify/contact-sheet.png)
"""
import math
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gifutil import _quantize_frame  # noqa: E402


def save_looping_gif(frames: list[Image.Image], dest: Path, duration_ms: int) -> None:
    """RGBA frames -> looping transparent GIF (disposal 2, full frames).

    Same writer as scripts/render_animated_emoji.py: per-frame adaptive
    palette, index 0 = transparent, loop=0 (Discord loops forever).
    """
    if not frames:
        raise ValueError("no frames to save")
    pal = [_quantize_frame(f.convert("RGBA")) for f in frames]
    pal[0].save(
        dest,
        save_all=True,
        append_images=pal[1:],
        duration=duration_ms,
        loop=0,
        transparency=0,
        optimize=False,
        disposal=2,
    )

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "emoji-animated"
VERIFY = OUT / "verify"
SIZE = 128


def hard_alpha(img: Image.Image, threshold: int = 128) -> Image.Image:
    """RGBA image with its alpha forced to a hard 0/255 edge."""
    r = img.convert("RGBA")
    a = r.getchannel("A").point(lambda v: 255 if v >= threshold else 0)
    r.putalpha(a)
    return r


def build_coin() -> Path:
    """Rebuild the coin spin from the cleanest face-on frame."""
    src = Image.open(OUT / "coin.gif")
    src.seek(0)
    face = src.convert("RGBA")
    bbox = face.getbbox()  # (35, 35, 93, 93) — the 58x58 coin art
    assert bbox is not None
    face = face.crop(bbox)
    # Upscale: Lanczos for colour, hard thresholded alpha for the edge.
    # (Lanczos on the alpha would leave a soft halo that the squash
    # stretches into the speckled smear of the old coin-big.)
    big = face.resize((SIZE, SIZE), Image.LANCZOS)
    big = hard_alpha(big)

    n_frames = 16
    duration_ms = 40  # 640 ms per spin
    frames: list[Image.Image] = []
    for i in range(n_frames):
        phase = 2 * math.pi * i / n_frames
        factor = abs(math.cos(phase))
        w = max(4, round(SIZE * factor))
        squashed = big.resize((w, SIZE), Image.LANCZOS)
        squashed = hard_alpha(squashed)
        canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        canvas.alpha_composite(squashed, ((SIZE - w) // 2, 0))
        frames.append(canvas)
    dest = OUT / "coin-big.gif"
    save_looping_gif(frames, dest, duration_ms)
    # coin.gif was the small original (74f, 58px art) — superseded by
    # the same clean rebuild; keep both files identical.
    save_looping_gif(frames, OUT / "coin.gif", duration_ms)
    return dest


def is_shadow_grey(p: tuple[int, int, int, int]) -> bool:
    """The gift's baked-in ellipse shadow: flat (218,218,218) grey."""
    r, g, b, a = p
    return a > 128 and 190 <= r <= 240 and 190 <= g <= 240 and 190 <= b <= 240 \
        and max(r, g, b) - min(r, g, b) <= 15


def fix_gift() -> Path:
    """Remove the white/grey ellipse shadow from every gift frame."""
    src = Image.open(OUT / "gift.gif")
    duration_ms = src.info.get("duration", 200)
    frames: list[Image.Image] = []
    # Decode respecting disposal 2 (same as render_animated_emoji).
    canvas = Image.new("RGBA", src.size, (0, 0, 0, 0))
    prev_disposal = 0
    try:
        while True:
            if prev_disposal == 2:
                canvas = Image.new("RGBA", src.size, (0, 0, 0, 0))
            frame = src.convert("RGBA")
            canvas.alpha_composite(frame)
            frames.append(canvas.copy())
            prev_disposal = getattr(src, "disposal_method", 0)
            src.seek(src.tell() + 1)
    except EOFError:
        pass
    cleaned: list[Image.Image] = []
    for f in frames:
        px = f.load()
        w, h = f.size
        for y in range(h):
            for x in range(w):
                if is_shadow_grey(px[x, y]):
                    px[x, y] = (0, 0, 0, 0)
        cleaned.append(f)
    dest = OUT / "gift.gif"
    save_looping_gif(cleaned, dest, duration_ms)
    return dest


def contact_sheet() -> Path:
    """All 8 emoji, 4 frames each, composited on Discord dark, 2x."""
    VERIFY.mkdir(exist_ok=True)
    bg = (49, 51, 56, 255)
    files = ["coin.gif", "coin-big.gif", "slots.gif", "roulette.gif",
             "trophy.gif", "gift.gif", "party.gif", "fire.gif", "star.gif"]
    rows = []
    for name in files:
        im = Image.open(OUT / name)
        n = im.n_frames
        idxs = [0, n // 3, 2 * n // 3, n - 1] if n >= 4 else list(range(n))
        tiles = []
        for i in idxs:
            im.seek(i)
            r = im.convert("RGBA")
            comp = Image.new("RGBA", r.size, bg)
            comp.alpha_composite(r)
            tiles.append(comp.convert("RGB").resize((256, 256), Image.NEAREST))
        row = Image.new("RGB", (256 * len(tiles), 256), bg[:3])
        for k, t in enumerate(tiles):
            row.paste(t, (256 * k, 0))
        rows.append(row)
    sheet = Image.new("RGB", (256 * 4, 256 * len(rows)), (20, 20, 20))
    for j, row in enumerate(rows):
        sheet.paste(row, (0, 256 * j))
    dest = VERIFY / "contact-sheet.png"
    sheet.save(dest)
    return dest


if __name__ == "__main__":
    coin = build_coin()
    print("coin ->", coin, coin.stat().st_size, "bytes")
    gift = fix_gift()
    print("gift ->", gift, gift.stat().st_size, "bytes")
    sheet = contact_sheet()
    print("contact sheet ->", sheet)
