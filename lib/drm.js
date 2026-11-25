// DRM / content-protection helpers: HLS AES-128 key handling, IV derivation,
// PSSH/KID extraction from fMP4 init segments and DASH MPDs, base64 codecs.
// Exposes globalThis.DRM. Runs in the extension and in the Node test sandbox.
(function (root) {
  const cryptoSrc = () => root.crypto || root.msCrypto || null;

  // ---------- binary helpers ----------
  function bytesFromB64(s) {
    const clean = String(s).replace(/[\r\n\s]/g, '');
    const bin = (typeof atob === 'function' ? atob(clean) : Buffer.from(clean, 'base64').toString('binary'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function b64FromBytes(u8) {
    let bin = '';
    const arr = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
  }

  function hexFromBytes(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
    return s;
  }

  function bytesFromHex(s) {
    const h = String(s).replace(/^0x/i, '').replace(/[^0-9a-f]/gi, '');
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }

  // ---------- HLS AES-128 ----------
  // IV for a segment: explicit IV from the key tag, else the media sequence
  // number as a 128-bit big-endian integer (RFC 8216 §5.2).
  function ivForSegment(key, seq) {
    if (key && key.iv) {
      const raw = bytesFromHex(key.iv);
      if (raw.length === 16) return raw;
      const iv = new Uint8Array(16);
      iv.set(raw.subarray(Math.max(0, raw.length - 16)), 16 - Math.min(16, raw.length));
      return iv;
    }
    const iv = new Uint8Array(16);
    const view = new DataView(iv.buffer);
    view.setUint32(8, Math.floor(seq / 0x100000000) >>> 0);
    view.setUint32(12, seq >>> 0);
    return iv;
  }

  async function importAesCbcKey(rawBytes) {
    const c = cryptoSrc();
    if (!c || !c.subtle) throw new Error('WebCrypto unavailable');
    return c.subtle.importKey('raw', rawBytes, { name: 'AES-CBC' }, false, ['decrypt']);
  }

  // CryptoKey cache keyed by the key URI so a single key tag serving 500
  // segments only costs one network round trip.
  function makeKeyCache(fetchKeyBytes) {
    const cache = new Map();
    return async function getKey(uri) {
      if (!uri) throw new Error('Encrypted segment has no key URI');
      if (!cache.has(uri)) {
        cache.set(uri, (async () => {
          const raw = await fetchKeyBytes(uri);
          if (!raw || raw.length !== 16) throw new Error(`AES-128 key is ${raw ? raw.length : 0} bytes, expected 16`);
          return importAesCbcKey(raw);
        })());
      }
      return cache.get(uri);
    };
  }

  async function decryptAes128(cryptoKey, iv, data) {
    const c = cryptoSrc();
    // WebCrypto's AES-CBC rejects ciphertext that is not a multiple of 16.
    if (!data || data.length === 0 || data.length % 16 !== 0) {
      throw new Error(`Ciphertext length ${data ? data.length : 0} is not a multiple of the AES block size`);
    }
    const buf = await c.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, data);
    return new Uint8Array(buf);
  }

  // ---------- PSSH / KID extraction ----------
  // Byte-scan for ISO-BMFF 'pssh' boxes (they sit inside moov, so a byte scan
  // is simpler and more tolerant than a full box walk for our purposes).
  function extractPssh(u8) {
    const out = [];
    if (!u8 || u8.length < 32) return out;
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    for (let i = 0; i + 8 <= u8.length; i++) {
      if (u8[i] !== 0x70 || u8[i + 1] !== 0x73 || u8[i + 2] !== 0x73 || u8[i + 3] !== 0x68) continue; // 'pssh'
      if (i < 4) continue;
      const size = view.getUint32(i - 4);
      if (size < 32 || i - 4 + size > u8.length) continue;
      const box = u8.subarray(i - 4, i - 4 + size);
      const systemId = hexFromBytes(box.subarray(12, 28)).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
      const b64 = b64FromBytes(box);
      if (!out.some((p) => p.b64 === b64)) out.push({ systemId, b64 });
      i += size - 1;
    }
    return out;
  }

  function kidFromUuidHex(hex) {
    const h = String(hex || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
    if (h.length !== 32) return null;
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  // Pull default_KID / cenc:pssh out of a static MPD.
  function psshFromMpd(xmlText) {
    const kids = [];
    const pssh = [];
    const text = String(xmlText || '');
    const kidRe = /default_KID\s*=\s*["']([0-9a-fA-F-]{32,36})["']/g;
    let m;
    while ((m = kidRe.exec(text))) {
      const kid = kidFromUuidHex(m[1]);
      if (kid && !kids.includes(kid)) kids.push(kid);
    }
    const b64Re = /<(?:\w+:)?pssh[^>]*>([A-Za-z0-9+/=\s]+)<\/(?:\w+:)?pssh>/g;
    while ((m = b64Re.exec(text))) {
      const b64 = m[1].replace(/\s+/g, '');
      if (!pssh.some((p) => p.b64 === b64)) pssh.push({ systemId: 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', b64 });
    }
    return { kids, pssh };
  }

  function isWidevine(list) {
    return (list || []).some((p) => /^edef8ba9/i.test(String(p.systemId || '').replace(/-/g, '')));
  }

  root.DRM = {
    bytesFromB64,
    b64FromBytes,
    hexFromBytes,
    bytesFromHex,
    ivForSegment,
    importAesCbcKey,
    makeKeyCache,
    decryptAes128,
    extractPssh,
    psshFromMpd,
    kidFromUuidHex,
    isWidevine
  };
})(globalThis);
