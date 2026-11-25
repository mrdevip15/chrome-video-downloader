# Chrome Media & HLS Downloader

A Manifest V3 Chrome extension that sniffs web traffic for media files and segmented HLS streams (`.m3u8`), allowing direct downloads and client-side segment concatenation into `.ts` files.

## Features

- **Direct Stream Sniffing**: Detects direct media files (`.mp4`, `.webm`, `.mkv`, `.mov`) via network headers and URL matching.
- **HLS (`.m3u8`) Support**:
  - Automatically parses master playlists and targets highest-bitrate variants.
  - Fetches segmented `.ts` chunks in sequence.
  - Concatenates segments into a unified MPEG-TS (`.ts`) container directly in-browser.
- **Progress Tracking**: Real-time progress bar and segment counter during HLS stream assembly.
- **Badge Indicator**: Displays the count of detected streams on the extension icon.

## Installation

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the extension directory.

## Usage

1. Open any page containing video or audio streams.
2. Play the media to trigger network requests.
3. Click the extension badge in the Chrome toolbar.
4. Hit **Download** (for direct files) or **Download (Mux TS)** (for HLS streams).
