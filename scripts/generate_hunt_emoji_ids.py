#!/usr/bin/env python3
"""Regenerate src/lib/hunt-emoji-ids.ts from assets/emoji-hunt/emoji-ids.json.

The emoji-ids.json file is written by scripts/upload_application_emoji.py
after uploading the animated hunt emoji to the bot's application emoji.
The bot code reads the checked-in TS map (no runtime file IO), so re-run
this script after any re-upload, then commit the result:

    python3 scripts/generate_hunt_emoji_ids.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "assets", "emoji-hunt", "emoji-ids.json")
OUT = os.path.join(ROOT, "src", "lib", "hunt-emoji-ids.ts")


def main() -> None:
    with open(SRC) as f:
        ids = json.load(f)
    lines = [
        "/**",
        " * Application-emoji IDs for the hunt-world roster (monsters, weapons,",
        " * pets). Keys are slugs of the roster name (lowercase, non-alphanumerics",
        " * become \"_\"). Values are Discord emoji ID snowflakes as STRINGS.",
        " *",
        " * GENERATED — do not edit by hand. Re-run",
        " * scripts/generate_hunt_emoji_ids.py after any re-upload, then commit.",
        " * Source of truth: assets/emoji-hunt/emoji-ids.json (written by",
        " * scripts/upload_application_emoji.py).",
        " *",
        " * All of these are animated GIFs, so markup is `<a:slug:id>`.",
        " */",
        "export const HUNT_EMOJI_IDS: Readonly<Record<string, string>> = {",
    ]
    for slug in sorted(ids):
        lines.append(f'  "{slug}": "{ids[slug]}",')
    lines.append("};")
    lines.append("")
    with open(OUT, "w") as f:
        f.write("\n".join(lines))
    print(f"wrote {OUT} ({len(ids)} ids)")


if __name__ == "__main__":
    main()
