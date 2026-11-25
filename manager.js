/* Download Manager Controller */
(() => {
  const SETTINGS_KEY = 'downloaderSettings';
  const HISTORY_KEY = 'downloadHistory';

  const DEFAULT_SETTINGS = {
    maxHeight: 0,
    concurrency: 4,
    remux: true,
    skipExisting: true
  };

  let targetTabId = null;
  let sink = new Engine.DownloadsSink();
  let currentCourse = null;
  let lectureProgress = {}; // lecId -> result object
  let selectedLocales = new Set();
  let selectedLectures = new Set();

  // Queue / Pause / Abort state
  let isRunning = false;
  let isPaused = false;
  let pauseResolvers = [];
  let currentAbort = null;

  // --- Helpers ---
  const $ = (id) => document.getElementById(id);

  function log(msg, level = 'info') {
    const box = $('log-box');
    const line = document.createElement('div');
    line.className = `log-line log-${level}`;
    const ts = new Date().toLocaleTimeString();
    line.textContent = `[${ts}] ${msg}`;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function formatBytes(b) {
    if (!b) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = b;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
  }

  function switchTab(panelId) {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === panelId));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === panelId));
  }

  async function waitIfPaused(signal) {
    while (isPaused) {
      if (signal && signal.aborted) throw new Engine.AbortedError();
      await new Promise((resolve) => pauseResolvers.push(resolve));
    }
    if (signal && signal.aborted) throw new Engine.AbortedError();
  }

  function setBanner(visible, label = '', pct = 0, detail = '') {
    const banner = $('queue-banner');
    banner.style.display = visible ? 'block' : 'none';
    if (!visible) return;
    $('queue-status-label').textContent = label;
    $('queue-progress-bar').style.width = `${Math.max(0, Math.min(100, pct))}%`;
    $('queue-detail').textContent = detail;
    $('btn-pause').style.display = isRunning && !isPaused ? 'inline-block' : 'none';
    $('btn-resume').style.display = isRunning && isPaused ? 'inline-block' : 'none';
    $('btn-cancel').style.display = isRunning ? 'inline-block' : 'none';
  }

  // --- Storage ---
  async function loadSettings() {
    const res = await chrome.storage.local.get(SETTINGS_KEY);
    const s = { ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] || {}) };
    $('opt-max-res').value = String(s.maxHeight);
    $('opt-concurrency').value = String(s.concurrency);
    $('opt-remux').checked = !!s.remux;
    $('opt-skip').checked = !!s.skipExisting;
    return s;
  }

  function getUiSettings() {
    const c = parseInt($('opt-concurrency').value, 10);
    return {
      maxHeight: parseInt($('opt-max-res').value, 10) || 0,
      concurrency: isNaN(c) ? 4 : Math.max(1, Math.min(8, c)),
      remux: $('opt-remux').checked,
      skipExisting: $('opt-skip').checked
    };
  }

  async function saveSettings() {
    await chrome.storage.local.set({ [SETTINGS_KEY]: getUiSettings() });
  }

  async function appendHistory(entry) {
    const res = await chrome.storage.local.get(HISTORY_KEY);
    const list = Array.isArray(res[HISTORY_KEY]) ? res[HISTORY_KEY] : [];
    list.unshift({ ...entry, timestamp: Date.now() });
    if (list.length > 200) list.length = 200;
    await chrome.storage.local.set({ [HISTORY_KEY]: list });
    renderHistory(list);
  }

  async function loadHistory() {
    const res = await chrome.storage.local.get(HISTORY_KEY);
    renderHistory(Array.isArray(res[HISTORY_KEY]) ? res[HISTORY_KEY] : []);
  }

  function renderHistory(list) {
    const el = $('history-list');
    const empty = $('history-empty');
    el.innerHTML = '';
    if (!list.length) {
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    list.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'item-card';
      const main = document.createElement('div');
      main.className = 'item-main';
      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = item.title || item.path || 'Download';
      const sub = document.createElement('div');
      sub.className = 'item-url';
      sub.textContent = `${new Date(item.timestamp).toLocaleString()} — ${item.detail || ''}`;
      main.appendChild(title);
      main.appendChild(sub);

      const badge = document.createElement('span');
      badge.className = `badge ${item.status === 'error' ? 'badge-err' : 'badge-done'}`;
      badge.textContent = item.kind || item.status || 'done';
      card.appendChild(main);
      card.appendChild(badge);
      el.appendChild(card);
    });
  }

  function notifyDone(title, message) {
    try {
      if (chrome.notifications && chrome.notifications.create) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title,
          message
        });
      }
    } catch (_) {}
  }

  // --- Target Tab ---
  function sendToTargetTab(msg) {
    return new Promise((resolve, reject) => {
      if (targetTabId == null || targetTabId < 0) {
        reject(new Error('No target tab selected'));
        return;
      }
      chrome.tabs.sendMessage(targetTabId, msg, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(res);
        }
      });
    });
  }

  async function detectTargetTab(preferredId = null) {
    if (preferredId != null && !isNaN(preferredId)) {
      try {
        const tab = await chrome.tabs.get(preferredId);
        if (tab) {
          targetTabId = tab.id;
          $('target-tab-label').textContent = `#${tab.id}: ${tab.title || tab.url}`;
          return tab;
        }
      } catch (_) {}
    }
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const extBase = chrome.runtime.getURL('');
    const candidate = tabs.find((t) => t.active && !t.url.startsWith(extBase)) || tabs.find((t) => !t.url.startsWith(extBase));
    if (candidate) {
      targetTabId = candidate.id;
      $('target-tab-label').textContent = `#${candidate.id}: ${candidate.title || candidate.url}`;
      return candidate;
    }
    targetTabId = null;
    $('target-tab-label').textContent = 'None found';
    return null;
  }

  // --- Sniffer & Single Stream ---
  async function loadSnifferList() {
    if (targetTabId == null) {
      renderSnifferList([]);
      return;
    }
    chrome.runtime.sendMessage({ action: 'getMedia', tabId: targetTabId }, (res) => {
      renderSnifferList((res && res.media) || []);
    });
  }

  function renderSnifferList(items) {
    const list = $('sniffer-list');
    const empty = $('sniffer-empty');
    $('sniffer-count').textContent = String(items.length);
    list.innerHTML = '';
    if (!items.length) {
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    items.forEach((item) => {
      const isHls = item.isHls || /\.m3u8(\?|$)/i.test(item.url);
      const isDash = item.isDash || /\.mpd(\?|$)/i.test(item.url);

      const card = document.createElement('div');
      card.className = 'item-card';

      const main = document.createElement('div');
      main.className = 'item-main';
      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = item.filename || 'stream';
      const url = document.createElement('div');
      url.className = 'item-url';
      url.textContent = item.url;
      main.appendChild(title);
      main.appendChild(url);

      const right = document.createElement('div');
      right.className = 'btn-row';

      const b = document.createElement('span');
      b.className = `badge ${isHls ? 'badge-hls' : isDash ? 'badge-dash' : 'badge-direct'}`;
      b.textContent = isHls ? 'HLS' : isDash ? 'DASH' : 'DIRECT';
      right.appendChild(b);

      if (item.source) {
        const sb = document.createElement('span');
        sb.className = 'badge badge-src';
        sb.textContent = item.source;
        right.appendChild(sb);
      }

      const dlBtn = document.createElement('button');
      dlBtn.className = 'btn btn-primary btn-sm';
      dlBtn.textContent = 'Download';
      dlBtn.addEventListener('click', () => runSingleStream(item));

      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn btn-secondary btn-sm';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(item.url).then(() => {
          copyBtn.textContent = 'Copied';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
        });
      });

      right.appendChild(dlBtn);
      right.appendChild(copyBtn);

      card.appendChild(main);
      card.appendChild(right);
      list.appendChild(card);
    });
  }

  async function runSingleStream(item) {
    if (isRunning) {
      log('A download batch is already running. Cancel or wait for it to finish.', 'warn');
      return;
    }
    const settings = getUiSettings();
    const url = item.url;
    const isHls = item.isHls || /\.m3u8(\?|$)/i.test(url);
    const isDash = item.isDash || /\.mpd(\?|$)/i.test(url);
    const rawName = (item.filename || 'video').replace(/\.(m3u8|mpd)$/i, '');
    const safeBase = CourseFormatter.sanitizePath(rawName);
    const prefix = sink.kind === 'downloads' ? 'MediaDownloader/' : '';

    isRunning = true;
    isPaused = false;
    currentAbort = new AbortController();
    setBanner(true, `Downloading: ${safeBase}`, 0, url);
    log(`Starting stream download: ${url}`);

    try {
      let outDesc = '';
      if (isHls) {
        const outputs = await Engine.downloadHls(url, {
          sink,
          basePath: `${prefix}${safeBase}`,
          concurrency: settings.concurrency,
          maxHeight: settings.maxHeight,
          remux: settings.remux,
          signal: currentAbort.signal,
          log: (m) => log(m),
          onProgress: ({ done, total, bytes }) => {
            const pct = total ? Math.floor((done / total) * 100) : 0;
            setBanner(true, `HLS: ${safeBase}`, pct, `Segment ${done}/${total} (${formatBytes(bytes)})`);
          }
        });
        outDesc = outputs.map((o) => `${o.path} (${formatBytes(o.bytes)})`).join(', ');
      } else if (isDash) {
        const outputs = await Engine.downloadDash(url, {
          sink,
          basePath: `${prefix}${safeBase}`,
          concurrency: settings.concurrency,
          maxHeight: settings.maxHeight,
          signal: currentAbort.signal,
          log: (m) => log(m),
          onProgress: ({ done, total, bytes }) => {
            const pct = total ? Math.floor((done / total) * 100) : 0;
            setBanner(true, `DASH: ${safeBase}`, pct, `Segment ${done}/${total} (${formatBytes(bytes)})`);
          }
        });
        outDesc = outputs.map((o) => `${o.path} (${formatBytes(o.bytes)})`).join(', ');
      } else {
        const extMatch = url.match(/\.(mp4|m4v|webm|mkv|mov|avi|flv)(\?|$)/i);
        const ext = extMatch ? `.${extMatch[1].toLowerCase()}` : '.mp4';
        const outPath = `${prefix}${safeBase.endsWith(ext) ? safeBase : safeBase + ext}`;
        await sink.saveUrl(url, outPath, {
          signal: currentAbort.signal,
          onProgress: ({ bytes, totalBytes }) => {
            const pct = totalBytes ? Math.floor((bytes / totalBytes) * 100) : 0;
            setBanner(true, `Direct: ${outPath}`, pct, `${formatBytes(bytes)}${totalBytes ? ' / ' + formatBytes(totalBytes) : ''}`);
          }
        });
        outDesc = outPath;
      }

      log(`Completed: ${outDesc}`, 'ok');
      setBanner(true, `Done: ${safeBase}`, 100, outDesc);
      await appendHistory({ title: safeBase, kind: isHls ? 'HLS' : isDash ? 'DASH' : 'DIRECT', status: 'done', detail: outDesc });
      notifyDone('Download Complete', outDesc);
    } catch (e) {
      if (e.aborted) {
        log(`Cancelled: ${safeBase}`, 'warn');
        setBanner(true, 'Cancelled', 0, '');
      } else {
        log(`Failed (${safeBase}): ${e.message}`, 'error');
        setBanner(true, `Error: ${e.message}`, 0, url);
        await appendHistory({ title: safeBase, kind: 'ERROR', status: 'error', detail: e.message });
      }
    } finally {
      isRunning = false;
      isPaused = false;
      currentAbort = null;
      $('btn-pause').style.display = 'none';
      $('btn-resume').style.display = 'none';
      $('btn-cancel').style.display = 'none';
    }
  }

  // --- Udemy Course Tree & Progress ---
  function progressKey(courseId) {
    return `courseProgress:${courseId}`;
  }

  async function loadCourseProgress(courseId) {
    const key = progressKey(courseId);
    const res = await chrome.storage.local.get(key);
    lectureProgress = res[key] || {};
  }

  async function saveCourseProgress(courseId) {
    await chrome.storage.local.set({ [progressKey(courseId)]: lectureProgress });
  }

  function updateCourseCounts() {
    if (!currentCourse) return;
    let total = 0;
    let done = 0;
    currentCourse.sections.forEach((s) => {
      s.lectures.forEach((l) => {
        total++;
        const st = lectureProgress[l.id] && lectureProgress[l.id].status;
        if (st === 'done' || st === 'drm') done++;
      });
    });
    $('meta-sections').textContent = String(currentCourse.sections.length);
    $('meta-lectures').textContent = String(total);
    $('meta-done').textContent = String(done);
  }

  function renderLocaleChips(course) {
    const container = $('caption-locales');
    container.innerHTML = '';
    const locales = UdemyModel.allCaptionLocales(course);
    selectedLocales = new Set();
    const enLocales = locales.filter((l) => /^en/i.test(l.locale));
    enLocales.forEach((l) => selectedLocales.add(l.locale));

    locales.forEach(({ locale, label }) => {
      const chip = document.createElement('label');
      chip.className = 'locale-chip';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = locale;
      cb.checked = selectedLocales.has(locale);
      cb.addEventListener('change', () => {
        if (cb.checked) selectedLocales.add(locale);
        else selectedLocales.delete(locale);
      });
      const txt = document.createElement('span');
      txt.textContent = `${locale} (${label})`;
      chip.appendChild(cb);
      chip.appendChild(txt);
      container.appendChild(chip);
    });
  }

  function syncLocaleCheckboxes() {
    $('caption-locales').querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = selectedLocales.has(cb.value);
    });
  }

  function renderCourseTree(course) {
    const tree = $('course-tree');
    tree.innerHTML = '';
    $('course-empty').style.display = 'none';
    $('course-meta').style.display = 'flex';
    $('course-options').style.display = 'flex';
    $('reset-progress-btn').style.display = 'inline-block';
    $('course-title').textContent = course.title;
    $('course-id-badge').textContent = `ID: ${course.id}`;

    selectedLectures = new Set();
    course.sections.forEach((sec) => sec.lectures.forEach((lec) => selectedLectures.add(lec.id)));

    course.sections.forEach((sec, idx) => {
      const box = document.createElement('div');
      box.className = 'sec-box';

      const head = document.createElement('div');
      head.className = 'sec-head';

      const left = document.createElement('div');
      left.className = 'sec-head-left';

      const secCb = document.createElement('input');
      secCb.type = 'checkbox';
      secCb.checked = true;
      secCb.addEventListener('click', (e) => e.stopPropagation());
      secCb.addEventListener('change', () => {
        sec.lectures.forEach((l) => {
          if (secCb.checked) selectedLectures.add(l.id);
          else selectedLectures.delete(l.id);
          const lcb = document.getElementById(`lec-cb-${l.id}`);
          if (lcb) lcb.checked = secCb.checked;
        });
      });

      const title = document.createElement('span');
      title.textContent = `${sec.dirName} (${sec.lectures.length})`;
      left.appendChild(secCb);
      left.appendChild(title);

      const toggleHint = document.createElement('span');
      toggleHint.className = 'label';
      toggleHint.textContent = idx === 0 ? '▼' : '▶';

      head.appendChild(left);
      head.appendChild(toggleHint);

      const body = document.createElement('div');
      body.className = 'sec-body';
      body.style.display = idx === 0 ? 'block' : 'none';

      head.addEventListener('click', () => {
        const open = body.style.display === 'block';
        body.style.display = open ? 'none' : 'block';
        toggleHint.textContent = open ? '▶' : '▼';
      });

      sec.lectures.forEach((lec) => {
        const row = document.createElement('div');
        row.className = 'lec-row';

        const lLeft = document.createElement('div');
        lLeft.className = 'lec-left';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.id = `lec-cb-${lec.id}`;
        cb.checked = true;
        cb.addEventListener('change', () => {
          if (cb.checked) selectedLectures.add(lec.id);
          else selectedLectures.delete(lec.id);
        });

        const name = document.createElement('span');
        name.className = 'lec-name';
        name.textContent = lec.fileBase;

        lLeft.appendChild(cb);
        lLeft.appendChild(name);

        const badges = document.createElement('div');
        badges.className = 'badges';

        const typeB = document.createElement('span');
        typeB.className = 'badge badge-src';
        typeB.textContent = lec.assetType;
        badges.appendChild(typeB);

        if (lec.captions.length) {
          const capB = document.createElement('span');
          capB.className = 'badge badge-direct';
          capB.textContent = `${lec.captions.length} SUB`;
          badges.appendChild(capB);
        }
        if (lec.resources.length) {
          const resB = document.createElement('span');
          resB.className = 'badge badge-hls';
          resB.textContent = `${lec.resources.length} RES`;
          badges.appendChild(resB);
        }
        if (lec.drmHint) {
          const drmB = document.createElement('span');
          drmB.className = 'badge badge-drm';
          drmB.textContent = 'DRM?';
          badges.appendChild(drmB);
        }

        const stBadge = document.createElement('span');
        stBadge.id = `lec-st-${lec.id}`;
        badges.appendChild(stBadge);

        row.appendChild(lLeft);
        row.appendChild(badges);
        body.appendChild(row);
      });

      box.appendChild(head);
      box.appendChild(body);
      tree.appendChild(box);
    });

    refreshLectureBadges();
    updateCourseCounts();
  }

  function setLectureBadge(lecId, status, customText = null) {
    const el = $(`lec-st-${lecId}`);
    if (!el) return;
    const map = {
      done: ['badge-done', 'Done'],
      drm: ['badge-drm', 'DRM Skipped'],
      error: ['badge-err', 'Error'],
      working: ['badge-working', 'Downloading'],
      pending: ['badge-pending', 'Pending']
    };
    const [cls, label] = map[status] || map.pending;
    el.className = `badge ${cls}`;
    el.textContent = customText || label;
  }

  function refreshLectureBadges() {
    if (!currentCourse) return;
    currentCourse.sections.forEach((s) => {
      s.lectures.forEach((l) => {
        const st = lectureProgress[l.id] ? lectureProgress[l.id].status : 'pending';
        setLectureBadge(l.id, st);
      });
    });
  }

  // --- Bulk Course Execution ---
  async function runCourseBulk() {
    if (!currentCourse || isRunning) return;
    const settings = getUiSettings();
    const includeVideos = $('chk-videos').checked;
    const includeSubtitles = $('chk-subtitles').checked;
    const includeArticles = $('chk-articles').checked;
    const includeResources = $('chk-resources').checked;
    const generateIndex = $('chk-index').checked;
    const articleFmt = $('opt-article-fmt').value;

    const queue = [];
    currentCourse.sections.forEach((sec) => {
      sec.lectures.forEach((lec) => {
        if (selectedLectures.has(lec.id)) queue.push({ sec, lec });
      });
    });

    if (!queue.length) {
      log('No lectures selected.', 'warn');
      return;
    }

    const rootDir = sink.kind === 'downloads' ? `Udemy/${currentCourse.dirName}` : currentCourse.dirName;

    isRunning = true;
    isPaused = false;
    currentAbort = new AbortController();
    $('start-bulk-btn').disabled = true;

    let countDone = 0;
    let countDrm = 0;
    let countErr = 0;
    let cancelled = false;

    log(`Starting course bulk download: "${currentCourse.title}" (${queue.length} lectures selected) -> ${rootDir}`);

    try {
      for (let idx = 0; idx < queue.length; idx++) {
        await waitIfPaused(currentAbort.signal);

        const { sec, lec } = queue[idx];
        const prev = lectureProgress[lec.id];
        const pct = Math.floor((idx / queue.length) * 100);
        setBanner(true, `Course [${idx + 1}/${queue.length}]: ${lec.title}`, pct, `${sec.dirName}`);

        if (settings.skipExisting && prev && prev.status === 'done') {
          log(`Skip completed: ${lec.fileBase}`);
          countDone++;
          continue;
        }

        setLectureBadge(lec.id, 'working');
        const rec = {
          status: 'done',
          videoStatus: null,
          videoFile: null,
          subtitleFiles: [],
          articleFiles: [],
          resourceFiles: [],
          error: null
        };

        try {
          const resp = await sendToTargetTab({
            action: 'resolveLecture',
            courseId: currentCourse.id,
            lectureId: lec.id
          });
          if (!resp || !resp.success) throw new Error((resp && resp.error) || 'Failed to resolve lecture');
          const lecData = resp.data || {};
          const asset = lecData.asset || {};
          const assetType = asset.asset_type || lec.assetType;

          // 1. Video / VideoMashup
          if (includeVideos && (assetType === 'Video' || assetType === 'VideoMashup')) {
            const relBase = `${sec.dirName}/${lec.fileBase}`;
            const fullBase = `${rootDir}/${relBase}`;
            const mp4 = UdemyModel.pickDirectMp4(asset, settings.maxHeight);
            const hlsUrl = !mp4 ? UdemyModel.pickHls(asset) : null;
            const dashUrl = !mp4 && !hlsUrl ? UdemyModel.pickDash(asset) : null;

            try {
              if (mp4) {
                const relFile = `${relBase}.mp4`;
                const fullFile = `${rootDir}/${relFile}`;
                if (settings.skipExisting && await sink.exists(fullFile)) {
                  log(`Video already exists, skipped: ${relFile}`);
                } else {
                  await sink.saveUrl(mp4.url, fullFile, {
                    signal: currentAbort.signal,
                    onProgress: ({ bytes, totalBytes }) => {
                      const lp = totalBytes ? ` (${Math.floor((bytes / totalBytes) * 100)}%)` : ` (${formatBytes(bytes)})`;
                      setBanner(true, `Course [${idx + 1}/${queue.length}]: ${lec.title}`, pct, `MP4 ${mp4.height}p${lp}`);
                    }
                  });
                }
                rec.videoFile = relFile;
                rec.videoStatus = 'done';
                log(`Saved MP4 (${mp4.height}p): ${relFile}`, 'ok');
              } else if (hlsUrl) {
                const candidateMp4 = `${fullBase}.mp4`;
                if (settings.skipExisting && await sink.exists(candidateMp4)) {
                  rec.videoFile = `${relBase}.mp4`;
                  rec.videoStatus = 'done';
                  log(`Video already exists, skipped: ${rec.videoFile}`);
                } else {
                  const outs = await Engine.downloadHls(hlsUrl, {
                    sink,
                    basePath: fullBase,
                    concurrency: settings.concurrency,
                    maxHeight: settings.maxHeight,
                    remux: settings.remux,
                    signal: currentAbort.signal,
                    log: (m) => log(`  [${lec.fileBase}] ${m}`),
                    onProgress: ({ done, total, bytes }) => {
                      setBanner(true, `Course [${idx + 1}/${queue.length}]: ${lec.title}`, pct, `HLS seg ${done}/${total} (${formatBytes(bytes)})`);
                    }
                  });
                  if (outs.length) {
                    rec.videoFile = outs[0].path.startsWith(`${rootDir}/`) ? outs[0].path.slice(rootDir.length + 1) : outs[0].path;
                    rec.videoStatus = 'done';
                    log(`Saved HLS -> ${rec.videoFile}`, 'ok');
                  }
                }
              } else if (dashUrl) {
                const outs = await Engine.downloadDash(dashUrl, {
                  sink,
                  basePath: fullBase,
                  concurrency: settings.concurrency,
                  maxHeight: settings.maxHeight,
                  signal: currentAbort.signal,
                  log: (m) => log(`  [${lec.fileBase}] ${m}`),
                  onProgress: ({ done, total, bytes }) => {
                    setBanner(true, `Course [${idx + 1}/${queue.length}]: ${lec.title}`, pct, `DASH seg ${done}/${total} (${formatBytes(bytes)})`);
                  }
                });
                if (outs.length) {
                  rec.videoFile = outs[0].path.startsWith(`${rootDir}/`) ? outs[0].path.slice(rootDir.length + 1) : outs[0].path;
                  rec.videoStatus = 'done';
                  log(`Saved DASH -> ${rec.videoFile}`, 'ok');
                }
              } else if (asset.course_is_drmed || asset.media_license_token) {
                throw new Engine.EncryptedError('Lecture uses DRM license — video skipped');
              } else {
                log(`No video stream URL found for ${lec.fileBase}`, 'warn');
              }
            } catch (ve) {
              if (ve.aborted) throw ve;
              if (ve.encrypted) {
                rec.videoStatus = 'drm';
                rec.status = 'drm';
                countDrm++;
                log(`DRM skipped: ${lec.fileBase} (${ve.message})`, 'warn');
              } else {
                throw ve;
              }
            }
          }

          // 2. Article
          if (includeArticles && assetType === 'Article' && asset.body) {
            if (articleFmt === 'html' || articleFmt === 'both') {
              const relHtml = `${sec.dirName}/${lec.fileBase}.html`;
              await sink.writeText(`${rootDir}/${relHtml}`, CourseExport.articleToHtml(lec.title, asset.body));
              rec.articleFiles.push(relHtml);
            }
            if (articleFmt === 'md' || articleFmt === 'both') {
              const relMd = `${sec.dirName}/${lec.fileBase}.md`;
              await sink.writeText(`${rootDir}/${relMd}`, CourseExport.articleToMarkdown(lec.title, asset.body));
              rec.articleFiles.push(relMd);
            }
            log(`Saved Article (${articleFmt}): ${lec.fileBase}`, 'ok');
          }

          // 3. Subtitles (.vtt -> .srt)
          if (includeSubtitles && Array.isArray(asset.captions)) {
            const caps = asset.captions.filter((c) => selectedLocales.has(c.locale_id || 'und'));
            for (const cap of caps) {
              await waitIfPaused(currentAbort.signal);
              const locale = CourseFormatter.sanitizePath(cap.locale_id || 'und');
              const relSrt = `${sec.dirName}/${lec.fileBase}.${locale}.srt`;
              const fullSrt = `${rootDir}/${relSrt}`;
              if (!(settings.skipExisting && await sink.exists(fullSrt))) {
                const vttRes = await Engine.fetchRetry(cap.url, { signal: currentAbort.signal });
                const srt = CourseFormatter.vttToSrt(await vttRes.text());
                if (srt) await sink.writeText(fullSrt, srt);
              }
              rec.subtitleFiles.push(relSrt);
            }
            if (caps.length) log(`Saved ${caps.length} subtitle(s) for ${lec.fileBase}`);
          }

          // 4. Supplementary Resources
          const supList = Array.isArray(lecData.supplementary_assets) && lecData.supplementary_assets.length
            ? lecData.supplementary_assets
            : lec.resources;
          if (includeResources && Array.isArray(supList)) {
            for (const sup of supList) {
              await waitIfPaused(currentAbort.signal);
              let supAsset = sup;
              if (!supAsset.download_urls && !supAsset.external_url && sup.id) {
                try {
                  const sResp = await sendToTargetTab({
                    action: 'resolveSupplementary',
                    courseId: currentCourse.id,
                    lectureId: lec.id,
                    assetId: sup.id
                  });
                  if (sResp && sResp.success && sResp.data) supAsset = sResp.data;
                } catch (se) {
                  log(`Failed resolving resource ${sup.title || sup.id}: ${se.message}`, 'warn');
                }
              }

              let dlUrl = null;
              if (supAsset.download_urls && typeof supAsset.download_urls === 'object') {
                for (const key of Object.keys(supAsset.download_urls)) {
                  const arr = supAsset.download_urls[key];
                  if (Array.isArray(arr) && arr.length && (arr[0].file || arr[0].url)) {
                    dlUrl = arr[0].file || arr[0].url;
                    break;
                  }
                }
              }

              if (dlUrl) {
                const fname = CourseFormatter.sanitizePath(supAsset.filename || supAsset.title || `resource-${sup.id}`);
                const relRes = `${sec.dirName}/Resources/${fname}`;
                const fullRes = `${rootDir}/${relRes}`;
                if (!(settings.skipExisting && await sink.exists(fullRes))) {
                  await sink.saveUrl(dlUrl, fullRes, { signal: currentAbort.signal });
                }
                rec.resourceFiles.push(relRes);
                log(`Saved Resource: ${relRes}`);
              } else if (supAsset.external_url) {
                const fname = `${CourseFormatter.sanitizePath(supAsset.title || `link-${sup.id}`)}.url`;
                const relRes = `${sec.dirName}/Resources/${fname}`;
                await sink.writeText(`${rootDir}/${relRes}`, `[InternetShortcut]\nURL=${supAsset.external_url}\n`);
                rec.resourceFiles.push(relRes);
                log(`Saved External Link: ${relRes}`);
              }
            }
          }

          if (rec.status !== 'drm') countDone++;
          lectureProgress[lec.id] = rec;
          setLectureBadge(lec.id, rec.status);
          await saveCourseProgress(currentCourse.id);
          updateCourseCounts();
        } catch (le) {
          if (le.aborted) throw le;
          countErr++;
          rec.status = 'error';
          rec.error = le.message;
          lectureProgress[lec.id] = rec;
          setLectureBadge(lec.id, 'error');
          await saveCourseProgress(currentCourse.id);
          log(`Lecture error (${lec.fileBase}): ${le.message}`, 'error');
        }
      }

      if (generateIndex) {
        const indexHtml = CourseExport.generateCourseIndexHtml(currentCourse, lectureProgress);
        await sink.writeText(`${rootDir}/index.html`, indexHtml);
        log(`Generated offline syllabus: ${rootDir}/index.html`, 'ok');
      }

      const summary = `${countDone} done, ${countDrm} DRM skipped, ${countErr} errors`;
      setBanner(true, `Course Complete — ${currentCourse.title}`, 100, summary);
      log(`Batch finished: ${summary}`, countErr ? 'warn' : 'ok');
      await appendHistory({ title: currentCourse.title, kind: 'COURSE', status: countErr ? 'error' : 'done', detail: summary });
      notifyDone('Course Download Complete', `${currentCourse.title}: ${summary}`);
    } catch (e) {
      if (e.aborted) {
        cancelled = true;
        setBanner(true, 'Course Download Cancelled', 0, '');
        log('Course batch cancelled by user.', 'warn');
      } else {
        setBanner(true, `Course Failed: ${e.message}`, 0, '');
        log(`Fatal batch error: ${e.message}`, 'error');
      }
    } finally {
      isRunning = false;
      isPaused = false;
      currentAbort = null;
      $('start-bulk-btn').disabled = false;
      $('btn-pause').style.display = 'none';
      $('btn-resume').style.display = 'none';
      $('btn-cancel').style.display = 'none';
      if (cancelled) refreshLectureBadges();
    }
  }

  // --- Fetch Syllabus ---
  async function fetchSyllabus() {
    const btn = $('fetch-syllabus-btn');
    btn.disabled = true;
    btn.textContent = 'Fetching...';
    try {
      const resp = await sendToTargetTab({ action: 'loadUdemyCurriculum' });
      if (!resp || !resp.success) throw new Error((resp && resp.error) || 'Failed to load curriculum');
      const { courseId, title, items } = resp.data;
      currentCourse = UdemyModel.buildCourse(items, courseId, title);
      await loadCourseProgress(courseId);
      renderLocaleChips(currentCourse);
      renderCourseTree(currentCourse);
      log(`Loaded syllabus "${currentCourse.title}" (${currentCourse.sections.length} sections)`, 'ok');
    } catch (e) {
      log(`Syllabus load failed: ${e.message}`, 'error');
      alert(`Error loading syllabus: ${e.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Fetch Syllabus';
    }
  }

  // --- Incoming actions from popup / query ---
  async function handleIncomingAction({ tabId, view, enqueueStream }) {
    if (tabId != null) await detectTargetTab(Number(tabId));
    if (view === 'course') switchTab('panel-course');
    else if (view === 'history') switchTab('panel-history');
    else if (view === 'sniffer') switchTab('panel-sniffer');
    await loadSnifferList();
    if (enqueueStream && enqueueStream.url) {
      await runSingleStream(enqueueStream);
    }
  }

  // --- Init ---
  document.addEventListener('DOMContentLoaded', async () => {
    ['opt-max-res', 'opt-concurrency', 'opt-remux', 'opt-skip'].forEach((id) => {
      $(id).addEventListener('change', saveSettings);
    });

    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    $('refresh-tab-btn').addEventListener('click', async () => {
      await detectTargetTab(null);
      await loadSnifferList();
    });

    $('pick-folder-btn').addEventListener('click', async () => {
      if (typeof window.showDirectoryPicker !== 'function') {
        alert('File System Access API is not supported in this browser.');
        return;
      }
      try {
        const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        sink = new Engine.FsSink(dirHandle);
        $('dest-badge').textContent = `Folder: ${dirHandle.name}`;
        $('reset-folder-btn').style.display = 'inline-block';
        log(`Output set to local folder: ${dirHandle.name}`, 'ok');
      } catch (e) {
        if (e.name !== 'AbortError') log(`Folder picker failed: ${e.message}`, 'error');
      }
    });

    $('reset-folder-btn').addEventListener('click', () => {
      sink = new Engine.DownloadsSink();
      $('dest-badge').textContent = 'Chrome Downloads';
      $('reset-folder-btn').style.display = 'none';
      log('Output reset to Chrome Downloads');
    });

    $('btn-pause').addEventListener('click', () => {
      isPaused = true;
      $('btn-pause').style.display = 'none';
      $('btn-resume').style.display = 'inline-block';
      $('queue-status-label').textContent = 'Paused';
      log('Queue paused', 'warn');
    });

    $('btn-resume').addEventListener('click', () => {
      isPaused = false;
      $('btn-resume').style.display = 'none';
      $('btn-pause').style.display = 'inline-block';
      const list = pauseResolvers;
      pauseResolvers = [];
      list.forEach((r) => r());
      log('Queue resumed', 'ok');
    });

    $('btn-cancel').addEventListener('click', () => {
      isPaused = false;
      const list = pauseResolvers;
      pauseResolvers = [];
      list.forEach((r) => r());
      if (currentAbort) currentAbort.abort();
    });

    $('manual-dl-btn').addEventListener('click', () => {
      const url = $('manual-url').value.trim();
      if (!url) return;
      const name = $('manual-name').value.trim();
      runSingleStream({ url, filename: name || url.split('/').pop().split('?')[0] || 'video' });
    });

    $('scan-dom-btn').addEventListener('click', async () => {
      try {
        await sendToTargetTab({ action: 'scanDom' });
      } catch (e) {
        log(`Scan failed: ${e.message}`, 'warn');
      }
      await loadSnifferList();
    });

    $('fetch-syllabus-btn').addEventListener('click', fetchSyllabus);

    $('reset-progress-btn').addEventListener('click', async () => {
      if (!currentCourse) return;
      lectureProgress = {};
      await chrome.storage.local.remove(progressKey(currentCourse.id));
      refreshLectureBadges();
      updateCourseCounts();
      log(`Reset progress for "${currentCourse.title}"`, 'warn');
    });

    $('sub-none-btn').addEventListener('click', () => { selectedLocales.clear(); syncLocaleCheckboxes(); });
    $('sub-en-btn').addEventListener('click', () => {
      selectedLocales.clear();
      if (currentCourse) {
        UdemyModel.allCaptionLocales(currentCourse).forEach((l) => {
          if (/^en/i.test(l.locale)) selectedLocales.add(l.locale);
        });
      }
      syncLocaleCheckboxes();
    });
    $('sub-all-btn').addEventListener('click', () => {
      if (currentCourse) {
        selectedLocales = new Set(UdemyModel.allCaptionLocales(currentCourse).map((l) => l.locale));
      }
      syncLocaleCheckboxes();
    });

    $('sel-all-btn').addEventListener('click', () => {
      if (!currentCourse) return;
      currentCourse.sections.forEach((s) => s.lectures.forEach((l) => {
        selectedLectures.add(l.id);
        const cb = $(`lec-cb-${l.id}`);
        if (cb) cb.checked = true;
      }));
    });
    $('sel-none-btn').addEventListener('click', () => {
      selectedLectures.clear();
      if (!currentCourse) return;
      currentCourse.sections.forEach((s) => s.lectures.forEach((l) => {
        const cb = $(`lec-cb-${l.id}`);
        if (cb) cb.checked = false;
      }));
    });
    $('sel-unfinished-btn').addEventListener('click', () => {
      if (!currentCourse) return;
      selectedLectures.clear();
      currentCourse.sections.forEach((s) => s.lectures.forEach((l) => {
        const st = lectureProgress[l.id] && lectureProgress[l.id].status;
        const keep = st !== 'done' && st !== 'drm';
        if (keep) selectedLectures.add(l.id);
        const cb = $(`lec-cb-${l.id}`);
        if (cb) cb.checked = keep;
      }));
    });

    $('start-bulk-btn').addEventListener('click', runCourseBulk);

    $('clear-history-btn').addEventListener('click', async () => {
      await chrome.storage.local.remove(HISTORY_KEY);
      renderHistory([]);
    });
    $('clear-log-btn').addEventListener('click', () => { $('log-box').innerHTML = ''; });

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.action === 'managerAction') {
        handleIncomingAction(msg);
      }
    });

    await loadSettings();
    await loadHistory();

    // Process URL query parameters
    const params = new URLSearchParams(location.search);
    const qTabId = params.get('tabId');
    const qView = params.get('view');
    let qEnqueue = null;
    try {
      if (params.get('enqueue')) qEnqueue = JSON.parse(params.get('enqueue'));
    } catch (_) {}

    await handleIncomingAction({ tabId: qTabId ? Number(qTabId) : null, view: qView, enqueueStream: qEnqueue });
    document.documentElement.dataset.ready = '1';
  });
})();
