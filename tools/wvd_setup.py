#!/usr/bin/env python3
"""Build and verify a Widevine .wvd device file (helper for widevine_helper.py).

What a .wvd is: a container holding a CDM Client ID (protobuf) plus the RSA
private key that CDM uses to sign license challenges, tagged with a device type
and security level. pywidevine loads it and does the license exchange.

Two ways to get one:

  A) You already dumped the CDM material from a device you own, giving you
     client_id.bin + private_key.pem  ->  use `build`.
  B) You want to see what the device exposes first  ->  use `check` / `pull`
     to locate the IDM credential blob and the Widevine engine library on a
     rooted Android device or emulator, then run a dumper over those files to
     obtain client_id.bin + private_key.pem.

Usage:
  python tools/wvd_setup.py check
  python tools/wvd_setup.py pull --out wvd-work
  python tools/wvd_setup.py build --client-id wvd-work/client_id.bin \
      --private-key wvd-work/private_key.pem --out device.wvd --level 3
  python tools/wvd_setup.py verify device.wvd
  python tools/wvd_setup.py selftest

Requires: pip install pywidevine ; adb on PATH for check/pull.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

DEVICE_TYPES = {"CHROME": 1, "ANDROID": 2, "IOS": 3}

# Where Android keeps the provisioned Widevine credentials and the engine.
IDM_CANDIDATES = [
    "/data/mediadrm",
    "/data/vendor/mediadrm",
    "/mnt/vendor/persist/mediadrm",
    "/persist/mediadrm",
]
ENGINE_CANDIDATES = [
    "/vendor/lib64/mediadrm",
    "/vendor/lib/mediadrm",
    "/vendor/lib64",
    "/vendor/lib",
    "/system/lib64/mediadrm",
    "/system/lib/mediadrm",
]
ENGINE_PATTERNS = ("*wvdrmengine*", "*wvhidl*", "*widevine*", "libwv*")


def run(cmd: list[str], check: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, check=check)


# ------------------------------------------------------------------ build
def build_wvd(client_id: Path, private_key: Path, out: Path, device_type: str, level: int) -> Path:
    try:
        from pywidevine.device import Device, DeviceTypes
    except ImportError:
        raise SystemExit("pywidevine is not installed: pip install pywidevine")

    if not client_id.is_file():
        raise SystemExit(f"client id not found: {client_id}")
    if not private_key.is_file():
        raise SystemExit(f"private key not found: {private_key}")

    key_bytes = private_key.read_bytes()
    if b"PRIVATE KEY" not in key_bytes:
        raise SystemExit("private key does not look like PEM (expected -----BEGIN PRIVATE KEY-----)")

    type_name = device_type.upper()
    if type_name not in DEVICE_TYPES:
        raise SystemExit(f"device type must be one of {sorted(DEVICE_TYPES)}")
    if level not in (1, 2, 3):
        raise SystemExit("security level must be 1, 2 or 3")

    dtype = getattr(DeviceTypes, type_name)
    device = Device(
        type_=dtype,
        security_level=level,
        flags=None,
        private_key=key_bytes,
        client_id=client_id.read_bytes(),
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    device.dump(out)
    return out


def verify_wvd(path: Path) -> None:
    try:
        from pywidevine.device import Device
    except ImportError:
        raise SystemExit("pywidevine is not installed: pip install pywidevine")
    if not path.is_file():
        raise SystemExit(f"wvd not found: {path}")
    try:
        device = Device.load(path)
    except Exception as exc:  # noqa: BLE001 - surface pywidevine's parse error
        raise SystemExit(f"invalid .wvd: {exc}")
    type_name = next((k for k, v in DEVICE_TYPES.items() if v == int(device.type)), "UNKNOWN")
    print(f"OK  {path}")
    print(f"    type           : {type_name}")
    print(f"    security_level : {device.security_level}")
    print(f"    client_id      : {len(device.client_id)} bytes")
    print(f"    private_key    : {len(device.private_key)} bytes")
    if device.security_level != 3:
        print("    note           : level != 3 will not work with most license servers")


# ------------------------------------------------------------------ device
def adb(args: list[str]) -> subprocess.CompletedProcess:
    return run(["adb", *args])


def check_device(serial: str | None) -> None:
    if shutil.which("adb") is None:
        raise SystemExit("adb not found on PATH (Android platform-tools)")
    dev = adb(["devices"])
    print(dev.stdout.strip() or "(no adb output)")
    prefix = ["-s", serial] if serial else []
    whoami = adb([*prefix, "shell", "id"])
    print("shell id:", (whoami.stdout or whoami.stderr).strip())
    print("\nIDM credential locations:")
    for base in IDM_CANDIDATES:
        listing = adb([*prefix, "shell", f"ls -la {base} 2>/dev/null"])
        for line in (listing.stdout or "").splitlines():
            if line.strip():
                print(f"  {base}: {line.strip()}")
    print("\nWidevine engine libraries:")
    for base in ENGINE_CANDIDATES:
        for pattern in ENGINE_PATTERNS:
            found = adb([*prefix, "shell", f"ls {base}/{pattern} 2>/dev/null"])
            for line in (found.stdout or "").splitlines():
                if line.strip():
                    print(f"  {line.strip()}")


def pull_artifacts(serial: str | None, out_dir: Path) -> None:
    if shutil.which("adb") is None:
        raise SystemExit("adb not found on PATH")
    out_dir.mkdir(parents=True, exist_ok=True)
    prefix = ["-s", serial] if serial else []

    pulled = 0
    for base in IDM_CANDIDATES:
        listing = adb([*prefix, "shell", f"ls {base} 2>/dev/null"])
        for name in (listing.stdout or "").split():
            remote = f"{base}/{name}".replace("//", "/")
            local = out_dir / Path(remote).name
            res = adb([*prefix, "pull", remote, str(local)])
            if res.returncode == 0:
                print(f"pulled {remote} -> {local}")
                pulled += 1
            else:
                print(f"failed {remote}: {res.stderr.strip()}")

    for base in ENGINE_CANDIDATES:
        for pattern in ENGINE_PATTERNS:
            found = adb([*prefix, "shell", f"ls {base}/{pattern} 2>/dev/null"])
            for remote in (found.stdout or "").split():
                local = out_dir / Path(remote).name
                res = adb([*prefix, "pull", remote, str(local)])
                if res.returncode == 0:
                    print(f"pulled {remote} -> {local}")
                    pulled += 1

    if not pulled:
        print("nothing pulled. On a non-rooted device these paths are unreadable; "
              "run `adb root` (emulator/Google-APIs image) or use a rooted device, "
              "and start a DRM app once so the IDM blob gets provisioned.")
        return
    print("\nNext: run your Widevine dumper over these files to obtain "
          "client_id.bin + private_key.pem, then `build`.")


# ------------------------------------------------------------------ selftest
def selftest() -> int:
    """Verify input handling. A .wvd cannot be fabricated: pywidevine requires a
    real provisioned client_id (it parses the SignedDrmCertificate inside it),
    so the test asserts we fail loudly on bogus inputs instead."""
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
    except ImportError:
        raise SystemExit("cryptography is required (it ships with pywidevine): pip install cryptography")

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pem = key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        (tmp_dir / "private_key.pem").write_bytes(pem)
        (tmp_dir / "not_a_key.pem").write_bytes(b"nope")
        (tmp_dir / "client_id.bin").write_bytes(b"\x00fake")

        # 1. non-PEM key is rejected
        try:
            build_wvd(tmp_dir / "client_id.bin", tmp_dir / "not_a_key.pem", tmp_dir / "x.wvd", "ANDROID", 3)
        except SystemExit as exc:
            assert "PEM" in str(exc)
        else:
            raise AssertionError("expected a PEM validation error")

        # 2. security level validation
        try:
            build_wvd(tmp_dir / "client_id.bin", tmp_dir / "private_key.pem", tmp_dir / "x.wvd", "ANDROID", 7)
        except SystemExit as exc:
            assert "security level" in str(exc)
        else:
            raise AssertionError("expected a security level validation error")

        # 3. bogus client_id is rejected by pywidevine, not silently accepted
        try:
            build_wvd(tmp_dir / "client_id.bin", tmp_dir / "private_key.pem", tmp_dir / "x.wvd", "ANDROID", 3)
        except SystemExit as exc:
            raise AssertionError(f"unexpected SystemExit: {exc}")
        except Exception:  # noqa: BLE001 - pywidevine DecodeError is the expected outcome
            pass
        else:
            raise AssertionError("expected pywidevine to reject a non-provisioned client id")

        print("selftest OK (validates key/PEM, security level, and client_id parsing)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Build/verify Widevine .wvd device files")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_check = sub.add_parser("check", help="inspect a connected Android device/emulator")
    p_check.add_argument("--serial")

    p_pull = sub.add_parser("pull", help="pull IDM + Widevine engine files")
    p_pull.add_argument("--serial")
    p_pull.add_argument("--out", default="wvd-work", type=Path)

    p_build = sub.add_parser("build", help="build a .wvd from client id + private key")
    p_build.add_argument("--client-id", required=True, type=Path)
    p_build.add_argument("--private-key", required=True, type=Path)
    p_build.add_argument("--out", default="device.wvd", type=Path)
    p_build.add_argument("--type", default="ANDROID", choices=sorted(DEVICE_TYPES))
    p_build.add_argument("--level", type=int, default=3)

    p_verify = sub.add_parser("verify", help="validate an existing .wvd")
    p_verify.add_argument("path", type=Path)

    sub.add_parser("selftest", help="build + re-parse a throwaway .wvd")

    args = ap.parse_args()
    if args.cmd == "check":
        check_device(args.serial)
        return 0
    if args.cmd == "pull":
        pull_artifacts(args.serial, args.out)
        return 0
    if args.cmd == "build":
        out = build_wvd(args.client_id, args.private_key, args.out, args.type, args.level)
        print(f"wrote {out}")
        verify_wvd(out)
        return 0
    if args.cmd == "verify":
        verify_wvd(args.path)
        return 0
    if args.cmd == "selftest":
        return selftest()
    return 1


if __name__ == "__main__":
    sys.exit(main())
