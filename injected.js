(() => {
  const isManifestUrl = (url) => /\.(m3u8|mpd)(\?|$)/i.test(url);
  const isLicenseUrl = (url) => /(?:^|[/?&_.-])(licen[cs]e|widevine|playready|drm)(?:[/?&_.-]|$)/i.test(url);

  const b64 = (bytes) => {
    let bin = '';
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin);
  };

  const toBytes = (body) => {
    if (!body) return null;
    try {
      if (typeof body === 'string') return new TextEncoder().encode(body);
      if (body instanceof ArrayBuffer) return new Uint8Array(body);
      if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    } catch (_) {}
    return null;
  };

  const headerObj = (headers) => {
    const out = {};
    if (!headers) return out;
    try {
      if (!Array.isArray(headers) && typeof headers.forEach === 'function') {
        headers.forEach((v, k) => { out[k] = v; });
      } else if (Array.isArray(headers)) {
        headers.forEach(([k, v]) => { out[k] = v; });
      } else {
        Object.keys(headers).forEach((k) => { out[k] = headers[k]; });
      }
    } catch (_) {}
    return out;
  };

  window.__DRM_CAPTURES__ = window.__DRM_CAPTURES__ || { initData: null, license: null };

  function publish(patch) {
    try { window.postMessage({ type: '__DRM_CAPTURE__', capture: patch }, '*'); } catch (_) {}
  }

  function recordInitData(keySystem, initDataType, initDataBytes) {
    if (!initDataBytes || !initDataBytes.length) return;
    window.__DRM_CAPTURES__.initData = { keySystem, initDataType, b64: b64(initDataBytes), length: initDataBytes.length, at: Date.now() };
    publish({ initData: window.__DRM_CAPTURES__.initData });
  }

  function recordLicense(req) {
    window.__DRM_CAPTURES__.license = req;
    publish({ license: req });
  }

  // ---- EME: capture the Widevine init data (PSSH) fed to the CDM ----
  try {
    const origCreateSession = MediaKeys.prototype.createSession;
    MediaKeys.prototype.createSession = function (...args) {
      const session = origCreateSession.apply(this, args);
      try {
        const origGenerate = session.generateRequest.bind(session);
        session.generateRequest = function (initDataType, initData) {
          try { recordInitData(session.keySystem || '', initDataType, toBytes(initData)); } catch (_) {}
          return origGenerate(initDataType, initData);
        };
      } catch (_) {}
      return session;
    };
  } catch (_) {}

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : null);
    let capturedReq = null;

    if (url && isLicenseUrl(url)) {
      const init = args[1] || {};
      const bodyBytes = toBytes(init.body);
      capturedReq = {
        url,
        method: (init.method || 'POST').toUpperCase(),
        headers: headerObj(init.headers),
        bodyBase64: bodyBytes ? b64(bodyBytes) : null,
        cookies: (() => { try { return document.cookie; } catch (_) { return ''; } })(),
        origin: location.origin,
        at: Date.now()
      };
    }

    const response = await originalFetch.apply(this, args);

    if (url) {
      try {
        if (capturedReq) {
          recordLicense({ ...capturedReq, status: response.status, statusText: response.statusText });
        } else if (isManifestUrl(url)) {
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
      } catch (_) {}
    }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._url = url;
    this._method = (method || 'GET').toUpperCase();
    this._drmHeaders = {};
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try { this._drmHeaders[name] = value; } catch (_) {}
    return originalSetHeader.apply(this, [name, value]);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body, ...rest) {
    const self = this;
    const url = String(self._url || '');
    const isLicense = isLicenseUrl(url);
    const bodyBytes = isLicense ? toBytes(body) : null;

    self.addEventListener('load', function () {
      if (!url) return;
      const text = typeof self.responseText === 'string' ? self.responseText.slice(0, 2000) : '';
      const isM3u8 = /\.m3u8(\?|$)/i.test(url) || text.includes('#EXTM3U');
      const isMpd = /\.mpd(\?|$)/i.test(url) || /<MPD[\s>]/i.test(text);
      if (isM3u8 || isMpd) {
        try { window.postMessage({ type: '__UDEMY_MEDIA_SNIFFED__', url, isM3u8, isMpd }, '*'); } catch (_) {}
      }
      if (isLicense) {
        try {
          recordLicense({
            url: new URL(url, location.href).href,
            method: self._method,
            headers: self._drmHeaders || {},
            bodyBase64: bodyBytes ? b64(bodyBytes) : null,
            cookies: document.cookie,
            origin: location.origin,
            status: self.status,
            statusText: self.statusText,
            at: Date.now()
          });
        } catch (_) {}
      }
    });
    return originalSend.apply(this, [body, ...rest]);
  };
})();
