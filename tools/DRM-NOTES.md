# DRM notes — Widevine L3 on emulator (verified findings)

Working notes for the DRM export path in this extension. Everything below was executed
and verified on an Android 11 `google_apis` x86_64 emulator (AVD `L3`, `sdk_gphone_x86_64`).
Nothing here is inferred from documentation alone; failed guesses are recorded too so
nobody repeats them.

## 1. What already works without any `.wvd`

`lib/engine.js` decrypts HLS **AES-128** in-browser (`#EXT-X-KEY: METHOD=AES-128`), derives
the IV from `#EXT-X-MEDIA-SEQUENCE` when the playlist omits it, then remuxes to MP4.
Most Udemy lectures use this scheme, so DRM mode can stay `skip`.

Verified by `tests/unit-test.mjs` (segments encrypted with Node crypto, decrypted by the
engine, remuxed, `ffprobe` duration 6.09 s, clean full decode) and `tests/edge-e2e.mjs`.

SAMPLE-AES and anything with `ContentProtection` (Widevine) is *not* handled in-browser:
export mode saves encrypted fragments (`.enc.mp4` / `.audio.enc.m4a`) plus a
`<base>.widevine.json` job for `tools/widevine_helper.py`.

## 2. Emulator provisioning (works)

```bash
adb root
adb shell am start -n com.android.chrome/com.google.android.apps.chrome.Main \
  -a android.intent.action.VIEW -d 'https://bitmovin.com/demos/drm'
adb pull /data/vendor/mediadrm/IDM1013 ./IDM1013
```

Produces `IDM1013/L3/` with:

- `cert<b64>.bin` — 3056-byte `SignedDrmCertificate` (parses cleanly with pywidevine)
- `ay64.dat` — 128-byte encrypted keybox (private key lives here, wrapped)
- `ay64.dat5`, `ay64.dat6`, `usgtable.bin`

`Device(client_id=…)` accepts the certificate as `ClientIdentification.token`
(3071 bytes, `security_level=3`, `Device.load()` round-trips). So the **client id half of a
`.wvd` is solved**; only the RSA private key is missing.

## 3. Symbol recovery: `.gnu_debugdata` is the key

`libcrypto.so` on Android exports **no** crypto symbols (`RSA_sign`, `BN_*`, `EVP_*`,
`AES_*` → all absent; checked in the DRM service, `drmserver`, and the clearkey service).
Name-based Frida hooks are therefore impossible.

`libwvhidl.so` and `libwvdrmengine.so` still ship `.gnu_debugdata` (MiniDebugInfo LZMA blob)
containing a real `.symtab`. Extract with `tools/wvd_symbols.py`. Useful addresses in
`libwvhidl.so` (module base + `st_value`):

| offset | symbol |
|---|---|
| `0x1ab8b0` | `wvdrm::WVGenericCryptoInterface::loadDeviceRSAKey(uint, uchar const*, ulong)` |
| `0x1100b0` | `wvcdm::(anon)::ExtractEntitlementKeys(video_widevine::License const&)` |
| `0x1103f0` | `wvcdm::(anon)::ExtractContentKeys(video_widevine::License const&)` |
| `0xdb190` | `wvcdm::CryptoSession::Decrypt(CdmDecryptionParametersV16 const&)` |

## 4. What the hooks proved

`ExtractContentKeys` returns `std::vector<CryptoKey>` (sret in `a0` on x86_64): 880 bytes =
5 elements × 176. Each element carries a 16-byte key id at `+0x01` and a heap pointer at
`+0x58`. The key ids match `cenc:default_KID` from the manifest exactly, so the mapping is
correct.

`CryptoSession::Decrypt` fires once per sample (1261 calls in one 20 s playback). Its
parameter struct holds **only the key id** (pointer at `+0x98` → `800aacaa-5229-…`), plus
frame metadata. No constant 16-byte secret appears anywhere in the struct across all calls.

## 5. Negative results (do not repeat)

Every candidate below was tested by feeding it to
`ffmpeg -decryption_key <hex> -i <segment>.mp4 -f null -` against the real Widevine
segments (`a-eng-0128k-aac-2c.mp4`, `v-0144p-0100k-libx264.mp4`) whose KID we had matched:

- 578 unique 16-byte windows from the `ExtractContentKeys` vector → all decode with errors
- 10 candidates from the heap blobs behind each element's `+0x58` pointer → all fail
- 61 constant 16-byte fields of the `Decrypt` parameters (over 1261 calls) → pointers,
  zeros, and sizes only

Two more dead ends worth recording:

- No crypto entry point is exported in the DRM service at all: `EVP_EncryptInit`,
  `EVP_DecryptInit*`, `EVP_CipherInit*`, `AES_set_*_key`, `AES_cbc_encrypt`,
  `AES_ctr128_encrypt` all resolve to `null` across every loaded module.
- `wvcdm::AesCbcKey::Init(std::string const&)` at `0xceff0` exists in the symtab but never
  fires during playback, so it is not on the content path either.

Conclusion: the content key stays inside the oemcrypto session; `Decrypt` receives a key id,
not a key. Getting the raw key needs a pattern scan of the AES implementation inside
`libcrypto.so` (locate the Rijndael S-box in `.rodata`, cross-reference it from `.text`,
then hook the key-expansion routine), which was not completed.

## 6. Repro harness

`tests/drm-test.html` is a minimal Shaka + EME page. It must be served over a **secure
context**: `http://10.0.2.2:8123` is rejected by EME (Shaka error 6001), while
`http://localhost:8123` via `adb reverse tcp:8123 tcp:8123` works:

```bash
python -m http.server 8123 --bind 0.0.0.0 --directory tests
adb reverse tcp:8123 tcp:8123
adb shell am start -n com.android.chrome/com.google.android.apps.chrome.Main \
  -a android.intent.action.VIEW -d 'http://localhost:8123/drm-test.html'
```

Chrome shows a first-run/sync flow on a fresh AVD; dismiss it once (`Accept & continue`,
`No thanks`) or every later `am start` lands on the wrong activity.

## 7. Tools in this repo

| file | purpose |
|---|---|
| `tools/wvd_setup.py` | `check` / `pull` / `build` / `verify` / `selftest` for `.wvd` from client id + key |
| `tools/wvd_symbols.py` | list `.dynsym`/`.gnu_debugdata` symbols with addresses |
| `tools/wvd_dump3.py` | configurable offset hook (module + offsets) with key-blob capture |
| `tools/wvd_dump4.py` | race the DRM service respawn so the hook is installed before plugin init |
| `tools/wvd_hook3.js` | Frida script injected by `wvd_dump3.py` |
| `tools/widevine_helper.py` | offline license + decrypt pipeline used by the extension export mode |

## 8. Practical guidance

For Udemy, try DRM mode `skip` first and watch the log for
`AES-128 (decrypting in-browser)`. Only assets that stay encrypted need a `.wvd`, and in
that case a `.wvd` produced by a dedicated tool (or from a device you control) drops
straight into `tools/widevine_helper.py --cdm device.wvd`.

## 9. Udemy specifics (probed against a real DRM lecture)

A real course lecture was resolved end to end with the operator's own session cookies.
The verified shape of a DRM lecture:

```
GET https://www.udemy.com/api-2.0/courses/<slug>/?fields[course]=id,title,url
GET https://www.udemy.com/api-2.0/users/me/subscribed-courses/<cid>/lectures/<lid>/
      ?fields[lecture]=id,title,asset
      &fields[asset]=asset_type,media_sources,media_license_token,course_is_drmed
```

Answer for a DRM lecture: `course_is_drmed: true`, a `media_license_token` (JWT, ES256,
claims `course_id`, `user_id`, `asset_id`, `user_agent`, `exp`), and two sources whose
paths both contain `/cbcs/` — DASH `.mpd` and HLS `master.m3u8`.

`cbcs` means **SAMPLE-AES**, not AES-128. The in-browser AES-128 path does not apply.
The variant playlist carries:

```
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://<32 hex>",KEYFORMAT="com.apple.streamingkeydelivery"
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,<pssh box>",KEYFORMAT="urn:uuid:edef8ba9-…"
```

The `skd://` payload **is** the content KID; the `data:` URI is the Widevine PSSH. Both are
extracted by `tools/udemy_license.py`.

### License endpoint

```
POST https://www.udemy.com/api-2.0/media-license-server/<media_license_token>
     ?auth_token=<same token>&drm_type=widevine
Content-Type: application/octet-stream
body: <signed Widevine license challenge>
```

Observed behaviour, useful as a probe:

| request | response |
|---|---|
| no `auth_token` | `400 {"message":"auth_token is required"}` |
| `auth_token` present, no `drm_type` | `400 {"message":"drm_type must be widevine, fairplay, or playready"}` |
| empty body | `400 {"message":"License challenge body is required"}` |
| dummy body | `403 371000005 "Widevine certificate request failed >> Invalid request format"` |

So the endpoint is alive and validates correctly; it only rejects a challenge that is not
signed by a real CDM. `/media-drm/widevine` and `/media-drm/` are not the endpoint (404/403).

Token notes: `exp` is roughly five minutes after issuance, and the JWT pins a `user_agent`
claim. A stale token cannot be reused, so any offline job must be regenerated from a fresh
session.

### What this means

Everything except the CDM exists: KID, PSSH, license URL, request shape. The missing piece
is still the device private key (`device.wvd`). Two workable routes remain — a `.wvd` from an
unlocked L3 device, or handing PSSH + license URL to a third-party CDM service. The second
route exposes a live session token, so prefer the first.

### Tools added for this

| file | purpose |
|---|---|
| `tools/udemy_license.py` | cookies + course/lecture → KID, PSSH, license URL, `<x>.widevine.json` job |
| `tools/drm_payload.py` | turn an exported job into copy-paste fields (cookies redacted by default) |

## 10. Phone route (Xiaomi Poco X3 NFC, `surya`)

Checked directly over adb: `ro.boot.flash.locked=1`, no `su`, `adb root` →
`adbd cannot run as root in production builds`, `/data/mediadrm` permission denied. So there
is no adb-only privilege escalation; `adb shell` stays uid 2000.

`sys.oem_unlock_allowed=1` means the OEM-unlock toggle is already on, so the only route is
the official one: bind a Mi account, wait 168 h, unlock (full wipe), patch `boot.img` with
Magisk, then run `keydive` against the device. `frida-server` 17.27.5 (android-arm64) and
`keydive` 3.0.6 are already staged outside the repo for that step.

Note: `ro.build.display.id` reports `test-keys` on this unit, which indicates a non-official
ROM; Mi Unlock may refuse it.

