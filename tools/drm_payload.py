#!/usr/bin/env python3
"""Turn an exported ``*.widevine.json`` job into copy-paste license fields.

The extension writes one of these next to every encrypted asset when DRM mode is
"export". It already holds everything a license request needs (PSSH, license URL,
request headers, request body), which is exactly what the manual key-service
workflow asks for.

Usage:
  python tools/drm_payload.py path/to/asset.widevine.json
  python tools/drm_payload.py path/to/folder --json payload.json
  python tools/drm_payload.py path/to/asset.widevine.json --show-cookies

Output is plain text so it can be pasted into any license console or piped into
tools/widevine_helper.py.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

SKIP_HEADERS = {
    "content-length",
    "accept-encoding",
    "connection",
    "host",
    ":authority",
    ":method",
    ":path",
    ":scheme",
}


def find_jobs(target: Path) -> list[Path]:
    if target.is_file():
        return [target]
    return sorted(target.rglob("*.widevine.json"))


def first_pssh(job: dict) -> str | None:
    for entry in job.get("pssh") or []:
        if isinstance(entry, dict) and entry.get("b64"):
            return entry["b64"]
        if isinstance(entry, str) and entry:
            return entry
    init = job.get("initData")
    if isinstance(init, str) and init:
        try:
            return base64.b64encode(base64.b64decode(init)).decode()
        except Exception:
            return init
    return None


def header_lines(headers: dict, show_cookies: bool, cookies: str) -> list[str]:
    out = []
    for key, value in (headers or {}).items():
        low = key.lower()
        if low in SKIP_HEADERS:
            continue
        if low == "cookie" and not show_cookies:
            out.append("Cookie: <redacted, rerun with --show-cookies>")
            continue
        out.append(f"{key}: {value}")
    if cookies and show_cookies and "cookie" not in {k.lower() for k in (headers or {})}:
        out.append(f"Cookie: {cookies}")
    return out


def describe(job: dict, path: Path, show_cookies: bool) -> tuple[str, dict]:
    lic = job.get("license") or {}
    pssh = first_pssh(job)
    kids = [k.get("kid") if isinstance(k, dict) else k for k in (job.get("kids") or [])]
    files = job.get("files") or []
    lines = [
        f"=== {path.name}",
        f"files      : {len(files)} ({', '.join(Path(f.get('name') or f.get('path') or '?').name if isinstance(f, dict) else str(f) for f in files[:4]) or '-'})",
        f"encryption : {job.get('encryption') or 'unknown'}",
        f"kids       : {', '.join(str(k) for k in kids) or '-'}",
        f"license    : {lic.get('method', 'POST')} {lic.get('url') or '-'}",
        "",
        "PSSH (base64):",
        pssh or "<none captured>",
        "",
        "Headers:",
    ]
    lines.extend(header_lines(lic.get("headers") or {}, show_cookies, lic.get("cookies") or "") or ["<none captured>"])
    if lic.get("bodyBase64"):
        lines += ["", "Request body (base64):", lic["bodyBase64"]]

    payload = {
        "license": lic.get("url"),
        "method": lic.get("method", "POST"),
        "pssh": pssh,
        "kids": kids,
        "headers": {k: v for k, v in (lic.get("headers") or {}).items()},
        "bodyBase64": lic.get("bodyBase64"),
    }
    return "\n".join(lines), payload


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("target", type=Path, help="a .widevine.json file or a folder to scan")
    ap.add_argument("--json", type=Path, help="also write the machine-readable payload here")
    ap.add_argument("--show-cookies", action="store_true",
                    help="print Cookie headers verbatim instead of redacting them")
    args = ap.parse_args()

    jobs = find_jobs(args.target)
    if not jobs:
        print(f"no *.widevine.json found under {args.target}", file=sys.stderr)
        return 1

    payloads = []
    for path in jobs:
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"=== {path.name}\n  unreadable: {exc}\n", file=sys.stderr)
            continue
        text, payload = describe(job, path, args.show_cookies)
        print(text, end="\n\n")
        payload["source"] = str(path)
        payloads.append(payload)

    if args.json:
        args.json.write_text(json.dumps(payloads, indent=2), encoding="utf-8")
        print(f"payload written: {args.json}")

    if any((p.get("headers") or {}).get("Cookie") for p in payloads) and not args.show_cookies:
        print("note: Cookie headers are redacted. Session cookies grant account access — "
              "do not paste them into a third-party service you would not give your password to.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
