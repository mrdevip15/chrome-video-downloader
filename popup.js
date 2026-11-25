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

document.addEventListener('DOMContentLoaded', () => {
  fetchCurrentMedia();

  const rescanBtn = document.getElementById('rescan');
  if (rescanBtn) {
    rescanBtn.addEventListener('click', () => {
      rescanBtn.disabled = true;
      rescanBtn.textContent = 'Scanning...';

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || tabs.length === 0) return;
        chrome.tabs.sendMessage(tabs[0].id, { action: 'scanDom' }, (res) => {
          if (res && res.items) {
            chrome.runtime.sendMessage({
              action: 'pageDomMediaFound',
              items: res.items
            }, () => {
              fetchCurrentMedia();
              rescanBtn.disabled = false;
              rescanBtn.textContent = 'Scan Page Links';
            });
          } else {
            fetchCurrentMedia();
            rescanBtn.disabled = false;
            rescanBtn.textContent = 'Scan Page Links';
          }
        });
      });
    });
  }
});
