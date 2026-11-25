(() => {
  // Overwrite window.fetch to catch master playlists, segment lists, and video responses
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : null);
    const response = await originalFetch.apply(this, args);
    
    if (url && (
      url.includes('.m3u8') || 
      url.includes('.mpd') || 
      url.includes('/media-license-server/') ||
      url.includes('/api-2.0/users/me/subscribed-courses/') ||
      url.includes('/api-2.0/lectures/')
    )) {
      try {
        const clone = response.clone();
        clone.text().then(text => {
          window.postMessage({
            type: '__UDEMY_MEDIA_SNIFFED__',
            url: url,
            isM3u8: url.includes('.m3u8') || text.includes('#EXTM3U'),
            payload: text.slice(0, 5000)
          }, '*');
        }).catch(() => {});
      } catch (_) {}
    }
    return response;
  };

  // Overwrite XMLHttpRequest to catch XHR-based manifest/video requests
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._url = url;
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      if (this._url && (
        this._url.includes('.m3u8') || 
        this._url.includes('.mpd') || 
        this._url.includes('/api-2.0/users/me/subscribed-courses/') ||
        this._url.includes('/api-2.0/lectures/')
      )) {
        try {
          window.postMessage({
            type: '__UDEMY_MEDIA_SNIFFED__',
            url: this._url,
            isM3u8: this._url.includes('.m3u8') || (typeof this.responseText === 'string' && this.responseText.includes('#EXTM3U')),
            payload: typeof this.responseText === 'string' ? this.responseText.slice(0, 5000) : ''
          }, '*');
        } catch (_) {}
      }
    });
    return originalSend.apply(this, args);
  };
})();
