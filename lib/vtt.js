// WebVTT -> SRT conversion and path helpers. Exposes globalThis.CourseFormatter.
(function (root) {
  function convTs(t) {
    const parts = t.split(':');
    const [s, ms] = parts.pop().split('.');
    const mm = parts.pop();
    const hh = parts.pop() || '0';
    return `${hh.padStart(2, '0')}:${mm}:${s},${ms}`;
  }

  function vttToSrt(vtt) {
    if (!vtt) return '';
    const blocks = vtt.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
    const out = [];
    let n = 1;
    for (const block of blocks) {
      const lines = block.split('\n').filter((l) => l.length);
      const ti = lines.findIndex((l) => l.includes('-->'));
      if (ti === -1) continue;
      const m = lines[ti].match(/((?:\d+:)?\d{2}:\d{2}\.\d{3})\s*-->\s*((?:\d+:)?\d{2}:\d{2}\.\d{3})/);
      if (!m) continue;
      const text = lines
        .slice(ti + 1)
        .map((l) => l.replace(/<(?!\/?(?:i|b|u)>)[^>]+>/g, ''))
        .join('\n')
        .trim();
      if (!text) continue;
      out.push(`${n++}\n${convTs(m[1])} --> ${convTs(m[2])}\n${text}`);
    }
    return out.length ? out.join('\n\n') + '\n' : '';
  }

  // Safe single path segment for Windows/macOS/Linux and chrome.downloads.
  function sanitizePath(name, maxLen = 120) {
    let s = String(name || 'untitled')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .replace(/[. ]+$/, '');
    if (s.length > maxLen) s = s.slice(0, maxLen).replace(/[. ]+$/, '');
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `_${s}`;
    return s || 'untitled';
  }

  root.CourseFormatter = { vttToSrt, sanitizePath };
})(globalThis);
