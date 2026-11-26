# Media & Course Downloader (v3.0)

Manifest V3 browser extension (Chrome & Microsoft Edge) that sniffs live media streams, downloads HLS (`.m3u8`) and static DASH (`.mpd`) streams with client-side MPEG-TS to MP4 remuxing, and bulk-exports Udemy courses into structured folders with subtitles (`.srt`), articles (`.html`/`.md`), resources, and an offline `index.html` syllabus.

## Features

- **Dedicated Download Manager (`manager.html`)**: Queue runs inside a dedicated manager tab so closing the popup never interrupts long downloads. Supports **Pause / Resume / Cancel**, download history, and live activity logs.
- **Direct Disk Streaming (File System Access API)**: Pick any local output folder (e.g. `D:\Courses`) to stream segments straight to disk without buffering large videos in RAM, or fall back to Chrome/Edge's `Downloads` folder.
- **HLS & DASH Engine**:
  - Parses master/media `.m3u8` playlists (resolution selection, `#EXT-X-MAP`, `#EXT-X-BYTERANGE`, separate audio renditions).
  - **HLS AES-128 decryption in-browser**: reads `#EXT-X-KEY`, fetches the key with the page session, derives the per-segment IV (explicit `IV=` or media sequence) and decrypts segments with WebCrypto before remuxing.
  - Remuxes MPEG-TS HLS segments to `.mp4` client-side via `mux.js` (`vendor/mux.min.js`).
  - Parses static DASH `.mpd` manifests (`SegmentTemplate`, `SegmentTimeline`, `SegmentList`, `BaseURL`).
  - Parallel ordered segment fetching (1–8 workers) with exponential backoff retries (`408`/`429`/`5xx`).
  - **DRM export mode**: for Widevine/CENC streams the encrypted fMP4 fragments are saved as `.enc.mp4` together with a `*.widevine.json` job (PSSH/KID + captured license request), which `tools/widevine_helper.py` decrypts with your own CDM.
- **Udemy Course Bulk Exporter**:
  - Crawls full course syllabus (`subscriber-curriculum-items`) and resolves per-lecture streams, subtitles, articles, and supplementary assets.
  - Per-section and per-lecture checkboxes, max resolution selector, subtitle language filter, and persistent progress/resume via `chrome.storage.local`.
  - Converts WebVTT captions to `.srt`, exports text lectures to standalone `.html` and/or `.md`, saves supplementary resources into `Resources/`, and generates an offline `index.html` with inline video preview and search.
- **Live Media Sniffer & DOM Scanner**: Captures direct video URLs, `.m3u8`/`.mpd` network requests, `<video>`/`<a>`/`<iframe>`/`data-*` elements, and `fetch`/`XHR` player requests.

## Directory Layout

```text
├── manifest.json         # Manifest V3 config
├── background.js         # Service worker: webRequest sniffer, badge, manager launcher
├── content.js            # DOM scanner & fetch/XHR hook bridge
├── injected.js           # Page-context fetch/XHR manifest sniffer
├── udemy-crawler.js      # Udemy API curriculum & asset resolver
├── popup.html / popup.js # Compact toolbar popup
├── manager.html/.css/.js # Full download manager UI & queue runner
├── lib/
│   ├── engine.js         # Retrying fetch, parallel ordered runner, sinks, HLS/DASH
│   ├── drm.js            # HLS AES-128 keys/IV, WebCrypto decrypt, PSSH/KID extraction
│   ├── m3u8.js           # HLS playlist parser & variant picker
│   ├── mpd.js            # Static DASH MPD parser
│   ├── vtt.js            # WebVTT -> SRT converter & path sanitizer
│   ├── udemy-model.js    # Curriculum -> course tree & stream picker
│   └── export.js         # Article HTML/Markdown & course index.html generator
├── tools/
│   └── widevine_helper.py # Widevine license + CENC decrypt helper (pywidevine/mp4decrypt)
├── vendor/
│   └── mux.min.js        # mux.js v6.3.0 (TS -> MP4 transmuxer)
├── icons/                # Extension icons (16, 48, 128)
└── tests/
    ├── unit-test.mjs     # Unit tests + ffmpeg/ffprobe remux check
    └── edge-e2e.mjs      # Automated Microsoft Edge E2E suite via CDP
```

## Installation (Chrome / Microsoft Edge)

1. Open `edge://extensions/` (or `chrome://extensions/`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select `D:\WORK\chrome-video-downloader`.

## DRM (Widevine / CENC)

Two things are handled differently from the old "detect and skip" behaviour.

**1. HLS AES-128 — decrypted in-browser, nothing else needed.**
Playlists using `#EXT-X-KEY:METHOD=AES-128` (the common non-DRM protection on
course CDNs) are downloaded, decrypted with WebCrypto using the key URL the
playlist points at, and remuxed to MP4. Segment IVs come from `IV=` when present,
otherwise from the media sequence number per RFC 8216.

**2. Widevine / SAMPLE-AES / CENC — export + offline decrypt.**
The CDM's device keys live inside the browser and cannot be extracted, so no
extension can decrypt Widevine by itself. Instead the extension does the part it
can do well:

- Set **DRM** to `Export (Widevine job)` in the manager.
- Download the lecture/stream. The encrypted fragments are saved as
  `*.enc.mp4` (video) and `*.audio.enc.m4a` (audio).
- A `<name>.widevine.json` job is written next to them containing the `pssh`
  boxes extracted from the init segment / MPD, the `kids`, and the license
  request the page made (URL, headers, cookies, init data) captured by the
  in-page EME/fetch hooks.
- Decrypt offline with your own CDM:

```powershell
pip install pywidevine requests
python tools/widevine_helper.py "D:\Courses\My Course" --cdm C:\path\to\device.wvd
```

The helper requests a license with *your* L3 CDM (replaying the captured URL and
headers), derives the content keys, decrypts with `mp4decrypt` (Bento4) or
`ffmpeg`, and muxes video+audio into `<name>.mp4`. Licensing is cached in
`*.keys.json`, and `--keys KID:KEY` skips licensing entirely if you already have
the keys. `--watch` keeps the helper polling the folder for new jobs.

For a lecture whose player never exposes a manifest URL via the API, open the
lecture in the page, let it play for a couple of seconds so the hooks capture the
license request, then download it from the **Live Sniffer** tab — the sniffer sees
the real manifest.

> Both modes only operate on content you are entitled to access with your own
> account and CDM.

Field notes from the DRM investigation are in the repo: `tools/DRM-NOTES.md` records the
verified findings and every dead end, and `tools/HANDOFF.md` is the resume plan for the
`.wvd` work. For Udemy specifically, `tools/udemy_license.py` resolves a lecture straight to
its KID, PSSH and license URL:

```powershell
python tools/udemy_license.py <course-slug-or-id> <lecture-id> --browser edge --out job.json
python tools/widevine_helper.py --cdm device.wvd job.json
```

## Testing

Requires Node.js v22+ and `ffmpeg` / `ffprobe` in `PATH`:

```powershell
node tests/unit-test.mjs
node tests/edge-e2e.mjs
```
