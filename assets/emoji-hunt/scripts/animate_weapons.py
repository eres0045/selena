#!/usr/bin/env python3
"""Animate weapon icons for the uwu Discord bot (Selena) — in-house PIL animation.

Source art: game-icons.net (CC BY 3.0) SVGs, fetched from the official GitHub
mirror (https://github.com/game-icons/icons) because game-icons.net is not
reachable from this VM. Each SVG is recolored to the weapon's material, rendered
to PNG with cairosvg, then animated with PIL (bounce / brightness pulse /
glow pulse, by tier) and saved as a transparent animated GIF <=128x128 and
<256 KiB (Discord emoji limits).

Usage: python3 animate_weapons.py [--force]
Writes GIFs to ../weapons/<snake>.gif and ../manifest-weapons.json.
Re-runnable: skips files that already exist and verify OK unless --force.
"""
import io
import json
import math
import os
import re
import sys
import urllib.request
from collections import Counter

from PIL import Image, ImageEnhance, ImageFilter

try:
    import cairosvg
except ImportError:  # pragma: no cover
    cairosvg = None

BASE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(BASE, "..", "weapons")
MANIFEST = os.path.join(BASE, "..", "manifest-weapons.json")
CACHE = "/tmp/gi_svg_cache"
RAW = "https://raw.githubusercontent.com/game-icons/icons/master/{path}"
PAGE = "https://game-icons.net/1x1/{path}.html"  # path without .svg

AUTHORS = {"lorc": "Lorc", "delapouite": "Delapouite", "willdabeast": "Willdabeast"}

# (roster_name, tier, game-icons path, color, glow color)
ROSTER = [
    # COMMON (20) — bounce only
    ("Wooden Sword", "common", "lorc/pointy-sword.svg", "#8B5A2B", "#8B5A2B"),
    ("Rusty Dagger", "common", "lorc/plain-dagger.svg", "#7A4A21", "#7A4A21"),
    ("Training Bow", "common", "lorc/pocket-bow.svg", "#8B5A2B", "#8B5A2B"),
    ("Pebble Hammer", "common", "lorc/flat-hammer.svg", "#8D8578", "#8D8578"),
    ("Stick Wand", "common", "delapouite/wood-stick.svg", "#7A5230", "#7A5230"),
    ("Blunt Axe", "common", "lorc/battered-axe.svg", "#8A7D6B", "#8A7D6B"),
    ("Leather Whip", "common", "lorc/whip.svg", "#6B4226", "#6B4226"),
    ("Stone Spear", "common", "lorc/stone-spear.svg", "#8D8578", "#8D8578"),
    ("Twig Staff", "common", "lorc/wizard-staff.svg", "#6B4A2A", "#6B4A2A"),
    ("Iron Knife", "common", "lorc/knife-thrust.svg", "#9AA0A6", "#9AA0A6"),
    ("Wooden Club", "common", "delapouite/wood-club.svg", "#8B5A2B", "#8B5A2B"),
    ("Slingshot", "common", "delapouite/slingshot.svg", "#7A5230", "#7A5230"),
    ("Bone Dagger", "common", "lorc/bone-knife.svg", "#E8E0C8", "#E8E0C8"),
    ("Copper Sword", "common", "lorc/broadsword.svg", "#B87333", "#B87333"),
    ("Reed Bow", "common", "delapouite/bow-arrow.svg", "#7A9A4A", "#7A9A4A"),
    ("Clay Hammer", "common", "lorc/claw-hammer.svg", "#B56545", "#B56545"),
    ("Thorn Whip", "common", "lorc/vine-whip.svg", "#4E7A3A", "#4E7A3A"),
    ("Flint Axe", "common", "lorc/stone-axe.svg", "#6E6E6E", "#6E6E6E"),
    ("Wooden Spear", "common", "lorc/thrown-spear.svg", "#8B5A2B", "#8B5A2B"),
    ("Practice Blade", "common", "lorc/piercing-sword.svg", "#B0B6BC", "#B0B6BC"),
    # UNCOMMON (12) — bounce + brightness pulse
    ("Iron Sword", "uncommon", "lorc/broadsword.svg", "#9AA0A6", "#B0C4DE"),
    ("Hunter's Bow", "uncommon", "delapouite/bow-string.svg", "#5A7A3A", "#7A9A4A"),
    ("Oak Staff", "uncommon", "delapouite/crescent-staff.svg", "#6B4A2A", "#8B5A2B"),
    ("Steel Dagger", "uncommon", "lorc/broad-dagger.svg", "#C0C8D0", "#DDE6F0"),
    ("Battle Axe", "uncommon", "lorc/battle-axe.svg", "#A8AEB6", "#C0C8D0"),
    ("Ember Wand", "uncommon", "willdabeast/orb-wand.svg", "#E86A2C", "#FF8C42"),
    ("Frost Dagger", "uncommon", "lorc/plain-dagger.svg", "#7FD4FF", "#A0E8FF"),
    ("War Hammer", "uncommon", "delapouite/warhammer.svg", "#8A8F96", "#B0B6BC"),
    ("Long Spear", "uncommon", "lorc/barbed-spear.svg", "#A8AEB6", "#C0C8D0"),
    ("Shadow Blade", "uncommon", "lorc/crescent-blade.svg", "#6A4A8A", "#9A6AC0"),
    ("Storm Bow", "uncommon", "lorc/lightning-bow.svg", "#F2C14E", "#FFE066"),
    ("Coral Trident", "uncommon", "lorc/trident.svg", "#F08080", "#FFA0A0"),
    # RARE (8) — bounce + glow pulse
    ("Knight's Sword", "rare", "lorc/winged-sword.svg", "#D8D8E0", "#FFF2B0"),
    ("Eagle Bow", "rare", "delapouite/bow-arrow.svg", "#D4A017", "#FFD34D"),
    ("Crystal Staff", "rare", "lorc/crystal-wand.svg", "#7FD4FF", "#A0E8FF"),
    ("Titan Axe", "rare", "delapouite/magic-axe.svg", "#E8A020", "#FFC93C"),
    ("Inferno Blade", "rare", "lorc/energy-sword.svg", "#E83A1E", "#FF6A3C"),
    ("Thunder Hammer", "rare", "delapouite/thor-hammer.svg", "#F2C14E", "#FFE066"),
    ("Venom Fang", "rare", "lorc/dripping-blade.svg", "#4CAF50", "#7FE07F"),
    ("Moon Wand", "rare", "delapouite/lunar-wand.svg", "#C8D8F0", "#E8F0FF"),
    # EPIC (5) — bounce + strong glow + brightness
    ("Dragon Slayer", "epic", "delapouite/two-handed-sword.svg", "#D43A2C", "#FF5A3C"),
    ("Phoenix Bow", "epic", "delapouite/bow-string.svg", "#E84A1E", "#FF8C42"),
    ("Stormcaller Staff", "epic", "lorc/wizard-staff.svg", "#7A5CFF", "#A88CFF"),
    ("Void Dagger", "epic", "lorc/cloak-dagger.svg", "#5A3A8A", "#9A6AC0"),
    ("Frostbrand", "epic", "lorc/shard-sword.svg", "#9FE8FF", "#D0F4FF"),
    # LEGENDARY (3)
    ("Solar Blade", "legendary", "lorc/zeus-sword.svg", "#FFC93C", "#FFE066"),
    ("Moonfang", "legendary", "lorc/crescent-blade.svg", "#C8D8F0", "#E8F0FF"),
    ("Storm King's Axe", "legendary", "lorc/battle-axe.svg", "#FFD34D", "#FFE066"),
    # MYTHIC (1)
    ("Voidreaver", "mythic", "lorc/relic-blade.svg", "#6A4AC0", "#9A6AC0"),
    # UWU-TIER (1)
    ("The UwU Blade", "uwu", "lorc/sparkling-sabre.svg", "#FF7FB0", "#FFA0C8"),
]

SIZE = 128
MAX_BYTES = 262144
FRAMES = 8
# sine bounce offsets (px) — no two consecutive frames identical
BOUNCE = [0, 3, 4, 3, 0, -3, -4, -3]
ICON_PX = {"common": 104, "uncommon": 104, "rare": 108, "epic": 108,
           "legendary": 112, "mythic": 112, "uwu": 112}
GLOW_PEAK = {"common": 0, "uncommon": 0, "rare": 110, "epic": 150,
             "legendary": 170, "mythic": 170, "uwu": 170}
BRIGHT_AMP = {"common": 0.0, "uncommon": 0.08, "rare": 0.05, "epic": 0.12,
              "legendary": 0.12, "mythic": 0.12, "uwu": 0.12}


def snake(name):
    return name.lower().replace("'", "").replace(" ", "_")


def fetch_svg(path):
    os.makedirs(CACHE, exist_ok=True)
    local = os.path.join(CACHE, path.replace("/", "__"))
    if os.path.exists(local):
        return open(local, "rb").read()
    req = urllib.request.Request(RAW.format(path=path),
                                 headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
    open(local, "wb").write(data)
    return data


def colorize(svg_bytes, color):
    """Strip the full-canvas background rect, recolor white icon paths."""
    s = svg_bytes.decode("utf-8")
    s = re.sub(r'<path d="M0 0h512v512H0z"\s*/>', "", s)
    s = re.sub(r'fill="#fff"', 'fill="__C__"', s)
    s = re.sub(r"<path(?![^>]*fill=)", '<path fill="__C__"', s)
    return s.replace("__C__", color).encode("utf-8")


def render_icon(path, color, px):
    svg = colorize(fetch_svg(path), color)
    png = cairosvg.svg2png(bytestring=svg, output_width=px, output_height=px)
    return Image.open(io.BytesIO(png)).convert("RGBA")


def hex2rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def make_frames(icon, tier, glow_rgb):
    px = icon.size[0]
    off = (SIZE - px) // 2
    peak = GLOW_PEAK[tier]
    bright = BRIGHT_AMP[tier]
    frames = []
    # pre-build glow sprite (blurred tinted silhouette)
    glow = None
    if peak:
        alpha = icon.split()[3]
        solid = Image.new("RGBA", icon.size, glow_rgb + (255,))
        solid.putalpha(alpha)
        glow = solid.filter(ImageFilter.GaussianBlur(7))
    for i in range(FRAMES):
        y = BOUNCE[i]
        f = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        if glow is not None:
            a = int(peak * (0.55 + 0.45 * math.sin(2 * math.pi * i / FRAMES)))
            g = glow.copy()
            ga = g.split()[3].point(lambda v: v * a // 255)
            g.putalpha(ga)
            f.alpha_composite(g, (off, off + y))
        ic = icon
        if bright:
            b = 1.0 + bright * math.sin(2 * math.pi * i / FRAMES)
            ic = ImageEnhance.Brightness(icon).enhance(b)
        f.alpha_composite(ic, (off, off + y))
        frames.append(f)
    return frames


def save_gif(frames, out_path, n_frames=FRAMES):
    use = frames[:n_frames]
    use[0].save(out_path, save_all=True, append_images=use[1:],
                duration=110, loop=0, optimize=True)
    return os.path.getsize(out_path)


def verify(path):
    with Image.open(path) as im:
        return {"format": im.format, "size": im.size,
                "frames": getattr(im, "n_frames", 1),
                "bytes": os.path.getsize(path)}


def build(force=False):
    os.makedirs(OUT_DIR, exist_ok=True)
    manifest = []
    stats = Counter()
    for name, tier, icon_path, color, glow in ROSTER:
        fn = snake(name) + ".gif"
        out = os.path.join(OUT_DIR, fn)
        author_dir = icon_path.split("/")[0]
        icon_name = icon_path.split("/")[-1][:-4]
        entry = {
            "roster_name": name,
            "category": "weapon",
            "tier": tier,
            "file": "weapons/" + fn,
            "source_url": PAGE.format(path=f"{author_dir}/{icon_name}"),
            "licence": (f"CC BY 3.0 — game-icons.net, author "
                        f"{AUTHORS.get(author_dir, author_dir)}. "
                        f"Animated in-house with PIL."),
            "bytes": 0, "frames": 0, "animated": False,
        }
        if os.path.exists(out) and not force:
            v = verify(out)
            if (v["format"] == "GIF" and v["size"] == (SIZE, SIZE)
                    and v["frames"] > 1 and v["bytes"] < MAX_BYTES):
                entry.update(bytes=v["bytes"], frames=v["frames"],
                             animated=True)
                manifest.append(entry)
                stats["reused"] += 1
                print(f"  ok (cached) {fn} {v['bytes']}B {v['frames']}f")
                continue
        try:
            icon = render_icon(icon_path, color, ICON_PX[tier])
            frames = make_frames(icon, tier, hex2rgb(glow))
            n = save_gif(frames, out)
            resized = False
            if n >= MAX_BYTES:  # halve frames, then quantize
                n = save_gif(frames, out, n_frames=4)
                resized = True
            if n >= MAX_BYTES:
                raise RuntimeError(f"still {n}B after frame halving")
            v = verify(out)
            entry.update(bytes=v["bytes"], frames=v["frames"], animated=True)
            stats["built"] += 1
            if resized:
                stats["resized"] += 1
            print(f"  ok {fn} {v['bytes']}B {v['frames']}f tier={tier}")
        except Exception as e:  # noqa: BLE001
            entry.update(file=None, bytes=0, frames=0, animated=False,
                         source_url="")
            stats["unmatched"] += 1
            print(f"  FAIL {name}: {e}")
        manifest.append(entry)
    with open(MANIFEST, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"\nbuilt={stats['built']} reused={stats['reused']} "
          f"resized={stats['resized']} unmatched={stats['unmatched']}")
    return manifest


if __name__ == "__main__":
    if cairosvg is None:
        sys.exit("cairosvg is required (pip install cairosvg)")
    build(force="--force" in sys.argv)
