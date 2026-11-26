#!/usr/bin/env python3
"""Dump the Widevine L3 device RSA key via offset hooks in libwvdrmengine.so.

Android strips crypto symbol names from .dynsym, so name-based hooks fail. The
library still ships .gnu_debugdata (MiniDebugInfo) with a real .symtab, which
yields exact addresses for:

    0x18a230  wvdrm::WVGenericCryptoInterface::loadDeviceRSAKey(uint, uchar const*, ulong)
    0x18a240  wvdrm::WVGenericCryptoInterface::generateRSASignature(...)

This script attaches to the widevine DRM hwservice, hooks loadDeviceRSAKey by
offset, force-restarts the service so the plugin re-reads its key, then triggers
a DRM session and captures the key blob.

Usage:
  python tools/wvd_dump2.py --serial emulator-5554 \
      --cert wvd-work/IDM1013/L3/certxxx.bin --out wvd-work/device.wvd

The captured blob is written to <out>.keyblob.bin for inspection; it is stored
as DER/PKCS#8 when the plugin hands over a plain RSA key, and left raw otherwise.
"""

from __future__ import annotations

import argparse
import binascii
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def adb_bin() -> str:
    import os
    import shutil

    env = os.environ.get("ADB_EXE")
    if env and Path(env).is_file():
        return env
    found = shutil.which("adb")
    if found:
        return found
    sdk = os.environ.get("ANDROID_SDK_ROOT") or os.environ.get("ANDROID_HOME")
    if sdk:
        cand = Path(sdk) / "platform-tools" / "adb.exe"
        if cand.is_file():
            return str(cand)
    local = Path(os.environ.get("LOCALAPPDATA", "")) / "Android" / "Sdk" / "platform-tools" / "adb.exe"
    if local.is_file():
        return str(local)
    raise SystemExit("adb not found — set ADB_EXE or ANDROID_SDK_ROOT")


ADB = adb_bin()


def adb(serial: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([ADB, "-s", serial, *args], capture_output=True, text=True)


def find_pid(device, needle: str):
    for proc in device.enumerate_processes():
        if needle in proc.name:
            return proc
    return None


def try_build_wvd(key_blob: bytes, cert_path: Path, out: Path) -> bool:
    """Build device.wvd if the blob really is an RSA private key."""
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
    except ImportError:
        return False

    key = None
    for loader in (
        lambda b: serialization.load_der_private_key(b, password=None),
        lambda b: serialization.load_pem_private_key(b, password=None),
        lambda b: serialization.load_der_public_key(b),
    ):
        try:
            key = loader(key_blob)
            break
        except Exception:
            continue
    if not isinstance(key, rsa.RSAPrivateKey):
        return False

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

    dev = Device(type_=DeviceTypes.ANDROID, security_level=3, flags=None,
                 private_key=pem, client_id=ci.SerializeToString())
    out.parent.mkdir(parents=True, exist_ok=True)
    dev.dump(out)
    print(f"wrote {out}")
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--serial", required=True)
    ap.add_argument("--cert", required=True, type=Path)
    ap.add_argument("--out", default=Path("device.wvd"), type=Path)
    ap.add_argument("--process", default="drm@1.0-service")
    ap.add_argument("--url", default="https://bitmovin.com/demos/drm")
    ap.add_argument("--timeout", type=float, default=90.0)
    ap.add_argument("--restart-service", action="store_true",
                    help="force-stop the DRM hwservice so it re-reads its key")
    args = ap.parse_args()

    try:
        import frida
    except ImportError:
        raise SystemExit("pip install frida")

    device = frida.get_device(args.serial, timeout=10)

    if args.restart_service:
        proc = find_pid(device, args.process)
        if proc:
            print(f"stopping {proc.name} (pid {proc.pid}) so init respawns it")
            adb(args.serial, "shell", f"kill {proc.pid}")
            time.sleep(2)

    proc = None
    for _ in range(20):
        proc = find_pid(device, args.process)
        if proc:
            break
        time.sleep(1)
    if not proc:
        raise SystemExit(f"process containing '{args.process}' not found")

    print(f"attaching to {proc.name} (pid {proc.pid})")
    session = device.attach(proc.pid)
    captured: dict = {}
    state = {"done": False}

    def on_message(message, data):
        if message.get("type") != "send":
            print("frida:", message)
            return
        p = message.get("payload") or {}
        if p.get("ready"):
            print(f"module base {p.get('base')} size {p.get('size')}")
            return
        if p.get("hooked"):
            print(f"hooked: {p['hooked']}")
            return
        if p.get("load"):
            captured.update(p["load"])
            print(f"captured key blob: {p['load']['len']} bytes, head {p['load']['head']}")
            state["done"] = True
            return
        if p.get("sign"):
            print(f"generateRSASignature fired (session {p['sign']['sessionId']}, {p['sign']['len']} bytes)")
            return
        if p.get("error"):
            print("error:", p["error"])
            return
        if p.get("note"):
            print("note:", p["note"])

    script = session.create_script((HERE / "wvd_hook2.js").read_text(encoding="utf-8"))
    script.on("message", on_message)
    script.load()
    time.sleep(1)

    adb(args.serial, "shell", "am", "force-stop", "com.android.chrome")
    time.sleep(1)
    adb(args.serial, "shell", "am", "start", "-n", "com.android.chrome/com.google.android.apps.chrome.Main",
        "-a", "android.intent.action.VIEW", "-d", args.url)

    deadline = time.time() + args.timeout
    while time.time() < deadline and not state["done"]:
        time.sleep(0.5)

    session.detach()

    if not captured:
        raise SystemExit("loadDeviceRSAKey never fired — try --restart-service")

    blob = binascii.unhexlify(captured["hex"])
    blob_path = args.out.with_suffix(".keyblob.bin")
    blob_path.parent.mkdir(parents=True, exist_ok=True)
    blob_path.write_bytes(blob)
    print(f"saved {blob_path} ({len(blob)} bytes)")

    if try_build_wvd(blob, args.cert, args.out):
        return 0

    print("blob is not a DER/PEM RSA private key; inspect it before mapping:")
    for off in range(0, min(len(blob), 64), 16):
        chunk = blob[off:off + 16]
        print(f"  {off:04x}  {chunk.hex(' ')}  {''.join(chr(b) if 32 <= b < 127 else '.' for b in chunk)}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
