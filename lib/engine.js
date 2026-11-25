// Download engine: retrying fetch, ordered parallel segments, sinks, HLS/DASH/direct.
// Exposes globalThis.Engine. Depends on M3U8, MPD and (optionally) muxjs.
(function (root) {
  class HttpError extends Error {
    constructor(status, url) {
      super(`HTTP ${status}`);
      this.status = status;
      this.url = url;
    }
  }
  class EncryptedError extends Error {
    constructor(msg) {
      super(msg || 'Stream is encrypted — skipped');
      this.encrypted = true;
    }
  }
  class AbortedError extends Error {
    constructor() {
      super('Aborted');
      this.aborted = true;
    }
  }

  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new AbortedError()); }, { once: true });
    });

  const retriable = (s) => s === 408 || s === 429 || s >= 500;

  async function fetchRetry(url, { range, signal, retries = 4 } = {}) {
    for (let attempt = 0; ; attempt++) {
      if (signal && signal.aborted) throw new AbortedError();
      const headers = {};
      if (range) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
      let res = null;
      let netErr = null;
      try {
        res = await fetch(url, { headers, signal, credentials: 'include' });
      } catch (e) {
        if ((signal && signal.aborted) || e.name === 'AbortError') throw new AbortedError();
        netErr = e;
      }
      if (res) {
        if (res.ok) return res;
        if (!retriable(res.status) || attempt >= retries) throw new HttpError(res.status, url);
      } else if (attempt >= retries) {
        throw netErr;
      }
      await sleep(Math.min(1000 * 2 ** attempt, 15000) + Math.random() * 300, signal);
    }
  }

  async function fetchBytes(url, opts) {
    const res = await fetchRetry(url, opts);
    return new Uint8Array(await res.arrayBuffer());
  }

  // Fetch `count` items with `concurrency` workers; consume strictly in order.
  async function runOrdered(count, concurrency, fetchFn, consumeFn) {
    const results = new Map();
    let next = 0;
    let written = 0;
    let failed = null;
    let wake = null;
    const poke = () => { if (wake) { const w = wake; wake = null; w(); } };
    const ahead = Math.max(2, concurrency * 3);

    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, count)) }, async () => {
      while (!failed) {
        while (next - written >= ahead && !failed) await new Promise((r) => setTimeout(r, 30));
        if (failed) return;
        const i = next++;
        if (i >= count) return;
        try {
          results.set(i, await fetchFn(i));
        } catch (e) {
          failed = failed || e;
        }
        poke();
      }
    });

    while (written < count && !failed) {
      if (results.has(written)) {
        const data = results.get(written);
        results.delete(written);
        try {
          await consumeFn(written, data);
        } catch (e) {
          failed = failed || e;
          break;
        }
        written++;
      } else {
        await new Promise((r) => { wake = r; setTimeout(r, 200); });
      }
    }
    await Promise.allSettled(workers);
    if (failed) throw failed;
  }

  // ---------- Sinks ----------
  function chromeDownload(url, filename, onProgress) {
    return new Promise((resolve, reject) => {
      chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false }, (id) => {
        if (chrome.runtime.lastError || id === undefined) {
          reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'download failed'));
          return;
        }
        let timer = null;
        const finish = (err) => {
          chrome.downloads.onChanged.removeListener(onChanged);
          clearInterval(timer);
          err ? reject(err) : resolve(id);
        };
        const check = (item) => {
          if (!item) return;
          if (item.state === 'complete') finish();
          else if (item.state === 'interrupted') finish(new Error(`Download interrupted: ${item.error || 'unknown'}`));
          else if (onProgress && item.bytesReceived) onProgress({ bytes: item.bytesReceived, totalBytes: item.totalBytes || 0 });
        };
        const onChanged = (d) => {
          if (d.id === id && d.state) chrome.downloads.search({ id }, (r) => check(r[0]));
        };
        chrome.downloads.onChanged.addListener(onChanged);
        timer = setInterval(() => chrome.downloads.search({ id }, (r) => check(r[0])), 1000);
        chrome.downloads.search({ id }, (r) => check(r[0]));
      });
    });
  }

  function mimeForPath(p) {
    const ext = (p.split('.').pop() || '').toLowerCase();
    switch (ext) {
      case 'mp4': case 'm4v': return 'video/mp4';
      case 'm4a': return 'audio/mp4';
      case 'webm': return 'video/webm';
      case 'weba': return 'audio/webm';
      case 'ts': return 'video/mp2t';
      case 'html': return 'text/html;charset=utf-8';
      default: return 'application/octet-stream';
    }
  }

  // Writes into Chrome's Downloads folder (relative path). Buffers per file as Blob parts.
  class DownloadsSink {
    constructor() { this.kind = 'downloads'; }
    async exists() { return false; }
    async open(path) {
      let parts = [];
      return {
        write: async (u8) => { parts.push(u8); },
        close: async () => {
          const blob = new Blob(parts, { type: mimeForPath(path) });
          parts = [];
          const url = URL.createObjectURL(blob);
          try { await chromeDownload(url, path); } finally { URL.revokeObjectURL(url); }
        },
        abort: async () => { parts = []; }
      };
    }
    async writeText(path, text) {
      const h = await this.open(path);
      await h.write(new TextEncoder().encode(text));
      await h.close();
    }
    async saveUrl(url, path, { onProgress } = {}) {
      await chromeDownload(url, path, onProgress);
    }
  }

  // Writes straight to disk in a user-picked folder (File System Access API). Streams, no RAM buffering.
  class FsSink {
    constructor(dirHandle) {
      this.dir = dirHandle;
      this.kind = 'fs';
    }
    async _dir(parts, create) {
      let d = this.dir;
      for (const p of parts) d = await d.getDirectoryHandle(p, { create });
      return d;
    }
    async exists(path) {
      try {
        const parts = path.split('/');
        const name = parts.pop();
        const d = await this._dir(parts, false);
        const f = await (await d.getFileHandle(name)).getFile();
        return f.size > 0;
      } catch (_) {
        return false;
      }
    }
    async open(path) {
      const parts = path.split('/');
      const name = parts.pop();
      const d = await this._dir(parts, true);
      const fh = await d.getFileHandle(name, { create: true });
      const w = await fh.createWritable({ keepExistingData: false });
      return {
        write: (u8) => w.write(u8),
        close: () => w.close(),
        abort: async () => {
          try { await w.abort(); } catch (_) {}
          try {
            const f = await fh.getFile();
            if (f.size === 0) await d.removeEntry(name);
          } catch (_) {}
        }
      };
    }
    async writeText(path, text) {
      const h = await this.open(path);
      await h.write(new TextEncoder().encode(text));
      await h.close();
    }
    async saveUrl(url, path, { signal, onProgress } = {}) {
      const res = await fetchRetry(url, { signal });
      const total = +res.headers.get('content-length') || 0;
      const h = await this.open(path);
      try {
        const reader = res.body.getReader();
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await h.write(value);
          got += value.byteLength;
          if (onProgress) onProgress({ bytes: got, totalBytes: total });
        }
        await h.close();
      } catch (e) {
        await h.abort();
        if (signal && signal.aborted) throw new AbortedError();
        throw e;
      }
    }
  }

  // ---------- HLS ----------
  function makeRemuxer() {
    if (!root.muxjs || !root.muxjs.mp4 || !root.muxjs.mp4.Transmuxer) return null;
    const tm = new root.muxjs.mp4.Transmuxer({ keepOriginalTimestamps: false });
    let out = [];
    let wroteInit = false;
    tm.on('data', (seg) => {
      if (!wroteInit && seg.initSegment && seg.initSegment.byteLength) {
        out.push(new Uint8Array(seg.initSegment));
        wroteInit = true;
      }
      if (seg.data && seg.data.byteLength) out.push(new Uint8Array(seg.data));
    });
    return (bytes) => {
      out = [];
      tm.push(bytes);
      tm.flush();
      return out;
    };
  }

  const HLS_AES = (pl) => Array.isArray(pl.keys) && pl.keys.length > 0 && pl.keys.every((k) => k && k.method === 'AES-128');

  async function downloadMediaPlaylist(pl, opts) {
    const { sink, basePath, concurrency, remux, signal, onProgress, log, allowEncrypted } = opts;
    const segs = pl.segments;
    if (!segs.length) throw new Error('Playlist has no segments');
    const encryptedKind = pl.encrypted ? (HLS_AES(pl) ? 'AES-128' : pl.encryption || 'unknown') : null;
    const rawEncrypted = !!pl.encrypted && !HLS_AES(pl);
    if (rawEncrypted && !allowEncrypted) throw new EncryptedError(`Stream encrypted (${encryptedKind}) — DRM export disabled`);

    const isFmp4 = !!pl.map || /\.(m4s|mp4|m4a|m4v|cmfv|cmfa)(\?|$)/i.test(segs[0].uri);
    let remuxer = !isFmp4 && !rawEncrypted && remux ? makeRemuxer() : null;
    let mode = rawEncrypted ? 'enc' : isFmp4 ? 'fmp4' : remuxer ? 'remux' : 'ts';
    let handle = null;
    let path = null;
    let bytesOut = 0;
    let head = new Uint8Array(0);
    const collect = (bytes) => {
      if (head.length < 262144) {
        const next = new Uint8Array(Math.min(262144, head.length + bytes.length));
        next.set(head, 0);
        next.set(bytes.subarray(0, next.length - head.length), head.length);
        head = next;
      }
    };

    const getKey = HLS_AES(pl)
      ? root.DRM.makeKeyCache((uri) => fetchBytes(uri, { signal }))
      : null;

    const openAs = async (ext) => {
      path = basePath + ext;
      handle = await sink.open(path);
    };

    try {
      if (isFmp4) {
        await openAs(rawEncrypted ? '.enc.mp4' : '.mp4');
        if (pl.map) {
          const init = await fetchBytes(pl.map.uri, { range: pl.map.byterange, signal });
          await handle.write(init);
          collect(init);
          bytesOut += init.byteLength;
        }
      }

      await runOrdered(
        segs.length,
        concurrency,
        async (i) => {
          let bytes = await fetchBytes(segs[i].uri, { range: segs[i].byterange, signal });
          if (getKey && segs[i].key && segs[i].key.method === 'AES-128') {
            const key = await getKey(segs[i].key.uri);
            const iv = root.DRM.ivForSegment(segs[i].key, segs[i].seq != null ? segs[i].seq : i);
            bytes = await root.DRM.decryptAes128(key, iv, bytes);
          }
          collect(bytes);
          return bytes;
        },
        async (i, bytes) => {
          if (mode === 'remux') {
            let chunks = [];
            try { chunks = remuxer(bytes); } catch (e) { chunks = []; if (i > 0) throw e; }
            if (i === 0 && !chunks.length) {
              mode = 'ts';
              remuxer = null;
              if (log) log('MP4 remux produced no output, saving raw .ts instead');
            } else {
              if (!handle) await openAs('.mp4');
              for (const c of chunks) { await handle.write(c); bytesOut += c.byteLength; }
              if (onProgress) onProgress({ done: i + 1, total: segs.length, bytes: bytesOut });
              return;
            }
          }
          if (!handle) await openAs(mode === 'ts' ? '.ts' : mode === 'enc' ? (isFmp4 ? '.enc.mp4' : '.enc.ts') : '.mp4');
          await handle.write(bytes);
          bytesOut += bytes.byteLength;
          if (onProgress) onProgress({ done: i + 1, total: segs.length, bytes: bytesOut });
        }
      );
      if (!handle) await openAs(mode === 'ts' ? '.ts' : mode === 'enc' ? (isFmp4 ? '.enc.mp4' : '.enc.ts') : '.mp4');
      await handle.close();
      return {
        path,
        bytes: bytesOut,
        mode,
        encrypted: rawEncrypted,
        encryption: encryptedKind,
        keys: (pl.keys || []).map((k) => ({ method: k.method, uri: k.uri, keyFormat: k.keyFormat })),
        pssh: root.DRM.extractPssh(head)
      };
    } catch (e) {
      if (handle) await handle.abort();
      throw e;
    }
  }

  async function downloadHls(url, opts) {
    const { signal, maxHeight, log, allowEncrypted } = opts;
    let text = await (await fetchRetry(url, { signal })).text();
    let pl = root.M3U8.parse(text, url);
    let audioUri = null;

    if (pl.type === 'master') {
      if (pl.encrypted && !HLS_AES(pl) && !allowEncrypted) {
        throw new EncryptedError(`Stream encrypted (${pl.encryption}) — DRM export disabled`);
      }
      const v = root.M3U8.pickVariant(pl.variants, maxHeight);
      if (log) log(`HLS variant: ${v.resolution ? v.resolution.height + 'p' : 'n/a'}, ${Math.round(v.bandwidth / 1000)} kbps`);
      if (v.audio) {
        const group = pl.media.filter((m) => m.type === 'AUDIO' && m.groupId === v.audio && m.uri);
        const pick = group.find((m) => m.isDefault) || group[0];
        if (pick) audioUri = pick.uri;
      }
      url = v.uri;
      text = await (await fetchRetry(url, { signal })).text();
      pl = root.M3U8.parse(text, url);
    }
    if (pl.type !== 'media') throw new Error('Unexpected nested master playlist');
    if (pl.encrypted && log) log(`Encryption: ${pl.encryption}${HLS_AES(pl) ? ' (decrypting in-browser)' : ' (Widevine/CENC — export mode)'}`);
    if (!pl.endList && log) log('Playlist has no ENDLIST (live?) — saving the segments listed now');

    const outputs = [await downloadMediaPlaylist(pl, opts)];
    if (audioUri) {
      const apl = root.M3U8.parse(await (await fetchRetry(audioUri, { signal })).text(), audioUri);
      outputs.push(await downloadMediaPlaylist(apl, { ...opts, basePath: opts.basePath + '.audio' }));
    }
    return outputs;
  }

  // ---------- DASH ----------
  function extFor(mime, type) {
    if (/webm/i.test(mime)) return type === 'audio' ? '.weba' : '.webm';
    return type === 'audio' ? '.m4a' : '.mp4';
  }

  async function downloadRepresentation(rep, path, { sink, concurrency, signal, onProgress }) {
    const handle = await sink.open(path);
    let bytesOut = 0;
    let head = new Uint8Array(0);
    const collect = (bytes) => {
      if (head.length < 262144) {
        const next = new Uint8Array(Math.min(262144, head.length + bytes.length));
        next.set(head, 0);
        next.set(bytes.subarray(0, next.length - head.length), head.length);
        head = next;
      }
    };
    try {
      if (rep.init && rep.init.url) {
        const init = await fetchBytes(rep.init.url, { range: rep.init.range, signal });
        await handle.write(init);
        collect(init);
        bytesOut += init.byteLength;
      }
      await runOrdered(
        rep.segments.length,
        concurrency,
        (i) => fetchBytes(rep.segments[i].url, { range: rep.segments[i].range, signal }),
        async (i, bytes) => {
          await handle.write(bytes);
          collect(bytes);
          bytesOut += bytes.byteLength;
          if (onProgress) onProgress({ done: i + 1, total: rep.segments.length, bytes: bytesOut });
        }
      );
      await handle.close();
      return { path, bytes: bytesOut, pssh: root.DRM.extractPssh(head) };
    } catch (e) {
      await handle.abort();
      throw e;
    }
  }

  async function downloadDash(url, opts) {
    const { signal, maxHeight, basePath, log, allowEncrypted } = opts;
    const xml = await (await fetchRetry(url, { signal })).text();
    const mpd = root.MPD.parse(xml, url);
    if (mpd.isProtected && !allowEncrypted) throw new EncryptedError('DASH stream declares ContentProtection — DRM export disabled');
    const protection = mpd.isProtected ? root.DRM.psshFromMpd(xml) : { kids: [], pssh: [] };
    const ext = (mime, type) => (allowEncrypted && mpd.isProtected ? '.enc' : '') + extFor(mime, type);
    const v = root.MPD.pickVideo(mpd.video, maxHeight);
    const a = root.MPD.pickAudio(mpd.audio);
    if (!v && !a) throw new Error('No playable representations in MPD');
    const outputs = [];
    if (v) {
      if (log) log(`DASH video: ${v.height || '?'}p, ${Math.round(v.bandwidth / 1000)} kbps`);
      outputs.push(await downloadRepresentation(v, basePath + ext(v.mime, 'video'), opts));
    }
    if (a) {
      const p = v ? `${basePath}.audio${ext(a.mime, 'audio')}` : basePath + ext(a.mime, 'audio');
      outputs.push(await downloadRepresentation(a, p, opts));
    }
    const pssh = [...protection.pssh];
    outputs.forEach((o) => (o.pssh || []).forEach((p) => { if (!pssh.some((x) => x.b64 === p.b64)) pssh.push(p); }));
    outputs.forEach((o) => {
      o.encrypted = !!mpd.isProtected;
      o.pssh = pssh;
      o.kids = protection.kids;
    });
    return outputs;
  }

  root.Engine = {
    HttpError,
    EncryptedError,
    AbortedError,
    fetchRetry,
    fetchBytes,
    runOrdered,
    DownloadsSink,
    FsSink,
    downloadHls,
    downloadDash,
    sleep
  };
})(globalThis);
