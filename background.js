const mediaMap = new Map();

const MEDIA_REGEX = /\.(mp4|m4v|webm|mkv|mov|avi|flv|m3u8|mpd)(\?.*)?$/i;
const MEDIA_TYPES = [
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-matroska',
  'application/x-mpegurl',
  'application/vnd.apple.mpegurl',
  'application/dash+xml'
];

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;

    let isMedia = MEDIA_REGEX.test(details.url);
    let isHls = details.url.includes('.m3u8');

    if (!isMedia && details.responseHeaders) {
      const contentTypeHeader = details.responseHeaders.find(
        (h) => h.name.toLowerCase() === 'content-type'
      );
      if (contentTypeHeader && contentTypeHeader.value) {
        const val = contentTypeHeader.value.toLowerCase().split(';')[0].trim();
        if (val.includes('mpegurl')) {
          isMedia = true;
          isHls = true;
        } else if (MEDIA_TYPES.includes(val) || val.startsWith('video/')) {
          isMedia = true;
        }
      }
    }

    if (isMedia) {
      let list = mediaMap.get(details.tabId) || [];
      if (!list.some((item) => item.url === details.url)) {
        let filename = 'video';
        try {
          const parsed = new URL(details.url);
          const pathSegments = parsed.pathname.split('/').filter(Boolean);
          if (pathSegments.length > 0) {
            filename = decodeURIComponent(pathSegments[pathSegments.length - 1]);
          }
        } catch (_) {}

        list.push({
          url: details.url,
          filename: filename,
          isHls: isHls,
          type: details.type,
          timestamp: Date.now()
        });
        mediaMap.set(details.tabId, list);
        chrome.action.setBadgeText({ tabId: details.tabId, text: String(list.length) });
        chrome.action.setBadgeBackgroundColor({ tabId: details.tabId, color: isHls ? '#7C3AED' : '#2563EB' });
      }
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.tabs.onRemoved.addListener((tabId) => {
  mediaMap.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    mediaMap.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getMedia') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length === 0) {
        sendResponse({ media: [] });
        return;
      }
      const activeTabId = tabs[0].id;
      sendResponse({ media: mediaMap.get(activeTabId) || [] });
    });
    return true;
  }
  if (message.action === 'download') {
    chrome.downloads.download({
      url: message.url,
      filename: message.filename || 'video.mp4',
      saveAs: true
    }, (downloadId) => {
      sendResponse({ success: Boolean(downloadId), downloadId });
    });
    return true;
  }
});
