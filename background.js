const mediaMap = new Map();
// Latest EME/license capture per tab (init data = PSSH, license = request body).
const drmMap = new Map();

function putDrm(tabId, patch) {
  if (tabId == null || tabId < 0 || !patch) return;
  const cur = drmMap.get(tabId) || {};
  drmMap.set(tabId, { ...cur, ...patch, updatedAt: Date.now() });
}

function getDrm(tabId) {
  return drmMap.get(tabId) || null;
}

const MEDIA_REGEX = /\.(mp4|m4v|webm|mkv|mov|avi|flv|m3u8|mpd)(\?.*)?$/i;
const MEDIA_TYPES = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-matroska', 'application/dash+xml'];

function addMediaItem(tabId, item) {
  if (tabId < 0 || !item || !item.url) return;
  const list = mediaMap.get(tabId) || [];
  if (list.some((x) => x.url === item.url)) return;
  list.push(item);
  mediaMap.set(tabId, list);
  chrome.action.setBadgeText({ tabId, text: String(list.length) });
  chrome.action.setBadgeBackgroundColor({ tabId, color: list.some((i) => i.isHls || i.isDash) ? '#7C3AED' : '#2563EB' });
}

function filenameFromUrl(url) {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    if (segs.length) return decodeURIComponent(segs[segs.length - 1]);
  } catch (_) {}
  return 'video';
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    let isMedia = MEDIA_REGEX.test(details.url);
    let isHls = /\.m3u8(\?|$)/i.test(details.url);
    let isDash = /\.mpd(\?|$)/i.test(details.url);

    if (!isMedia && details.responseHeaders) {
      const ct = details.responseHeaders.find((h) => h.name.toLowerCase() === 'content-type');
      const val = ct && ct.value ? ct.value.toLowerCase().split(';')[0].trim() : '';
      if (val.includes('mpegurl')) { isMedia = true; isHls = true; }
      else if (val === 'application/dash+xml') { isMedia = true; isDash = true; }
      else if (MEDIA_TYPES.includes(val) || val.startsWith('video/')) isMedia = true;
    }
    if (!isMedia) return;
    // Skip byte-range chunk requests of a file we already listed and HLS/DASH segment files.
    if (/\.(ts|m4s|aac)(\?|$)/i.test(details.url)) return;

    addMediaItem(details.tabId, {
      url: details.url,
      filename: filenameFromUrl(details.url),
      isHls,
      isDash,
      type: details.type,
      source: 'network',
      timestamp: Date.now()
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.tabs.onRemoved.addListener((tabId) => { mediaMap.delete(tabId); drmMap.delete(tabId); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    mediaMap.delete(tabId);
    drmMap.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});

function openManagerTab({ tabId, view, enqueueStream }) {
  const baseUrl = chrome.runtime.getURL('manager.html');
  const params = new URLSearchParams();
  if (tabId != null) params.set('tabId', String(tabId));
  if (view) params.set('view', view);
  if (enqueueStream) params.set('enqueue', JSON.stringify(enqueueStream));
  const fullUrl = `${baseUrl}?${params.toString()}`;

  chrome.tabs.query({ url: `${baseUrl}*` }, (tabs) => {
    if (tabs && tabs.length > 0) {
      const existing = tabs[0];
      chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId != null) {
        chrome.windows.update(existing.windowId, { focused: true });
      }
      const payload = { action: 'managerAction', tabId, view, enqueueStream };
      chrome.tabs.sendMessage(existing.id, payload, () => {
        if (chrome.runtime.lastError) {
          setTimeout(() => chrome.tabs.sendMessage(existing.id, payload, () => {}), 300);
        }
      });
    } else {
      chrome.tabs.create({ url: fullUrl });
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'drmCaptureFound' && sender.tab && sender.tab.id != null) {
    putDrm(sender.tab.id, message.capture);
    sendResponse({ ok: true });
    return false;
  }
  if (message.action === 'getDrmCapture') {
    sendResponse({ capture: getDrm(message.tabId) });
    return false;
  }
  if (message.action === 'clearDrmCapture') {
    if (message.tabId != null) drmMap.delete(message.tabId);
    sendResponse({ ok: true });
    return false;
  }
  if (message.action === 'pageDomMediaFound' && sender.tab && sender.tab.id != null) {
    (message.items || []).forEach((item) => addMediaItem(sender.tab.id, item));
    sendResponse({ ok: true });
    return false;
  }
  if (message.action === 'getMedia') {
    const respond = (tabId) => sendResponse({ media: mediaMap.get(tabId) || [] });
    if (message.tabId != null) {
      respond(message.tabId);
      return false;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => respond(tabs.length ? tabs[0].id : -1));
    return true;
  }
  if (message.action === 'download') {
    chrome.downloads.download({
      url: message.url,
      filename: message.filename || 'video.mp4',
      saveAs: message.saveAs !== undefined ? message.saveAs : true
    }, (downloadId) => {
      sendResponse({
        success: Boolean(downloadId),
        downloadId,
        error: chrome.runtime.lastError ? chrome.runtime.lastError.message : null
      });
    });
    return true;
  }
  if (message.action === 'openManager') {
    if (message.tabId != null) {
      openManagerTab(message);
      sendResponse({ ok: true });
      return false;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      openManagerTab({ ...message, tabId: tabs.length ? tabs[0].id : null });
      sendResponse({ ok: true });
    });
    return true;
  }
  return false;
});
