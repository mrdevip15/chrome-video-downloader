# HANDOFF — resuming the DRM work

Snapshot for picking this back up after the bootloader-unlock wait.
Written at commit `3b08ea8`. Read alongside `tools/DRM-NOTES.md`, which holds the full
evidence trail (including every dead end, so nothing gets re-explored).

## Where this stands

| Piece | State |
|---|---|
| Extension: HLS AES-128 decrypt in-browser | **working** (unit test + Edge E2E green) |
| Extension: DRM export (`*.widevine.json` + encrypted fragments) | **working** |
| Udemy lecture resolution (KID, PSSH, license URL) | **working** via `tools/udemy_license.py` |
| `device.wvd` for real Widevine content | **blocked** — no L3 private key yet |
| Poco X3 NFC unlock | **waiting** on the Mi Unlock 168 h window |

Everything is blocked on exactly one object: the Widevine **device private key**. KID, PSSH,
license URL and request shape are all in hand; a license server rejects only the unsigned
challenge, which is what a CDM is for.

## How to resume this chat

Open a new session in `D:\WORK\chrome-video-downloader` and say something like:

> Baca `tools/HANDOFF.md` dan `tools/DRM-NOTES.md`, lalu lanjut dari bagian "Day of unlock".

The assistant needs no other context — those two files carry the state, the commands, and the
verified/refuted list. If a `widevine-drm-capture` skill is available, load it first; it encodes
the same workflow with the pitfalls already sorted.

Useful anchors for a fresh session:

* repo: `D:\WORK\chrome-video-downloader`, branch `main`, base commit `3b08ea8`
* extension version `3.1.0`, DRM mode selector in the manager page (Skip / Export)
* test commands: `node tests/unit-test.mjs`, `node tests/edge-e2e.mjs`,
  `python tools/wvd_setup.py selftest`, `python tools/widevine_helper.py --selftest`
* node needs the absolute path: `C:/nvm4w/nodejs/node.exe` (the `node` on PATH is broken)

## Environment inventory

| Thing | Path / value |
|---|---|
| adb + fastboot | `%LOCALAPPDATA%\Android\Sdk\platform-tools\` |
| emulator (L3, provisioned) | `emulator-5554`, AVD `L3`, Android 11 `google_apis` x86_64 |
| scratch artifacts | `%LOCALAPPDATA%\hermes\cache\scratch\wvd-work\` |
| — emulator IDM | `wvd-work\IDM1013\L3\` (certs + `ay64.dat`) |
| — symbols | `wvd-work\libwvhidl.so`, `libwvhidl_funcs.txt`, `symtab_funcs.txt` |
| — captures | `vec_dump.json`, `vec_heap.json`, `decrypt_params.json`, `decrypt_ptrs.json` |
| staged binaries (not in repo) | `wvd-work\bin\frida-server` (17.27.5, android-arm64) |
| host tooling | `keydive 3.0.6`, `frida-python 17.27.5`, `pywidevine` |

The scratch directory is safe to delete; nothing in the repo depends on it. Recreating the
emulator from zero is documented in `DRM-NOTES.md` §2.

## Day of unlock

The phone: Poco X3 NFC (`surya`, `M2007J20CG`), Android 12, MIUI `V14.0.2.0.SJGIDXM`,
`sys.oem_unlock_allowed=1`, currently `flash.locked=1`.

### 1. Confirm unlock took

```bash
ADB="$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe"
"$ADB" devices -l
"$ADB" -s <serial> shell "getprop ro.boot.flash.locked; which su; id"
```

Expect `flash.locked=0`. No `su` yet — Magisk is next.

### 2. Root with Magisk

1. Download the **fastboot ROM matching `V14.0.2.0.SJGIDXM`** and extract `boot.img`.
2. `adb push boot.img /sdcard/Download/`
3. On the phone: Magisk app → *Install* → *Select and Patch a File* → pick `boot.img`
   → output `/sdcard/Download/magisk_patched-*.img`
4. `adb pull /sdcard/Download/magisk_patched-*.img`
5. `adb reboot bootloader` → `fastboot flash boot magisk_patched-*.img` → `fastboot reboot`
6. Verify: `adb shell "su -c id"` → `uid=0`.

If Windows cannot see the phone in fastboot (`fastboot devices` empty while Device Manager
shows `USB\VID_18D1&PID_D00D` with status Error), install the Google USB driver or let the Mi
Unlock Tool install its own. That failure mode is already recorded in `DRM-NOTES.md`.

### 3. Dump the device key

```bash
adb -s <serial> push "%LOCALAPPDATA%\hermes\cache\scratch\wvd-work\bin\frida-server" /data/local/tmp/
adb -s <serial> shell "su -c 'chmod 755 /data/local/tmp/frida-server'"
adb -s <serial> shell "su -c '/data/local/tmp/frida-server &'"
keydive -s <serial>          # keep DRM content playing on the phone while it runs
```

Version match matters: host `frida-python` is 17.27.5, so the server must be 17.27.5.

### 4. Validate the `.wvd`

```bash
python -c "from pywidevine.device import Device; d=Device.load('device.wvd'); print(d.security_level)"
```

Must print `3`. A wrong or truncated key fails here, not later.

### 5. End-to-end on one Udemy lecture

```bash
# fresh job (the license token lives ~5 minutes — never reuse an old one)
python tools/udemy_license.py cookies.json 1659676 51267967 --out job.json

# local license + decrypt (no third party touches the token)
python tools/widevine_helper.py --cdm device.wvd job.json
```

`job.json` carries `pssh[]`, `kids[]` and the license URL with `auth_token` + `drm_type`;
`widevine_helper.py` builds the challenge with the CDM, POSTs it, then runs `mp4decrypt`
(falling back to `ffmpeg -decryption_key`) and muxes audio+video.

### 6. Verify before claiming success

```bash
ffprobe -v error -show_entries format=duration -of default=nw=1 out.mp4
ffmpeg -hide_banner -i out.mp4 -f null - 2>&1 | grep -Ei "Error submitting|Number of bands|Invalid data"
```

No decoder complaints and a sane duration = real decrypted video. Silence plus a plausible
file size can still be garbage.

## If the unlock never comes

Fallbacks, in order of preference:

1. Extension with DRM = **Skip** — most Udemy lectures are AES-128 and already work.
2. Any other **L3** Android device that can be rooted (the S24 Ultra is L1: useless here).
3. A third-party CDM service fed with PSSH + license URL. It works, but the license URL *is*
   a bearer credential for the account; only do this with an account you are willing to burn.

## Housekeeping

* Never commit cookies, license URLs or `.wvd` files. Secret grep before every commit:
  `grep -rilE "eyJhbG|ud_user_jwt|access_token" .`
* The session tokens pasted during this work are compromised; rotating the account password
  is the only remediation.
* `tools/wvd_dump*.py` / `wvd_hook*.js` are emulator probes kept for the record — they did not
  yield the key, and `DRM-NOTES.md` §5 explains why so they are not retried.
