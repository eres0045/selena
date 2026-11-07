#!/usr/bin/env python3
"""Preprocess uwu Discord bot profile backgrounds.

Worker A — re-runnable end to end:
  1. Downloads every source (Tenor GIFs / Wallhaven wallpapers) into a cache
     dir (default /tmp/uwu_bgs_cache; skipped when already present).
  2. Cover-crops/resizes every background to exactly 800x500 px.
  3. Animated GIFs: sampled to <=24 frames, palette <=128 colours,
     <2MB target with a 5MB hard cap (retries with fewer frames/colours).
  4. Static images: saved as JPEG quality 88 (stepped down if >2MB).
  5. Generates default.png locally (dark purple/navy gradient + starfield).
  6. Writes manifest.json + SOURCES.md next to the outputs.

Usage:
    python3 scripts/preprocess_profile_bgs.py [--out assets/profile-bgs]
"""
import argparse
import json
import math
import os
import random
import subprocess
import sys
import urllib.parse

from PIL import Image

TARGET_W, TARGET_H = 800, 500
MAX_FRAMES = 24
MAX_COLORS = 128
TARGET_BYTES = 2 * 1024 * 1024
HARD_CAP_BYTES = 5 * 1024 * 1024
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"

# (id, name, type, price_gold, source_url, source_page)
ENTRIES = [
    # ---- 10 STATIC (cheap: 10,000-20,000) ----
    ("neon-street", "Neon Street", "static", 20000,
     "https://w.wallhaven.cc/full/po/wallhaven-pomqg9.jpg", "https://wallhaven.cc/w/pomqg9"),
    ("rainy-street", "Rainy Street", "static", 18000,
     "https://w.wallhaven.cc/full/gw/wallhaven-gwvzy7.png", "https://wallhaven.cc/w/gwvzy7"),
    ("ocean-sunset", "Ocean Sunset", "static", 18000,
     "https://w.wallhaven.cc/full/k8/wallhaven-k8jeqm.png", "https://wallhaven.cc/w/k8jeqm"),
    ("snowy-village", "Snowy Village", "static", 18000,
     "https://w.wallhaven.cc/full/gw/wallhaven-gw1e3d.png", "https://wallhaven.cc/w/gw1e3d"),
    ("galaxy-drift", "Galaxy Drift", "static", 17000,
     "https://w.wallhaven.cc/full/1q/wallhaven-1qoej1.png", "https://wallhaven.cc/w/1qoej1"),
    ("sakura-path", "Sakura Path", "static", 16000,
     "https://w.wallhaven.cc/full/9o/wallhaven-9okqyw.jpg", "https://wallhaven.cc/w/9okqyw"),
    ("eclipse-blade", "Eclipse Blade", "static", 16000,
     "https://w.wallhaven.cc/full/ml/wallhaven-mloe19.png", "https://wallhaven.cc/w/mloe19"),
    ("lotus-rain", "Lotus Rain", "static", 15000,
     "https://w.wallhaven.cc/full/d8/wallhaven-d8vjom.png", "https://wallhaven.cc/w/d8vjom"),
    ("beach-day", "Beach Day", "static", 14000,
     "https://w.wallhaven.cc/full/rq/wallhaven-rqexm7.jpg", "https://wallhaven.cc/w/rqexm7"),
    ("autumn-leaves", "Autumn Leaves", "static", 12000,
     "https://w.wallhaven.cc/full/9o/wallhaven-9oky71.jpg", "https://wallhaven.cc/w/9oky71"),
    # ---- 20 ANIMATED (expensive: 25,000-50,000, scaled by effect) ----
    ("starry-space", "Starry Space", "animated", 48000,
     "https://media.tenor.com/02Y4uGZPKPQAAAAd/night-sky-stars.gif",
     "https://tenor.com/search/anime-space-stars-galaxy-gifs"),
    ("cloud-sea", "Cloud Sea", "animated", 48000,
     "https://media.tenor.com/-2KMbS1XrKUAAAAd/heythatme-cloud.gif",
     "https://tenor.com/search/anime-clouds-sky-floating-gifs"),
    ("comet-night", "Comet Night", "animated", 45000,
     "https://media.tenor.com/2PoAn8rF-OAAAAAd/night-sky-night.gif",
     "https://tenor.com/search/fireworks-anime-sky-night-gifs"),
    ("waterfall-valley", "Waterfall Valley", "animated", 45000,
     "https://media.tenor.com/04hLpaOWYN4AAAAd/waterfall-anime.gif",
     "https://tenor.com/search/anime-waterfall-river-gifs"),
    ("flower-field", "Flower Field", "animated", 45000,
     "https://media.tenor.com/-GAX-e1bgfUAAAAd/petals-flowers.gif",
     "https://tenor.com/search/anime-flower-field-spring-gifs"),
    ("forest-spirit", "Forest Spirit", "animated", 42000,
     "https://media.tenor.com/-Os48QY_xEIAAAAd/studio-ghibli-aesthetic.gif",
     "https://tenor.com/search/anime-forest-ghibli-gifs"),
    ("golden-sunset", "Golden Sunset", "animated", 40000,
     "https://media.tenor.com/0qBG1Yxjh1UAAAAd/love-live-sunset.gif",
     "https://tenor.com/search/anime-sunset-sky-gifs"),
    ("neon-city", "Neon City", "animated", 40000,
     "https://media.tenor.com/2FIMeyZLsD8AAAAd/anime-1980s.gif",
     "https://tenor.com/search/anime-city-night-street-neon-lights-gifs"),
    ("aquarium-night", "Aquarium Night", "animated", 38000,
     "https://media.tenor.com/0b1Wwm8BTeUAAAAd/anime-anime-coffee.gif",
     "https://tenor.com/search/cyberpunk-anime-rain-city-gifs"),
    ("stargazing-night", "Stargazing Night", "animated", 38000,
     "https://media.tenor.com/05u1G7_UlLcAAAAd/anime-love.gif",
     "https://tenor.com/search/anime-desert-night-stars-gifs"),
    ("sakura-dreams", "Sakura Dreams", "animated", 35000,
     "https://media.tenor.com/1Jxk2tD-H9MAAAAd/teleport-guy.gif",
     "https://tenor.com/search/anime-sakura-cherry-blossom-gifs"),
    ("starry-sleep", "Starry Sleep", "animated", 35000,
     "https://media.tenor.com/-KLOoR7ZU0wAAAAd/anime-sleeping.gif",
     "https://tenor.com/search/anime-train-night-gifs"),
    ("twilight-bloom", "Twilight Bloom", "animated", 35000,
     "https://media.tenor.com/2SPaMvRXcZcAAAAd/anime-another.gif",
     "https://tenor.com/search/anime-moon-lake-night-landscape-gifs"),
    ("cloudy-night", "Cloudy Night", "animated", 35000,
     "https://media.tenor.com/-GmDy8jpYrIAAAAd/night-time-anime.gif",
     "https://tenor.com/search/anime-aurora-borealis-night-sky-gifs"),
    ("beach-sunset", "Beach Sunset", "animated", 32000,
     "https://media.tenor.com/0ifoirdcDi8AAAAd/anime-sunset.gif",
     "https://tenor.com/search/anime-mountain-sunrise-scenery-gifs"),
    ("crimson-sun", "Crimson Sun", "animated", 32000,
     "https://media.tenor.com/-RNOB5xDZ5gAAAAd/sunset.gif",
     "https://tenor.com/search/anime-torii-gate-shrine-sunset-gifs"),
    ("night-balcony", "Night Balcony", "animated", 30000,
     "https://media.tenor.com/4wuIR3sMYjoAAAAd/waiting-vrchat.gif",
     "https://tenor.com/search/anime-rain-window-gifs"),
    ("rainy-village", "Rainy Village", "animated", 30000,
     "https://media.tenor.com/0Qyw1jwj7NcAAAAd/aesthetic-anime.gif",
     "https://tenor.com/search/anime-city-night-neon-gifs"),
    ("winter-snow", "Winter Snow", "animated", 30000,
     "https://media.tenor.com/2Aw1_npXU-QAAAAd/wintersnight-winter.gif",
     "https://tenor.com/search/ghibli-snow-winter-gifs"),
    ("ocean-waves-ride", "Ocean Waves Ride", "animated", 25000,
     "https://media.tenor.com/3dMG23W7vsYAAAAd/taku-morisaki-ocean-waves.gif",
     "https://tenor.com/search/anime-ocean-beach-waves-gifs"),
]

DEFAULT_ENTRY = ("default", "Default", "static", 0, "", "")


def cache_path(cache_dir, entry_id, url):
    ext = os.path.splitext(urllib.parse.urlparse(url).path)[1].lower() or ".bin"
    return os.path.join(cache_dir, entry_id + ext)


def download(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 1000:
        return True
    r = subprocess.run(["curl", "-sL", "-A", UA, "--max-time", "120", url, "-o", dest],
                       capture_output=True, text=True)
    return os.path.exists(dest) and os.path.getsize(dest) > 1000


def cover_resize(im, w=TARGET_W, h=TARGET_H):
    """Cover-crop/resize an RGB image to exactly w x h."""
    iw, ih = im.size
    s = max(w / iw, h / ih)
    im = im.resize((max(1, int(iw * s + 0.5)), max(1, int(ih * s + 0.5))), Image.LANCZOS)
    x = (im.width - w) // 2
    y = (im.height - h) // 2
    return im.crop((x, y, x + w, y + h))


def process_gif(src, out_path):
    """Sample frames, cover-crop to 800x500, palette<=128. Returns (frames, bytes, config)."""
    im = Image.open(src)
    n = getattr(im, "n_frames", 1)
    if n < 2:
        raise ValueError(f"not animated: {n} frame(s)")
    durations = []
    for i in range(n):
        im.seek(i)
        durations.append(im.info.get("duration", 100) or 100)
    total_ms = sum(durations)
    # Evenly sample source frame indices.
    for max_frames, colors in ((24, 128), (20, 128), (16, 96), (12, 64), (8, 64)):
        k = min(n, max_frames)
        idx = [round(i * (n - 1) / (k - 1)) if k > 1 else 0 for i in range(k)]
        idx = sorted(set(idx))
        k = len(idx)
        frame_dur = max(20, total_ms // k)
        frames = []
        for j in idx:
            im.seek(j)
            f = cover_resize(im.convert("RGB"))
            q = f.quantize(colors=colors, method=Image.MEDIANCUT,
                           dither=Image.FLOYDSTEINBERG)
            # quantize() copies the source frame's info, incl. a
            # 'transparency' tuple that breaks Pillow's GIF writer
            # ("Transparency for P mode should be bytes or int").
            q.info.pop("transparency", None)
            frames.append(q)
        frames[0].save(out_path, save_all=True, append_images=frames[1:],
                       duration=frame_dur, loop=0, optimize=True, disposal=2)
        size = os.path.getsize(out_path)
        if size <= TARGET_BYTES or (max_frames, colors) == (8, 64):
            return k, size, (max_frames, colors)
    raise ValueError("unreachable")


def process_static(src, out_path):
    im = Image.open(src).convert("RGB")
    im = cover_resize(im)
    for q in (88, 80, 70, 60):
        im.save(out_path, "JPEG", quality=q, optimize=True)
        if os.path.getsize(out_path) <= TARGET_BYTES or q == 60:
            return os.path.getsize(out_path), q
    raise ValueError("unreachable")


def make_default(out_path):
    rng = random.Random(7)
    w, h = TARGET_W, TARGET_H
    top = (13, 11, 38)      # deep navy
    mid = (32, 18, 64)      # dark purple
    bot = (58, 26, 96)      # violet
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = y / (h - 1)
        if t < 0.5:
            a, b, f = top, mid, t / 0.5
        else:
            a, b, f = mid, bot, (t - 0.5) / 0.5
        col = tuple(int(a[i] + (b[i] - a[i]) * f) for i in range(3))
        for x in range(w):
            px[x, y] = col
    # subtle radial glow, upper-centre
    cx, cy, r = int(w * 0.62), int(h * 0.32), 260
    for y in range(h):
        for x in range(w):
            d = math.hypot(x - cx, y - cy) / r
            if d < 1:
                g = int(28 * (1 - d) * (1 - d))
                r0, g0, b0 = px[x, y]
                px[x, y] = (min(255, r0 + g), min(255, g0 + g // 2), min(255, b0 + g))
    # starfield + faint noise
    for _ in range(420):
        x, y = rng.randrange(w), rng.randrange(h)
        v = rng.choice((140, 180, 220, 255))
        s = rng.choice((1, 1, 1, 2))
        for dx in range(s):
            for dy in range(s):
                if x + dx < w and y + dy < h:
                    px[x + dx, y + dy] = (v, v, min(255, v + 20))
    for _ in range(6000):
        x, y = rng.randrange(w), rng.randrange(h)
        r0, g0, b0 = px[x, y]
        n = rng.randint(-6, 6)
        px[x, y] = (max(0, min(255, r0 + n)), max(0, min(255, g0 + n)),
                    max(0, min(255, b0 + n)))
    img.save(out_path, "PNG", optimize=True)
    return os.path.getsize(out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="assets/profile-bgs")
    ap.add_argument("--cache", default="/tmp/uwu_bgs_cache")
    args = ap.parse_args()
    out_dir = args.out
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(args.cache, exist_ok=True)

    manifest = []
    report = []

    # default first
    default_path = os.path.join(out_dir, "default.png")
    dsize = make_default(default_path)
    manifest.append({"id": "default", "name": "Default", "type": "static",
                     "file": "default.png", "price": 0, "source_url": ""})
    report.append(f"default: static PNG 800x500 {dsize} bytes (generated locally)")
    print(report[-1])

    for entry_id, name, typ, price, url, page in ENTRIES:
        src = cache_path(args.cache, entry_id, url)
        if not download(url, src):
            print(f"FAIL download {entry_id}: {url}", file=sys.stderr)
            sys.exit(1)
        with open(src, "rb") as f:
            magic = f.read(6)
        if typ == "animated" and magic not in (b"GIF89a", b"GIF87a"):
            print(f"FAIL {entry_id}: not a GIF (magic {magic!r})", file=sys.stderr)
            sys.exit(1)
        if typ == "animated":
            out_path = os.path.join(out_dir, entry_id + ".gif")
            frames, size, cfg = process_gif(src, out_path)
            if size > HARD_CAP_BYTES:
                print(f"FAIL {entry_id}: {size} bytes > 5MB hard cap", file=sys.stderr)
                sys.exit(1)
            manifest.append({"id": entry_id, "name": name, "type": typ,
                             "file": entry_id + ".gif", "price": price, "source_url": url})
            report.append(f"{entry_id}: animated GIF {frames} frames 800x500 "
                          f"{size} bytes (frames<={cfg[0]}, colors<={cfg[1]})")
        else:
            out_path = os.path.join(out_dir, entry_id + ".jpg")
            size, q = process_static(src, out_path)
            if size > HARD_CAP_BYTES:
                print(f"FAIL {entry_id}: {size} bytes > 5MB hard cap", file=sys.stderr)
                sys.exit(1)
            manifest.append({"id": entry_id, "name": name, "type": typ,
                             "file": entry_id + ".jpg", "price": price, "source_url": url})
            report.append(f"{entry_id}: static JPG 800x500 {size} bytes (quality {q})")
        print(report[-1])

    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    lines = ["# Profile Background Sources",
             "",
             "Every background shipped in this folder, its source, and its licence basis.",
             "All GIFs are freely shared Tenor GIFs (Tenor share links); all static images",
             "are freely shared anime wallpapers from Wallhaven (user-uploaded, SFW).",
             "No paid stock, no watermarked stock, no logo-only images.",
             "",
             "| ID | Name | Type | Price (gold) | Source | Licence basis |",
             "| --- | --- | --- | ---: | --- | --- |"]
    for (entry_id, name, typ, price, url, page) in ENTRIES:
        basis = "Freely shared GIF via Tenor" if typ == "animated" else "Freely shared wallpaper via Wallhaven"
        lines.append(f"| {entry_id} | {name} | {typ} | {price} | [{url}]({url}) (found: {page}) | {basis} |")
    lines += ["| default | Default | static | 0 | — (generated locally with PIL) | Original, generated locally |",
              "",
              "All files are cover-cropped/resized to 800x500 px by",
              "`scripts/preprocess_profile_bgs.py` (re-runnable)."]
    with open(os.path.join(out_dir, "SOURCES.md"), "w") as f:
        f.write("\n".join(lines) + "\n")

    total = sum(os.path.getsize(os.path.join(out_dir, fn))
                for fn in os.listdir(out_dir))
    print(f"\nDONE: {len(manifest)} manifest entries "
          f"({len(ENTRIES)} buyable + default), total dir size {total} bytes "
          f"({total / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
