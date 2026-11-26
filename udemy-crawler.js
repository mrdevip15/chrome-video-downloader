// Runs on Udemy pages. Answers curriculum / lecture / resource lookups using the page's own session.
(() => {
  if (window.__CVD_UDEMY_CRAWLER_LOADED__) return;
  if (!/(^|\.)udemy\.com$/i.test(location.hostname) && location.hostname !== '127.0.0.1' && location.hostname !== 'localhost') return;
  window.__CVD_UDEMY_CRAWLER_LOADED__ = true;

  const api = (path) => `${location.origin}${path}`;

  function authHeaders() {
    const h = { Accept: 'application/json, text/plain, */*' };
    const m = document.cookie.match(/(?:^|;\s*)access_token=([^;]+)/);
    if (m) {
      h.Authorization = `Bearer ${decodeURIComponent(m[1])}`;
      h['X-Udemy-Authorization'] = `Bearer ${decodeURIComponent(m[1])}`;
    }
    return h;
  }

  async function getJson(url) {
    const res = await fetch(url, { credentials: 'include', headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).pathname}`);
    return res.json();
  }

  function getCourseId() {
    const app = document.querySelector('[data-module-id="course-taking"], .ud-component--course-taking--app');
    if (app) {
      try {
        const args = JSON.parse(app.getAttribute('data-module-args') || '{}');
        if (args.courseId) return args.courseId;
      } catch (_) {}
    }
    const body = document.body;
    if (body && body.dataset && body.dataset.clpCourseId) return +body.dataset.clpCourseId;
    const any = document.querySelector('[data-course-id]');
    if (any) return +any.getAttribute('data-course-id');
    return null;
  }

  function getCourseTitleFromDom() {
    const el = document.querySelector('[data-purpose="course-header-title"] a, [data-purpose="course-header-title"]');
    if (el && el.textContent.trim()) return el.textContent.trim();
    return document.title.replace(/^Course:\s*/i, '').replace(/\s*\|.*$/, '').trim();
  }

  const LECTURE_ASSET_FIELDS =
    'asset_type,title,filename,length,media_license_token,course_is_drmed,media_sources,captions,stream_urls,download_urls,body,external_url';

  async function loadCurriculum(courseId) {
    const fields =
      'fields[lecture]=title,object_index,asset,supplementary_assets' +
      '&fields[chapter]=title,object_index' +
      '&fields[quiz]=title,object_index' +
      '&fields[practice]=title,object_index' +
      '&fields[asset]=title,filename,asset_type,captions,external_url,course_is_drmed';
    let url = api(`/api-2.0/courses/${courseId}/subscriber-curriculum-items/?page_size=200&${fields}`);
    const items = [];
    let guard = 0;
    while (url && guard++ < 50) {
      const data = await getJson(url);
      items.push(...(data.results || []));
      url = data.next || null;
    }
    return items;
  }

  async function loadCourseTitle(courseId) {
    try {
      const d = await getJson(api(`/api-2.0/courses/${courseId}/?fields[course]=title`));
      if (d && d.title) return d.title;
    } catch (_) {}
    return getCourseTitleFromDom();
  }

  async function resolveLecture(courseId, lectureId) {
    return getJson(
      api(`/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${lectureId}/?fields[lecture]=title,asset,supplementary_assets&fields[asset]=${LECTURE_ASSET_FIELDS}`)
    );
  }

  async function resolveSupplementary(courseId, lectureId, assetId) {
    return getJson(
      api(`/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${lectureId}/supplementary-assets/${assetId}/?fields[asset]=download_urls,external_url,filename,title,asset_type`)
    );
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const reply = (p) =>
      p.then((data) => sendResponse({ success: true, data })).catch((e) => sendResponse({ success: false, error: e.message }));

    switch (msg && msg.action) {
      case 'getUdemyCourseInfo':
        sendResponse({ success: true, data: { courseId: getCourseId(), courseTitle: getCourseTitleFromDom(), origin: location.origin } });
        return false;
      case 'loadUdemyCurriculum': {
        const id = msg.courseId || getCourseId();
        if (!id) {
          sendResponse({ success: false, error: 'Course ID not found on this page.' });
          return false;
        }
        reply(Promise.all([loadCurriculum(id), loadCourseTitle(id)]).then(([items, title]) => ({ courseId: id, title, items })));
        return true;
      }
      case 'resolveLecture':
        reply(resolveLecture(msg.courseId, msg.lectureId));
        return true;
      case 'resolveSupplementary':
        reply(resolveSupplementary(msg.courseId, msg.lectureId, msg.assetId));
        return true;
      default:
        return false;
    }
  });
})();
