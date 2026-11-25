(() => {
  const VIDEO_EXT_REGEX = /\.(mp4|m4v|webm|mkv|mov|avi|flv|m3u8|mpd)(\?.*)?$/i;

  // Inject hook script into the actual page execution environment
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('injected.js');
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => s.remove();
  } catch (_) {}

  // Listen for media messages dispatched by injected hook
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.type !== '__UDEMY_MEDIA_SNIFFED__') return;
    const { url, isM3u8 } = event.data;
    if (url) {
      chrome.runtime.sendMessage({
        action: 'pageDomMediaFound',
        items: [{
          url: url,
          filename: getFilenameFromUrl(url),
          isHls: Boolean(isM3u8),
          type: 'media',
          source: 'XHR/Fetch Hook',
          timestamp: Date.now()
        }]
      });
    }
  });

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

  function scanUdemySpecificMedia() {
    const results = [];

    // Udemy Shaka player video tag & container
    const udemyVideos = document.querySelectorAll('video, [data-purpose="shaka-video-player"] video');
    udemyVideos.forEach((v) => {
      // Find lecture title if present on page
      let title = '';
      const titleEl = document.querySelector('[data-purpose="course-header-title"] a, .lecture-view--container--mrZSm');
      if (titleEl) {
        title = titleEl.getAttribute('aria-label') || titleEl.textContent || '';
        title = title.replace(/[\\/:*?"<>|]/g, '_').trim();
      }

      // Check currentSrc and src
      const src = v.currentSrc || v.src;
      if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
        results.push({
          url: src,
          filename: title ? `${title}.mp4` : getFilenameFromUrl(src),
          isHls: src.includes('.m3u8'),
          type: 'media',
          source: 'Udemy Player',
          timestamp: Date.now()
        });
      }
    });

    return results;
  }

  function scanDomVideos() {
    const foundUrls = new Set();
    const results = [...scanUdemySpecificMedia()];
    results.forEach(r => foundUrls.add(r.url));

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

  // Scan immediately
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
