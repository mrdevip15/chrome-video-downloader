/**
 * Minimal HLS (m3u8) parser & segment fetcher.
 * Concatenates MPEG-TS segments into a single downloadable blob.
 */

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching playlist: ${url}`);
  return await res.text();
}

function resolveUrl(relativeOrAbsolute, baseUrl) {
  try {
    return new URL(relativeOrAbsolute, baseUrl).href;
  } catch (_) {
    return relativeOrAbsolute;
  }
}

function parseM3U8(content, baseUrl) {
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let isMaster = false;
  const variants = [];
  const segments = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      isMaster = true;
      const nextLine = lines[i + 1];
      if (nextLine && !nextLine.startsWith('#')) {
        let bandwidth = 0;
        const bwMatch = line.match(/BANDWIDTH=(\d+)/);
        if (bwMatch) bandwidth = parseInt(bwMatch[1], 10);
        variants.push({
          url: resolveUrl(nextLine, baseUrl),
          bandwidth
        });
        i++;
      }
    } else if (line.startsWith('#EXTINF')) {
      const nextLine = lines[i + 1];
      if (nextLine && !nextLine.startsWith('#')) {
        segments.push(resolveUrl(nextLine, baseUrl));
        i++;
      }
    }
  }

  return { isMaster, variants, segments };
}

async function resolveMediaPlaylist(playlistUrl) {
  const content = await fetchText(playlistUrl);
  const parsed = parseM3U8(content, playlistUrl);

  if (parsed.isMaster && parsed.variants.length > 0) {
    // Pick the highest bandwidth variant
    parsed.variants.sort((a, b) => b.bandwidth - a.bandwidth);
    const bestVariantUrl = parsed.variants[0].url;
    return await resolveMediaPlaylist(bestVariantUrl);
  }

  return { segments: parsed.segments, baseUrl: playlistUrl };
}

async function downloadHlsStream(playlistUrl, onProgress) {
  const { segments } = await resolveMediaPlaylist(playlistUrl);

  if (!segments || segments.length === 0) {
    throw new Error('No playable segments found in playlist.');
  }

  const chunks = [];
  const total = segments.length;

  for (let i = 0; i < total; i++) {
    const segUrl = segments[i];
    const res = await fetch(segUrl);
    if (!res.ok) {
      throw new Error(`Failed to fetch segment ${i + 1}/${total}: ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    chunks.push(new Uint8Array(buf));

    if (typeof onProgress === 'function') {
      onProgress(i + 1, total);
    }
  }

  // Concatenate MPEG-TS segments into a single TS blob
  const totalLength = chunks.reduce((acc, curr) => acc + curr.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new Blob([combined], { type: 'video/mp2t' });
}

window.HlsDownloader = {
  downloadHlsStream
};
