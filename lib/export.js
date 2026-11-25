// Article HTML/Markdown exporters and offline course index.html generator. Exposes globalThis.CourseExport.
(function (root) {
  function escHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function decodeEntities(s) {
    return String(s || '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }

  function encodeRelPath(rel) {
    return String(rel || '')
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
  }

  function articleToHtml(title, bodyHtml) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(title)}</title>
  <style>
    body {
      max-width: 820px;
      margin: 40px auto;
      padding: 0 20px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.7;
      color: #1e293b;
      background: #f8fafc;
    }
    article {
      background: #ffffff;
      padding: 32px;
      border-radius: 10px;
      box-shadow: 0 1px 4px rgba(15, 23, 42, 0.08);
    }
    h1 { margin-top: 0; font-size: 1.75rem; color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 12px; }
    pre { background: #0f172a; color: #e2e8f0; padding: 14px; border-radius: 6px; overflow-x: auto; }
    code { background: #f1f5f9; padding: 2px 5px; border-radius: 4px; font-family: Consolas, monospace; font-size: 0.9em; }
    pre code { background: none; padding: 0; color: inherit; }
    img { max-width: 100%; height: auto; border-radius: 6px; }
    blockquote { border-left: 4px solid #3b82f6; margin: 16px 0; padding: 4px 16px; color: #475569; background: #eff6ff; }
    a { color: #2563eb; }
  </style>
</head>
<body>
  <article>
    <h1>${escHtml(title)}</h1>
    <div class="article-body">
${bodyHtml || ''}
    </div>
  </article>
</body>
</html>
`;
  }

  function domNodeToMd(node, listCtx = null) {
    if (node.nodeType === 3) {
      return node.nodeValue || '';
    }
    if (node.nodeType !== 1) return '';

    const tag = node.tagName.toLowerCase();
    const childrenMd = (ctx = listCtx) => Array.from(node.childNodes).map((c) => domNodeToMd(c, ctx)).join('');

    switch (tag) {
      case 'script':
      case 'style':
        return '';
      case 'h1': return `\n# ${childrenMd().trim()}\n\n`;
      case 'h2': return `\n## ${childrenMd().trim()}\n\n`;
      case 'h3': return `\n### ${childrenMd().trim()}\n\n`;
      case 'h4': return `\n#### ${childrenMd().trim()}\n\n`;
      case 'h5': return `\n##### ${childrenMd().trim()}\n\n`;
      case 'h6': return `\n###### ${childrenMd().trim()}\n\n`;
      case 'p': {
        const inner = childrenMd().trim();
        return inner ? `${inner}\n\n` : '';
      }
      case 'br': return '  \n';
      case 'hr': return '\n---\n\n';
      case 'strong':
      case 'b': {
        const inner = childrenMd().trim();
        return inner ? `**${inner}**` : '';
      }
      case 'em':
      case 'i': {
        const inner = childrenMd().trim();
        return inner ? `*${inner}*` : '';
      }
      case 'code': {
        if (node.parentElement && node.parentElement.tagName.toLowerCase() === 'pre') {
          return node.textContent || '';
        }
        return `\`${(node.textContent || '').trim()}\``;
      }
      case 'pre': {
        const codeText = (node.textContent || '').replace(/^\n+|\n+$/g, '');
        return `\n\`\`\`\n${codeText}\n\`\`\`\n\n`;
      }
      case 'blockquote': {
        const inner = childrenMd().trim().split('\n').map((l) => `> ${l}`).join('\n');
        return inner ? `\n${inner}\n\n` : '';
      }
      case 'ul': {
        let idx = 0;
        const inner = Array.from(node.childNodes).map((c) => domNodeToMd(c, { ordered: false, idx: () => ++idx })).join('');
        return `\n${inner}\n`;
      }
      case 'ol': {
        let idx = 0;
        const inner = Array.from(node.childNodes).map((c) => domNodeToMd(c, { ordered: true, idx: () => ++idx })).join('');
        return `\n${inner}\n`;
      }
      case 'li': {
        const prefix = listCtx && listCtx.ordered ? `${listCtx.idx()}. ` : '- ';
        const inner = childrenMd().trim().replace(/\n+/g, '\n  ');
        return `${prefix}${inner}\n`;
      }
      case 'a': {
        const href = node.getAttribute('href') || '';
        const text = childrenMd().trim() || href;
        return href ? `[${text}](${href})` : text;
      }
      case 'img': {
        const src = node.getAttribute('src') || '';
        const alt = node.getAttribute('alt') || 'image';
        return src ? `![${alt}](${src})` : '';
      }
      default:
        return childrenMd();
    }
  }

  function regexHtmlToMd(html) {
    let s = String(html || '');
    s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
    s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
    s = s.replace(/<pre[^>]*>\s*(?:<code[^>]*>)?([\s\S]*?)(?:<\/code>)?\s*<\/pre>/gi, (_, c) => `\n\`\`\`\n${decodeEntities(c).trim()}\n\`\`\`\n\n`);
    for (let lvl = 1; lvl <= 6; lvl++) {
      const re = new RegExp(`<h${lvl}[^>]*>([\\s\\S]*?)<\\/h${lvl}>`, 'gi');
      s = s.replace(re, (_, t) => `\n${'#'.repeat(lvl)} ${t.replace(/<[^>]+>/g, '').trim()}\n\n`);
    }
    s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t) => `\n> ${t.replace(/<[^>]+>/g, '').trim()}\n\n`);
    s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `- ${t.replace(/<[^>]+>/g, '').trim()}\n`);
    s = s.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');
    s = s.replace(/<hr\s*\/?>/gi, '\n---\n\n');
    s = s.replace(/<br\s*\/?>/gi, '  \n');
    s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
    s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
    s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
    s = s.replace(/<img[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*\/?>/gi, '![$2]($1)');
    s = s.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*\/?>/gi, '![$1]($2)');
    s = s.replace(/<img[^>]*src=["']([^"']+)["'][^>]*\/?>/gi, '![image]($1)');
    s = s.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => `[${text.replace(/<[^>]+>/g, '').trim() || href}](${href})`);
    s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');
    s = s.replace(/<[^>]+>/g, '');
    return decodeEntities(s);
  }

  function articleToMarkdown(title, bodyHtml) {
    let bodyMd = '';
    if (typeof root.DOMParser === 'function') {
      try {
        const doc = new root.DOMParser().parseFromString(`<div>${bodyHtml || ''}</div>`, 'text/html');
        const container = doc.body && doc.body.firstElementChild;
        if (container) {
          bodyMd = domNodeToMd(container);
        }
      } catch (_) {
        bodyMd = regexHtmlToMd(bodyHtml);
      }
    } else {
      bodyMd = regexHtmlToMd(bodyHtml);
    }

    const cleaned = bodyMd
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return `# ${title}\n\n${cleaned}\n`;
  }

  function generateCourseIndexHtml(course, lectureResults) {
    const map = lectureResults || {};
    let totalVideos = 0;
    let totalArticles = 0;
    let totalSubtitles = 0;
    let totalResources = 0;
    let totalDrm = 0;

    const sectionsHtml = (course.sections || []).map((sec, sIdx) => {
      const itemsHtml = (sec.lectures || []).map((lec) => {
        const res = map[lec.id] || {};
        const status = res.status || 'pending';
        if (res.videoFile) totalVideos++;
        if (res.articleFiles && res.articleFiles.length) totalArticles++;
        if (res.subtitleFiles && res.subtitleFiles.length) totalSubtitles += res.subtitleFiles.length;
        if (res.resourceFiles && res.resourceFiles.length) totalResources += res.resourceFiles.length;
        if (status === 'drm' || res.videoStatus === 'drm') totalDrm++;

        let badgeClass = 'pending';
        let badgeLabel = 'Pending';
        if (status === 'done') { badgeClass = 'done'; badgeLabel = lec.assetType === 'Article' ? 'Article' : 'Done'; }
        else if (status === 'drm' || res.videoStatus === 'drm') { badgeClass = 'drm'; badgeLabel = 'DRM Skipped'; }
        else if (status === 'error') { badgeClass = 'error'; badgeLabel = 'Error'; }

        const links = [];
        if (res.videoFile) {
          const href = encodeRelPath(res.videoFile);
          links.push(`<a href="${href}" class="play-link" data-video="${escHtml(href)}" data-title="${escHtml(lec.title)}">Video (${escHtml(res.videoFile.split('.').pop().toUpperCase())})</a>`);
        }
        (res.subtitleFiles || []).forEach((sf) => {
          const lang = sf.split('.').slice(-2, -1)[0] || 'sub';
          links.push(`<a href="${encodeRelPath(sf)}" target="_blank">Subtitle (${escHtml(lang)})</a>`);
        });
        (res.articleFiles || []).forEach((af) => {
          const ext = af.split('.').pop().toUpperCase();
          links.push(`<a href="${encodeRelPath(af)}" target="_blank">Article (${escHtml(ext)})</a>`);
        });
        (res.resourceFiles || []).forEach((rf) => {
          const name = rf.split('/').pop();
          links.push(`<a href="${encodeRelPath(rf)}" target="_blank">Resource: ${escHtml(name)}</a>`);
        });

        const searchStr = escHtml(`${sec.title} ${lec.title} ${badgeLabel}`.toLowerCase());
        return `<li class="lec" data-search="${searchStr}">
          <div class="lec-top">
            <span class="lec-title">${escHtml(lec.fileBase)}</span>
            <span class="badge ${badgeClass}">${escHtml(badgeLabel)}</span>
          </div>
          ${links.length ? `<div class="lec-links">${links.join('')}</div>` : ''}
          ${res.error ? `<div class="lec-err">${escHtml(res.error)}</div>` : ''}
        </li>`;
      }).join('\n');

      return `<details class="sec" ${sIdx === 0 ? 'open' : ''}>
        <summary>${escHtml(sec.dirName)} <span class="sec-cnt">(${(sec.lectures || []).length})</span></summary>
        <ul class="lec-list">${itemsHtml}</ul>
      </details>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(course.title)} — Offline Syllabus</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #e2e8f0; }
    .wrap { max-width: 1040px; margin: 0 auto; padding: 24px 16px 48px; }
    h1 { margin: 0 0 8px; font-size: 1.5rem; color: #f8fafc; }
    .stats { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; font-size: 12px; color: #94a3b8; }
    .stat { background: #1e293b; border: 1px solid #334155; padding: 5px 10px; border-radius: 6px; }
    .stat strong { color: #38bdf8; }
    .player-box { background: #020617; border: 1px solid #334155; border-radius: 8px; padding: 12px; margin-bottom: 16px; display: none; }
    .player-box.active { display: block; }
    .player-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; color: #f1f5f9; }
    video { width: 100%; max-height: 520px; border-radius: 4px; background: #000; }
    #search { width: 100%; padding: 10px 12px; margin-bottom: 16px; border-radius: 6px; border: 1px solid #334155; background: #1e293b; color: #f1f5f9; font-size: 13px; }
    .sec { background: #1e293b; border: 1px solid #334155; border-radius: 8px; margin-bottom: 10px; overflow: hidden; }
    .sec summary { cursor: pointer; padding: 12px 14px; font-weight: 600; font-size: 14px; color: #f1f5f9; background: #1e293b; }
    .sec summary:hover { background: #263449; }
    .sec-cnt { color: #94a3b8; font-weight: 400; font-size: 12px; }
    .lec-list { list-style: none; margin: 0; padding: 0; border-top: 1px solid #334155; }
    .lec { padding: 10px 14px; border-bottom: 1px solid #263449; }
    .lec:last-child { border-bottom: none; }
    .lec-top { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .lec-title { font-size: 13px; font-weight: 500; }
    .badge { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 4px; text-transform: uppercase; }
    .badge.done { background: #065f46; color: #a7f3d0; }
    .badge.drm { background: #78350f; color: #fde68a; }
    .badge.error { background: #7f1d1d; color: #fecaca; }
    .badge.pending { background: #334155; color: #cbd5e1; }
    .lec-links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
    .lec-links a { font-size: 11px; color: #38bdf8; text-decoration: none; background: #0f172a; border: 1px solid #334155; padding: 3px 8px; border-radius: 4px; }
    .lec-links a:hover { border-color: #38bdf8; }
    .lec-err { margin-top: 4px; font-size: 11px; color: #fca5a5; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>${escHtml(course.title)}</h1>
    <div class="stats">
      <span class="stat">Videos: <strong>${totalVideos}</strong></span>
      <span class="stat">Articles: <strong>${totalArticles}</strong></span>
      <span class="stat">Subtitles: <strong>${totalSubtitles}</strong></span>
      <span class="stat">Resources: <strong>${totalResources}</strong></span>
      <span class="stat">DRM Skipped: <strong>${totalDrm}</strong></span>
    </div>
    <div class="player-box" id="playerBox">
      <div class="player-title" id="playerTitle"></div>
      <video id="player" controls></video>
    </div>
    <input type="search" id="search" placeholder="Filter sections or lectures...">
    <div id="sections">
${sectionsHtml}
    </div>
  </div>
  <script>
    const playerBox = document.getElementById('playerBox');
    const player = document.getElementById('player');
    const playerTitle = document.getElementById('playerTitle');
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a.play-link');
      if (!a) return;
      e.preventDefault();
      playerBox.classList.add('active');
      playerTitle.textContent = a.dataset.title || '';
      player.src = a.dataset.video;
      player.play().catch(() => {});
    });
    document.getElementById('search').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      document.querySelectorAll('.sec').forEach((sec) => {
        let anyVisible = false;
        sec.querySelectorAll('.lec').forEach((li) => {
          const match = !q || (li.dataset.search || '').includes(q);
          li.style.display = match ? '' : 'none';
          if (match) anyVisible = true;
        });
        sec.style.display = anyVisible ? '' : 'none';
        if (q && anyVisible) sec.open = true;
      });
    });
  </script>
</body>
</html>
`;
  }

  root.CourseExport = { articleToHtml, articleToMarkdown, generateCourseIndexHtml };
})(globalThis);
