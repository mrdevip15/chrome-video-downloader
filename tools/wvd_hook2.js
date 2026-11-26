// Offset-based hook for libwvdrmengine.so.
// Symbol names are stripped from .dynsym on Android, but .gnu_debugdata carries the
// real symtab, giving exact function addresses:
//   0x18a230  wvdrm::WVGenericCryptoInterface::loadDeviceRSAKey(uint, uchar const*, ulong)
//   0x18a240  wvdrm::WVGenericCryptoInterface::generateRSASignature(uint, uchar const*, ulong, uchar*, ulong*, uchar)
// Module base + st_value == runtime address (PIE, vaddr starts at 0).
//
// Emits { load: {hex, len} } when loadDeviceRSAKey fires.

const TARGET_MODULE = 'libwvdrmengine.so';
const OFF_LOAD_KEY = 0x18a230;
const OFF_SIGN = 0x18a240;

function findModule(name) {
  const mods = Process.enumerateModules();
  for (let i = 0; i < mods.length; i++) {
    if (mods[i].name === name) return mods[i];
  }
  return null;
}

const mod = findModule(TARGET_MODULE);
if (!mod) {
  send({ error: 'module not loaded', modules: Process.enumerateModules().map((m) => m.name) });
} else {
  send({ ready: true, base: mod.base.toString(), size: mod.size, path: mod.path });

  const loadAddr = mod.base.add(OFF_LOAD_KEY);
  const signAddr = mod.base.add(OFF_SIGN);

  let emitted = false;

  Interceptor.attach(loadAddr, {
    onEnter(args) {
      try {
        const len = args[2].toInt32();
        if (len <= 0 || len > 8192) {
          send({ note: 'loadDeviceRSAKey called with odd length', len });
          return;
        }
        const bytes = args[1].readByteArray(len);
        if (!bytes) return;
        const hex = Array.prototype.map
          .call(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0'))
          .join('');
        const head = hex.slice(0, 16);
        send({ load: { hex, len, head, sessionId: args[0].toInt32() } });
        emitted = true;
      } catch (e) {
        send({ error: 'load hook: ' + e });
      }
    }
  });

  Interceptor.attach(signAddr, {
    onEnter(args) {
      try {
        send({ sign: { sessionId: args[0].toInt32(), len: args[2].toInt32() } });
      } catch (_) {}
    }
  });

  send({ hooked: { loadAddr: loadAddr.toString(), signAddr: signAddr.toString() } });
}
