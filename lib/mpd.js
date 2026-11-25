// Minimal static DASH (MPD) parser. Exposes globalThis.MPD. Needs a DOMParser.
(function (root) {
  function parseDuration(s) {
    if (!s) return 0;
    const m = s.match(/P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?/);
    if (!m) return 0;
    return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60 + (+(m[4] || 0));
  }

  const localName = (n) => n.localName || String(n.nodeName).replace(/^.*:/, '');
  const elems = (el) => Array.from(el.childNodes).filter((c) => c.nodeType === 1);
  const child = (el, name) => (el ? elems(el).find((c) => localName(c) === name) || null : null);
  const children = (el, name) => (el ? elems(el).filter((c) => localName(c) === name) : []);
  const has = (el, n) => !!el && el.hasAttribute(n);
  const attr = (el, n) => (has(el, n) ? el.getAttribute(n) : null);
  const firstAttr = (els, n) => {
    for (const e of els) if (has(e, n)) return e.getAttribute(n);
    return null;
  };

  function baseOf(el, parentBase) {
    const b = child(el, 'BaseURL');
    return b ? new URL(b.textContent.trim(), parentBase).href : parentBase;
  }

  function fillTemplate(tpl, vars) {
    return tpl.replace(/\$(RepresentationID|Number|Bandwidth|Time)(?:%0(\d+)d)?\$|\$\$/g, (all, name, width) => {
      if (!name) return '$';
      let v = String(vars[name]);
      if (width) v = v.padStart(parseInt(width, 10), '0');
      return v;
    });
  }

  function parseRange(r) {
    if (!r) return null;
    const [a, b] = r.split('-').map(Number);
    return { offset: a, length: b - a + 1 };
  }

  function parse(xml, mpdUrl) {
    const doc = new root.DOMParser().parseFromString(xml, 'application/xml');
    const mpd = doc.documentElement;
    if (!mpd || localName(mpd) !== 'MPD') throw new Error('Not a DASH MPD');
    if (attr(mpd, 'type') === 'dynamic') throw new Error('Live DASH streams are not supported');

    const isProtected =
      doc.getElementsByTagName('ContentProtection').length > 0 ||
      (doc.getElementsByTagNameNS && doc.getElementsByTagNameNS('*', 'ContentProtection').length > 0);

    const mpdBase = baseOf(mpd, mpdUrl);
    const period = child(mpd, 'Period');
    if (!period) throw new Error('MPD has no Period');
    const periodDur = parseDuration(attr(period, 'duration')) || parseDuration(attr(mpd, 'mediaPresentationDuration'));
    const periodBase = baseOf(period, mpdBase);
    const reps = [];

    for (const as of children(period, 'AdaptationSet')) {
      const asBase = baseOf(as, periodBase);
      const asMime = attr(as, 'mimeType') || '';
      const asType = attr(as, 'contentType') || asMime.split('/')[0];

      for (const rep of children(as, 'Representation')) {
        const mime = attr(rep, 'mimeType') || asMime;
        const type = attr(rep, 'contentType') || asType || mime.split('/')[0];
        const base = baseOf(rep, asBase);
        const id = attr(rep, 'id') || '';
        const bandwidth = parseInt(attr(rep, 'bandwidth') || '0', 10);
        const r = {
          id,
          bandwidth,
          mime,
          type,
          codecs: attr(rep, 'codecs') || attr(as, 'codecs') || '',
          width: +(attr(rep, 'width') || attr(as, 'width') || 0),
          height: +(attr(rep, 'height') || attr(as, 'height') || 0),
          init: null,
          segments: []
        };

        const tpls = [child(rep, 'SegmentTemplate'), child(as, 'SegmentTemplate'), child(period, 'SegmentTemplate')].filter(Boolean);
        const list = child(rep, 'SegmentList') || child(as, 'SegmentList');

        if (tpls.length) {
          const vars = { RepresentationID: id, Bandwidth: bandwidth };
          const mediaTpl = firstAttr(tpls, 'media');
          const initTpl = firstAttr(tpls, 'initialization');
          const timescale = +(firstAttr(tpls, 'timescale') || 1);
          const startNumber = +(firstAttr(tpls, 'startNumber') || 1);
          if (initTpl) r.init = { url: new URL(fillTemplate(initTpl, { ...vars, Number: startNumber, Time: 0 }), base).href };
          const timeline = tpls.map((t) => child(t, 'SegmentTimeline')).find(Boolean);

          if (timeline) {
            let t = 0;
            let num = startNumber;
            for (const s of children(timeline, 'S')) {
              if (has(s, 't')) t = +s.getAttribute('t');
              const d = +s.getAttribute('d');
              let rpt = has(s, 'r') ? +s.getAttribute('r') : 0;
              if (rpt < 0) rpt = Math.ceil((periodDur * timescale - t) / d) - 1;
              for (let i = 0; i <= rpt; i++) {
                r.segments.push({ url: new URL(fillTemplate(mediaTpl, { ...vars, Number: num, Time: t }), base).href });
                t += d;
                num++;
              }
            }
          } else {
            const dur = +(firstAttr(tpls, 'duration') || 0);
            if (!dur || !periodDur) throw new Error('Cannot compute DASH segment count');
            const count = Math.ceil(periodDur / (dur / timescale));
            for (let i = 0; i < count; i++) {
              r.segments.push({
                url: new URL(fillTemplate(mediaTpl, { ...vars, Number: startNumber + i, Time: i * dur }), base).href
              });
            }
          }
        } else if (list) {
          const initEl = child(list, 'Initialization');
          if (initEl) r.init = { url: new URL(attr(initEl, 'sourceURL') || '', base).href, range: parseRange(attr(initEl, 'range')) };
          for (const su of children(list, 'SegmentURL')) {
            r.segments.push({ url: new URL(attr(su, 'media') || '', base).href, range: parseRange(attr(su, 'mediaRange')) });
          }
        } else {
          // SegmentBase / plain BaseURL: the whole representation is one file.
          r.segments.push({ url: base });
        }
        reps.push(r);
      }
    }

    return {
      isProtected,
      duration: periodDur,
      video: reps.filter((r) => r.type === 'video'),
      audio: reps.filter((r) => r.type === 'audio')
    };
  }

  function pickVideo(list, maxHeight) {
    const sorted = [...list].sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
    if (!maxHeight) return sorted[0] || null;
    return sorted.find((r) => !r.height || r.height <= maxHeight) || sorted[sorted.length - 1] || null;
  }

  function pickAudio(list) {
    return [...list].sort((a, b) => b.bandwidth - a.bandwidth)[0] || null;
  }

  root.MPD = { parse, pickVideo, pickAudio, parseDuration, fillTemplate };
})(globalThis);
