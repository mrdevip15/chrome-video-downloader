#!/usr/bin/env python3
"""Widevine license + CENC decrypt helper for the Media & Course Downloader extension.

The browser extension cannot decrypt Widevine CENC content on its own (the CDM's
device keys are sealed inside the browser). What it *can* do is save the encrypted
fMP4 segments plus a job file describing them, the PSSH/KID, and the license
endpoint the page used. This script takes that job file, requests a license with
your own L3 CDM (pywidevine), and decrypts the saved segments with Bento4's
mp4decrypt (or ffmpeg as a fallback).

    python tools/widevine_helper.py "D:\\Courses\\My Course"

Every *.widevine.json under that folder is processed, producing
"<output>.mp4" next to the encrypted source files.

Options:
    --cdm PATH        path to your own device .wvd file (required for licensing)
    --keys KID:KEY    skip licensing, decrypt with explicit keys (repeatable,
                      or comma separated). KID may be omitted if only one key.
    --mp4decrypt P    path to the mp4decrypt binary (default: from PATH)
    --ffmpeg P        path to ffmpeg (default: from PATH)
    --keep            keep the .enc.* source files after a successful decrypt
    --watch           stay running and process new job files as they appear

Requires (for licensing):   pip install pywidevine requests
Requires (for decrypting):  Bento4 mp4decrypt, or ffmpeg built with CENC support

Only use this against content you are authorised to access.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

VIDEO_EXT = {".mp4", ".m4v", ".m4a", ".webm", ".mkv", ".ts"}
ENC_MARKERS = ".enc."


# ---------------------------------------------------------------- utilities
def log(msg: str) -> None:
    print(msg, flush=True)


def find_jobs(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*.widevine.json") if p.is_file())


def is_encrypted(path: Path) -> bool:
    return ENC_MARKERS in path.name or path.suffix in {".enc"}


def default_output(job: dict, job_path: Path) -> Path:
    out = job.get("output")
    if out:
        return Path(out)
    first = Path(job["files"][0])
    return first.with_name(first.name.replace(ENC_MARKERS, ".").rsplit(".", 1)[0] + ".mp4")


# ---------------------------------------------------------------- licensing
def fetch_keys_with_cdm(job: dict, cdm_path: Path) -> list[tuple[str, str]]:
    try:
        from pywidevine.cdm import Cdm
        from pywidevine.device import Device
        from pywidevine.pssh import PSSH
    except ImportError:
        raise SystemExit("pywidevine is not installed. Run: pip install pywidevine requests")

    import requests

    pssh_b64 = None
    for entry in job.get("pssh") or []:
        if entry.get("b64"):
            pssh_b64 = entry["b64"]
            break
    if not pssh_b64 and job.get("initData", {}).get("b64"):
        pssh_b64 = job["initData"]["b64"]
    if not pssh_b64:
        raise SystemExit("Job has no PSSH. Re-export it from the Live Sniffer tab while the lecture loads.")

    device = Device.load(str(cdm_path))
    cdm = Cdm.from_device(device)
    session_id = cdm.open()
    try:
        challenge = cdm.get_license_challenge(session_id, PSSH(pssh_b64))

        lic = job.get("license") or {}
        url = lic.get("url")
        if not url:
            raise SystemExit("Job has no license URL. Play the lecture once with DRM capture enabled, then re-export.")

        headers = {
            k: v
            for k, v in (lic.get("headers") or {}).items()
            if k.lower() not in {"content-length", "host", "connection", "accept-encoding"}
        }
        if lic.get("cookies"):
            headers.setdefault("Cookie", lic["cookies"])

        method = (lic.get("method") or "POST").upper()
        if method == "POST":
            resp = requests.post(url, data=challenge, headers=headers, timeout=30)
        else:
            resp = requests.get(url, headers=headers, timeout=30)

        if resp.status_code >= 400:
            raise SystemExit(f"License request failed: HTTP {resp.status_code} {resp.text[:300]}")

        cdm.parse_license(session_id, resp.content)
        keys = []
        for key in cdm.get_keys(session_id):
            if key.type not in ("CONTENT", "OPERATOR"):
                continue
            keys.append((key.kid.hex, key.key.hex()))
        if not keys:
            raise SystemExit("CDM returned no content keys (license may require a higher security level).")
        return keys
    finally:
        cdm.close(session_id)


def parse_key_args(values: list[str]) -> list[tuple[str, str]]:
    keys: list[tuple[str, str]] = []
    for value in values:
        for chunk in value.split(","):
            chunk = chunk.strip()
            if not chunk:
                continue
            if ":" in chunk:
                kid, key = chunk.split(":", 1)
                keys.append((kid.strip().lower(), key.strip().lower()))
            else:
                keys.append(("", chunk.lower()))
    return keys


# ---------------------------------------------------------------- decryption
def run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(f"Command failed ({proc.returncode}): {' '.join(cmd)}\n{proc.stderr[-2000:]}")


def decrypt_file(src: Path, dst: Path, keys: list[tuple[str, str]], mp4decrypt: str | None, ffmpeg: str) -> None:
    if mp4decrypt:
        cmd = [mp4decrypt]
        for kid, key in keys:
            cmd += ["--key", f"{kid}:{key}" if kid else key]
        cmd += [str(src), str(dst)]
        try:
            run(cmd)
            return
        except SystemExit as exc:
            log(f"  mp4decrypt failed, falling back to ffmpeg: {exc}")
    # ffmpeg only accepts a single --decryption_key per input; loop is handled by caller
    key = keys[0][1]
    run([ffmpeg, "-y", "-loglevel", "error", "-decryption_key", key, "-i", str(src), "-c", "copy", str(dst)])


def mux(video: Path, audio: Path | None, output: Path, ffmpeg: str) -> None:
    if audio and audio.exists():
        run([ffmpeg, "-y", "-loglevel", "error", "-i", str(video), "-i", str(audio),
             "-map", "0:v?", "-map", "1:a?", "-c", "copy", str(output)])
    else:
        shutil.move(str(video), str(output))


# ---------------------------------------------------------------- job driver
def process_job(job_path: Path, args) -> bool:
    job = json.loads(job_path.read_text(encoding="utf-8"))
    files = [Path(f) for f in job.get("files") or []]
    files = [f if f.is_absolute() else (job_path.parent / f) for f in files]
    files = [f for f in files if f.exists()]
    if not files:
        log(f"[skip] {job_path.name}: encrypted sources not found")
        return False

    output = default_output(job, job_path)
    if not output.is_absolute():
        output = job_path.parent / output
    if output.exists() and output.stat().st_size > 0:
        log(f"[skip] {output.name} already exists")
        return True

    keys = args.keys or []
    cache = job_path.with_suffix(".keys.json")
    if not keys and cache.exists():
        keys = [tuple(k) for k in json.loads(cache.read_text())]
    if not keys:
        if not args.cdm:
            log(f"[skip] {job_path.name}: no --keys and no --cdm supplied")
            return False
        log(f"[license] {job_path.name}")
        keys = fetch_keys_with_cdm(job, args.cdm)
        cache.write_text(json.dumps([list(k) for k in keys], indent=2), encoding="utf-8")
        log(f"  got {len(keys)} key(s)")
    else:
        log(f"[keys] using {len(keys)} supplied/cached key(s)")

    decrypted: list[Path] = []
    for src in files:
        dst = src.with_name(src.name.replace(ENC_MARKERS, ".").rsplit(".", 1)[0] + ".dec.mp4")
        log(f"  decrypt {src.name} -> {dst.name}")
        decrypt_file(src, dst, keys, args.mp4decrypt, args.ffmpeg)
        decrypted.append(dst)

    video = next((p for p in decrypted if ".audio." not in p.name), decrypted[0])
    audio = next((p for p in decrypted if ".audio." in p.name), None)
    mux(video, audio, output, args.ffmpeg)
    log(f"[done] {output}")

    if not args.keep:
        for p in decrypted:
            p.unlink(missing_ok=True)
        for src in files:
            src.unlink(missing_ok=True)
        job_path.unlink(missing_ok=True)
        cache.unlink(missing_ok=True)
    return True


def selftest() -> int:
    assert parse_key_args(["abc:def"]) == [("abc", "def")]
    assert parse_key_args(["abc:def,111:222"]) == [("abc", "def"), ("111", "222")]
    assert parse_key_args(["deadbeef"]) == [("", "deadbeef")]
    assert is_encrypted(Path("01 - Intro.enc.mp4"))
    assert not is_encrypted(Path("01 - Intro.mp4"))
    assert default_output({"files": ["a/01 - Intro.enc.mp4"]}, Path("a/job.widevine.json")).name == "01 - Intro.mp4"
    print("widevine_helper selftest OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Widevine license + CENC decrypt helper")
    ap.add_argument("folder", nargs="?", help="course/output folder containing *.widevine.json jobs")
    ap.add_argument("--cdm", type=Path, help="your own device .wvd file")
    ap.add_argument("--keys", nargs="*", default=[], help="explicit KID:KEY values")
    ap.add_argument("--mp4decrypt", default=None, help="mp4decrypt binary path")
    ap.add_argument("--ffmpeg", default="ffmpeg", help="ffmpeg binary path")
    ap.add_argument("--keep", action="store_true", help="keep encrypted sources")
    ap.add_argument("--watch", action="store_true", help="poll for new jobs")
    ap.add_argument("--selftest", action="store_true", help="run internal checks and exit")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    args.keys = parse_key_args(args.keys)

    if not args.ffmpeg or shutil.which(args.ffmpeg) is None:
        raise SystemExit("ffmpeg not found in PATH")

    root = args.folder if isinstance(args.folder, Path) else Path(args.folder or "")
    if not args.folder:
        raise SystemExit("folder argument is required (or pass --selftest)")
    if not root.exists():
        raise SystemExit(f"Folder not found: {root}")

    def pass_once() -> int:
        count = 0
        for job in find_jobs(root):
            if process_job(job, args):
                count += 1
        return count

    done = pass_once()
    if not args.watch:
        log(f"Processed {done} job(s).")
        return 0

    log("Watching for new *.widevine.json jobs (Ctrl+C to stop)...")
    try:
        while True:
            time.sleep(3)
            pass_once()
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
