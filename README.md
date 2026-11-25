# Media & Course Downloader (v3.0)

Manifest V3 browser extension (Chrome & Microsoft Edge) that sniffs live media streams, downloads HLS (`.m3u8`) and static DASH (`.mpd`) streams with client-side MPEG-TS to MP4 remuxing, and bulk-exports Udemy courses into structured folders with subtitles (`.srt`), articles (`.html`/`.md`), resources, and an offline `index.html` syllabus.

## Features

- **Dedicated Download Manager (`manager.html`)**: Queue runs inside a dedicated manager tab so closing the popup never interrupts long downloads. Supports **Pause / Resume / Cancel**, download history, and live activity logs.
- **Direct Disk Streaming (File System Access API)**: Pick any local output folder (e.g. `D:\Courses`) to stream segments straight to disk without buffering large videos in RAM, or fall back to Chrome/Edge's `Downloads` folder.
- **HLS & DASH Engine**:
  - Parses master/media `.m3u8` playlists (resolution selection, `#EXT-X-MAP`, `#EXT-X-BYTERANGE`, separate audio renditions).
  - Remuxes MPEG-TS HLS segments to `.mp4` client-side via `mux.js` (`vendor/mux.min.js`).
  - Parses static DASH `.mpd` manifests (`SegmentTemplate`, `SegmentTimeline`, `SegmentList`, `BaseURL`).
  - Parallel ordered segment fetching (1–8 workers) with exponential backoff retries (`408`/`429`/`5xx`).
  - Automatically detects and skips encrypted/DRM streams (`#EXT-X-KEY`, `ContentProtection`, Udemy DRM licenses) without aborting the batch.
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
│   ├── m3u8.js           # HLS playlist parser & variant picker
│   ├── mpd.js            # Static DASH MPD parser
│   ├── vtt.js            # WebVTT -> SRT converter & path sanitizer
│   ├── udemy-model.js    # Curriculum -> course tree & stream picker
│   └── export.js         # Article HTML/Markdown & course index.html generator
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

## Testing

Requires Node.js v22+ and `ffmpeg` / `ffprobe` in `PATH`:

```powershell
node tests/unit-test.mjs
node tests/edge-e2e.mjs
```
