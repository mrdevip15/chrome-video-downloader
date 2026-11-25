(() => {
  const isManifestUrl = (url) => /\.(m3u8|mpd)(\?|$)/i.test(url);

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : null);
    const response = await originalFetch.apply(this, args);

    if (url) {
      const urlMatch = isManifestUrl(url);
      if (urlMatch) {
        window.postMessage({
          type: '__UDEMY_MEDIA_SNIFFED__',
          url,
          isM3u8: /\.m3u8(\?|$)/i.test(url),
          isMpd: /\.mpd(\?|$)/i.test(url)
        }, '*');
      } else {
        const ct = (response.headers && response.headers.get('content-type')) || '';
        if (/mpegurl|dash\+xml|text\/plain|application\/octet-stream/i.test(ct)) {
          try {
            response.clone().text().then((text) => {
              const isM3u8 = text.includes('#EXTM3U');
              const isMpd = /<MPD[\s>]/i.test(text);
              if (isM3u8 || isMpd) {
                window.postMessage({ type: '__UDEMY_MEDIA_SNIFFED__', url, isM3u8, isMpd }, '*');
              }
            }).catch(() => {});
          } catch (_) {}
        }
      }
    }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._url = url;
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      if (!this._url) return;
      const body = typeof this.responseText === 'string' ? this.responseText.slice(0, 2000) : '';
      const isM3u8 = /\.m3u8(\?|$)/i.test(this._url) || body.includes('#EXTM3U');
      const isMpd = /\.mpd(\?|$)/i.test(this._url) || /<MPD[\s>]/i.test(body);
      if (isM3u8 || isMpd) {
        try {
          window.postMessage({ type: '__UDEMY_MEDIA_SNIFFED__', url: this._url, isM3u8, isMpd }, '*');
        } catch (_) {}
      }
    });
    return originalSend.apply(this, args);
  };
})();
