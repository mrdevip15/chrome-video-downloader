#!/usr/bin/env python3
"""Udemy course downloader for the terminal.

Login once, then hand it a course URL. It walks the curriculum, downloads every
lecture it can decrypt, and writes a structured tree:

    <out>/<course>/
        01 - Section name/
            01 - Lecture title.mp4
            01 - Lecture title.en.vtt
        _report.json

Lectures that are Widevine/SAMPLE-AES cannot be decrypted without a CDM, so they
are not downloaded as garbage: a `<name>.widevine.json` job (KID, PSSH, license
URL) is written instead, for `tools/widevine_helper.py --cdm device.wvd` later.

Usage:
    python tools/udemy_cli.py login --browser edge
    python tools/udemy_cli.py download https://www.udemy.com/course/foo/ --out D:\\Courses -w 4 -s 8
    python tools/udemy_cli.py list https://www.udemy.com/course/foo/

Cookies live in ~/.udemy-cli/cookies.json (never in the repo).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

API = "https://www.udemy.com/api-2.0"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
CONF_DIR = Path.home() / ".udemy-cli"
CONF_FILE = CONF_DIR / "cookies.json"
PRINT_LOCK = threading.Lock()

CURRICULUM_FIELDS = {
    "fields[lecture]": "id,title,asset_type,object_index,asset",
    "fields[chapter]": "id,title,object_index",
    "fields[asset]": "asset_type,media_sources,media_license_token,course_is_drmed",
    "page_size": "1000",
}


def log(*parts: object) -> None:
    with PRINT_LOCK:
        print(*parts, flush=True)


def safe_name(text: str, limit: int = 90) -> str:
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", text or "").strip(" .")
    return (text[:limit].rstrip(" .") or "untitled")


# ---------------------------------------------------------------- credentials

def save_cookies(browser: str | None, path: str | None) -> int:
    if browser:
        try:
            import browser_cookie3
        except ImportError:
            return die("browser_cookie3 missing: pip install browser_cookie3")
        getter = getattr(browser_cookie3, browser, None)
        if not getter:
            return die(f"unsupported browser: {browser}")
        try:
            jar = getter(domain_name="udemy.com")
        except Exception as exc:
            return die(f"could not read {browser} cookies: {type(exc).__name__}: {exc}\n"
                       f"run this from an elevated shell, or export cookies to JSON and use --cookies")
        cookies = [{"domain": c.domain, "name": c.name, "value": c.value} for c in jar]
    elif path:
        cookies = json.load(open(path, encoding="utf-8"))
    else:
        return die("pass --browser edge|chrome|firefox or --cookies <file.json>")

    needed = {"access_token", "client_id"}
    have = {c["name"] for c in cookies}
    CONF_DIR.mkdir(parents=True, exist_ok=True)
    CONF_FILE.write_text(json.dumps(cookies, indent=1), encoding="utf-8")
    try:
        os.chmod(CONF_FILE, 0o600)
    except OSError:
        pass
    log(f"saved {len(cookies)} cookies to {CONF_FILE}")
    if not needed & have:
        log(f"warning: missing {', '.join(sorted(needed - have))} — the session probably is not logged in")
    return 0


def load_cookies() -> str:
    if not CONF_FILE.exists():
        die(f"no saved session. run: python {sys.argv[0]} login --browser edge")
    cookies = json.loads(CONF_FILE.read_text(encoding="utf-8"))
    return "; ".join(f'{c["name"]}={c["value"]}' for c in cookies if "udemy.com" in c.get("domain", ""))


# ---------------------------------------------------------------------- http

def api_get(path: str, ck: str, referer: str = "https://www.udemy.com/") -> dict:
    req = urllib.request.Request(f"{API}{path}", headers={
        "Cookie": ck, "User-Agent": UA, "Accept": "application/json",
        "Referer": referer, "X-Requested-With": "XMLHttpRequest",
    })
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.loads(r.read().decode("utf-8"))


def lecture_url_from_arg(arg: str) -> str:
    if "udemy.com" in arg:
        m = re.search(r"/course/([^/?#]+)", arg)
        if not m:
            die(f"could not find a course slug in {arg}")
        return m.group(1)
    return arg.strip().strip("/")


# ---------------------------------------------------------------- curriculum

def fetch_curriculum(course_id: str, ck: str) -> list[dict]:
    items: list[dict] = []
    url = f"/courses/{course_id}/cached-subscriber-curriculum-items/"
    q = urllib.parse.urlencode(CURRICULUM_FIELDS)
    referer = f"https://www.udemy.com/course/{course_id}/"
    while url:
        body = api_get(f"{url}?{q}" if "?" not in url else url, ck, referer)
        results = body.get("results") or []
        items.extend(results)
        url = body.get("next")
        if url:
            url = url.replace("https://www.udemy.com/api-2.0", "")
        if not results:
            break
    return items


def plan(items: list[dict]) -> list[dict]:
    """Flatten the curriculum into ordered sections and lectures."""
    sections: list[dict] = []
    current = {"title": "00 - Introduction", "lectures": []}
    chapter_no = 0
    for item in items:
        kind = item.get("_class") or ""
        if kind == "chapter":
            if current["lectures"]:
                sections.append(current)
            chapter_no += 1
            current = {"title": f"{chapter_no:02d} - {safe_name(item.get('title'))}", "lectures": []}
        elif kind == "lecture":
            current["lectures"].append(item)
    if current["lectures"]:
        sections.append(current)

    out = []
    for section in sections:
        for index, lecture in enumerate(section["lectures"], start=1):
            out.append({
                "section": section["title"],
                "index": index,
                "id": lecture.get("id"),
                "title": safe_name(lecture.get("title")),
                "asset_type": lecture.get("asset_type"),
                "raw": lecture,
            })
    return out


def best_hls(sources: list[dict]) -> str | None:
    hls = [s for s in sources if "mpegurl" in (s.get("type") or "").lower()]
    return hls[0]["src"] if hls else None


def pick_variant(master: str) -> str:
    """Highest-bandwidth variant from a master playlist (relative URLs kept relative)."""
    lines = [ln.strip() for ln in master.splitlines() if ln.strip()]
    best_uri, best_bw = None, -1
    for i, line in enumerate(lines):
        if not line.startswith("#EXT-X-STREAM-INF"):
            continue
        m = re.search(r"BANDWIDTH=(\d+)", line)
        bw = int(m.group(1)) if m else 0
        for nxt in lines[i + 1:]:
            if not nxt.startswith("#"):
                if bw > best_bw:
                    best_uri, best_bw = nxt, bw
                break
    return best_uri or (lines[-1] if lines else "")


def fetch_playlist(url: str, work_dir: Path, ck: str, workers: int) -> Path:
    """Download every segment in parallel and return a local, self-contained playlist.

    ffmpeg cannot parallelise HLS segment fetches, so we grab them here and hand it a
    playlist that points at local files (key included) — it then only does decryption
    and muxing, which it is good at.
    """
    headers = {"Cookie": ck, "User-Agent": UA, "Referer": "https://www.udemy.com/"}

    def get_text(target: str) -> str:
        req = urllib.request.Request(target, headers=headers)
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read().decode("utf-8", "replace")

    text = get_text(url)
    if "#EXT-X-STREAM-INF" in text:
        variant = pick_variant(text)
        url = urllib.parse.urljoin(url, variant)
        text = get_text(url)

    work_dir.mkdir(parents=True, exist_ok=True)
    out_lines: list[str] = []
    pending: list[tuple[str, Path]] = []

    def join(base: str, uri: str) -> str:
        if uri.startswith(("http://", "https://", "data:", "skd:")):
            return uri
        if re.match(r"^[A-Za-z]:[\\/]", uri):  # already an absolute Windows path
            return uri
        return urllib.parse.urljoin(base, uri)

    def queue(remote: str) -> str:
        name = f"{len(pending):04d}_{os.path.basename(remote.replace(chr(92), '/')) or 'part'}"
        local = work_dir / name
        pending.append((remote, local))
        return local.name

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#EXT-X-KEY"):
            m = re.search(r'URI="([^"]+)"', stripped)
            if m and not m.group(1).startswith(("data:", "skd:")):
                key_remote = join(url, m.group(1))
                key_local = queue(key_remote)
                stripped = stripped.replace(m.group(1), key_local)
        elif stripped.startswith("#EXT-X-MAP"):
            m = re.search(r'URI="([^"]+)"', stripped)
            if m:
                init_remote = join(url, m.group(1))
                stripped = stripped.replace(m.group(1), queue(init_remote))
        elif not stripped.startswith("#"):
            stripped = queue(join(url, stripped))
        out_lines.append(stripped)

    def grab(item: tuple[str, Path]) -> tuple[Path, str | None]:
        remote, local = item
        try:
            if remote.startswith(("http://", "https://")):
                req = urllib.request.Request(remote, headers=headers)
                with urllib.request.urlopen(req, timeout=120) as r:
                    local.write_bytes(r.read())
            elif remote.startswith("file://"):
                shutil.copyfile(urllib.request.url2pathname(urllib.parse.urlparse(remote).path), local)
            else:
                shutil.copyfile(remote, local)
            return local, None
        except Exception as exc:
            return local, str(exc)

    errors = []
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for local, err in pool.map(grab, pending):
            if err:
                errors.append(f"{local.name}: {err}")
    if errors:
        raise RuntimeError(f"{len(errors)} segment(s) failed, first: {errors[0]}")

    playlist = work_dir / "local.m3u8"
    playlist.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
    return playlist


# ------------------------------------------------------------------- workers

def download_lecture(job: dict, ck: str, out_dir: Path, seg_workers: int,
                     keep_captions: bool) -> dict:
    lecture = job["raw"]
    folder = out_dir / job["section"]
    folder.mkdir(parents=True, exist_ok=True)
    stem = f'{job["index"]:02d} - {job["title"]}'
    target = folder / f"{stem}.mp4"

    if target.exists() and target.stat().st_size > 1024:
        return {"id": job["id"], "title": stem, "status": "exists"}

    asset = lecture.get("asset") or {}
    if not asset and job.get("id"):
        try:
            detail = api_get(
                f'/users/me/subscribed-courses/{job["course_id"]}/lectures/{job["id"]}/'
                f'?fields[lecture]=id,title,asset&fields[asset]=asset_type,media_sources,'
                f'media_license_token,course_is_drmed', ck)
            asset = detail.get("asset") or {}
        except Exception as exc:
            return {"id": job["id"], "title": stem, "status": "error", "detail": str(exc)}

    if asset.get("course_is_drmed"):
        from udemy_license import build_license_url, pssh_from_manifest  # same tools dir
        kid = pssh = None
        src = best_hls(asset.get("media_sources") or [])
        if src:
            try:
                headers = {"Cookie": ck, "User-Agent": UA, "Referer": "https://www.udemy.com/"}
                with urllib.request.urlopen(urllib.request.Request(src, headers=headers), timeout=60) as r:
                    master = r.read(200_000).decode("utf-8", "replace")
                variants = [ln.strip() for ln in master.splitlines() if ln.strip() and not ln.startswith("#")]
                if variants:
                    media_url = urllib.parse.urljoin(src, variants[0])
                    with urllib.request.urlopen(urllib.request.Request(media_url, headers=headers), timeout=60) as r:
                        kid, pssh = pssh_from_manifest(r.read(200_000).decode("utf-8", "replace"))
            except Exception:
                pass

        token = asset.get("media_license_token")
        job_path = folder / f"{stem}.widevine.json"
        job_path.write_text(json.dumps({
            "version": 1,
            "encryption": "widevine",
            "course_id": job["course_id"],
            "lecture_id": job["id"],
            "kids": [kid] if kid else [],
            "pssh": [{"b64": pssh}] if pssh else [],
            "license": {
                "url": build_license_url(token) if token else None,
                "method": "POST",
                "headers": {"Origin": "https://www.udemy.com", "Referer": "https://www.udemy.com/",
                            "User-Agent": UA, "Content-Type": "application/octet-stream"},
            },
        }, indent=2), encoding="utf-8")
        return {"id": job["id"], "title": stem, "status": "drm", "path": str(job_path)}

    src = best_hls(asset.get("media_sources") or [])
    if not src:
        return {"id": job["id"], "title": stem, "status": "no-source"}

    tmp = folder / f".{stem}.part.mp4"
    segments = folder / f".{stem}.segments"
    try:
        local_playlist = fetch_playlist(src, segments, ck, seg_workers)
    except Exception as exc:
        return {"id": job["id"], "title": stem, "status": "failed", "detail": f"segments: {exc}"}

    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-allowed_extensions", "ALL",
        "-i", str(local_playlist),
        "-c", "copy", "-bsf:a", "aac_adtstoasc",
        str(tmp),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
    if proc.returncode != 0 or not tmp.exists() or tmp.stat().st_size < 1024:
        tmp.unlink(missing_ok=True)
        shutil.rmtree(segments, ignore_errors=True)
        return {"id": job["id"], "title": stem, "status": "failed",
                "detail": (proc.stderr or "").strip().splitlines()[-1:] or ""}

    tmp.replace(target)
    shutil.rmtree(segments, ignore_errors=True)

    if keep_captions:
        for cap in asset.get("captions") or []:
            lang = cap.get("language") or "en"
            url = cap.get("url")
            if not url:
                continue
            try:
                req = urllib.request.Request(url, headers={"Cookie": ck, "User-Agent": UA})
                with urllib.request.urlopen(req, timeout=60) as r:
                    (folder / f"{stem}.{lang}.vtt").write_bytes(r.read())
            except Exception:
                pass

    return {"id": job["id"], "title": stem, "status": "ok",
            "size": target.stat().st_size, "path": str(target)}


def die(message: str) -> int:
    print(message, file=sys.stderr)
    return 2


# ---------------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser(description="Udemy course downloader (CLI)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_login = sub.add_parser("login", help="store the Udemy session once")
    p_login.add_argument("--browser", help="chrome, edge, firefox, brave")
    p_login.add_argument("--cookies", help="cookie-export JSON instead")

    for name, helptext in (("download", "fetch every lecture"), ("list", "show the curriculum")):
        p = sub.add_parser(name, help=helptext)
        p.add_argument("course", help="course URL, slug or numeric id")
        p.add_argument("--out", default=".", help="output root (default: current dir)")
        p.add_argument("-w", "--workers", type=int, default=3, help="lectures in parallel (default 3)")
        p.add_argument("-s", "--seg-workers", type=int, default=8,
                       help="concurrent fragment downloads per lecture (default 8)")
        p.add_argument("--include-non-video", action="store_true",
                       help="also walk articles/quizzes (they have no media and are skipped by default)")
        if name == "download":
            p.add_argument("--no-captions", action="store_true", help="skip subtitle files")

    args = ap.parse_args()

    if args.cmd == "login":
        return save_cookies(args.browser, args.cookies)

    ck = load_cookies()
    slug = lecture_url_from_arg(args.course)
    try:
        course = api_get(f"/courses/{slug}/?fields[course]=id,title,url", ck)
    except Exception as exc:
        return die(f"course lookup failed: {exc}")

    cid = str(course.get("id"))
    title = safe_name(course.get("title"), 80)
    log(f"course: {cid} | {course.get('title')}")

    items = fetch_curriculum(cid, ck)
    jobs_all = plan(items)
    for job in jobs_all:
        job["course_id"] = cid
    jobs = jobs_all if getattr(args, "include_non_video", False) else [
        j for j in jobs_all if (j.get("asset_type") or "").lower() == "video"
    ]
    skipped = len(jobs_all) - len(jobs)
    log(f"curriculum: {len({j['section'] for j in jobs_all})} sections, {len(jobs)} videos"
        + (f" ({skipped} non-video skipped)" if skipped else ""))

    if args.cmd == "list":
        for job in jobs:
            log(f"  {job['section']} / {job['index']:02d} {job['title']} [{job['asset_type']}]")
        return 0

    out_dir = Path(args.out).expanduser() / title
    out_dir.mkdir(parents=True, exist_ok=True)
    log(f"output: {out_dir}")

    results = []
    started = time.time()
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = {
            pool.submit(download_lecture, job, ck, out_dir, args.seg_workers,
                        not args.no_captions): job
            for job in jobs
        }
        for future in as_completed(futures):
            job = futures[future]
            try:
                result = future.result()
            except Exception as exc:
                result = {"id": job["id"], "title": job["title"], "status": "error", "detail": str(exc)}
            results.append(result)
            log(f'[{result["status"]:>7}] {job["section"]} / {result["title"]}')

    report = {
        "course_id": cid,
        "course_title": course.get("title"),
        "finished": time.strftime("%Y-%m-%d %H:%M:%S"),
        "seconds": round(time.time() - started, 1),
        "counts": {},
        "lectures": results,
    }
    for result in results:
        report["counts"][result["status"]] = report["counts"].get(result["status"], 0) + 1
    (out_dir / "_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    log("\nsummary:", json.dumps(report["counts"]))
    if report["counts"].get("drm"):
        log("DRM lectures were not downloaded — fill their job with tools/udemy_license.py, "
            "then decrypt with tools/widevine_helper.py --cdm device.wvd.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
