let activeTabId = null;

function renderStreams(items) {
  const list = document.getElementById('list');
  const empty = document.getElementById('empty');
  const count = document.getElementById('count');

  list.innerHTML = '';
  count.textContent = String(items.length);

  if (!items.length) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  items.forEach((item) => {
    const isHls = item.isHls || /\.m3u8(\?|$)/i.test(item.url);
    const isDash = item.isDash || /\.mpd(\?|$)/i.test(item.url);

    const card = document.createElement('div');
    card.className = 'item';

    const top = document.createElement('div');
    top.className = 'item-top';

    const name = document.createElement('div');
    name.className = 'item-name';
    name.textContent = item.filename || 'video';

    const badge = document.createElement('span');
    badge.className = `badge ${isHls ? 'badge-hls' : isDash ? 'badge-dash' : 'badge-direct'}`;
    badge.textContent = isHls ? 'HLS' : isDash ? 'DASH' : 'DIRECT';

    top.appendChild(name);
    top.appendChild(badge);

    const url = document.createElement('div');
    url.className = 'item-url';
    url.textContent = item.url;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const dlBtn = document.createElement('button');
    dlBtn.className = 'btn';
    dlBtn.textContent = (isHls || isDash) ? 'Download in Manager' : 'Download';
    dlBtn.addEventListener('click', () => {
      if (isHls || isDash) {
        chrome.runtime.sendMessage({
          action: 'openManager',
          tabId: activeTabId,
          view: 'sniffer',
          enqueueStream: item
        }, () => window.close());
      } else {
        chrome.runtime.sendMessage({
          action: 'download',
          url: item.url,
          filename: item.filename || 'video.mp4',
          saveAs: true
        });
      }
    });

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-secondary';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(item.url).then(() => {
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
      });
    });

    actions.appendChild(dlBtn);
    actions.appendChild(copyBtn);

    card.appendChild(top);
    card.appendChild(url);
    card.appendChild(actions);
    list.appendChild(card);
  });
}

function refreshMedia() {
  if (activeTabId == null) return;
  chrome.runtime.sendMessage({ action: 'getMedia', tabId: activeTabId }, (res) => {
    renderStreams((res && res.media) || []);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs.length) return;
    activeTabId = tabs[0].id;
    refreshMedia();

    chrome.tabs.sendMessage(activeTabId, { action: 'getUdemyCourseInfo' }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && res.success && res.data && res.data.courseId) {
        document.getElementById('course-card').style.display = 'block';
        document.getElementById('course-name').textContent = res.data.courseTitle || `Course #${res.data.courseId}`;
      }
    });
  });

  document.getElementById('open-manager').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'openManager', tabId: activeTabId, view: 'sniffer' }, () => window.close());
  });

  document.getElementById('open-course-bulk').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'openManager', tabId: activeTabId, view: 'course' }, () => window.close());
  });

  document.getElementById('scan-btn').addEventListener('click', () => {
    if (activeTabId == null) return;
    chrome.tabs.sendMessage(activeTabId, { action: 'scanDom' }, () => {
      if (!chrome.runtime.lastError) refreshMedia();
    });
  });
});
