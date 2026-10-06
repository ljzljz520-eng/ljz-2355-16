// Snippet builder.
//
// Pipeline (every stage is an explicit "view"; offsets never silently reused):
//
//   raw HTML ──stripHtml──▶ stripped plain text ──normalizeView──▶ norm text
//        offsets(raw)           offsets(stripped)                   offsets(norm)
//
// Index tokens live on the norm view. The best snippet window is chosen on the
// norm view, then mapped back to stripped cp for output slicing, and (for
// deep-link anchors) to raw cp. Output is sliced from the *stripped* text and
// HTML-escaped, so original tags/scripts can never be injected into the page.

import { stripHtml, escapeHtml } from '../text/html-view.js';
import { normalizeView } from '../text/analyzers.js';
import { cpSlice, codePointLength } from '../text/codepoints.js';

export const HL = {
  FIELD: 'field',
  API: 'api',
  ERROR: 'error',
  TEXT: 'text',
};

/**
 * Prepare indexable views for a section body.
 * @returns raw, stripped, norm, maps (rawMap: stripped->raw, normMap: norm->stripped)
 */
export function prepareViews(rawHtml) {
  const stripped = stripHtml(rawHtml);
  const norm = normalizeView(stripped.text);
  return {
    raw: rawHtml,
    stripped: stripped.text,
    strippedMap: stripped.map, // stripped cp -> raw cp
    norm: norm.text,
    normMap: norm.map, // norm cp -> stripped cp
  };
}

/** Convert a norm cp range to a stripped cp range. */
export function normToStripped(views, ns, ne) {
  return views.normMap.mapRange(ns, ne);
}

/** Convert stripped cp range to raw cp range (anchor positioning). */
export function strippedToRaw(views, ss, se) {
  return views.strippedMap.mapRange(ss, se);
}

/**
 * Choose the best window [wStart,wEnd) in NORM cp units.
 * @param tokenRanges array of {start,end} (norm cp) that matched
 * @param normLen
 * @param radius target window radius in cp
 */
export function chooseWindow(tokenRanges, normLen, radius = 36) {
  if (!tokenRanges.length) return { start: 0, end: Math.min(radius * 2, normLen) };
  // Score candidate windows centered on each matched token, prefer windows
  // that contain the most matched tokens (density) and earliest position.
  let best = null;
  for (const t of tokenRanges) {
    const center = (t.start + t.end) / 2;
    let start = Math.max(0, Math.floor(center - radius));
    let end = Math.min(normLen, Math.ceil(center + radius));
    // expand to norm word boundaries (avoid cutting a token) when cheap
    start = expandBoundary(start, normLen, -1);
    end = expandBoundary(end, normLen, 1);
    let contained = 0;
    for (const r of tokenRanges) if (r.start >= start && r.end <= end) contained++;
    const score = contained * 1000 - start;
    if (!best || score > best.score) best = { start, end, score };
  }
  return { start: best.start, end: best.end };
}

function expandBoundary(p, len, dir) {
  // Move to nearest whitespace boundary so we don't slice through a word.
  return p; // boundary expansion handled by caller via token ranges; kept hook
}

/**
 * Build snippet segments for output.
 *
 * @param {object} views from prepareViews
 * @param {Array} matches matched tokens on NORM view: {start,end,type}
 * @param {object} opts {radius}
 * @returns {segments: [{text,type,marked}], anchor:{rawStart,rawEnd},
 *           strippedStart, strippedEnd}
 */
export function buildSnippet(views, matches, opts = {}) {
  const radius = opts.radius ?? 36;
  const normLen = codePointLength(views.norm);
  const inWindow = matches
    .map((m) => ({ ...m }))
    .sort((a, b) => a.start - b.start);
  const win = chooseWindow(inWindow, normLen, radius);

  // Restrict highlights to inside window, merge overlaps (higher priority type
  // wins: error > api > field > text).
  const priority = { [HL.ERROR]: 3, [HL.API]: 2, [HL.FIELD]: 1, [HL.TEXT]: 0 };
  const ranges = inWindow
    .filter((m) => m.end > win.start && m.start < win.end)
    .map((m) => ({
      start: Math.max(m.start, win.start),
      end: Math.min(m.end, win.end),
      type: m.type || HL.TEXT,
    }))
    .sort((a, b) => a.start - b.start || priority[b.type] - priority[a.type]);

  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      if (priority[r.type] > priority[last.type]) last.type = r.type;
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }

  // Map window from norm -> stripped ONCE.
  const sw = normToStripped(views, win.start, win.end);
  // Map each highlight range norm -> stripped.
  const strippedMarks = merged.map((r) => {
    const s = normToStripped(views, r.start, r.end);
    return { start: s.start, end: s.end, type: r.type };
  });

  // Build segments on the STRIPPED view (output text), code-point slicing.
  const segments = [];
  let cursor = sw.start;
  const addSeg = (a, b, marked, type) => {
    if (b <= a) return;
    segments.push({ text: cpSlice(views.stripped, a, b), marked, type });
  };
  for (const m of strippedMarks) {
    const ms = Math.max(m.start, sw.start);
    const me = Math.min(m.end, sw.end);
    if (me <= ms) continue;
    addSeg(cursor, ms, false, null);
    addSeg(ms, me, true, m.type);
    cursor = Math.max(cursor, me);
  }
  addSeg(cursor, sw.end, false, null);

  // anchor: raw cp range for the window start -> first mark (chapter position)
  const rawWin = strippedToRaw(views, sw.start, sw.end);

  return {
    segments,
    html: renderSegments(segments),
    anchor: { rawStart: rawWin.start, rawEnd: rawWin.end },
    strippedStart: sw.start,
    strippedEnd: sw.end,
  };
}

/** Render segments to escaped HTML with typed <mark data-hl>. */
export function renderSegments(segments) {
  return segments
    .map((seg) => {
      const safe = escapeHtml(seg.text);
      if (!seg.marked) return safe;
      return `<mark class="hl-${seg.type}" data-hl="${seg.type}">${safe}</mark>`;
    })
    .join('');
}
