#!/usr/bin/env python3
"""Dump the Widevine L3 device RSA key using offset hooks in libwvhidl.so.

Why offsets: Android builds strip crypto names from .dynsym, so Frida cannot find
RSA_sign / loadDeviceRSAKey by name. The library still carries .gnu_debugdata
(MiniDebugInfo) with the full .symtab, which gives exact function addresses:

    libwvhidl.so 0x1ab8b0  wvdrm::WVGenericCryptoInterface::loadDeviceRSAKey(uint, uchar const*, ulong)
    libwvhidl.so 0x18a240  (legacy plugin equivalent, if you target libwvdrmengine.so)

Module base + st_value == runtime address, so a Frida Interceptor at
base+offset captures the key blob the CDM hands to its crypto backend.

Usage:
  python tools/wvd_dump3.py --serial emulator-5554 \
      --module libwvhidl.so --load 0x1ab8b0 \
      --process "drm@1.3-service.widevine" \
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
    raise SystemExit("adb not found — set ADB_EXE or ANDROID_SDK_ROOT")


ADB = adb_bin()


def adb(serial: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([ADB, "-s", serial, *args], capture_output=True, text=True)


def find_pid(device, needle: str):
    for proc in device.enumerate_processes():
        if needle in proc.name:
            return proc
    return None


def build_wvd(key_blob: bytes, cert_path: Path, out: Path) -> str:
    """Return a status string; builds device.wvd when the blob is a real RSA key."""
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
    except ImportError:
        return "cryptography missing (pip install cryptography)"

    key = None
    for loader in (
        lambda b: serialization.load_der_private_key(b, password=None),
        lambda b: serialization.load_pem_private_key(b, password=None),
    ):
        try:
            key = loader(key_blob)
            break
        except Exception:
            continue
    if not isinstance(key, rsa.RSAPrivateKey):
        # Last resort: the blob may be PKCS#1 with a trailing MAC/padding.
        for cut in (64, 32, 16, 8, 4):
            try:
                key = serialization.load_der_private_key(key_blob[:-cut], password=None)
                if isinstance(key, rsa.RSAPrivateKey):
                    print(f"  (parsed after trimming {cut} trailing bytes)")
                    break
            except Exception:
                key = None
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
    ap.add_argument("--sign", type=lambda v: int(v, 0), default=0)
    ap.add_argument("--process", default="drm@1.3-service.widevine")
    ap.add_argument("--cert", required=True, type=Path)
    ap.add_argument("--out", default=Path("device.wvd"), type=Path)
    ap.add_argument("--url", default="https://bitmovin.com/demos/drm")
    ap.add_argument("--timeout", type=float, default=120.0)
    ap.add_argument("--no-trigger", action="store_true")
    args = ap.parse_args()

    try:
        import frida
    except ImportError:
        raise SystemExit("pip install frida")

    device = frida.get_device(args.serial, timeout=10)
    proc = find_pid(device, args.process)
    if not proc:
        raise SystemExit(f"process containing '{args.process}' not found")
    print(f"attaching to {proc.name} (pid {proc.pid})")

    session = device.attach(proc.pid)
    cfg = {"module": args.module, "load": args.load, "sign": args.sign}
    source = (HERE / "wvd_hook3.js").read_text(encoding="utf-8").replace("__CFG__", json.dumps(cfg))

    captured: dict = {}
    state = {"done": False}

    def on_message(message, data):
        if message.get("type") != "send":
            print("frida:", message)
            return
        p = message.get("payload") or {}
        if p.get("ready"):
            print(f"module {args.module} base {p['base']} size {p['size']}")
        elif p.get("hooked"):
            print(f"hooked: {p['hooked']}")
        elif p.get("hit"):
            print(f"{p['hit']}: {p['len']} bytes, head {p['head']}")
            captured.update(p)
            state["done"] = True
        elif p.get("note"):
            print("note:", p["note"])
        elif p.get("error"):
            print("error:", p["error"])
        else:
            print("frida payload:", p)

    script = session.create_script(source)
    script.on("message", on_message)
    script.load()
    time.sleep(1)

    if not args.no_trigger:
        adb(args.serial, "shell", "am", "force-stop", "com.android.chrome")
        time.sleep(1)
        adb(args.serial, "shell", "am", "start", "-n",
            "com.android.chrome/com.google.android.apps.chrome.Main",
            "-a", "android.intent.action.VIEW", "-d", args.url)
        print("playback triggered, waiting for the key load...")

    deadline = time.time() + args.timeout
    while time.time() < deadline and not state["done"]:
        time.sleep(0.5)
    session.detach()

    if not captured:
        print("no key material captured")
        return 2

    blob = binascii.unhexlify(captured["hex"])
    blob_path = args.out.with_suffix(".keyblob.bin")
    blob_path.parent.mkdir(parents=True, exist_ok=True)
    blob_path.write_bytes(blob)
    print(f"saved {blob_path} ({len(blob)} bytes)")

    status = build_wvd(blob, args.cert, args.out)
    print(status)
    if status.startswith("wrote"):
        return 0

    for off in range(0, min(len(blob), 96), 16):
        chunk = blob[off:off + 16]
        print(f"  {off:04x}  {chunk.hex(' ')}  {''.join(chr(b) if 32 <= b < 127 else '.' for b in chunk)}")
    return 3


if __name__ == "__main__":
    sys.exit(main())
