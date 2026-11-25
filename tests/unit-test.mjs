import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function loadModule(relPath, sandbox) {
  const code = fs.readFileSync(path.join(rootDir, relPath), 'utf8');
  vm.runInContext(code, sandbox, { filename: relPath });
}

const sandbox = vm.createContext({
  globalThis: null,
  window: null,
  self: null,
  fetch,
  URL,
  Blob,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  ArrayBuffer,
  Map,
  Set,
  Date,
  Math,
  RegExp,
  Promise,
  Error,
  crypto: globalThis.crypto,
  atob: globalThis.atob,
  btoa: globalThis.btoa,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  console
});
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
sandbox.self = sandbox;

loadModule('vendor/mux.min.js', sandbox);
loadModule('lib/vtt.js', sandbox);
loadModule('lib/m3u8.js', sandbox);
loadModule('lib/mpd.js', sandbox);
loadModule('lib/drm.js', sandbox);
loadModule('lib/engine.js', sandbox);
loadModule('lib/udemy-model.js', sandbox);
loadModule('lib/export.js', sandbox);

const { CourseFormatter, M3U8, DRM, Engine, UdemyModel, CourseExport } = sandbox;

// 1. lib/vtt.js
console.log('Testing lib/vtt.js...');
{
  const vtt = `WEBVTT
Kind: captions
Language: en

NOTE ignore this note

00:01.500 --> 00:04.250 align:start position:0%
Hello <i>world</i> <c.colorE5E5E5>extra</c>

12
01:02:03.000 --> 01:02:05.125
Second line
`;
  const srt = CourseFormatter.vttToSrt(vtt);
  assert.match(srt, /^1\n00:00:01,500 --> 00:00:04,250\nHello <i>world<\/i> extra\n\n2\n01:02:03,000 --> 01:02:05,125\nSecond line\n$/);
  assert.equal(CourseFormatter.sanitizePath('CON'), '_CON');
  assert.equal(CourseFormatter.sanitizePath('a/b\\c:d*e?f"g<h>i|j.. '), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(CourseFormatter.sanitizePath('..hidden'), 'hidden');
}

// 2. lib/m3u8.js
console.log('Testing lib/m3u8.js...');
{
  const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,AUDIO="aud"
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1920x1080,AUDIO="aud"
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,AUDIO="aud"
360/index.m3u8
`;
  const pm = M3U8.parse(master, 'https://cdn.example.com/v1/master.m3u8');
  assert.equal(pm.type, 'master');
  assert.equal(pm.variants.length, 3);
  assert.equal(M3U8.pickVariant(pm.variants, 720).resolution.height, 720);
  assert.equal(M3U8.pickVariant(pm.variants, 0).resolution.height, 1080);
  assert.equal(M3U8.pickVariant(pm.variants, 240).resolution.height, 360);
  assert.equal(pm.media[0].uri, 'https://cdn.example.com/v1/audio/en.m3u8');

  const encMedia = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="https://example.com/key"
#EXTINF:2.0,
seg0.ts
#EXT-X-ENDLIST
`;
  const pe = M3U8.parse(encMedia, 'https://cdn.example.com/media.m3u8');
  assert.equal(pe.encrypted, true);
  assert.equal(pe.encryption, 'AES-128');

  const brMedia = `#EXTM3U
#EXT-X-MAP:URI="init.mp4",BYTERANGE="500@0"
#EXTINF:2.0,
#EXT-X-BYTERANGE:1000@500
chunk.m4s
#EXTINF:2.0,
#EXT-X-BYTERANGE:1200
chunk.m4s
#EXT-X-ENDLIST
`;
  const pb = M3U8.parse(brMedia, 'https://cdn.example.com/br.m3u8');
  assert.equal(pb.map.uri, 'https://cdn.example.com/init.mp4');
  assert.deepEqual(JSON.parse(JSON.stringify(pb.segments[0].byterange)), { length: 1000, offset: 500 });
  assert.deepEqual(JSON.parse(JSON.stringify(pb.segments[1].byterange)), { length: 1200, offset: 1500 });
}

// 3. lib/udemy-model.js
console.log('Testing lib/udemy-model.js...');
{
  const items = [
    { _class: 'chapter', id: 10, object_index: 1, title: 'Intro: Basics' },
    {
      _class: 'lecture',
      id: 101,
      object_index: 1,
      title: 'Welcome',
      asset: {
        asset_type: 'Video',
        captions: [{ locale_id: 'en_US', video_label: 'English' }, { locale_id: 'id_ID', video_label: 'Indonesian' }]
      },
      supplementary_assets: [{ id: 501, title: 'Notes', filename: 'notes.pdf' }]
    }
  ];
  const course = UdemyModel.buildCourse(items, 999, 'Course: Test/101');
  assert.equal(course.dirName, 'Course_ Test_101');
  assert.equal(course.sections[0].dirName, '01 - Intro_ Basics');
  assert.equal(course.sections[0].lectures[0].fileBase, '01 - Welcome');
  assert.equal(UdemyModel.allCaptionLocales(course).length, 2);

  const asset = {
    media_sources: [
      { type: 'video/mp4', label: '720', src: 'https://x/720.mp4' },
      { type: 'video/mp4', label: '1080', src: 'https://x/1080.mp4' },
      { type: 'application/x-mpegURL', src: 'https://x/hls.m3u8' }
    ]
  };
  assert.equal(UdemyModel.pickDirectMp4(asset, 720).url, 'https://x/720.mp4');
  assert.equal(UdemyModel.pickDirectMp4(asset, 0).url, 'https://x/720.mp4'); // 0 <= 0 false -> smallest; let's check maxHeight=2160
  assert.equal(UdemyModel.pickDirectMp4(asset, 2160).url, 'https://x/1080.mp4');
  assert.equal(UdemyModel.pickHls(asset), 'https://x/hls.m3u8');
}

// 4. lib/export.js
console.log('Testing lib/export.js...');
{
  const html = CourseExport.articleToHtml('Lesson <1>', '<p>Hello <b>world</b></p>');
  assert.match(html, /<title>Lesson &lt;1&gt;<\/title>/);
  assert.match(html, /<p>Hello <b>world<\/b><\/p>/);

  const md = CourseExport.articleToMarkdown('Lesson 1', '<h2>Header</h2><p>Line with <strong>bold</strong> and <a href="https://a.b">link</a>.</p><ul><li>One</li><li>Two</li></ul><pre><code>const x = 1;</code></pre>');
  assert.match(md, /^# Lesson 1/);
  assert.match(md, /## Header/);
  assert.match(md, /\*\*bold\*\*/);
  assert.match(md, /\[link\]\(https:\/\/a\.b\)/);
  assert.match(md, /- One/);
  assert.match(md, /```\nconst x = 1;\n```/);

  const idxHtml = CourseExport.generateCourseIndexHtml(
    {
      title: 'Test Course',
      sections: [
        {
          dirName: '01 - Intro',
          lectures: [
            { id: 1, title: 'L1', fileBase: '01 - L1', assetType: 'Video' },
            { id: 2, title: 'L2', fileBase: '02 - L2', assetType: 'Video' }
          ]
        }
      ]
    },
    {
      1: { status: 'done', videoFile: '01 - Intro/01 - L1.mp4', subtitleFiles: ['01 - Intro/01 - L1.en_US.srt'], articleFiles: [], resourceFiles: ['01 - Intro/Resources/a b.txt'] },
      2: { status: 'drm', videoStatus: 'drm', subtitleFiles: [], articleFiles: [], resourceFiles: [] }
    }
  );
  assert.match(idxHtml, /Videos: <strong>1<\/strong>/);
  assert.match(idxHtml, /DRM Skipped: <strong>1<\/strong>/);
  assert.match(idxHtml, /01%20-%20Intro\/Resources\/a%20b\.txt/);
}

// 4b. lib/drm.js
console.log('Testing lib/drm.js...');
{
  const seq = 0x0102030405;
  const iv = DRM.ivForSegment({ iv: null }, seq);
  assert.equal(iv.length, 16);
  assert.equal(DRM.hexFromBytes(iv), '00000000000000000000000102030405');

  const explicit = DRM.ivForSegment({ iv: '0xAABBCCDDEEFF00112233445566778899' }, 7);
  assert.equal(DRM.hexFromBytes(explicit), 'aabbccddeeff00112233445566778899');

  // Round-trip base64 helpers
  const bytes = new Uint8Array([0, 1, 2, 254, 255]);
  assert.equal(DRM.b64FromBytes(bytes), 'AAEC/v8=');
  assert.deepEqual(DRM.bytesFromB64('AAEC/v8='), bytes);

  // Build a syntactically valid pssh box (version 0, 16-byte system id + data)
  const systemId = DRM.bytesFromHex('edef8ba979d64acea3c827dcd51d21ed');
  const payload = DRM.bytesFromHex('0801121000000000000000000000000000000000');
  const boxLen = 32 + payload.length;
  const psshBox = new Uint8Array(boxLen);
  new DataView(psshBox.buffer).setUint32(0, boxLen);
  psshBox.set(new TextEncoder().encode('pssh'), 4);
  psshBox.set(systemId, 12);
  new DataView(psshBox.buffer).setUint32(28, payload.length);
  psshBox.set(payload, 32);
  const psshB64 = DRM.b64FromBytes(psshBox);

  // psshFromMpd
  const mpd = `<MPD><Period><AdaptationSet>
    <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" cenc:default_KID="0123abcd-4567-89ab-cdef-0123456789ab">
      <cenc:pssh>${psshB64}</cenc:pssh>
    </ContentProtection></AdaptationSet></Period></MPD>`;
  const prot = DRM.psshFromMpd(mpd);
  assert.deepEqual(JSON.parse(JSON.stringify(prot.kids)), ['0123abcd-4567-89ab-cdef-0123456789ab']);
  assert.equal(prot.pssh.length, 1);
  assert.equal(prot.pssh[0].systemId, 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed');

  // extractPssh on a synthetic fMP4 init segment
  const init = new Uint8Array(8 + psshBox.length);
  new DataView(init.buffer).setUint32(0, 8);
  init.set(new TextEncoder().encode('ftyp'), 4);
  init.set(psshBox, 8);
  const found = DRM.extractPssh(init);
  assert.equal(found.length, 1);
  assert.equal(found[0].b64, psshB64);
}

// 5. lib/engine.js: fetchRetry, runOrdered, and real ffmpeg HLS TS -> mux.js MP4 remux
console.log('Testing lib/engine.js & mux.js transmuxing...');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvd-unit-'));
try {
  // Generate 6-second 3-segment HLS stream with ffmpeg
  const hlsDir = path.join(tmp, 'hls');
  fs.mkdirSync(hlsDir);
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6:sample_rate=44100',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '64k',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
    '-hls_segment_filename', path.join(hlsDir, 'seg_%03d.ts'),
    path.join(hlsDir, 'index.m3u8')
  ]);

  // AES-128 variant of the same segments (RFC 8216: implicit IV = media sequence number)
  const aesDir = path.join(tmp, 'enc');
  fs.mkdirSync(aesDir);
  const aesKey = crypto.randomBytes(16);
  const tsFiles = fs.readdirSync(hlsDir).filter((f) => f.endsWith('.ts')).sort();
  tsFiles.forEach((f, i) => {
    const iv = Buffer.alloc(16);
    iv.writeUInt32BE(i, 12);
    const cipher = crypto.createCipheriv('aes-128-cbc', aesKey, iv);
    const enc = Buffer.concat([cipher.update(fs.readFileSync(path.join(hlsDir, f))), cipher.final()]);
    fs.writeFileSync(path.join(aesDir, `${f}.enc`), enc);
  });
  fs.writeFileSync(
    path.join(aesDir, 'index.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n' +
      tsFiles.map((f) => `#EXTINF:2.0,\n${f}.enc`).join('\n') +
      '\n#EXT-X-ENDLIST\n'
  );

  let flakyCalls = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/flaky') {
      flakyCalls++;
      if (flakyCalls < 3) {
        res.writeHead(503);
        res.end('retry');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok-after-retry');
      return;
    }
    if (req.url === '/encrypted.m3u8') {
      res.writeHead(200);
      res.end('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"\n#EXTINF:2,\nseg_000.ts\n#EXT-X-ENDLIST\n');
      return;
    }
    if (req.url === '/enc/key.bin') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(aesKey);
      return;
    }
    if (req.url.startsWith('/enc/')) {
      const fp = path.join(aesDir, path.basename(req.url));
      if (fs.existsSync(fp)) {
        res.writeHead(200);
        fs.createReadStream(fp).pipe(res);
      } else {
        res.writeHead(404);
        res.end('not found');
      }
      return;
    }
    const clean = req.url.replace(/^\//, '');
    const fp = path.join(hlsDir, clean);
    if (fs.existsSync(fp)) {
      res.writeHead(200);
      fs.createReadStream(fp).pipe(res);
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // Test retry
    const retryRes = await Engine.fetchRetry(`${base}/flaky`);
    assert.equal(await retryRes.text(), 'ok-after-retry');
    assert.equal(flakyCalls, 3);

    // Test runOrdered out-of-order completion preserves consumption order
  const consumed = [];
    await Engine.runOrdered(
      8,
      4,
      async (i) => {
        await new Promise((r) => setTimeout(r, (8 - i) * 10));
        return i * 10;
      },
      async (i, val) => {
        consumed.push([i, val]);
      }
    );
    assert.deepEqual(JSON.parse(JSON.stringify(consumed)), [[0, 0], [1, 10], [2, 20], [3, 30], [4, 40], [5, 50], [6, 60], [7, 70]]);

    // Node disk sink for testing downloadHls + mux.js
    const outDir = path.join(tmp, 'out');
    fs.mkdirSync(outDir);
    const nodeSink = {
      kind: 'fs',
      async exists(p) { return fs.existsSync(path.join(outDir, p)); },
      async open(p) {
        const full = path.join(outDir, p);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        const ws = fs.createWriteStream(full);
        return {
          write: (u8) => new Promise((res, rej) => ws.write(Buffer.from(u8), (e) => (e ? rej(e) : res()))),
          close: () => new Promise((res) => ws.end(res)),
          abort: async () => { ws.destroy(); }
        };
      }
    };

    // Test encrypted skip
    await assert.rejects(
      Engine.downloadHls(`${base}/encrypted.m3u8`, { sink: nodeSink, basePath: 'enc', concurrency: 2, maxHeight: 0, remux: true }),
      (e) => e instanceof Engine.EncryptedError && e.encrypted === true
    );

    // Test DRM export mode saves raw encrypted bytes instead of throwing
    const drmOuts = await Engine.downloadHls(`${base}/encrypted.m3u8`, {
      sink: nodeSink,
      basePath: 'drmraw',
      concurrency: 2,
      maxHeight: 0,
      remux: true,
      allowEncrypted: true
    });
    assert.equal(drmOuts[0].path, 'drmraw.enc.ts');
    assert.equal(drmOuts[0].encrypted, true);
    assert.ok(fs.statSync(path.join(outDir, 'drmraw.enc.ts')).size > 0);

    // Test AES-128 HLS decrypt (in-browser WebCrypto path) then remux
    const aesOuts = await Engine.downloadHls(`${base}/enc/index.m3u8`, {
      sink: nodeSink,
      basePath: 'aes',
      concurrency: 3,
      maxHeight: 0,
      remux: true
    });
    assert.equal(aesOuts.length, 1);
    assert.equal(aesOuts[0].path, 'aes.mp4');
    assert.equal(aesOuts[0].encrypted, false);
    const aesProbe = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path.join(outDir, 'aes.mp4')
    ], { encoding: 'utf8' }));
    const aesDur = parseFloat(aesProbe.format.duration);
    console.log(`AES-128 decrypted MP4 duration=${aesDur.toFixed(2)}s`);
    assert.ok(aesDur >= 5.5 && aesDur <= 6.5, `Expected ~6s from decrypted HLS, got ${aesDur}`);
    execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(outDir, 'aes.mp4'), '-f', 'null', '-']);

    // Test HLS download + mux.js remux
    const outs = await Engine.downloadHls(`${base}/index.m3u8`, {
      sink: nodeSink,
      basePath: 'remuxed',
      concurrency: 3,
      maxHeight: 0,
      remux: true
    });
    assert.equal(outs.length, 1);
    assert.equal(outs[0].path, 'remuxed.mp4');
    assert.equal(outs[0].mode, 'remux');

    const mp4Path = path.join(outDir, 'remuxed.mp4');
    const probeJson = execFileSync('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', mp4Path
    ], { encoding: 'utf8' });
    const probe = JSON.parse(probeJson);
    const dur = parseFloat(probe.format.duration);
    const codecs = probe.streams.map((s) => s.codec_type).sort();
    console.log(`Remuxed MP4 duration=${dur.toFixed(2)}s streams=${codecs.join(',')}`);
    assert.ok(dur >= 5.5 && dur <= 6.5, `Expected ~6s duration, got ${dur}`);
    assert.deepEqual(codecs, ['audio', 'video']);

    // Verify full decode succeeds cleanly
    execFileSync('ffmpeg', ['-v', 'error', '-i', mp4Path, '-f', 'null', '-']);
  } finally {
    server.close();
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('ALL UNIT TESTS PASSED');
