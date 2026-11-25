import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(__dirname, '..');
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.rej(new Error(msg.error.message || JSON.stringify(msg.error)));
          else p.res(msg.result);
        }
      } else {
        this.events.push(msg);
      }
    });
  }
  async send(method, params = {}, sessionId = undefined) {
    await this.ready;
    const id = this.id++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify(payload));
    });
  }
  close() {
    try { this.ws.close(); } catch (_) {}
  }
}

async function waitFor(fn, timeoutMs = 30000, intervalMs = 250, label = 'condition') {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvd-edge-'));
const mediaDir = path.join(tmp, 'media');
const hlsDir = path.join(mediaDir, 'hls');
const dashDir = path.join(mediaDir, 'dash');
const profileDir = path.join(tmp, 'edge-profile');
const downloadsDir = path.join(tmp, 'downloads');
fs.mkdirSync(hlsDir, { recursive: true });
fs.mkdirSync(dashDir, { recursive: true });
fs.mkdirSync(profileDir, { recursive: true });
fs.mkdirSync(downloadsDir, { recursive: true });

// Configure Edge profile default download directory & disable download prompt
const defaultProfileDir = path.join(profileDir, 'Default');
fs.mkdirSync(defaultProfileDir, { recursive: true });
fs.writeFileSync(
  path.join(defaultProfileDir, 'Preferences'),
  JSON.stringify({
    download: { default_directory: downloadsDir, prompt_for_download: false }
  })
);

let server = null;
let edgeProc = null;
let cdp = null;

try {
  console.log('Generating test media fixtures with ffmpeg...');
  const directMp4 = path.join(mediaDir, 'direct.mp4');
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=44100',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k',
    directMp4
  ]);

  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=6:sample_rate=44100',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '64k',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
    '-hls_segment_filename', path.join(hlsDir, 'seg_%03d.ts'),
    path.join(hlsDir, 'index.m3u8')
  ]);

  // Generate static DASH MPD + m4s inside dashDir so relative chunk files land in dashDir
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=520:duration=4:sample_rate=44100',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '64k',
    '-f', 'dash', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '1',
    'manifest.mpd'
  ], { cwd: dashDir });

  const vttText = `WEBVTT

00:00.000 --> 00:02.000
Welcome to the course!

00:02.000 --> 00:03.000
Let us begin.
`;

  const resourceText = 'Sample exercise notes for Lesson 1.\n';

  // Local test HTTP server
  server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    const origin = `http://${req.headers.host}`;
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (u === '/video.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><title>Video Test Page</title></head><body>
        <video id="v" src="/media/direct.mp4" controls muted></video>
        <script>fetch('/media/hls/index.m3u8').then(r => r.text()).catch(() => {});</script>
      </body></html>`);
      return;
    }

    if (u === '/course/test/learn/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><title>Course: Test Course | Udemy</title></head><body>
        <div class="ud-component--course-taking--app" data-module-id="course-taking" data-module-args='{"courseId":9001}'>
          <div data-purpose="course-header-title"><a>Test Course</a></div>
        </div>
      </body></html>`);
      return;
    }

    if (u === '/api-2.0/courses/9001/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 9001, title: 'Test Course' }));
      return;
    }

    if (u === '/api-2.0/courses/9001/subscriber-curriculum-items/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        results: [
          { _class: 'chapter', id: 10, object_index: 1, title: 'Getting Started' },
          {
            _class: 'lecture', id: 101, object_index: 1, title: 'Direct Lecture',
            asset: { asset_type: 'Video', captions: [{ locale_id: 'en_US', video_label: 'English' }] },
            supplementary_assets: [{ id: 501, title: 'Exercise Notes', filename: 'notes.txt', asset_type: 'File' }]
          },
          {
            _class: 'lecture', id: 102, object_index: 2, title: 'HLS Lecture',
            asset: { asset_type: 'Video', captions: [] },
            supplementary_assets: []
          },
          {
            _class: 'lecture', id: 103, object_index: 3, title: 'DRM Lecture',
            asset: { asset_type: 'Video', course_is_drmed: true, captions: [{ locale_id: 'en_US', video_label: 'English' }] },
            supplementary_assets: []
          },
          { _class: 'chapter', id: 20, object_index: 2, title: 'Reading' },
          {
            _class: 'lecture', id: 104, object_index: 4, title: 'Setup Guide',
            asset: { asset_type: 'Article', captions: [] },
            supplementary_assets: []
          }
        ],
        next: null
      }));
      return;
    }

    if (u === '/api-2.0/users/me/subscribed-courses/9001/lectures/101/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 101,
        title: 'Direct Lecture',
        asset: {
          asset_type: 'Video',
          stream_urls: { Video: [{ type: 'video/mp4', label: '720', file: `${origin}/media/direct.mp4` }] },
          captions: [{ locale_id: 'en_US', url: `${origin}/subs/en.vtt` }]
        },
        supplementary_assets: [{ id: 501, title: 'Exercise Notes', filename: 'notes.txt', asset_type: 'File' }]
      }));
      return;
    }

    if (u === '/api-2.0/users/me/subscribed-courses/9001/lectures/101/supplementary-assets/501/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 501,
        title: 'Exercise Notes',
        filename: 'notes.txt',
        asset_type: 'File',
        download_urls: { File: [{ file: `${origin}/res/notes.txt` }] }
      }));
      return;
    }

    if (u === '/api-2.0/users/me/subscribed-courses/9001/lectures/102/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 102,
        title: 'HLS Lecture',
        asset: {
          asset_type: 'Video',
          media_sources: [{ type: 'application/x-mpegURL', src: `${origin}/media/hls/index.m3u8` }],
          captions: []
        },
        supplementary_assets: []
      }));
      return;
    }

    if (u === '/api-2.0/users/me/subscribed-courses/9001/lectures/103/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 103,
        title: 'DRM Lecture',
        asset: {
          asset_type: 'Video',
          course_is_drmed: true,
          media_license_token: 'fake-drm-token',
          media_sources: [{ type: 'application/x-mpegURL', src: `${origin}/media/encrypted.m3u8` }],
          captions: [{ locale_id: 'en_US', url: `${origin}/subs/en.vtt` }]
        },
        supplementary_assets: []
      }));
      return;
    }

    if (u === '/api-2.0/users/me/subscribed-courses/9001/lectures/104/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 104,
        title: 'Setup Guide',
        asset: {
          asset_type: 'Article',
          body: '<h2>Install Steps</h2><p>Run <code>npm install</code> and read <a href="https://example.com">docs</a>.</p>'
        },
        supplementary_assets: []
      }));
      return;
    }

    if (u === '/media/encrypted.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://example.com/key"\n#EXTINF:2,\n/media/hls/seg_000.ts\n#EXT-X-ENDLIST\n');
      return;
    }

    if (u === '/subs/en.vtt') {
      res.writeHead(200, { 'Content-Type': 'text/vtt' });
      res.end(vttText);
      return;
    }

    if (u === '/res/notes.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(resourceText);
      return;
    }

    if (u.startsWith('/media/')) {
      const fp = path.join(mediaDir, u.slice('/media/'.length));
      if (fs.existsSync(fp)) {
        const ext = path.extname(fp).toLowerCase();
        const ct =
          ext === '.mp4' ? 'video/mp4' :
          ext === '.m3u8' ? 'application/vnd.apple.mpegurl' :
          ext === '.mpd' ? 'application/dash+xml' :
          'application/octet-stream';
        res.writeHead(200, { 'Content-Type': ct });
        fs.createReadStream(fp).pipe(res);
        return;
      }
    }

    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const httpPort = server.address().port;
  const baseUrl = `http://127.0.0.1:${httpPort}`;
  const cdpPort = await getFreePort();

  console.log(`Launching Edge with extension on CDP port ${cdpPort}...`);
  edgeProc = spawn(edgePath, [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    `--load-extension=${extDir}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--window-size=1280,900',
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let edgeStderr = '';
  edgeProc.stderr.on('data', (d) => { edgeStderr += d.toString(); });

  const versionInfo = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    if (!r.ok) return null;
    return await r.json();
  }, 15000, 250, 'Edge CDP /json/version');

  console.log(`Connected to ${versionInfo.Browser}`);
  cdp = new CDPClient(versionInfo.webSocketDebuggerUrl);
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  // Wait for our extension's service worker target (there are Edge component service workers too)
  const swTarget = await waitFor(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const candidates = targetInfos.filter((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'));
    for (const c of candidates) {
      try {
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: c.targetId, flatten: true });
        await cdp.send('Runtime.enable', {}, sessionId);
        const r = await cdp.send('Runtime.evaluate', {
          expression: `typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().name : ''`,
          returnByValue: true
        }, sessionId);
        await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
        if (r.result && r.result.value === 'Media & Course Downloader') return c;
      } catch (_) {}
    }
    return null;
  }, 15000, 300, 'Media & Course Downloader service_worker target');

  const extId = new URL(swTarget.url).hostname;
  console.log(`Extension loaded! ID=${extId}`);

  // Helper to evaluate JS in a target session
  async function attachAndEval(targetId, expression) {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    try {
      await cdp.send('Runtime.enable', {}, sessionId);
      const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (res.exceptionDetails) {
        throw new Error(`Page eval error: ${JSON.stringify(res.exceptionDetails)}`);
      }
      return { value: res.result ? res.result.value : undefined };
    } finally {
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
  }

  // Test 1: Open video.html and verify sniffing + popup
  console.log('Testing live media sniffer on /video.html...');
  const { targetId: videoTargetId } = await cdp.send('Target.createTarget', { url: `${baseUrl}/video.html` });
  await new Promise((r) => setTimeout(r, 1500));

  const { targetId: popupTargetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
  await new Promise((r) => setTimeout(r, 1000));
  const popupEval = await attachAndEval(popupTargetId, `({ title: document.title, count: document.body.innerText.length })`);
  assert.ok(popupEval.value.count > 0, 'Popup rendered cleanly');

  // Verify background mediaMap recorded video.html streams
  const swAttach = await attachAndEval(swTarget.targetId, `Promise.resolve(mediaMap.size)`);
  assert.ok(swAttach.value >= 1, 'Background service worker captured media stream(s)');

  // Test 2: Open mock Udemy course page
  console.log('Testing Udemy Course Bulk Downloader...');
  const { targetId: udemyTargetId } = await cdp.send('Target.createTarget', { url: `${baseUrl}/course/test/learn/` });
  await waitFor(async () => {
    const { value } = await attachAndEval(udemyTargetId, `document.readyState === 'complete'`);
    return value;
  }, 10000, 200, 'udemy page complete');

  // Resolve numeric chrome tabId for udemyTargetId via service worker chrome.tabs.query
  const { value: udemyChromeTabId } = await attachAndEval(
    swTarget.targetId,
    `new Promise(r => chrome.tabs.query({ url: '${baseUrl}/course/test/learn/*' }, tabs => r(tabs[0] ? tabs[0].id : null)))`
  );
  assert.ok(udemyChromeTabId != null, 'Found Chrome tabId for mock Udemy page');

  // Open Manager targeting udemyChromeTabId directly in course view
  const { targetId: mgrTargetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extId}/manager.html?tabId=${udemyChromeTabId}&view=course`
  });

  // Wait for manager DOM & init ready before clicking Fetch Syllabus
  await waitFor(async () => {
    const { value } = await attachAndEval(mgrTargetId, `document.documentElement.dataset.ready === '1'`);
    return value;
  }, 10000, 200, 'manager UI ready');

  await attachAndEval(mgrTargetId, `document.getElementById('fetch-syllabus-btn').click()`);

  await waitFor(async () => {
    const { value } = await attachAndEval(mgrTargetId, `document.getElementById('course-meta').style.display === 'flex'`);
    return value;
  }, 10000, 200, 'syllabus loaded');

  const meta = await attachAndEval(mgrTargetId, `({
    title: document.getElementById('course-title').textContent,
    sections: document.getElementById('meta-sections').textContent,
    lectures: document.getElementById('meta-lectures').textContent
  })`);
  assert.equal(meta.value.title, 'Test Course');
  assert.equal(meta.value.sections, '2');
  assert.equal(meta.value.lectures, '4');

  // Select article format = both and start bulk download
  await attachAndEval(mgrTargetId, `
    document.getElementById('opt-article-fmt').value = 'both';
    document.getElementById('start-bulk-btn').click();
  `);

  await waitFor(async () => {
    const { value } = await attachAndEval(mgrTargetId, `document.getElementById('queue-status-label').textContent`);
    return value && value.startsWith('Course Complete');
  }, 30000, 400, 'course bulk download completion');

  const bannerText = await attachAndEval(mgrTargetId, `({
    label: document.getElementById('queue-status-label').textContent,
    detail: document.getElementById('queue-detail').textContent
  })`);
  console.log('Course Bulk Result:', bannerText.value);
  assert.match(bannerText.value.detail, /1 DRM skipped/);
  assert.match(bannerText.value.detail, /0 errors/);

  // Verify downloaded files in downloadsDir
  const courseOutDir = path.join(downloadsDir, 'Udemy', 'Test Course');
  const expectedFiles = [
    '01 - Getting Started/01 - Direct Lecture.mp4',
    '01 - Getting Started/01 - Direct Lecture.en_US.srt',
    '01 - Getting Started/Resources/notes.txt',
    '01 - Getting Started/02 - HLS Lecture.mp4',
    '01 - Getting Started/03 - DRM Lecture.en_US.srt',
    '02 - Reading/04 - Setup Guide.html',
    '02 - Reading/04 - Setup Guide.md',
    'index.html'
  ];
  for (const rel of expectedFiles) {
    const full = path.join(courseOutDir, rel);
    if (!fs.existsSync(full)) {
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
      console.error('DOWNLOADS TREE:', walk(downloadsDir));
      const logs = await attachAndEval(mgrTargetId, `Array.from(document.querySelectorAll('.log-line')).map(e => e.textContent)`);
      console.error('MANAGER LOGS:', logs.value);
    }
    assert.ok(fs.existsSync(full), `Missing expected downloaded file: ${full}`);
    assert.ok(fs.statSync(full).size > 0, `Empty downloaded file: ${full}`);
  }
  assert.ok(!fs.existsSync(path.join(courseOutDir, '01 - Getting Started/03 - DRM Lecture.mp4')), 'DRM lecture video must not exist');
  assert.ok(!fs.existsSync(path.join(courseOutDir, '01 - Getting Started/03 - DRM Lecture.ts')), 'DRM lecture TS must not exist');

  // Validate remuxed HLS MP4 from Edge via ffprobe & ffmpeg
  const hlsMp4 = path.join(courseOutDir, '01 - Getting Started/02 - HLS Lecture.mp4');
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', hlsMp4], { encoding: 'utf8' }));
  const hlsDur = parseFloat(probe.format.duration);
  assert.ok(hlsDur >= 5.5 && hlsDur <= 6.5, `Expected ~6s Edge remuxed HLS duration, got ${hlsDur}`);
  execFileSync('ffmpeg', ['-v', 'error', '-i', hlsMp4, '-f', 'null', '-']);

  // Validate SRT content
  const srt = fs.readFileSync(path.join(courseOutDir, '01 - Getting Started/01 - Direct Lecture.en_US.srt'), 'utf8');
  assert.match(srt, /00:00:00,000 --> 00:00:02,000/);

  // Test 3: DASH .mpd download via Manager manual URL input
  console.log('Testing DASH .mpd download via Manager...');
  await attachAndEval(mgrTargetId, `
    document.querySelector('[data-tab="panel-sniffer"]').click();
    document.getElementById('manual-url').value = '${baseUrl}/media/dash/manifest.mpd';
    document.getElementById('manual-name').value = 'dash-sample';
    document.getElementById('manual-dl-btn').click();
  `);

  await waitFor(async () => {
    const { value } = await attachAndEval(mgrTargetId, `document.getElementById('queue-status-label').textContent`);
    if (value && value.startsWith('Error:')) {
      const logs = await attachAndEval(mgrTargetId, `Array.from(document.querySelectorAll('.log-line')).map(e => e.textContent)`);
      throw new Error(`DASH failed: ${value}\nLogs:\n${logs.value.join('\n')}`);
    }
    return value && value.startsWith('Done:');
  }, 20000, 300, 'DASH download completion');

  const dashVideoPath = path.join(downloadsDir, 'MediaDownloader', 'dash-sample.mp4');
  assert.ok(fs.existsSync(dashVideoPath) && fs.statSync(dashVideoPath).size > 0, 'DASH video downloaded');

  // Check zero uncaught errors in manager page
  const logErrors = await attachAndEval(mgrTargetId, `Array.from(document.querySelectorAll('.log-error')).map(e => e.textContent)`);
  assert.deepEqual(logErrors.value, [], `Unexpected errors in manager log: ${JSON.stringify(logErrors.value)}`);

  console.log('ALL MICROSOFT EDGE E2E TESTS PASSED!');
} finally {
  if (cdp) cdp.close();
  if (edgeProc) {
    try { edgeProc.kill('SIGTERM'); } catch (_) {}
    await new Promise((r) => setTimeout(r, 800));
    try { execFileSync('taskkill', ['/F', '/T', '/PID', String(edgeProc.pid)], { stdio: 'ignore' }); } catch (_) {}
  }
  if (server) server.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}
