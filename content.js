(() => {
  const VIDEO_EXT_REGEX = /\.(mp4|m4v|webm|mkv|mov|avi|flv|m3u8|mpd)(\?.*)?$/i;

  // Page-context hook (fetch/XHR) that reports stream manifests the player requests.
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('injected.js');
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => s.remove();
  } catch (_) {}

  function resolveUrl(url) {
    if (!url) return null;
    try { return new URL(url, location.href).href; } catch (_) { return null; }
  }

  function getFilenameFromUrl(url) {
    try {
      const segs = new URL(url).pathname.split('/').filter(Boolean);
      if (segs.length) return decodeURIComponent(segs[segs.length - 1]);
    } catch (_) {}
    return 'video';
  }

  function send(items) {
    if (!items.length) return;
    try { chrome.runtime.sendMessage({ action: 'pageDomMediaFound', items }); } catch (_) {}
  }

  // Only real manifests are forwarded (API JSON calls are ignored).
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.type === '__DRM_CAPTURE__') {
      try { chrome.runtime.sendMessage({ action: 'drmCaptureFound', capture: event.data.capture }); } catch (_) {}
      return;
    }
    if (event.data.type !== '__UDEMY_MEDIA_SNIFFED__') return;
    const { url, isM3u8 } = event.data;
    if (!url) return;
    const full = resolveUrl(url);
    const isMpd = /\.mpd(\?|$)/i.test(full || '');
    if (!full || (!isM3u8 && !isMpd)) return;
    send([{ url: full, filename: getFilenameFromUrl(full), isHls: !!isM3u8, isDash: isMpd, type: 'media', source: 'XHR/Fetch Hook', timestamp: Date.now() }]);
  });

  function scanDomVideos() {
    const found = new Set();
    const results = [];

    const add = (rawUrl, source) => {
      const full = resolveUrl(rawUrl);
      if (!full || full.startsWith('blob:') || full.startsWith('data:') || found.has(full)) return;
      if (!VIDEO_EXT_REGEX.test(full)) return;
      found.add(full);
      results.push({
        url: full,
        filename: getFilenameFromUrl(full),
        isHls: /\.m3u8(\?|$)/i.test(full),
        isDash: /\.mpd(\?|$)/i.test(full),
        type: 'media',
        source,
        timestamp: Date.now()
      });
    };

    document.querySelectorAll('video, audio').forEach((el) => {
      if (el.currentSrc) add(el.currentSrc, '<video.currentSrc>');
      if (el.src) add(el.src, '<video.src>');
      el.querySelectorAll('source').forEach((s) => s.src && add(s.src, '<source.src>'));
    });
    document.querySelectorAll('a[href]').forEach((a) => add(a.getAttribute('href'), '<a> link'));
    document.querySelectorAll('iframe[src], embed[src], object[data]').forEach((el) => add(el.getAttribute('src') || el.getAttribute('data'), '<frame/embed>'));
    document.querySelectorAll('*').forEach((el) => {
      for (const at of el.attributes) {
        if (at.name.startsWith('data-') && VIDEO_EXT_REGEX.test(at.value)) add(at.value, `[${at.name}]`);
      }
    });
    return results;
  }

  // content.js runs at document_start, so wait for the DOM before scanning.
  const initialScan = () => send(scanDomVideos());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialScan, { once: true });
  else initialScan();

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.action === 'scanDom') {
      const items = scanDomVideos();
      send(items);
      sendResponse({ items });
    }
    if (msg && msg.action === 'getPageDrmCapture') {
      sendResponse({ capture: (window.__DRM_CAPTURES__ || null) });
    }
    return false;
  });
})();
