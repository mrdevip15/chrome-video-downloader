#!/usr/bin/env python3
"""Win the race against plugin init: kill the widevine DRM service, grep its
respawn, attach + hook loadDeviceRSAKey before the CDM reads its keybox.

The CDM only calls loadDeviceRSAKey once per plugin instance, so a hook that
arrives after service start never fires. This script polls enumerate_processes
in a tight loop, attaches the moment the new pid appears, installs the offset
hook (base + st_value from .gnu_debugdata), then triggers a DRM session.

Usage:
  python tools/wvd_dump4.py --serial emulator-5554 \
      --cert wvd-work/IDM1013/L3/certxxx.bin --out wvd-work/device.wvd
"""

from __future__ import annotations

import argparse
import binascii
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def adb_bin() -> str:
    env = os.environ.get("ADB_EXE")
    if env and Path(env).is_file():
        return env
    found = shutil.which("adb")
    if found:
        return found
    for root in (os.environ.get("ANDROID_SDK_ROOT"), os.environ.get("ANDROID_HOME"),
                 str(Path(os.environ.get("LOCALAPPDATA", "")) / "Android" / "Sdk")):
        if not root:
            continue
        cand = Path(root) / "platform-tools" / "adb.exe"
        if cand.is_file():
            return str(cand)
    raise SystemExit("adb not found — set ADB_EXE")


ADB = adb_bin()


def adb(serial: str, *args: str) -> None:
    subprocess.run([ADB, "-s", serial, *args], capture_output=True, text=True)


def pids_for(device, needle: str):
    return [p.pid for p in device.enumerate_processes() if needle in p.name]


def build_wvd(blob: bytes, cert_path: Path, out: Path) -> str:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = None
    candidates = [blob] + [blob[:-n] for n in (16, 32, 64, 128) if len(blob) > n]
    for cand in candidates:
        try:
            k = serialization.load_der_private_key(cand, password=None)
        except Exception:
            continue
        if isinstance(k, rsa.RSAPrivateKey):
            key = k
            break
    if not isinstance(key, rsa.RSAPrivateKey):
        return "not a parsable RSA private key"

    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    from pywidevine.license_protocol_pb2 import ClientIdentification, SignedDrmCertificate
    from pywidevine.device import Device, DeviceTypes

    cert_bytes = cert_path.read_bytes()
    SignedDrmCertificate().ParseFromString(cert_bytes)
    ci = ClientIdentification()
    ci.token = cert_bytes
    ci.client_info.add().name = "wvd-dump"

    out.parent.mkdir(parents=True, exist_ok=True)
    Device(type_=DeviceTypes.ANDROID, security_level=3, flags=None,
           private_key=pem, client_id=ci.SerializeToString()).dump(out)
    return f"wrote {out}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--serial", required=True)
    ap.add_argument("--module", default="libwvhidl.so")
    ap.add_argument("--load", type=lambda v: int(v, 0), default=0x1AB8B0)
    ap.add_argument("--process", default="drm@1.3-service.widevine")
    ap.add_argument("--cert", required=True, type=Path)
    ap.add_argument("--out", default=Path("device.wvd"), type=Path)
    ap.add_argument("--url", default="http://localhost:8123/drm-test.html")
    ap.add_argument("--timeout", type=float, default=90.0)
    ap.add_argument("--race-window", type=float, default=5.0)
    args = ap.parse_args()

    import frida

    device = frida.get_device(args.serial, timeout=10)
    old = pids_for(device, args.process)
    print(f"current pids: {old}")

    cfg = {"module": args.module, "load": args.load, "sign": 0}
    source = (HERE / "wvd_hook3.js").read_text(encoding="utf-8").replace("__CFG__", json.dumps(cfg))

    captured: dict = {}
    state = {"done": False}
    session = None
    script = None

    def on_message(message, data):
        if message.get("type") != "send":
            return
        p = message.get("payload") or {}
        if p.get("ready"):
            print(f"  module base {p['base']}")
        elif p.get("hooked"):
            print(f"  hooked {p['hooked']}")
        elif p.get("hit"):
            print(f"  HIT {p['hit']}: {p['len']} bytes head {p['head']}")
            captured.update(p)
            state["done"] = True
        elif p.get("note"):
            print("  note:", p["note"])
        elif p.get("error"):
            print("  error:", p["error"])

    for pid in old:
        print(f"stopping pid {pid}")
        adb(args.serial, "shell", f"kill {pid}")

    deadline = time.time() + args.race_window
    new_pid = None
    while time.time() < deadline:
        fresh = [p for p in pids_for(device, args.process) if p not in old]
        if fresh:
            new_pid = fresh[0]
            try:
                session = device.attach(new_pid)
                script = session.create_script(source)
                script.on("message", on_message)
                script.load()
                print(f"attached to respawned pid {new_pid}")
                break
            except Exception as exc:  # process may still be starting
                print(f"  attach retry ({exc})")
                time.sleep(0.02)
        time.sleep(0.02)

    if not script:
        raise SystemExit("lost the race — plugin already read its keybox")

    time.sleep(1.0)
    adb(args.serial, "shell", "am", "force-stop", "com.android.chrome")
    time.sleep(1)
    adb(args.serial, "shell", "am", "start", "-n",
        "com.android.chrome/com.google.android.apps.chrome.Main",
        "-a", "android.intent.action.VIEW", "-d", args.url)
    print("session triggered, waiting for key load...")

    end = time.time() + args.timeout
    while time.time() < end and not state["done"]:
        time.sleep(0.3)
    try:
        session.detach()
    except Exception:
        pass

    if not captured:
        print("no key load captured")
        return 2

    blob = binascii.unhexlify(captured["hex"])
    blob_path = args.out.with_suffix(".keyblob.bin")
    blob_path.write_bytes(blob)
    print(f"saved {blob_path} ({len(blob)} bytes)")
    status = build_wvd(blob, args.cert, args.out)
    print(status)
    return 0 if status.startswith("wrote") else 3


if __name__ == "__main__":
    sys.exit(main())
