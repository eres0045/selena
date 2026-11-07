"""Build Selena's animated emoji set.

Two kinds of files land in assets/emoji-animated/:
  * emoji.gg downloads, normalised: resized to <=128px, re-saved as
    looping GIFs (loop=0 — Discord custom emoji loop forever) with
    disposal 2 + transparent background, via gifutil's quantiser.
  * PIL originals drawn here (no fitting emoji.gg result existed):
    slots.gif — a mini slot machine whose reels scroll and settle 7-7-7;
    roulette.gif — a spinning European-style wheel with a ball.

Usage: python3 scripts/render_animated_emoji.py
Source downloads live in /tmp/anim (fetched from cdn3.emoji.gg).
"""
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gifutil import _quantize_frame  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "emoji-animated"
TMP = Path("/tmp/anim")
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

SIZE = 128  # Discord custom emoji: 128x128 recommended, 256 KB max


def save_looping_gif(frames: list[Image.Image], dest: Path, duration_ms: int) -> None:
    """RGBA frames -> looping transparent GIF (disposal 2, full frames)."""
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


def decode_gif_frames(path: Path) -> list[Image.Image]:
    """Decode a GIF the way a player shows it (respect disposal 2)."""
    im = Image.open(path)
    frames: list[Image.Image] = []
    canvas = Image.new("RGBA", im.size, (0, 0, 0, 0))
    prev_disposal = 0
    try:
        while True:
            if prev_disposal == 2:
                canvas = Image.new("RGBA", im.size, (0, 0, 0, 0))
            frame = im.convert("RGBA")
            canvas.alpha_composite(frame)
            frames.append(canvas.copy())
            prev_disposal = getattr(im, "disposal_method", 0)
            im.seek(im.tell() + 1)
    except EOFError:
        pass
    return frames


def normalise(src_name: str, dest_name: str, duration_ms: int = 100,
              max_px: int = SIZE, sample: int = 1) -> Path:
    """Resize an emoji.gg GIF to <=max_px and re-save it looping.

    sample=2 keeps every 2nd frame (halves the byte size for
    frame-heavy GIFs); callers raise duration_ms to keep the speed.
    """
    frames = decode_gif_frames(TMP / src_name)
    if sample > 1:
        frames = frames[::sample]
    w, h = frames[0].size
    scale = min(1.0, max_px / max(w, h))
    if scale < 1.0:
        nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
        frames = [f.resize((nw, nh), Image.LANCZOS) for f in frames]
    dest = OUT / dest_name
    save_looping_gif(frames, dest, duration_ms)
    return dest


# ---------------------------------------------------------------------------
# Slots machine (PIL original)
# ---------------------------------------------------------------------------

def _star_points(cx: float, cy: float, r_out: float, r_in: float, n: int = 5):
    pts = []
    for i in range(2 * n):
        r = r_out if i % 2 == 0 else r_in
        a = -math.pi / 2 + i * math.pi / n
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def _draw_symbol(draw: ImageDraw.ImageDraw, kind: str, cx: int, cy: int) -> None:
    """Draw one slot symbol centred at (cx, cy) inside a 26x40 cell."""
    if kind == "cherry":
        draw.line([(cx - 2, cy - 12), (cx - 6, cy + 2)], fill=(34, 139, 34), width=2)
        draw.line([(cx + 2, cy - 12), (cx + 6, cy + 2)], fill=(34, 139, 34), width=2)
        draw.ellipse([cx - 12, cy - 2, cx - 2, cy + 8], fill=(220, 20, 60), outline=(139, 0, 18))
        draw.ellipse([cx + 2, cy - 2, cx + 12, cy + 8], fill=(220, 20, 60), outline=(139, 0, 18))
        draw.ellipse([cx - 10, cy, cx - 6, cy + 3], fill=(255, 120, 140))
        draw.ellipse([cx + 4, cy, cx + 8, cy + 3], fill=(255, 120, 140))
    elif kind == "seven":
        font = ImageFont.truetype(FONT_BOLD, 26)
        draw.text((cx, cy), "7", font=font, fill=(220, 20, 60), anchor="mm",
                  stroke_width=1, stroke_fill=(120, 0, 10))
    elif kind == "star":
        draw.polygon(_star_points(cx, cy, 15, 6), fill=(255, 200, 0), outline=(200, 140, 0))
    elif kind == "diamond":
        draw.polygon([(cx, cy - 15), (cx + 11, cy), (cx, cy + 15), (cx - 11, cy)],
                     fill=(0, 200, 220), outline=(0, 120, 150))
        draw.line([(cx, cy - 15), (cx, cy + 15)], fill=(255, 255, 255), width=1)


SYMBOLS = ["cherry", "seven", "star", "diamond"]
CELL_H = 40
REEL_W = 26


def _reel_strip() -> Image.Image:
    """One reel as a vertical strip: the 4 symbols, twice (for wraparound)."""
    strip = Image.new("RGBA", (REEL_W, CELL_H * len(SYMBOLS) * 2), (255, 255, 255, 255))
    d = ImageDraw.Draw(strip)
    for rep in range(2):
        for i, kind in enumerate(SYMBOLS):
            _draw_symbol(d, kind, REEL_W // 2, rep * len(SYMBOLS) * CELL_H + i * CELL_H + CELL_H // 2)
    return strip


def build_slots() -> Path:
    strip = _reel_strip()
    period = CELL_H * len(SYMBOLS)  # 160px — one full symbol cycle
    final_offset = CELL_H * 1  # "seven" is cell index 1
    stops = [5, 9, 13]  # frame each reel settles on
    n_frames = 14
    speed = 12  # px per frame while spinning
    frames: list[Image.Image] = []
    font = ImageFont.truetype(FONT_BOLD, 12)
    for f in range(n_frames):
        img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        # Machine body
        d.rounded_rectangle([14, 26, 114, 122], radius=8, fill=(59, 45, 92),
                            outline=(255, 201, 60), width=3)
        # Marquee
        d.rounded_rectangle([24, 8, 104, 28], radius=6, fill=(230, 57, 70),
                            outline=(255, 201, 60), width=2)
        d.text((64, 18), "SLOTS", font=font, fill=(255, 255, 255), anchor="mm")
        # Blinking marquee lights
        lit = (255, 220, 0) if f % 2 == 0 else (150, 120, 0)
        d.ellipse([18, 13, 24, 19], fill=lit)
        d.ellipse([104, 13, 110, 19], fill=(255, 220, 0) if f % 2 else (150, 120, 0))
        # Reels
        for ri, x in enumerate((22, 51, 80)):
            stop = stops[ri]
            if f < stop:
                offset = (speed * f) % period
            elif f == stop:
                offset = final_offset
            else:
                offset = final_offset
            # Ease into the stop over the last spinning frame is skipped:
            # the offset jumps to the final cell on the stop frame, which
            # reads as the reel locking in (same beat as a real machine).
            window = strip.crop((0, offset, REEL_W, offset + CELL_H))
            img.alpha_composite(window, (x, 40))
            d.rectangle([x, 40, x + REEL_W, 40 + CELL_H], outline=(20, 20, 30), width=2)
        # Payline
        d.line([(20, 60), (108, 60)], fill=(255, 201, 60), width=1)
        # Lever: pulls down on frames 0-2, springs back by frame 4
        lever_y = 38 + (14 if f in (1, 2) else 7 if f == 3 else 0)
        d.line([(118, 48), (118, 92)], fill=(255, 201, 60), width=3)
        d.ellipse([113, lever_y, 123, lever_y + 10], fill=(230, 57, 70),
                  outline=(255, 255, 255))
        # Coin tray
        d.rounded_rectangle([34, 96, 94, 112], radius=4, fill=(20, 20, 30),
                            outline=(255, 201, 60), width=2)
        d.text((64, 104), "7 7 7", font=ImageFont.truetype(FONT_BOLD, 10),
               fill=(255, 201, 60), anchor="mm")
        frames.append(img)
    dest = OUT / "slots.gif"
    save_looping_gif(frames, dest, 90)
    return dest


# ---------------------------------------------------------------------------
# Roulette wheel (PIL original)
# ---------------------------------------------------------------------------

def _wheel_base() -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = cy = SIZE // 2
    # Outer gold rim
    d.ellipse([cx - 62, cy - 62, cx + 62, cy + 62], fill=(32, 36, 46),
              outline=(255, 201, 60), width=5)
    # Pockets: 12 segments — 1 green (0) + alternating red/black
    seg = 360 / 12
    for i in range(12):
        a0, a1 = i * seg, (i + 1) * seg
        color = (14, 122, 61) if i == 0 else ((210, 31, 60) if i % 2 else (16, 16, 20))
        d.pieslice([cx - 55, cy - 55, cx + 55, cy + 55], start=a0, end=a1, fill=color)
        x0 = cx + 55 * math.cos(math.radians(a0))
        y0 = cy + 55 * math.sin(math.radians(a0))
        x1 = cx + 22 * math.cos(math.radians(a0))
        y1 = cy + 22 * math.sin(math.radians(a0))
        d.line([(x0, y0), (x1, y1)], fill=(255, 201, 60), width=2)
    # Inner gold ring + cone
    d.ellipse([cx - 22, cy - 22, cx + 22, cy + 22], fill=(60, 50, 20),
              outline=(255, 201, 60), width=3)
    d.ellipse([cx - 10, cy - 10, cx + 10, cy + 10], fill=(255, 201, 60),
              outline=(180, 130, 0), width=2)
    d.ellipse([cx - 3, cy - 3, cx + 3, cy + 3], fill=(255, 255, 255))
    return img


def build_roulette() -> Path:
    base = _wheel_base()
    cx = cy = SIZE // 2
    frames: list[Image.Image] = []
    for f in range(12):
        # Wheel spins clockwise 30 deg/frame (one full turn); the ball
        # orbits the other way and drops inward on the last frames.
        wheel = base.rotate(-30 * f, resample=Image.BICUBIC, center=(cx, cy))
        img = wheel.copy()
        d = ImageDraw.Draw(img)
        ball_angle = math.radians(200 - 28 * f)
        r = 52 if f < 9 else 52 - (f - 8) * 2
        bx = cx + r * math.cos(ball_angle)
        by = cy + r * math.sin(ball_angle)
        d.ellipse([bx - 4, by - 4, bx + 4, by + 4], fill=(255, 255, 255),
                  outline=(120, 120, 120), width=1)
        frames.append(img)
    dest = OUT / "roulette.gif"
    save_looping_gif(frames, dest, 100)
    return dest


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    jobs = [
        # (source, dest, frame duration ms, max px, frame sample)
        # Trophy (142 frames) and fire (45 frames) blow past Discord's
        # 256 KB emoji cap when re-encoded full-frame, so they are
        # frame-sampled and fire is shrunk to 96px.
        ("529977-coin.gif", "coin.gif", 80, SIZE, 1),
        ("30348-trophy-fixed.gif", "trophy.gif", 160, SIZE, 2),
        ("380114-bouncingpresent.gif", "gift.gif", 200, SIZE, 1),
        ("19953-partyballoonsandgifts.gif", "party.gif", 150, SIZE, 1),
        ("391906-fire.gif", "fire.gif", 160, 96, 2),
        ("156016-sparkle.gif", "star.gif", 100, SIZE, 1),
    ]
    for src, dest_name, dur, max_px, sample in jobs:
        dest = normalise(src, dest_name, dur, max_px, sample)
        im = Image.open(dest)
        print(f"{dest.name}: {im.size} frames={getattr(im, 'n_frames', 1)} "
              f"bytes={dest.stat().st_size}")
    for builder in (build_slots, build_roulette):
        dest = builder()
        im = Image.open(dest)
        print(f"{dest.name}: {im.size} frames={getattr(im, 'n_frames', 1)} "
              f"bytes={dest.stat().st_size}")


if __name__ == "__main__":
    main()
