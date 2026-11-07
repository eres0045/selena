"""Currency emoji candidates for uwu's gold (replacing the spinning coin).

Two PIL originals, same style as the other animated emoji:
  goldbar.gif — a gold ingot with a shine sweeping across it
  gem.gif     — a faceted gem with twinkling sparkles
128x128, looping, transparent background. Existing star.gif is the 3rd candidate.
"""
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
from render_animated_emoji import save_looping_gif  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "emoji-animated"
SIZE = 128
FRAMES = 12


def goldbar_frames():
    frames = []
    for i in range(FRAMES):
        img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        # wide ingot: top face + front face, ~2.2:1 wide:high
        top = [(30, 50), (98, 50), (88, 64), (40, 64)]
        front = [(40, 64), (88, 64), (100, 94), (28, 94)]
        d.polygon(top, fill=(255, 223, 110, 255), outline=(176, 124, 0, 255))
        d.polygon(front, fill=(232, 178, 32, 255), outline=(176, 124, 0, 255))
        # shine band sweeping left -> right, clipped inside the front face
        t = i / FRAMES
        x = 34 + t * 56
        # front face edges slope outwards as y grows: left edge x goes 40->28,
        # right edge 88->100 between y 64 and 94
        def clamp_band(y):
            lx = 40 - (y - 64) * 12 / 30
            rx = 88 + (y - 64) * 12 / 30
            return lx, rx
        for y0, y1 in [(64, 79), (79, 94)]:
            lx0, rx0 = clamp_band(y0)
            lx1, rx1 = clamp_band(y1)
            bx0 = max(x, lx0)
            bx1 = min(x + 10, rx0)
            bx2 = min(x + 18, rx1)
            bx3 = max(x + 8, lx1)
            if bx1 > bx0 and bx2 > bx3:
                d.polygon([(bx0, y0), (bx1, y0), (bx2, y1), (bx3, y1)],
                          fill=(255, 248, 200, 170))
        # stamped mark on the top face
        d.ellipse([59, 53, 69, 61], outline=(176, 124, 0, 255), width=2)
        frames.append(img)
    return frames


def sparkle(d, x, y, r, alpha):
    """4-point star sparkle."""
    pts = [(x, y - r), (x + r * 0.28, y - r * 0.28), (x + r, y),
           (x + r * 0.28, y + r * 0.28), (x, y + r),
           (x - r * 0.28, y + r * 0.28), (x - r, y),
           (x - r * 0.28, y - r * 0.28)]
    d.polygon(pts, fill=(255, 255, 255, alpha))


def gem_frames():
    frames = []
    for i in range(FRAMES):
        img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        # diamond: crown (top) + pavilion (bottom point)
        crown = [(30, 52), (98, 52), (84, 34), (44, 34)]
        left_facet = [(30, 52), (64, 52), (64, 104)]
        right_facet = [(98, 52), (64, 52), (64, 104)]
        d.polygon(crown, fill=(125, 211, 252, 255), outline=(255, 255, 255, 255))
        d.polygon(left_facet, fill=(56, 189, 248, 255), outline=(255, 255, 255, 255))
        d.polygon(right_facet, fill=(14, 165, 233, 255), outline=(255, 255, 255, 255))
        # table highlight
        d.polygon([(48, 38), (80, 38), (74, 48), (54, 48)], fill=(224, 242, 254, 255))
        # two small twinkles close to the gem, phase-shifted
        for (sx, sy, ph) in [(30, 34, 0), (100, 60, 6)]:
            a = int(255 * max(0, math.sin(math.pi * ((i + ph) % FRAMES) / FRAMES)))
            if a > 20:
                sparkle(d, sx, sy, 7, a)
        frames.append(img)
    return frames


if __name__ == "__main__":
    save_looping_gif(goldbar_frames(), OUT / "goldbar.gif", 120)
    save_looping_gif(gem_frames(), OUT / "gem.gif", 120)
    for name in ("goldbar.gif", "gem.gif"):
        im = Image.open(OUT / name)
        print(name, im.size, "frames:", getattr(im, "n_frames", 1),
              "bytes:", (OUT / name).stat().st_size)
