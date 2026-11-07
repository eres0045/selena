"""Build Selena's VISUAL casino games (Ronit: 'not text-based — let the
user SEE the flip/spin/reveal, then the result').

Blackjack/high-low are already visual (card flip strips) and are NOT
touched. This script builds the assets for the other four games:

  * coinflip — flip.gif: a real TOSS, like a camera filming it — the
    coin goes UP, gets BIG as it comes toward the viewer, comes DOWN
    spinning fast, and the view zooms in close as it lands edge-on
    (neutral — the face is revealed by the edit to heads/tails.png).
    heads.png / tails.png: the landed face on a WIDE canvas, the coin
    ~330px so it displays ~160px on a phone (NOT a tight close-up
    that fills the frame — that was the old too-big version). Both
    faces are PIL-drawn (the emoji.gg $ face carries a faint stock
    watermark that shows at 320px, so heads is a clean redrawn $
    disc in the same style; tails is a star-emboss disc).
  * slots — spin.gif: the machine with all three reels scrolling
    (seamless loop, never settles on a combination); machine.gif: the
    machine frame with TRANSPARENT reel windows; tiles/<key>.gif: one
    75x85 reel tile per symbol (Twemoji art, CC-BY, + a PIL "7").
    The settled strip is composed at reply time by src/lib/visualgames.ts
    from the real spin result — never a canned 7-7-7.
  * roulette — spin.gif: the 37-pocket European wheel spinning with the
    ball orbiting; wheel-<nn>.png: one settled wheel per number (0-36)
    with the ball on the ACTUAL winning pocket. Wheel order is the
    canonical European clockwise order from 0, verified against
    multiple published references:
    0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,
    20,14,31,9,22,18,29,7,28,12,35,3,26.
    Pocket i is centred at angle -90 + (i+0.5)*360/37 degrees (PIL
    convention: 0 deg = 3 o'clock, positive = clockwise, so pocket 0
    sits at the top). src/lib/visualgames.ts mirrors this exactly.
  * scratch — tiles/<key>.gif: revealed symbol tiles (teal card +
    gold border); tiles/cover.gif: the covered foil tile ("?"). The
    settled strip is composed at reply time from the real draw; the
    suspense strip is the same three tiles covered.

Every asset has a TRANSPARENT background (the standing bg rule):
nothing is shipped without compositing it on Discord dark (#313338)
first — see verify_contact_sheet() at the end, which the author must
VIEW before committing.

SMALL ON SCREEN (Ronit 2026-11-07, twice): Discord on a phone
stretches EVERY attached image to the full message width (~340px)
no matter how small the file is — so shrinking the FILE 700px ->
240px did NOT shrink the display, it just made it blurrier. The
fix is to shrink the ART inside a WIDE transparent canvas: every
visual ships on a ~700px-wide canvas with the art drawn small and
centred in it, so when Discord stretches the canvas to message
width the art itself displays at only ~150-220px. (Same mechanism
as the v7 card strips: 100px cards inside a 700px strip.) All art
is still rendered at 2x+ and Lanczos-downscaled with an unsharp
pass, so it stays crisp. If a visual can't stay readable small,
prefer a tighter crop/zoom on the important part over bigger art.

Ship sizes (canvas size = what src/lib/visualgames.ts expects):
coin 700x280 (coin art <= 340px -> ~165px on screen), slots
700x280 (machine art 350x230 -> ~170px), roulette 700x500
(wheel art 606x485, wheel 450px -> ~219px), scratch 700x150
(tiles 110x127 -> ~53px); slots tiles 75x85, scratch tiles 110x127.

Usage: python3 scripts/render_visual_games.py
Writes: assets/games/** (+ assets/games/verify/contact-sheet.png)
"""
import math
import sys
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gifutil import _quantize_frame, save_transparent_gif  # noqa: E402
from render_animated_emoji import decode_gif_frames, save_looping_gif  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
GAMES = ROOT / "assets" / "games"
TWEMOJI_DIR = GAMES / "twemoji"
VERIFY = GAMES / "verify"
EMOJI_DIR = ROOT / "assets" / "emoji-animated"

FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
DARK = (49, 51, 56, 255)  # Discord dark, for the verify sheet
GOLD = (255, 201, 60)
PURPLE_BODY = (59, 45, 92)
RED_MARQUEE = (230, 57, 70)

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

TWEMOJI = {
    # symbol -> (twemoji codepoint file, PIL fallback kind)
    "🍒": ("1f352", "cherry"),
    "🍋": ("1f34b", "lemon"),
    "🍇": ("1f347", "grape"),
    "🔔": ("1f514", "bell"),
    "⭐": ("2b50", "star"),
    "💎": ("1f48e", "diamond"),
    "🍀": ("1f340", "clover"),
    "7️⃣": (None, "seven"),  # no keycap-7 file in twemoji 14.0.2 — PIL "7"
}

SLOT_ORDER = ["🍒", "🍋", "🍇", "🔔", "⭐", "💎", "🍀", "7️⃣"]
SLOT_KEYS = {"🍒": "cherry", "🍋": "lemon", "🍇": "grape", "🔔": "bell",
             "⭐": "star", "💎": "diamond", "🍀": "clover", "7️⃣": "seven"}
SCRATCH_SYMBOLS = ["🍒", "⭐", "💎", "7️⃣"]

RED_NUMBERS = {1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36}
WHEEL_ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23,
               10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26]


def hard_alpha(img: Image.Image, threshold: int = 128) -> Image.Image:
    """RGBA image with its alpha forced to a hard 0/255 edge (no halo)."""
    r = img.convert("RGBA")
    a = r.getchannel("A").point(lambda v: 255 if v >= threshold else 0)
    r.putalpha(a)
    return r


def ship(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Downscale a 2x+ render to its ship size: Lanczos + unsharp on
    RGB only (alpha is resized untouched, so no halo creeps in)."""
    from PIL import ImageFilter

    small = img.resize(size, Image.LANCZOS)
    rgb = small.convert("RGB").filter(
        ImageFilter.UnsharpMask(radius=2, percent=60, threshold=2))
    out = rgb.convert("RGBA")
    out.putalpha(small.getchannel("A"))
    return out


def ship_frames(frames: list[Image.Image], size: tuple[int, int]) -> list[Image.Image]:
    return [ship(f, size) for f in frames]


def ship_padded(img: Image.Image, art_size: tuple[int, int],
                canvas_size: tuple[int, int]) -> Image.Image:
    """Downscale a render to its ART size, then centre it on a WIDE
    transparent canvas. Discord stretches the whole canvas to message
    width, so the art displays at art/canvas of that width — this is
    what actually makes a visual look small on a phone."""
    small = ship(img, art_size)
    canvas = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    canvas.alpha_composite(small, ((canvas_size[0] - art_size[0]) // 2,
                                   (canvas_size[1] - art_size[1]) // 2))
    return canvas


# Ship sizes: wide canvases, small centred art (see docstring).
# Displayed art on a ~340px phone bubble ≈ art_px / canvas_px * 340.
COIN_SHIP = (700, 280)          # coin art <= 340px -> ~165px on screen
SLOTS_SHIP = (700, 280)         # machine art 350x230 -> ~170px on screen
SLOTS_ART = (350, 230)
SLOTS_TILE_SHIP = (75, 85)
ROULETTE_SHIP = (700, 500)      # wheel art 450px -> ~219px on screen
ROULETTE_ART = (606, 485)
SCRATCH_SHIP = (700, 150)       # tiles 110x127 -> ~53px on screen
SCRATCH_TILE_SHIP = (110, 127)


def fetch_twemoji() -> dict[str, Path]:
    """Download the Twemoji PNGs we need (72x72, CC-BY 4.0). Cached in repo."""
    TWEMOJI_DIR.mkdir(parents=True, exist_ok=True)
    out: dict[str, Path] = {}
    for sym, (code, _kind) in TWEMOJI.items():
        if code is None:
            continue
        dest = TWEMOJI_DIR / f"{code}.png"
        if not dest.exists():
            url = f"https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/{code}.png"
            req = urllib.request.Request(url, headers={"User-Agent": "SelenaBot/1.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                dest.write_bytes(resp.read())
        im = Image.open(dest)
        assert im.size == (72, 72), f"{dest} unexpected size {im.size}"
        out[sym] = dest
    return out


def _star_points(cx: float, cy: float, r_out: float, r_in: float, n: int = 5):
    pts = []
    for i in range(2 * n):
        r = r_out if i % 2 == 0 else r_in
        a = -math.pi / 2 + i * math.pi / n
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def draw_twemoji_symbol(draw: ImageDraw.ImageDraw, img: Image.Image,
                        twemoji: dict[str, Path], sym: str, cx: int, cy: int,
                        size: int) -> None:
    """Paste a Twemoji PNG centred at (cx, cy), or draw the PIL '7'."""
    if sym == "7️⃣":
        font = ImageFont.truetype(FONT_BOLD, size)
        draw.text((cx, cy), "7", font=font, fill=(220, 20, 60), anchor="mm",
                  stroke_width=max(2, size // 25), stroke_fill=(120, 0, 10))
        return
    art = Image.open(twemoji[sym]).convert("RGBA").resize((size, size), Image.LANCZOS)
    img.alpha_composite(art, (cx - size // 2, cy - size // 2))


# ---------------------------------------------------------------------------
# Coinflip — big spin + landed faces
# ---------------------------------------------------------------------------

COIN_W, COIN_H = 1400, 560  # render canvas = exactly 2x the 700x280 ship size
COIN_CX, COIN_CY = COIN_W // 2, COIN_H // 2
COIN_CLOSE_D = 660  # landed coin diameter (render px -> 330 shipped, ~160px on screen)


def draw_heads_disc(d: int = COIN_CLOSE_D) -> Image.Image:
    """Heads: a clean PIL $ coin (same disc construction as tails).

    NOTE: the emoji.gg $ face (assets/emoji-animated/coin.gif) carries a
    faint stock watermark across the $ — invisible at 22px emoji size,
    but plainly visible once the face is shown 320px big as the landed
    coin. So heads is drawn clean here instead of reusing that art; the
    disc matches the tails disc so both sides read as one coin.
    All measurements scale with `d` (the disc is drawn at any size,
    from the small mid-toss coin to the tight close-up).
    """
    img = Image.new("RGBA", (d, d), (0, 0, 0, 0))
    dr = ImageDraw.Draw(img)
    c = d // 2
    rim = max(2, d // 40)
    dr.ellipse([0, 0, d - 1, d - 1], fill=(212, 175, 55), outline=(150, 110, 20), width=rim)
    inset = max(2, d // 23)
    dr.ellipse([inset, inset, d - 1 - inset, d - 1 - inset], fill=(240, 200, 80),
               outline=(200, 160, 50), width=max(1, d // 100))
    dr.ellipse([d // 11, d // 16, d - 1 - d // 11, d - 1 - d // 5], fill=(255, 220, 130))
    # Embossed $: light highlight offset up-left, dark gold face on top.
    font = ImageFont.truetype(FONT_BOLD, int(d * 0.656))
    dr.text((c - d // 100, c - d // 80), "$", font=font, fill=(255, 225, 140), anchor="mm")
    dr.text((c, c), "$", font=font, fill=(185, 145, 35), anchor="mm",
            stroke_width=max(1, d // 80), stroke_fill=(130, 95, 15))
    return hard_alpha(img)


def draw_tails_disc(d: int = COIN_CLOSE_D) -> Image.Image:
    """Tails: a gold disc with a star emboss — unmistakable vs heads."""
    img = Image.new("RGBA", (d, d), (0, 0, 0, 0))
    dr = ImageDraw.Draw(img)
    c = d // 2
    # Disc: darker rim, bright face, subtle top-light.
    rim = max(2, d // 40)
    dr.ellipse([0, 0, d - 1, d - 1], fill=(212, 175, 55), outline=(150, 110, 20), width=rim)
    inset = max(2, d // 23)
    dr.ellipse([inset, inset, d - 1 - inset, d - 1 - inset], fill=(240, 200, 80),
               outline=(200, 160, 50), width=max(1, d // 100))
    dr.ellipse([d // 11, d // 16, d - 1 - d // 11, d - 1 - d // 5], fill=(255, 220, 130))
    # Star emboss: darker bronze star + a lighter star offset up-left.
    star = _star_points(c - max(1, d // 160), c - max(1, d // 160),
                        int(d * 0.3125), int(d * 0.131))
    dr.polygon(star, fill=(255, 225, 140))
    star = _star_points(c, c, int(d * 0.3125), int(d * 0.131))
    dr.polygon(star, fill=(176, 138, 32), outline=(120, 90, 20))
    return hard_alpha(img)


def build_coinflip(face: Image.Image) -> tuple[Path, Path, Path]:
    """A real toss, like a camera filming it (Ronit 2026-11-07).

    16 frames x 75ms = 1.2s per toss, looping through the ~2.4s
    suspense: the coin rises from the bottom, gets BIG as it comes
    toward the viewer, comes DOWN spinning fast, and the view zooms
    in close as it lands — ending EDGE-ON (a thin gold sliver), so
    the toss never leaks the result; the edit to heads/tails.png is
    the tight close-up that shows what it landed on.
    """
    out = GAMES / "coinflip"
    out.mkdir(parents=True, exist_ok=True)
    # Landed faces: the coin ~330px on the 700x280 canvas — small on
    # screen (~160px on a phone), but the $ / star still read clearly.
    heads = Image.new("RGBA", (COIN_W, COIN_H), (0, 0, 0, 0))
    heads.alpha_composite(face, ((COIN_W - COIN_CLOSE_D) // 2,
                                 (COIN_H - COIN_CLOSE_D) // 2))
    heads_path = out / "heads.png"
    ship(heads, COIN_SHIP).save(heads_path)
    tails_img = draw_tails_disc()
    tails = Image.new("RGBA", (COIN_W, COIN_H), (0, 0, 0, 0))
    tails.alpha_composite(tails_img, ((COIN_W - COIN_CLOSE_D) // 2,
                                      (COIN_H - COIN_CLOSE_D) // 2))
    tails_path = out / "tails.png"
    ship(tails, COIN_SHIP).save(tails_path)
    # Toss keyframes (render px, canvas 1400x560): (centre-y, diameter).
    # Ship px are half these: the coin rises from the bottom (410,300),
    # gets BIG toward the viewer (peak 288 ship px at the top, ~140px on
    # screen, looming past the top edge), falls spinning fast, and lands
    # edge-on at the centre. The y values keep the coin inside the
    # frame except for the deliberate top-clip at the peak.
    keys = [
        (410, 300), (360, 374), (288, 450), (220, 512), (160, 562), (120, 576),
        (148, 538), (208, 488), (280, 438), (340, 400), (370, 374), (370, 374),
        (370, 438), (348, 524), (308, 612), (280, 660),
    ]
    frames: list[Image.Image] = []
    for i, (cy, d) in enumerate(keys):
        phase = i * 1.9  # fast spin (~4.5 revolutions over the toss)
        w = max(6, round(d * abs(math.cos(phase))))
        if i >= 14:
            w = 8  # lands edge-on: a thin gold sliver, face hidden
        squashed = hard_alpha(face.resize((w, d), Image.LANCZOS))
        canvas = Image.new("RGBA", (COIN_W, COIN_H), (0, 0, 0, 0))
        canvas.alpha_composite(squashed, (COIN_CX - w // 2, int(cy) - d // 2))
        frames.append(canvas)
    flip_path = out / "flip.gif"
    save_looping_gif(ship_frames(frames, COIN_SHIP), flip_path, 75)
    return flip_path, heads_path, tails_path


# ---------------------------------------------------------------------------
# Slots — machine frame, symbol tiles, spinning reels
# ---------------------------------------------------------------------------

SLOTS_W, SLOTS_H = 700, 460
SLOT_WINDOWS = [(85, 120), (275, 120), (465, 120)]  # (x, y) of each reel window
SLOT_WIN_W, SLOT_WIN_H = 150, 170
SLOT_CELL = 170  # one symbol cell in the scrolling reel strip


def draw_slots_body(draw: ImageDraw.ImageDraw, frame: int = 0, lever_down: bool = False) -> None:
    """Machine body + marquee + lever + tray. Reel windows are left for
    the caller (frame version leaves them transparent, spin fills them)."""
    # Body
    draw.rounded_rectangle([40, 30, 660, 430], radius=16, fill=PURPLE_BODY,
                           outline=GOLD, width=5)
    # Marquee
    draw.rounded_rectangle([190, 6, 510, 54], radius=10, fill=RED_MARQUEE,
                           outline=GOLD, width=3)
    font = ImageFont.truetype(FONT_BOLD, 28)
    draw.text((350, 30), "SLOTS", font=font, fill=(255, 255, 255), anchor="mm")
    lit = (255, 220, 0) if frame % 2 == 0 else (150, 120, 0)
    draw.ellipse([206, 22, 222, 38], fill=lit)
    draw.ellipse([478, 22, 494, 38], fill=(255, 220, 0) if frame % 2 else (150, 120, 0))
    # Lever (right of the body)
    draw.line([(674, 130), (674, 300)], fill=GOLD, width=6)
    ball_y = 138 if lever_down else 118
    draw.ellipse([660, ball_y, 688, ball_y + 28], fill=(230, 57, 70),
                 outline=(255, 255, 255), width=2)
    # Coin tray
    draw.rounded_rectangle([230, 350, 470, 410], radius=8, fill=(20, 20, 30),
                           outline=GOLD, width=3)


def draw_reel_window_borders(draw: ImageDraw.ImageDraw) -> None:
    """Gold borders around the three reel windows + the payline."""
    for (x, y) in SLOT_WINDOWS:
        draw.rectangle([x, y, x + SLOT_WIN_W, y + SLOT_WIN_H], outline=GOLD, width=4)
    draw.line([(75, 205), (625, 205)], fill=GOLD, width=3)


def reel_strip(twemoji: dict[str, Path]) -> Image.Image:
    """One reel as a vertical strip: the 8 symbols, twice (wraparound)."""
    strip = Image.new("RGBA", (SLOT_WIN_W, SLOT_CELL * len(SLOT_ORDER) * 2), (255, 255, 255, 255))
    d = ImageDraw.Draw(strip)
    for rep in range(2):
        for i, sym in enumerate(SLOT_ORDER):
            cy = rep * len(SLOT_ORDER) * SLOT_CELL + i * SLOT_CELL + SLOT_CELL // 2
            draw_twemoji_symbol(d, strip, twemoji, sym, SLOT_WIN_W // 2, cy, 120)
    return strip


def build_slots(twemoji: dict[str, Path]) -> list[Path]:
    out = GAMES / "slots"
    (out / "tiles").mkdir(parents=True, exist_ok=True)
    made: list[Path] = []
    # Symbol tiles: white window + symbol, exactly window-sized.
    # Drawn big (150x170), shipped small (69x78) via the 2x trick.
    for sym in SLOT_ORDER:
        tile = Image.new("RGBA", (SLOT_WIN_W, SLOT_WIN_H), (0, 0, 0, 0))
        d = ImageDraw.Draw(tile)
        d.rounded_rectangle([2, 2, SLOT_WIN_W - 3, SLOT_WIN_H - 3], radius=10,
                            fill=(255, 255, 255, 255), outline=(20, 20, 30), width=3)
        draw_twemoji_symbol(d, tile, twemoji, sym, SLOT_WIN_W // 2, SLOT_WIN_H // 2, 120)
        p = out / "tiles" / f"{SLOT_KEYS[sym]}.gif"
        save_transparent_gif([ship(tile, SLOTS_TILE_SHIP)], p, 100)
        made.append(p)
    # Machine frame: body + borders + payline, windows left transparent.
    # The whole machine is art 350x230 centred on the 700x280 canvas.
    frame = Image.new("RGBA", (SLOTS_W, SLOTS_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(frame)
    draw_slots_body(d)
    for (x, y) in SLOT_WINDOWS:
        frame.paste((0, 0, 0, 0), (x, y, x + SLOT_WIN_W, y + SLOT_WIN_H))
    draw_reel_window_borders(d)
    p = out / "machine.gif"
    save_transparent_gif([ship_padded(frame, SLOTS_ART, SLOTS_SHIP)], p, 100)
    made.append(p)
    # Spin: reels scrolling, seamless loop (16 frames x 85px = 1360 = 1 cycle).
    strip = reel_strip(twemoji)
    period = SLOT_CELL * len(SLOT_ORDER)
    phases = [0, 453, 907]
    frames: list[Image.Image] = []
    for f in range(16):
        img = Image.new("RGBA", (SLOTS_W, SLOTS_H), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        draw_slots_body(d, frame=f, lever_down=f in (0, 1, 2))
        for ri, (x, y) in enumerate(SLOT_WINDOWS):
            offset = (f * 85 + phases[ri]) % period
            window = strip.crop((0, offset, SLOT_WIN_W, offset + SLOT_WIN_H))
            img.alpha_composite(window, (x, y))
        draw_reel_window_borders(d)
        frames.append(img)
    p = out / "spin.gif"
    save_looping_gif([ship_padded(f, SLOTS_ART, SLOTS_SHIP) for f in frames], p, 80)
    made.append(p)
    return made


# ---------------------------------------------------------------------------
# Roulette — 37-pocket European wheel, spin + one settled wheel per number
# ---------------------------------------------------------------------------

ROULETTE_W, ROULETTE_H = 1400, 1120  # render canvas = 2x the art size
ROULETTE_CX, ROULETTE_CY = 700, 560
WHEEL_R = 520          # outer rim radius
POCKET_OUT, POCKET_IN = 500, 300  # pocket ring radii
NUMBER_R = 390         # numbers sit here
BALL_R = 464           # the ball rests here, on the pocket
BALL_D = 64            # ball diameter
STEP = 360 / 37


def pocket_center_angle(roll: int) -> float:
    """Centre angle (deg, PIL convention: 0 = 3 o'clock, + = clockwise)
    of a number's pocket. Pocket 0 is centred at the top (-90 deg)."""
    i = WHEEL_ORDER.index(roll)
    return -90 + (i + 0.5) * STEP


def pocket_color(roll: int) -> tuple[int, int, int]:
    if roll == 0:
        return (14, 122, 61)
    return (210, 31, 60) if roll in RED_NUMBERS else (16, 16, 20)


def draw_wheel_base() -> Image.Image:
    """The 37-pocket wheel, no ball. 0 at the top, clockwise order."""
    img = Image.new("RGBA", (ROULETTE_W, ROULETTE_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = ROULETTE_CX, ROULETTE_CY
    # Outer rim
    d.ellipse([cx - WHEEL_R, cy - WHEEL_R, cx + WHEEL_R, cy + WHEEL_R],
              fill=(32, 36, 46), outline=GOLD, width=16)
    # Pockets
    for i, n in enumerate(WHEEL_ORDER):
        a0 = -90 + i * STEP
        d.pieslice([cx - POCKET_OUT, cy - POCKET_OUT, cx + POCKET_OUT, cy + POCKET_OUT],
                   start=a0, end=a0 + STEP, fill=pocket_color(n))
    # Pocket separators (gold spokes)
    for i in range(37):
        a = math.radians(-90 + i * STEP)
        x0 = cx + POCKET_IN * math.cos(a)
        y0 = cy + POCKET_IN * math.sin(a)
        x1 = cx + POCKET_OUT * math.cos(a)
        y1 = cy + POCKET_OUT * math.sin(a)
        d.line([(x0, y0), (x1, y1)], fill=GOLD, width=4)
    # Numbers (upright, readable from outside the wheel)
    font = ImageFont.truetype(FONT_BOLD, 40)
    for i, n in enumerate(WHEEL_ORDER):
        a = math.radians(pocket_center_angle(n))
        x = cx + NUMBER_R * math.cos(a)
        y = cy + NUMBER_R * math.sin(a)
        d.text((x, y), str(n), font=font, fill=(255, 255, 255), anchor="mm")
    # Inner cone + hub
    d.ellipse([cx - POCKET_IN, cy - POCKET_IN, cx + POCKET_IN, cy + POCKET_IN],
              fill=(60, 50, 20), outline=GOLD, width=8)
    d.ellipse([cx - 90, cy - 90, cx + 90, cy + 90], fill=GOLD, outline=(180, 130, 0), width=6)
    d.ellipse([cx - 24, cy - 24, cx + 24, cy + 24], fill=(255, 255, 255))
    return img


def draw_ball(img: Image.Image, roll: int) -> None:
    """White ball on the winning pocket."""
    d = ImageDraw.Draw(img)
    a = math.radians(pocket_center_angle(roll))
    bx = ROULETTE_CX + BALL_R * math.cos(a)
    by = ROULETTE_CY + BALL_R * math.sin(a)
    r = BALL_D // 2
    d.ellipse([bx - r, by - r, bx + r, by + r], fill=(255, 255, 255),
              outline=(120, 120, 120), width=4)


def build_roulette() -> list[Path]:
    out = GAMES / "roulette"
    out.mkdir(parents=True, exist_ok=True)
    made: list[Path] = []
    base = draw_wheel_base()
    # Settled wheels, one per number: the wheel is art 606x485 (wheel
    # 450px) centred on the 700x500 canvas.
    for n in range(37):
        img = base.copy()
        draw_ball(img, n)
        p = out / f"wheel-{n:02d}.png"
        ship_padded(img, ROULETTE_ART, ROULETTE_SHIP).save(p)
        made.append(p)
    # Spin: wheel turning clockwise, ball orbiting the other way.
    frames: list[Image.Image] = []
    for f in range(12):
        wheel = base.rotate(-30 * f, resample=Image.BICUBIC,
                            center=(ROULETTE_CX, ROULETTE_CY))
        img = wheel.copy()
        d = ImageDraw.Draw(img)
        ball_angle = math.radians(200 - 28 * f)
        r = BALL_R
        bx = ROULETTE_CX + r * math.cos(ball_angle)
        by = ROULETTE_CY + r * math.sin(ball_angle)
        br = BALL_D // 2
        d.ellipse([bx - br, by - br, bx + br, by + br], fill=(255, 255, 255),
                  outline=(120, 120, 120), width=4)
        frames.append(img)
    p = out / "spin.gif"
    save_looping_gif([ship_padded(f, ROULETTE_ART, ROULETTE_SHIP) for f in frames], p, 100)
    made.append(p)
    return made


def verify_wheels() -> None:
    """Every settled wheel must have its (white) ball on the right pocket:
    the pocket index at the ball's angle must be the wheel's number.
    Samples the SHIPPED 700x500 PNGs, so the centres use ship-scale
    geometry (centre 350,250; ball radius 201)."""
    out = GAMES / "roulette"
    scx, scy, sball_r = 350, 250, 201
    for n in range(37):
        img = Image.open(out / f"wheel-{n:02d}.png").convert("RGBA")
        a = math.radians(pocket_center_angle(n))
        bx = int(round(scx + sball_r * math.cos(a)))
        by = int(round(scy + sball_r * math.sin(a)))
        px = img.getpixel((bx, by))
        assert px[0] > 200 and px[1] > 200 and px[2] > 200 and px[3] == 255, \
            f"wheel-{n:02d}: ball centre pixel {px} is not white"
        # The angle maps back to the same pocket index.
        idx = int(((math.degrees(a) + 90) % 360) // STEP)
        assert WHEEL_ORDER[idx] == n, f"wheel-{n:02d}: angle maps to {WHEEL_ORDER[idx]}"
    print("wheels verified: ball on the right pocket for all 37 numbers")


# ---------------------------------------------------------------------------
# Scratch — revealed + covered tiles
# ---------------------------------------------------------------------------

SCRATCH_W, SCRATCH_H = 700, 150  # (unused: strips are composed at runtime)
SCRATCH_TILES = [(160, 11), (295, 11), (430, 11)]  # (x, y) of each tile, ship px
SCRATCH_TW, SCRATCH_TH = 220, 254  # render tile = 2x the 110x127 ship tile


def draw_scratch_card(draw: ImageDraw.ImageDraw, x: int, y: int) -> None:
    draw.rounded_rectangle([x + 4, y + 4, x + SCRATCH_TW - 5, y + SCRATCH_TH - 5],
                           radius=14, fill=(15, 118, 110), outline=GOLD, width=4)


def build_scratch(twemoji: dict[str, Path]) -> list[Path]:
    out = GAMES / "scratch"
    (out / "tiles").mkdir(parents=True, exist_ok=True)
    made: list[Path] = []
    for sym in SCRATCH_SYMBOLS:
        tile = Image.new("RGBA", (SCRATCH_TW, SCRATCH_TH), (0, 0, 0, 0))
        d = ImageDraw.Draw(tile)
        draw_scratch_card(d, 0, 0)
        draw_twemoji_symbol(d, tile, twemoji, sym, SCRATCH_TW // 2, SCRATCH_TH // 2, 150)
        p = out / "tiles" / f"{SLOT_KEYS[sym]}.gif"
        save_transparent_gif([ship(tile, SCRATCH_TILE_SHIP)], p, 100)
        made.append(p)
    # Covered foil tile: same card, silver foil + "?".
    tile = Image.new("RGBA", (SCRATCH_TW, SCRATCH_TH), (0, 0, 0, 0))
    d = ImageDraw.Draw(tile)
    d.rounded_rectangle([4, 4, SCRATCH_TW - 5, SCRATCH_TH - 5], radius=14,
                        fill=(198, 198, 205), outline=(150, 150, 160), width=4)
    # Diagonal shine stripes.
    for x0 in range(-40, SCRATCH_TW + 40, 36):
        d.line([(x0, SCRATCH_TH), (x0 + 60, 0)], fill=(225, 225, 232), width=10)
    font = ImageFont.truetype(FONT_BOLD, 130)
    d.text((SCRATCH_TW // 2, SCRATCH_TH // 2), "?", font=font,
           fill=(70, 70, 80), anchor="mm")
    p = out / "tiles" / "cover.gif"
    save_transparent_gif([ship(tile, SCRATCH_TILE_SHIP)], p, 100)
    made.append(p)
    return made


# ---------------------------------------------------------------------------
# Verification sheet (author must VIEW this before committing)
# ---------------------------------------------------------------------------

def verify_contact_sheet() -> Path:
    """Contact sheet at PHONE-DISPLAY scale (every visual scaled to
    340px wide, the width Discord shows on his phone) on Discord dark
    — the author must VIEW this before committing. A visual that is
    unreadable here is unreadable in Discord; judge the landed coin
    ($ vs star), the slots/scratch symbols, and the roulette ball."""
    VERIFY.mkdir(parents=True, exist_ok=True)
    tiles: list[tuple[str, Image.Image]] = []

    def add(name: str, path: Path, frames: list[int]) -> None:
        im = Image.open(path)
        n = getattr(im, "n_frames", 1)
        for i in frames:
            im.seek(min(i, n - 1))
            r = im.convert("RGBA")
            comp = Image.new("RGBA", r.size, DARK)
            comp.alpha_composite(r)
            tiles.append((f"{name} f{i}", comp.convert("RGB")))

    def add_img(name: str, img: Image.Image) -> None:
        comp = Image.new("RGBA", img.size, DARK)
        comp.alpha_composite(img.convert("RGBA"))
        tiles.append((name, comp.convert("RGB")))

    # The toss: rise, big at the top, falling fast, edge-on landing.
    add("toss f0 rise", GAMES / "coinflip" / "flip.gif", [0])
    add("toss f5 top-big", GAMES / "coinflip" / "flip.gif", [5])
    add("toss f10 falling", GAMES / "coinflip" / "flip.gif", [10])
    add("toss f15 edge-on", GAMES / "coinflip" / "flip.gif", [15])
    add("heads close-up", GAMES / "coinflip" / "heads.png", [0])
    add("tails close-up", GAMES / "coinflip" / "tails.png", [0])
    add("slots spin", GAMES / "slots" / "spin.gif", [0, 5, 10, 15])
    add("machine", GAMES / "slots" / "machine.gif", [0])
    # Settled slots strip, composed the same way the bot does it
    # (machine frame + real tiles), at ship size.
    strip = Image.new("RGBA", SLOTS_SHIP, (0, 0, 0, 0))
    frame = Image.open(GAMES / "slots" / "machine.gif").convert("RGBA")
    for (x, y), key in zip([(218, 85), (313, 85), (408, 85)],
                           ["cherry", "lemon", "seven"]):
        strip.alpha_composite(Image.open(GAMES / "slots" / "tiles" / f"{key}.gif").convert("RGBA"), (x, y))
    strip.alpha_composite(frame)
    add_img("slots settled 🍒🍋7", strip)
    add("wheel 0", GAMES / "roulette" / "wheel-00.png", [0])
    add("wheel 17", GAMES / "roulette" / "wheel-17.png", [0])
    add("wheel 32", GAMES / "roulette" / "wheel-32.png", [0])
    add("wheel 36", GAMES / "roulette" / "wheel-36.png", [0])
    add("roulette spin", GAMES / "roulette" / "spin.gif", [0, 4, 8])
    # 3x zoom on the ball of wheel-17 (is it findable at 700px?).
    w17 = Image.open(GAMES / "roulette" / "wheel-17.png").convert("RGBA")
    a = math.radians(pocket_center_angle(17))
    bx = int(round(350 + 201 * math.cos(a)))
    by = int(round(250 + 201 * math.sin(a)))
    zoom = w17.crop((bx - 30, by - 30, bx + 30, by + 30)).resize((150, 150), Image.LANCZOS)
    add_img("wheel-17 ball 3x", zoom)
    add("scratch cover", GAMES / "scratch" / "tiles" / "cover.gif", [0])
    add("scratch diamond", GAMES / "scratch" / "tiles" / "diamond.gif", [0])
    add("scratch seven", GAMES / "scratch" / "tiles" / "seven.gif", [0])
    # Settled scratch strip at ship size (diamond / star / cherry).
    sstrip = Image.new("RGBA", SCRATCH_SHIP, (0, 0, 0, 0))
    for (x, y), key in zip([(160, 11), (295, 11), (430, 11)],
                           ["diamond", "star", "cherry"]):
        sstrip.alpha_composite(
            Image.open(GAMES / "scratch" / "tiles" / f"{key}.gif").convert("RGBA"), (x, y))
    add_img("scratch settled 💎⭐🍒", sstrip)

    # PHONE-DISPLAY SCALE: every tile is scaled to 340px wide — the
    # width Discord shows on his phone — before it goes on the sheet.
    # A visual unreadable here is unreadable in Discord.
    scaled: list[tuple[str, Image.Image]] = []
    for name, t in tiles:
        if t.width > 340:
            t = t.resize((340, round(t.height * 340 / t.width)), Image.LANCZOS)
        scaled.append((name, t))

    cols = 2
    cw = 340
    rows = []
    row: list[tuple[str, Image.Image]] = []
    for t in scaled:
        row.append(t)
        if len(row) == cols:
            rows.append(row)
            row = []
    if row:
        rows.append(row)
    total_h = sum(max(t[1].height for t in r) + 22 for r in rows)
    sheet = Image.new("RGB", (cols * cw, total_h), (20, 20, 20))
    d = ImageDraw.Draw(sheet)
    font = ImageFont.truetype(FONT_BOLD, 14)
    y = 0
    for r in rows:
        rh = max(t[1].height for t in r)
        for j, (name, t) in enumerate(r):
            x = j * cw + (cw - t.width) // 2
            sheet.paste(t, (x, y))
            d.text((j * cw + 6, y + rh + 4), name, font=font, fill=(255, 255, 255))
        y += rh + 22
    dest = VERIFY / "contact-sheet.png"
    sheet.save(dest)
    return dest


def main() -> None:
    twemoji = fetch_twemoji()
    print("twemoji:", sorted(str(p) for p in twemoji.values()))
    face = draw_heads_disc()
    made: list[Path] = list(build_coinflip(face))
    made += build_slots(twemoji)
    made += build_roulette()
    verify_wheels()
    made += build_scratch(twemoji)
    sheet = verify_contact_sheet()
    print(f"built {len(made)} assets")
    total = 0
    for p in sorted(made):
        frames = getattr(Image.open(p), "n_frames", 1)
        print(f"  {p.relative_to(ROOT)}: {Image.open(p).size} frames={frames} "
              f"bytes={p.stat().st_size}")
        total += p.stat().st_size
    print(f"total bytes: {total}")
    print("contact sheet ->", sheet)


if __name__ == "__main__":
    main()
