(() => {
  // Extract course ID and syllabus from the current Udemy tab
  function getUdemyCourseId() {
    const appEl = document.querySelector('.ud-component--course-taking--app, [data-module-id="course-taking"]');
    if (appEl) {
      try {
        const rawArgs = appEl.getAttribute('data-module-args');
        if (rawArgs) {
          const parsed = JSON.parse(rawArgs);
          if (parsed.courseId) return parsed.courseId;
        }
      } catch (_) {}
    }

    if (window.UD && window.UD.request && window.UD.request.courseId) {
      return window.UD.request.courseId;
    }
    return null;
  }

  function getCourseTitle() {
    const titleEl = document.querySelector('[data-purpose="course-header-title"] h1, [data-purpose="course-header-title"] a');
    if (titleEl) return titleEl.textContent.trim();
    return document.title.replace(/\|.*$/, '').trim();
  }

  // Fetch full curriculum from Udemy internal API
  async function fetchCurriculumItems(courseId) {
    const endpoint = `/api-2.0/courses/${courseId}/subscriber-curriculum-items/?page_size=1400&fields[lecture]=title,object_index,asset,supplementary_assets,download_url&fields[chapter]=title,object_index&fields[asset]=title,filename,asset_type,stream_urls,captions,download_urls`;
    const res = await fetch(endpoint, {
      credentials: 'include',
      headers: {
        'Accept': 'application/json, text/plain, */*'
      }
    });

    if (!res.ok) {
      throw new Error(`Failed to load curriculum API: HTTP ${res.status}`);
    }

    const data = await res.json();
    return data.results || [];
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'getUdemyCourseInfo') {
      const courseId = getUdemyCourseId();
      const courseTitle = getCourseTitle();
      sendResponse({ courseId, courseTitle });
      return true;
    }

    if (msg.action === 'loadUdemyCurriculum') {
      const courseId = msg.courseId || getUdemyCourseId();
      if (!courseId) {
        sendResponse({ success: false, error: 'Course ID not found on active page.' });
        return true;
      }

      fetchCurriculumItems(courseId)
        .then(items => {
          sendResponse({ success: true, items });
        })
        .catch(err => {
          sendResponse({ success: false, error: err.message });
        });
      return true; // Keep message channel open for async response
    }
  });
})();
