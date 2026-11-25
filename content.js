(() => {
  const VIDEO_EXT_REGEX = /\.(mp4|m4v|webm|mkv|mov|avi|flv|m3u8|mpd)(\?.*)?$/i;

  function resolveUrl(url) {
    if (!url) return null;
    try {
      return new URL(url, window.location.href).href;
    } catch (_) {
      return null;
    }
  }

  function getFilenameFromUrl(url) {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      if (segments.length > 0) {
        return decodeURIComponent(segments[segments.length - 1]);
      }
    } catch (_) {}
    return 'video';
  }

  function scanDomVideos() {
    const foundUrls = new Set();
    const results = [];

    function addCandidate(rawUrl, sourceDescription) {
      const fullUrl = resolveUrl(rawUrl);
      if (!fullUrl) return;
      if (fullUrl.startsWith('blob:') || fullUrl.startsWith('data:')) return;
      if (foundUrls.has(fullUrl)) return;

      const isVideoExt = VIDEO_EXT_REGEX.test(fullUrl);
      if (isVideoExt) {
        foundUrls.add(fullUrl);
        results.push({
          url: fullUrl,
          filename: getFilenameFromUrl(fullUrl),
          isHls: fullUrl.includes('.m3u8'),
          type: 'media',
          source: sourceDescription,
          timestamp: Date.now()
        });
      }
    }

    // 1. Scan <video> and <audio> tags
    document.querySelectorAll('video, audio').forEach((mediaEl) => {
      if (mediaEl.currentSrc) addCandidate(mediaEl.currentSrc, '<video.currentSrc>');
      if (mediaEl.src) addCandidate(mediaEl.src, '<video.src>');

      mediaEl.querySelectorAll('source').forEach((srcEl) => {
        if (srcEl.src) addCandidate(srcEl.src, '<source.src>');
      });
    });

    // 2. Scan all anchor <a> links
    document.querySelectorAll('a[href]').forEach((a) => {
      addCandidate(a.getAttribute('href'), '<a> link');
    });

    // 3. Scan <iframe> embeds & objects
    document.querySelectorAll('iframe[src], embed[src], object[data]').forEach((el) => {
      const src = el.getAttribute('src') || el.getAttribute('data');
      if (src) addCandidate(src, '<frame/embed>');
    });

    // 4. Scan data-* attributes across the entire document
    document.querySelectorAll('*').forEach((el) => {
      for (const attr of el.attributes) {
        if (attr.name.startsWith('data-') && VIDEO_EXT_REGEX.test(attr.value)) {
          addCandidate(attr.value, `[${attr.name}]`);
        }
      }
    });

    return results;
  }

  // Scan immediately and notify background script
  const scanned = scanDomVideos();
  if (scanned.length > 0) {
    chrome.runtime.sendMessage({
      action: 'pageDomMediaFound',
      items: scanned
    });
  }

  // Listen for explicit rescan requests from popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'scanDom') {
      const current = scanDomVideos();
      sendResponse({ items: current });
      return true;
    }
  });
})();
