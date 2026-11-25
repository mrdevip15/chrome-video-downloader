// Udemy curriculum -> course model + source selection. Exposes globalThis.UdemyModel.
(function (root) {
  const S = (s) => root.CourseFormatter.sanitizePath(s);

  function buildCourse(items, courseId, courseTitle) {
    const sections = [];
    let cur = null;
    const lectureCount = items.filter((i) => i._class === 'lecture').length;
    const pad = lectureCount > 99 ? 3 : 2;

    for (const it of items) {
      if (it._class === 'chapter') {
        const idx = it.object_index != null ? it.object_index : sections.length + 1;
        cur = { id: it.id, index: idx, title: it.title, dirName: `${String(idx).padStart(2, '0')} - ${S(it.title)}`, lectures: [] };
        sections.push(cur);
      } else if (it._class === 'lecture') {
        if (!cur) {
          cur = { id: 0, index: 0, title: 'Introduction', dirName: '00 - Introduction', lectures: [] };
          sections.push(cur);
        }
        const asset = it.asset || {};
        const idx = it.object_index != null ? it.object_index : cur.lectures.length + 1;
        cur.lectures.push({
          id: it.id,
          index: idx,
          title: it.title,
          fileBase: `${String(idx).padStart(pad, '0')} - ${S(it.title)}`,
          assetType: asset.asset_type || 'Unknown',
          drmHint: !!asset.course_is_drmed,
          captions: (asset.captions || []).map((c) => ({ locale: c.locale_id || 'und', label: c.video_label || c.title || c.locale_id || 'und' })),
          resources: (it.supplementary_assets || []).map((a) => ({
            id: a.id,
            title: a.title || a.filename || 'resource',
            filename: a.filename || a.title || `resource-${a.id}`,
            assetType: a.asset_type || 'File',
            externalUrl: a.external_url || null
          }))
        });
      }
    }
    return { id: courseId, title: courseTitle, dirName: S(courseTitle || `Course ${courseId}`), sections };
  }

  function directMp4Candidates(asset) {
    const out = [];
    const add = (list) =>
      (list || []).forEach((s) => {
        const url = s.file || s.src;
        const h = parseInt(s.label, 10);
        if (url && /mp4/i.test(s.type || '') && !isNaN(h)) out.push({ url, height: h });
      });
    add(asset.stream_urls && asset.stream_urls.Video);
    add(asset.download_urls && asset.download_urls.Video);
    add(asset.media_sources);
    return out.sort((a, b) => b.height - a.height);
  }

  function pickDirectMp4(asset, maxHeight) {
    const c = directMp4Candidates(asset);
    if (!c.length) return null;
    return c.find((x) => x.height <= maxHeight) || c[c.length - 1];
  }

  function pickHls(asset) {
    const all = [...(asset.media_sources || []), ...((asset.stream_urls && asset.stream_urls.Video) || [])];
    const h = all.find((s) => /mpegurl/i.test(s.type || ''));
    return h ? h.src || h.file : null;
  }

  function pickDash(asset) {
    const d = (asset.media_sources || []).find((s) => /dash\+xml/i.test(s.type || ''));
    return d ? d.src : null;
  }

  function allCaptionLocales(course) {
    const set = new Map();
    course.sections.forEach((s) => s.lectures.forEach((l) => l.captions.forEach((c) => set.set(c.locale, c.label))));
    return [...set.entries()].map(([locale, label]) => ({ locale, label })).sort((a, b) => a.locale.localeCompare(b.locale));
  }

  root.UdemyModel = { buildCourse, pickDirectMp4, pickHls, pickDash, allCaptionLocales };
})(globalThis);
