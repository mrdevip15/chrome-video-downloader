// HLS playlist parser (master + media). Exposes globalThis.M3U8.
(function (root) {
  function parseAttrs(str) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(str))) {
      let v = m[2];
      if (v.startsWith('"')) v = v.slice(1, -1);
      out[m[1]] = v;
    }
    return out;
  }

  function resolve(uri, base) {
    try { return new URL(uri, base).href; } catch (_) { return uri; }
  }

  function parseByteRange(s, prevEnd) {
    const [len, off] = s.split('@');
    return { length: parseInt(len, 10), offset: off !== undefined ? parseInt(off, 10) : prevEnd };
  }

  function parse(text, baseUrl) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length || !lines[0].startsWith('#EXTM3U')) throw new Error('Not an M3U8 playlist');

    const variants = [];
    const media = [];
    const segments = [];
    let map = null;
    let encrypted = false;
    let encryption = null;
    let endList = false;
    let pendingVariant = null;
    let duration = 0;
    let byterange = null;
    let lastEnd = 0;

    for (const line of lines) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseAttrs(line.slice(18));
        let resolution = null;
        if (a.RESOLUTION) {
          const [w, h] = a.RESOLUTION.split('x').map(Number);
          resolution = { width: w, height: h };
        }
        pendingVariant = {
          bandwidth: parseInt(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || '0', 10),
          resolution,
          codecs: a.CODECS || '',
          audio: a.AUDIO || null
        };
      } else if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttrs(line.slice(13));
        media.push({
          type: a.TYPE,
          groupId: a['GROUP-ID'],
          name: a.NAME,
          language: a.LANGUAGE || '',
          isDefault: a.DEFAULT === 'YES',
          uri: a.URI ? resolve(a.URI, baseUrl) : null
        });
      } else if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
        const a = parseAttrs(line.slice(line.indexOf(':') + 1));
        if (a.METHOD && a.METHOD !== 'NONE') {
          encrypted = true;
          encryption = a.METHOD;
        }
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const a = parseAttrs(line.slice(11));
        map = { uri: resolve(a.URI, baseUrl), byterange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
      } else if (line.startsWith('#EXTINF:')) {
        duration = parseFloat(line.slice(8)) || 0;
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        byterange = parseByteRange(line.slice(17), lastEnd);
      } else if (line === '#EXT-X-ENDLIST') {
        endList = true;
      } else if (!line.startsWith('#')) {
        if (pendingVariant) {
          pendingVariant.uri = resolve(line, baseUrl);
          variants.push(pendingVariant);
          pendingVariant = null;
        } else {
          segments.push({ uri: resolve(line, baseUrl), duration, byterange });
          if (byterange) lastEnd = byterange.offset + byterange.length;
          duration = 0;
          byterange = null;
        }
      }
    }

    if (variants.length) return { type: 'master', variants, media, encrypted, encryption };
    return {
      type: 'media',
      segments,
      map,
      encrypted,
      encryption,
      endList,
      totalDuration: segments.reduce((s, x) => s + x.duration, 0)
    };
  }

  // Highest variant whose height <= maxHeight; falls back to the smallest one.
  function pickVariant(variants, maxHeight) {
    const h = (v) => (v.resolution ? v.resolution.height : 0);
    const sorted = [...variants].sort((a, b) => h(b) - h(a) || b.bandwidth - a.bandwidth);
    if (!maxHeight) return sorted[0];
    const fit = sorted.filter((v) => h(v) <= maxHeight);
    return fit[0] || sorted[sorted.length - 1];
  }

  root.M3U8 = { parse, pickVariant, parseAttrs };
})(globalThis);
