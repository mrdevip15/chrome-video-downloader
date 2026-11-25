let currentCurriculum = [];
let activeCourseTitle = '';

// --- TAB SWITCHING ---
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));

    btn.classList.add('active');
    const target = document.getElementById(btn.dataset.tab);
    if (target) target.classList.add('active');
  });
});

// --- PANEL 1: LIVE SNIFFER ---
function renderMediaList(items) {
  const listEl = document.getElementById('list');
  const emptyEl = document.getElementById('empty');
  const countEl = document.getElementById('count');

  listEl.innerHTML = '';

  if (!items || items.length === 0) {
    emptyEl.style.display = 'block';
    countEl.textContent = '0';
    return;
  }

  emptyEl.style.display = 'none';
  countEl.textContent = String(items.length);

  items.forEach((item) => {
    const isHls = item.isHls || item.url.includes('.m3u8');

    const card = document.createElement('div');
    card.className = 'media-item';

    const headerRow = document.createElement('div');
    headerRow.className = 'header-row';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.filename || (isHls ? 'stream.m3u8' : 'video.mp4');

    const badges = document.createElement('div');
    badges.className = 'badges';

    const typeBadge = document.createElement('span');
    typeBadge.className = `badge ${isHls ? 'hls' : 'direct'}`;
    typeBadge.textContent = isHls ? 'HLS' : 'DIRECT';
    badges.appendChild(typeBadge);

    if (item.source && item.source !== 'network') {
      const srcBadge = document.createElement('span');
      srcBadge.className = 'badge source';
      srcBadge.textContent = item.source;
      badges.appendChild(srcBadge);
    }

    headerRow.appendChild(name);
    headerRow.appendChild(badges);

    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = item.url;

    const progressContainer = document.createElement('div');
    progressContainer.className = 'progress-bar-container';
    const progressBar = document.createElement('div');
    progressBar.className = 'progress-bar';
    progressContainer.appendChild(progressBar);

    const statusText = document.createElement('div');
    statusText.className = 'status-text';

    const actions = document.createElement('div');
    actions.className = 'actions';

    const dlBtn = document.createElement('button');
    dlBtn.className = 'action-btn';
    dlBtn.textContent = isHls ? 'Download (Mux TS)' : 'Download';

    dlBtn.addEventListener('click', async () => {
      if (isHls) {
        dlBtn.disabled = true;
        progressContainer.style.display = 'block';
        statusText.style.display = 'block';
        statusText.textContent = 'Parsing playlist...';

        try {
          const blob = await window.HlsDownloader.downloadHlsStream(
            item.url,
            (current, total) => {
              const pct = Math.floor((current / total) * 100);
              progressBar.style.width = `${pct}%`;
              statusText.textContent = `Fetching segment ${current}/${total} (${pct}%)`;
            }
          );

          statusText.textContent = 'Saving file...';
          const blobUrl = URL.createObjectURL(blob);
          const rawName = (item.filename || 'video').replace(/\.m3u8$/i, '');
          const finalName = `${rawName}.ts`;

          chrome.downloads.download({
            url: blobUrl,
            filename: finalName,
            saveAs: true
          }, () => {
            statusText.textContent = 'Finished!';
            dlBtn.disabled = false;
          });
        } catch (err) {
          statusText.textContent = `Error: ${err.message}`;
          dlBtn.disabled = false;
        }
      } else {
        chrome.runtime.sendMessage({
          action: 'download',
          url: item.url,
          filename: item.filename
        });
      }
    });

    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy';
    copyBtn.textContent = 'Copy URL';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(item.url).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy URL'; }, 1500);
      });
    });

    actions.appendChild(dlBtn);
    actions.appendChild(copyBtn);

    card.appendChild(headerRow);
    card.appendChild(url);
    card.appendChild(progressContainer);
    card.appendChild(statusText);
    card.appendChild(actions);

    listEl.appendChild(card);
  });
}

function fetchCurrentMedia() {
  chrome.runtime.sendMessage({ action: 'getMedia' }, (response) => {
    if (response && response.media) {
      renderMediaList(response.media);
    }
  });
}

// --- PANEL 2: UDEMY CURRICULUM & BULK DOWNLOADER ---
function parseCurriculumStructure(items, courseTitle) {
  const structured = [];
  let currentSection = {
    index: 0,
    title: 'Section 00 - Introduction',
    lectures: []
  };

  const cleanCourse = window.CourseFormatter.sanitizePath(courseTitle || 'Udemy Course');

  items.forEach((item) => {
    if (item._class === 'chapter') {
      const idxStr = String(item.object_index || structured.length + 1).padStart(2, '0');
      currentSection = {
        index: item.object_index,
        title: `${idxStr} - ${window.CourseFormatter.sanitizePath(item.title)}`,
        lectures: []
      };
      structured.push(currentSection);
    } else if (item._class === 'lecture') {
      if (structured.length === 0) structured.push(currentSection);

      const lecIdxStr = String(item.object_index || currentSection.lectures.length + 1).padStart(2, '0');
      const cleanLecTitle = `${lecIdxStr} - ${window.CourseFormatter.sanitizePath(item.title)}`;
      const basePath = `Udemy/${cleanCourse}/${currentSection.title}`;

      // 1. Determine Video URL
      let videoUrl = null;
      let isHls = false;
      const asset = item.asset;

      if (asset) {
        if (asset.stream_urls && asset.stream_urls.Video) {
          // Check for HLS stream or highest mp4 quality
          const videoStreams = asset.stream_urls.Video;
          const hlsStream = videoStreams.find(s => s.type === 'application/x-mpegURL');
          if (hlsStream) {
            videoUrl = hlsStream.file;
            isHls = true;
          } else if (videoStreams.length > 0) {
            // Sort by label/resolution
            videoStreams.sort((a, b) => parseInt(b.label || 0) - parseInt(a.label || 0));
            videoUrl = videoStreams[0].file;
          }
        } else if (asset.download_urls && asset.download_urls.Video) {
          const dlList = asset.download_urls.Video;
          if (dlList.length > 0) {
            dlList.sort((a, b) => parseInt(b.label || 0) - parseInt(a.label || 0));
            videoUrl = dlList[0].file;
          }
        }
      }

      // 2. Determine Subtitles (captions)
      const captions = (asset && asset.captions) || [];

      // 3. Determine Supplementary Assets (resources/zip)
      const resources = [];
      if (item.supplementary_assets && Array.isArray(item.supplementary_assets)) {
        item.supplementary_assets.forEach(sup => {
          if (sup.download_urls && sup.download_urls.File && sup.download_urls.File.length > 0) {
            resources.push({
              title: sup.title || sup.filename || 'resource',
              filename: sup.filename || `${window.CourseFormatter.sanitizePath(sup.title)}.zip`,
              url: sup.download_urls.File[0].file
            });
          }
        });
      }

      currentSection.lectures.push({
        id: item.id,
        title: item.title,
        cleanTitle: cleanLecTitle,
        basePath: basePath,
        videoUrl: videoUrl,
        isHls: isHls,
        captions: captions,
        resources: resources
      });
    }
  });

  return structured;
}

function renderCurriculumList(structured) {
  const listEl = document.getElementById('curriculum-list');
  const emptyEl = document.getElementById('curriculum-empty');
  listEl.innerHTML = '';

  if (!structured || structured.length === 0) {
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';

  structured.forEach(section => {
    section.lectures.forEach(lec => {
      const card = document.createElement('div');
      card.className = 'media-item';

      const headerRow = document.createElement('div');
      headerRow.className = 'header-row';

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = `${section.title} / ${lec.cleanTitle}`;

      const badges = document.createElement('div');
      badges.className = 'badges';

      const courseBadge = document.createElement('span');
      courseBadge.className = 'badge course';
      courseBadge.textContent = lec.videoUrl ? (lec.isHls ? 'HLS' : 'MP4') : 'No Video';
      badges.appendChild(courseBadge);

      if (lec.captions.length > 0) {
        const subBadge = document.createElement('span');
        subBadge.className = 'badge direct';
        subBadge.textContent = `${lec.captions.length} SRT`;
        badges.appendChild(subBadge);
      }

      if (lec.resources.length > 0) {
        const resBadge = document.createElement('span');
        resBadge.className = 'badge source';
        resBadge.textContent = `${lec.resources.length} Res`;
        badges.appendChild(resBadge);
      }

      headerRow.appendChild(name);
      headerRow.appendChild(badges);

      card.appendChild(headerRow);
      listEl.appendChild(card);
    });
  });
}

// Download queue executor
async function executeStructuredBulkDownload(structured, updateProgress) {
  const downloadTasks = [];

  structured.forEach(section => {
    section.lectures.forEach(lec => {
      // 1. Video file
      if (lec.videoUrl) {
        downloadTasks.push({
          type: 'video',
          url: lec.videoUrl,
          isHls: lec.isHls,
          filepath: `${lec.basePath}/${lec.cleanTitle}.${lec.isHls ? 'ts' : 'mp4'}`
        });
      }

      // 2. Subtitles (.srt converted from .vtt)
      lec.captions.forEach(cap => {
        const lang = cap.locale_id || cap.language || 'en_US';
        downloadTasks.push({
          type: 'subtitle',
          url: cap.url,
          filepath: `${lec.basePath}/${lec.cleanTitle}.${lang}.srt`
        });
      });

      // 3. Resources
      lec.resources.forEach(res => {
        downloadTasks.push({
          type: 'resource',
          url: res.url,
          filepath: `${lec.basePath}/Resources/${res.filename}`
        });
      });
    });
  });

  const total = downloadTasks.length;
  for (let i = 0; i < total; i++) {
    const task = downloadTasks[i];
    updateProgress(i + 1, total, task.filepath);

    try {
      if (task.type === 'subtitle') {
        // Fetch VTT and convert to SRT before saving
        const res = await fetch(task.url);
        if (res.ok) {
          const vttText = await res.text();
          const srtText = window.CourseFormatter.vttToSrt(vttText);
          const blob = new Blob([srtText], { type: 'text/plain;charset=utf-8' });
          const blobUrl = URL.createObjectURL(blob);
          await triggerDownload(blobUrl, task.filepath);
        }
      } else if (task.type === 'video' && task.isHls) {
        // Concatenate HLS chunks
        const blob = await window.HlsDownloader.downloadHlsStream(task.url);
        const blobUrl = URL.createObjectURL(blob);
        await triggerDownload(blobUrl, task.filepath);
      } else {
        // Direct download
        await triggerDownload(task.url, task.filepath);
      }
    } catch (e) {
      console.error(`Error downloading ${task.filepath}:`, e);
    }
  }
}

function triggerDownload(url, filename) {
  return new Promise((resolve) => {
    chrome.downloads.download({
      url: url,
      filename: filename,
      saveAs: false,
      conflictAction: 'uniquify'
    }, () => {
      // Small debounce to avoid hitting download rate limits
      setTimeout(resolve, 350);
    });
  });
}

// --- INIT LISTENERS ---
document.addEventListener('DOMContentLoaded', () => {
  fetchCurrentMedia();

  // Sniffer rescan
  const rescanBtn = document.getElementById('rescan');
  if (rescanBtn) {
    rescanBtn.addEventListener('click', () => {
      rescanBtn.disabled = true;
      rescanBtn.textContent = 'Scanning...';

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || tabs.length === 0) return;
        chrome.tabs.sendMessage(tabs[0].id, { action: 'scanDom' }, () => {
          fetchCurrentMedia();
          rescanBtn.disabled = false;
          rescanBtn.textContent = 'Scan Page Links';
        });
      });
    });
  }

  // Fetch Udemy Syllabus
  const fetchCurriculumBtn = document.getElementById('fetch-curriculum');
  fetchCurriculumBtn.addEventListener('click', () => {
    fetchCurriculumBtn.disabled = true;
    fetchCurriculumBtn.textContent = 'Reading Course...';

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) return;
      const tabId = tabs[0].id;

      chrome.tabs.sendMessage(tabId, { action: 'getUdemyCourseInfo' }, (info) => {
        if (!info || !info.courseId) {
          alert('Could not find Udemy course ID on this tab. Ensure you are on a Udemy course learning page.');
          fetchCurriculumBtn.disabled = false;
          fetchCurriculumBtn.textContent = 'Fetch Syllabus';
          return;
        }

        activeCourseTitle = info.courseTitle || 'Udemy Course';
        document.getElementById('course-details').style.display = 'flex';
        document.getElementById('course-title').textContent = activeCourseTitle;
        document.getElementById('course-id').textContent = info.courseId;

        chrome.tabs.sendMessage(tabId, { action: 'loadUdemyCurriculum', courseId: info.courseId }, (res) => {
          fetchCurriculumBtn.disabled = false;
          fetchCurriculumBtn.textContent = 'Fetch Syllabus';

          if (res && res.success && res.items) {
            currentCurriculum = parseCurriculumStructure(res.items, activeCourseTitle);
            
            let totalLectures = 0;
            currentCurriculum.forEach(s => totalLectures += s.lectures.length);

            document.getElementById('total-sections').textContent = String(currentCurriculum.length);
            document.getElementById('total-lectures').textContent = String(totalLectures);
            document.getElementById('curriculum-count').textContent = `${totalLectures} lectures`;
            document.getElementById('bulk-actions').style.display = 'flex';

            renderCurriculumList(currentCurriculum);
          } else {
            alert('Error loading curriculum: ' + (res ? res.error : 'Unknown error'));
          }
        });
      });
    });
  });

  // Start Bulk Download Button
  const startBulkBtn = document.getElementById('start-bulk-download');
  startBulkBtn.addEventListener('click', () => {
    if (!currentCurriculum || currentCurriculum.length === 0) return;

    startBulkBtn.disabled = true;
    const progressContainer = document.getElementById('bulk-progress-bar-container');
    const progressBar = document.getElementById('bulk-progress-bar');
    const statusText = document.getElementById('bulk-status-text');

    progressContainer.style.display = 'block';
    statusText.style.display = 'block';

    executeStructuredBulkDownload(currentCurriculum, (current, total, file) => {
      const pct = Math.floor((current / total) * 100);
      progressBar.style.width = `${pct}%`;
      statusText.textContent = `[${current}/${total}] (${pct}%) Saving: ${file}`;
      if (current === total) {
        statusText.textContent = `Completed downloading ${total} files!`;
        startBulkBtn.disabled = false;
      }
    });
  });
});
