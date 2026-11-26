// Frida script: pull the Widevine device RSA key out of the DRM service at sign time.
// Attach to android.hardware.drm@1.x-service.widevine while a DRM session is active.
// Sends {"n","e","d","p","q"} hex strings to the host once per new key.

const seen = new Set();

// Frida 17 replaced Module.findExportByName with Module.getGlobalExportByName.
// Exports in dlopen'd CDM libraries are often not global, so search module exports too.
const exportCache = new Map();

function safeFind(name) {
  if (exportCache.has(name)) return exportCache.get(name);
  let found = null;
  try {
    if (typeof Module.getGlobalExportByName === 'function') found = Module.getGlobalExportByName(name);
  } catch (_) {}
  if (!found) {
    try {
      if (typeof Module.findExportByName === 'function') found = Module.findExportByName(null, name);
    } catch (_) {}
  }
  if (!found) {
    const mods = Process.enumerateModules();
    for (let i = 0; i < mods.length && !found; i++) {
      const mod = mods[i];
      try {
        if (typeof mod.findExportByName === 'function') {
          const a = mod.findExportByName(name);
          if (a) found = a;
        }
      } catch (_) {}
      if (!found) {
        try {
          const exps = Module.enumerateExports(mod.name);
          for (let j = 0; j < exps.length; j++) {
            if (exps[j].name === name && exps[j].address) {
              found = exps[j].address;
              break;
            }
          }
        } catch (_) {}
      }
    }
  }
  exportCache.set(name, found);
  return found;
}

function hexOfBN(bnPtr) {
  try {
    const hexAddr = safeFind('BN_bn2hex');
    if (hexAddr) {
      const fn = new NativeFunction(hexAddr, 'pointer', ['pointer']);
      const out = fn(bnPtr);
      if (out.isNull()) return null;
      const s = out.readUtf8();
      const freeAddr = safeFind('OPENSSL_free');
      if (freeAddr) new NativeFunction(freeAddr, 'void', ['pointer'])(out);
      return s.toLowerCase();
    }
    const BN_bn2bin = safeFind('BN_bn2bin');
    const BN_num_bits = safeFind('BN_num_bits');
    if (!BN_bn2bin || !BN_num_bits) return null;
    const bits = new NativeFunction(BN_num_bits, 'int', ['pointer'])(bnPtr);
    const len = (bits + 7) >> 3;
    const buf = Memory.alloc(len);
    new NativeFunction(BN_bn2bin, 'int', ['pointer', 'pointer'])(bnPtr, buf);
    return buf.readByteArray(len) ? Array.from(new Uint8Array(buf.readByteArray(len)))
      .map((b) => b.toString(16).padStart(2, '0')).join('') : null;
  } catch (e) {
    return null;
  }
}

function emit(rsaPtr) {
  try {
    const getKey = safeFind('RSA_get0_key');
    const getFactors = safeFind('RSA_get0_factors');
    if (!getKey) {
      send({ error: 'RSA_get0_key not exported' });
      return;
    }
    const nRef = Memory.alloc(Process.pointerSize);
    const eRef = Memory.alloc(Process.pointerSize);
    const dRef = Memory.alloc(Process.pointerSize);
    new NativeFunction(getKey, 'void', ['pointer', 'pointer', 'pointer', 'pointer'])(rsaPtr, nRef, eRef, dRef);

    let pRef = null;
    let qRef = null;
    if (getFactors) {
      pRef = Memory.alloc(Process.pointerSize);
      qRef = Memory.alloc(Process.pointerSize);
      const getF = new NativeFunction(getFactors, 'void', ['pointer', 'pointer', 'pointer']);
      getF(rsaPtr, pRef, qRef);
    }

    const n = hexOfBN(nRef.readPointer());
    const e = hexOfBN(eRef.readPointer());
    const d = hexOfBN(dRef.readPointer());
    const p = pRef ? hexOfBN(pRef.readPointer()) : null;
    const q = qRef ? hexOfBN(qRef.readPointer()) : null;
    if (!n || !e || !d) {
      send({ error: 'incomplete key material', n: !!n, e: !!e, d: !!d });
      return;
    }
    const id = `${n}:${d}`;
    if (seen.has(id)) return;
    seen.add(id);
    send({ n, e, d, p, q });
  } catch (err) {
    send({ error: String(err) });
  }
}

function hookName(name, argIndex) {
  const addr = safeFind(name);
  if (!addr) return false;
  Interceptor.attach(addr, {
    onEnter(args) {
      try { emit(args[argIndex]); } catch (_) {}
    }
  });
  return true;
}

const hooked = [];
// BoringSSL: int RSA_sign(int type, const uint8_t *m, unsigned mlen, uint8_t *sig, unsigned *slen, RSA *rsa)
if (hookName('RSA_sign', 5)) hooked.push('RSA_sign');
// int RSA_private_encrypt(int flen, const uint8_t *from, uint8_t *to, RSA *rsa, int padding)
if (hookName('RSA_private_encrypt', 3)) hooked.push('RSA_private_encrypt');

send({ ready: true, hooked, modules: Process.enumerateModules().filter((m) => /wvdrm|wvhidl|oemcrypto|crypto/.test(m.name)).map((m) => m.name) });
