// Configurable offset-based hook. CFG is injected by wvd_dump3.py, e.g.
//   { module: "libwvhidl.so", load: 0x1ab8b0, sign: 0x1ab8c0 }
// Module base + st_value (from .gnu_debugdata symtab) == runtime address.

const CFG = __CFG__;

function findModule(name) {
  const mods = Process.enumerateModules();
  for (let i = 0; i < mods.length; i++) {
    if (mods[i].name === name) return mods[i];
  }
  return null;
}

const mod = findModule(CFG.module);
if (!mod) {
  send({
    error: 'module not loaded: ' + CFG.module,
    candidates: Process.enumerateModules()
      .filter(function (m) { return /wv|drm/i.test(m.name); })
      .map(function (m) { return m.name; })
  });
} else {
  send({ ready: true, base: mod.base.toString(), size: mod.size, path: mod.path });

  function tryHook(offset, label, argIndex, argLenIndex) {
    if (!offset) return null;
    const addr = mod.base.add(offset);
    try {
      Interceptor.attach(addr, {
        onEnter(args) {
          try {
            let len = 0;
            if (argLenIndex >= 0) len = args[argLenIndex].toInt32();
            if (len <= 0 || len > 16384) {
              send({ note: label + ' called, unexpected length', len: len });
              return;
            }
            const bytes = args[argIndex].readByteArray(len);
            if (!bytes) return;
            const hex = Array.prototype.map
              .call(new Uint8Array(bytes), function (b) { return b.toString(16).padStart(2, '0'); })
              .join('');
            send({ hit: label, len: len, head: hex.slice(0, 32), hex: hex });
          } catch (e) {
            send({ error: label + ': ' + e });
          }
        }
      });
      return addr.toString();
    } catch (e) {
      send({ error: 'attach ' + label + ': ' + e });
      return null;
    }
  }

  send({ hooked: { load: tryHook(CFG.load, 'loadDeviceRSAKey', 1, 2), sign: tryHook(CFG.sign, 'generateRSASignature', 1, 2) } });
}
