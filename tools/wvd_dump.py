#!/usr/bin/env python3
"""Dump a Widevine L3 device key from an Android emulator/device via Frida.

Pipeline:
  1. attach to the Widevine DRM service process
  2. hook RSA_sign / RSA_private_encrypt (tools/wvd_hook.js)
  3. trigger a DRM session (play a test stream) so the CDM signs a license challenge
  4. capture n/e/d/p/q, rebuild private_key.pem
  5. wrap the provisioned SignedDrmCertificate from the IDM folder into client_id.bin
  6. emit device.wvd (not written until both parts exist)

Usage:
  python tools/wvd_dump.py --serial emulator-5554 \
      --cert wvd-work/IDM1013/L3/certxxxx.bin \
      --out wvd-work/device.wvd \
      --trigger "https://bitmovin.com/demos/drm"

Requires: pip install frida cryptography pywidevine ; frida-server running on the device
as root (tools/wvd_setup.py has the adb helpers for the pull side).
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def build_private_key_pem(n: str, e: str, d: str, p: str | None, q: str | None) -> bytes:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    N = int(n, 16)
    E = int(e, 16)
    D = int(d, 16)
    if not p or not q:
        raise SystemExit("no RSA factors captured — RSA_get0_factors unavailable; cannot build a PKCS#1 key")
    P = int(p, 16)
    Q = int(q, 16)
    if P * Q != N:
        P, Q = Q, P
    if P * Q != N:
        raise SystemExit("captured factors do not multiply to the modulus")
    dmp1 = D % (P - 1)
    dmq1 = D % (Q - 1)
    iqmp = pow(Q, -1, P)
    priv = rsa.RSAPrivateNumbers(
        p=P, q=Q, d=D, dmp1=dmp1, dmq1=dmq1, iqmp=iqmp,
        public_numbers=rsa.RSAPublicNumbers(E, N),
    ).private_key()
    return priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )


def build_client_id(cert_path: Path) -> bytes:
    """pywidevine parses ClientIdentification.token as the SignedDrmCertificate,
    so the client id is simply that token plus the matching client metadata."""
    from pywidevine.license_protocol_pb2 import ClientIdentification, SignedDrmCertificate

    cert_bytes = cert_path.read_bytes()
    cert = SignedDrmCertificate()
    cert.ParseFromString(cert_bytes)  # fail fast if the file is not a device certificate

    ci = ClientIdentification()
    ci.token = cert_bytes
    ci.client_info.add().name = "wvd-dump"
    return ci.SerializeToString()


def find_target(device, needle: str):
    for proc in device.enumerate_processes():
        if needle in proc.name:
            return proc
    raise SystemExit(f"process containing '{needle}' not found")


def trigger(serial: str, url: str | None) -> None:
    if not url:
        return
    adb = subprocess.run(
        ["adb", "-s", serial, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url],
        capture_output=True, text=True,
    )
    print(f"triggered playback via adb ({adb.returncode})")


def main() -> int:
    ap = argparse.ArgumentParser(description="Dump Widevine L3 key via Frida and build device.wvd")
    ap.add_argument("--serial", required=True, help="adb serial, e.g. emulator-5554")
    ap.add_argument("--process", default="android.hardware.drm", help="DRM service process name substring")
    ap.add_argument("--cert", required=True, type=Path, help="SignedDrmCertificate .bin from the IDM folder")
    ap.add_argument("--out", default=Path("device.wvd"), type=Path)
    ap.add_argument("--trigger", default=None, help="URL to open for a DRM session")
    ap.add_argument("--timeout", type=float, default=120.0)
    ap.add_argument("--save-keys", type=Path, default=None, help="optional JSON of captured key material")
    args = ap.parse_args()

    try:
        import frida
    except ImportError:
        raise SystemExit("frida is not installed: pip install frida")

    if not args.cert.is_file():
        raise SystemExit(f"cert not found: {args.cert}")

    device = frida.get_device(args.serial, timeout=10)
    proc = find_target(device, args.process)
    print(f"attaching to {proc.name} (pid {proc.pid})")
    session = device.attach(proc.pid)

    state: dict = {}
    done = {"ok": False}

    def on_message(message, data):
        if message.get("type") != "send":
            print("frida:", message)
            return
        payload = message.get("payload") or {}
        if payload.get("ready"):
            print(f"hooks: {payload.get('hooked')} modules: {payload.get('modules')}")
            return
        if "error" in payload:
            print("hook error:", payload["error"])
            return
        if payload.get("n"):
            state.update(payload)
            print("captured RSA key material")
            done["ok"] = True

    script = session.create_script((HERE / "wvd_hook.js").read_text(encoding="utf-8"))
    script.on("message", on_message)
    script.load()

    time.sleep(1)
    trigger(args.serial, args.trigger)
    print("waiting for a DRM signature (start playback if nothing happens)...")
    deadline = time.time() + args.timeout
    while time.time() < deadline and not done["ok"]:
        time.sleep(0.5)

    session.detach()
    if not done["ok"]:
        raise SystemExit("no key material captured — play a Widevine stream and retry")

    if args.save_keys:
        args.save_keys.write_text(
            "\n".join(f"{k}={v}" for k, v in state.items()), encoding="utf-8"
        )

    pem = build_private_key_pem(state["n"], state["e"], state["d"], state.get("p"), state.get("q"))
    key_path = args.out.with_name("private_key.pem")
    key_path.write_bytes(pem)
    client_id = build_client_id(args.cert)
    cid_path = args.out.with_name("client_id.bin")
    cid_path.write_bytes(client_id)

    from pywidevine.device import Device, DeviceTypes

    dev = Device(type_=DeviceTypes.ANDROID, security_level=3, flags=None,
                 private_key=pem, client_id=client_id)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    dev.dump(args.out)
    print(f"wrote {args.out} (+ {key_path.name}, {cid_path.name})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
