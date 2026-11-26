#!/usr/bin/env python3
"""Resolve a Udemy DRM lecture into a ready-to-use license job.

Takes the operator's own session cookies plus a course slug (or numeric id) and a
lecture id, then prints:

* the content KID and PSSH taken from the HLS manifest,
* the exact license URL (auth_token + drm_type query) that Udemy's DRM server expects,

and writes a ``.widevine.json``-shaped job that ``tools/widevine_helper.py`` accepts.

Usage:
  python tools/udemy_license.py cookies.json digital-marketing-guide 51267967
  python tools/udemy_license.py cookies.json 1659676 51267967 --out job.json

Cookies file = the JSON array exported by a cookie-export extension.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
import sys
import urllib.parse
import urllib.request

API = "https://www.udemy.com/api-2.0"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def cookie_header(cookies: list[dict]) -> str:
    return "; ".join(f'{c["name"]}={c["value"]}' for c in cookies if "udemy.com" in c.get("domain", ""))


def fetch_json(url: str, ck: str, referer: str) -> dict:
    req = urllib.request.Request(url, headers={
        "Cookie": ck, "User-Agent": UA, "Accept": "application/json",
        "Referer": referer, "X-Requested-With": "XMLHttpRequest",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_text(url: str, ck: str, referer: str, limit: int = 200_000) -> str:
    req = urllib.request.Request(url, headers={"Cookie": ck, "User-Agent": UA, "Referer": referer})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read(limit).decode("utf-8", "replace")


def resolve_course(slug_or_id: str, ck: str) -> dict:
    q = urllib.parse.urlencode({"fields[course]": "id,title,url"})
    return fetch_json(f"{API}/courses/{slug_or_id}/?{q}", ck, "https://www.udemy.com/")


def lecture_asset(course_id: str, lecture_id: str, ck: str, referer: str) -> dict:
    q = urllib.parse.urlencode({
        "fields[lecture]": "id,title,asset",
        "fields[asset]": "asset_type,media_sources,media_license_token,course_is_drmed",
    })
    url = f"{API}/users/me/subscribed-courses/{course_id}/lectures/{lecture_id}/?{q}"
    return fetch_json(url, ck, referer)


def pssh_from_manifest(playlist: str) -> tuple[str | None, str | None]:
    """Pull PSSH + KID out of the manifest key lines.

    Udemy emits two keys: ``URI="skd://<32 hex>"`` (KID for FairPlay) and a
    ``data:text/plain;base64,`` URI carrying the Widevine PSSH box.
    """
    pssh = None
    kid = None
    for line in playlist.splitlines():
        if "#EXT-X-KEY" not in line:
            continue
        if kid is None:
            m = re.search(r'URI="skd://([0-9a-fA-F]{32})"', line)
            if m:
                h = m.group(1).lower()
                kid = "-".join([h[:8], h[8:12], h[12:16], h[16:20], h[20:]])
        if pssh is None:
            m = re.search(r'URI="data:text/plain;base64,([^"]+)"', line)
            if m:
                pssh = m.group(1)
    if kid is None and pssh:
        try:
            raw = base64.b64decode(pssh)
            version = raw[8]
            if version == 1 and len(raw) >= 48:
                kid_count = int.from_bytes(raw[28:32], "big")
                if kid_count:
                    kb = raw[32:48]
                    kid = "-".join([kb[0:4].hex(), kb[4:6].hex(), kb[6:8].hex(),
                                    kb[8:10].hex(), kb[10:16].hex()])
        except (binascii.Error, IndexError):
            pass
    return kid, pssh


def build_license_url(token: str) -> str:
    base = f"{API}/media-license-server/{token}"
    q = urllib.parse.urlencode({"auth_token": token, "drm_type": "widevine"})
    return f"{base}?{q}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cookies", help="cookie-export JSON array")
    ap.add_argument("course", help="course slug or numeric id")
    ap.add_argument("lecture", help="lecture id")
    ap.add_argument("--out", help="write the widevine job here")
    args = ap.parse_args()

    cookies = json.load(open(args.cookies, encoding="utf-8"))
    ck = cookie_header(cookies)

    course = resolve_course(args.course, ck)
    cid = str(course.get("id"))
    slug = (course.get("url") or "").rstrip("/").split("/")[-1]
    referer = f"https://www.udemy.com/course/{slug}/learn/lecture/{args.lecture}"

    lec = lecture_asset(cid, args.lecture, ck, referer)
    asset = lec.get("asset") or {}
    print(f"course    : {cid} | {course.get('title')}")
    print(f"lecture   : {lec.get('id')} | {lec.get('title')}")
    print(f"drm       : {asset.get('course_is_drmed')} | token={bool(asset.get('media_license_token'))}")

    sources = asset.get("media_sources") or []
    hls = next((s for s in sources if "mpegurl" in (s.get("type") or "").lower()), None)
    if not hls:
        print("no HLS source — nothing to do", file=sys.stderr)
        return 2

    master = fetch_text(hls["src"], ck, referer, limit=4000)
    variants = [ln for ln in master.splitlines() if ln and not ln.startswith("#")]
    kid = pssh = None
    if variants:
        base_dir = hls["src"].rsplit("/", 1)[0] + "/"
        media = fetch_text(base_dir + variants[0], ck, referer, limit=6000)
        kid, pssh = pssh_from_manifest(media)

    token = asset.get("media_license_token")
    lic_url = build_license_url(token) if token else None

    print(f"kid       : {kid or '<not in manifest>'}")
    print(f"pssh      : {(pssh or '<none>')[:64]}{'...' if pssh and len(pssh) > 64 else ''}")
    print(f"license   : {lic_url[:110] if lic_url else '<no token>'}...")

    job = {
        "version": 1,
        "encryption": "widevine",
        "course_id": cid,
        "lecture_id": lec.get("id"),
        "kids": [kid] if kid else [],
        "pssh": [{"b64": pssh}] if pssh else [],
        "license": {
            "url": lic_url,
            "method": "POST",
            "headers": {
                "Origin": "https://www.udemy.com",
                "Referer": referer,
                "User-Agent": UA,
                "Content-Type": "application/octet-stream",
            },
            "cookies": ck if "--with-cookies" in sys.argv else "",
        },
    }
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(job, fh, indent=2)
        print(f"job written: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
