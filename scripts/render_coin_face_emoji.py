"""Render the coinflip settled faces as 128x128 Discord emoji PNGs.

Ronit 2026-11-07: the four visual casino games are now TINY EMOJI
visuals — no attached pictures at all. The coinflip settles on a
small custom emoji of the landed face, so heads/tails need crisp
128x128 PNGs to upload to the server as the 'heads' and 'tails'
emoji (IDs go in src/lib/emoji.ts once uploaded).

The faces are the SAME clean PIL discs as the old landed close-ups
(draw_heads_disc / draw_tails_disc in render_visual_games.py) — the
emoji.gg $ face is NOT reused: it carries a faint stock watermark
across the $ that shows once the face is shown big. Tails is the
gold star-emboss disc, unmistakable vs heads at emoji size.

Usage: python3 scripts/render_coin_face_emoji.py
Writes: assets/emoji-animated/heads.png, assets/emoji-animated/tails.png
        assets/emoji-animated/verify/coin-faces.png (contact sheet on #313338)
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
from render_visual_games import draw_heads_disc, draw_tails_disc  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
EMOJI_DIR = ROOT / "assets" / "emoji-animated"
DARK = (49, 51, 56, 255)  # Discord dark
SIZE = 128  # Discord custom emoji: 128x128 recommended, 256 KB max


def main() -> None:
    EMOJI_DIR.mkdir(parents=True, exist_ok=True)
    heads = draw_heads_disc(SIZE)
    tails = draw_tails_disc(SIZE)
    assert heads.size == (SIZE, SIZE) and tails.size == (SIZE, SIZE)
    heads_path = EMOJI_DIR / "heads.png"
    tails_path = EMOJI_DIR / "tails.png"
    heads.save(heads_path)
    tails.save(tails_path)
    for p in (heads_path, tails_path):
        assert p.stat().st_size <= 256 * 1024, f"{p} over the 256 KB emoji cap"
        print(f"{p} {p.stat().st_size} bytes")

    # Contact sheet: both faces at 1x and 3x on Discord dark, for the eye check.
    verify = EMOJI_DIR / "verify"
    verify.mkdir(parents=True, exist_ok=True)
    big = SIZE * 3
    sheet = Image.new("RGBA", (16 + big + 16 + big + 16, 16 + SIZE + 24 + big + 16), DARK)
    dr = ImageDraw.Draw(sheet)
    sheet.alpha_composite(heads, (16, 16))
    sheet.alpha_composite(tails, (16 + SIZE + 32, 16))
    dr.text((16, 16 + SIZE + 6), "heads (128)      tails (128)", fill=(255, 255, 255, 255))
    sheet.alpha_composite(heads.resize((big, big), Image.LANCZOS), (16, 16 + SIZE + 24))
    sheet.alpha_composite(tails.resize((big, big), Image.LANCZOS), (16 + big + 16, 16 + SIZE + 24))
    sheet.convert("RGB").save(verify / "coin-faces.png")
    print(f"{verify / 'coin-faces.png'} written")


if __name__ == "__main__":
    main()
