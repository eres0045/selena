#!/usr/bin/env python3
"""One-off upload of the uwu hunt-world animated emoji to the bot's
application emoji (usable by the bot in any server, no server slots).

Usage: DISCORD_BOT_TOKEN is read from stdin (paste once, never stored).
  printf '%s' '<token>' | python3 upload_application_emoji.py

Reads assets/emoji-hunt/manifest.json, skips entries with no file,
skips names already present on the application (idempotent re-runs),
POSTs the rest to /applications/{APP_ID}/emojis with 429 backoff,
and writes assets/emoji-hunt/emoji-ids.json (name -> id).
Prints only counts and names — never the token.
"""
import base64
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error

APP_ID = "1568320080419496026"
BASE = "https://discord.com/api/v10"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ASSETS = os.path.join(ROOT, "assets", "emoji-hunt")
MANIFEST = os.path.join(ASSETS, "manifest.json")
OUT = os.path.join(ASSETS, "emoji-ids.json")


def slug(name):
    s = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return s[:32]


def req(method, path, token, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"Authorization": "Bot " + token,
                 "Content-Type": "application/json",
                 "User-Agent": "uwu-emoji-upload/1.0"})
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            parsed = json.loads(body or b"{}")
        except Exception:
            parsed = {"raw": body[:200].decode("utf-8", "replace")}
        return e.code, parsed


def main():
    token = sys.stdin.read().strip()
    if not token:
        print("error: bot token required on stdin", file=sys.stderr)
        sys.exit(1)
    with open(MANIFEST) as f:
        manifest = json.load(f)

    status, existing = req("GET", f"/applications/{APP_ID}/emojis", token)
    if status != 200:
        print(f"error: list existing emoji failed HTTP {status}: {existing}",
              file=sys.stderr)
        sys.exit(1)
    have = {e["name"]: e["id"] for e in existing.get("items", [])}
    print(f"application already has {len(have)} emoji")

    ids = {}
    if os.path.exists(OUT):
        with open(OUT) as f:
            ids = json.load(f)
    uploaded, skipped, failed = 0, 0, []
    for entry in manifest:
        path = entry.get("file")
        if not path:
            continue
        name = slug(entry["roster_name"])
        if name in have:
            ids[name] = have[name]
            skipped += 1
            continue
        full = os.path.join(ASSETS, path)  # manifest paths are relative to assets/emoji-hunt/
        with open(full, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        payload = {"name": name, "image": "data:image/gif;base64," + b64}
        for attempt in range(5):
            status, body = req("POST", f"/applications/{APP_ID}/emojis",
                               token, payload)
            if status in (200, 201):
                ids[name] = body["id"]
                have[name] = body["id"]
                uploaded += 1
                print(f"uploaded {name} ({entry['roster_name']})")
                break
            if status == 429:
                wait = float(body.get("retry_after", 1)) + 0.5
                print(f"429 on {name}, waiting {wait:.1f}s")
                time.sleep(wait)
                continue
            failed.append((name, status, body))
            print(f"FAILED {name}: HTTP {status}: {body}", file=sys.stderr)
            break
        time.sleep(0.2)  # gentle pace between creates
    with open(OUT, "w") as f:
        json.dump(ids, f, indent=2, sort_keys=True)
    print(f"done: uploaded={uploaded} already_present={skipped} "
          f"failed={len(failed)} total_ids={len(ids)}")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
