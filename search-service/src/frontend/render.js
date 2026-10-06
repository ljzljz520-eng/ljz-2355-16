// Browser-safe snippet renderer.
//
// The server returns BOTH:
//   - segments : [{text, marked, type}]  (preferred: already HTML-escaped on
//                 the server because text comes from the STRIPPED view)
//   - html     : pre-rendered string (convenient, but must only be inserted via
//                 an explicit, reviewed innerHTML sink)
//
// For defense in depth the default UI path builds DOM nodes from `segments`
// using textContent, so even a malformed/forged snippet containing markup can
// never execute. The mark color encodes highlight kind:
//   field=蓝, api=绿, error=红, text=黄.

export const HL_CLASS = {
  field: 'search-hl-field',
  api: 'search-hl-api',
  error: 'search-hl-error',
  text: 'search-hl-text',
};

/** Create a DocumentFragment from segments without HTML parsing. */
export function renderSegmentsToFragment(segments, doc = globalThis.document) {
  const frag = doc.createDocumentFragment();
  for (const seg of segments) {
    let node;
    if (seg.marked) {
      node = doc.createElement('mark');
      node.className = HL_CLASS[seg.type] || HL_CLASS.text;
      node.dataset.hl = seg.type || 'text';
      node.textContent = seg.text; // textContent => never interpreted as HTML
    } else {
      node = doc.createTextNode(seg.text);
    }
    frag.appendChild(node);
  }
  return frag;
}

/**
 * Pure helper (also usable in non-DOM tests): produce a safe HTML string from
 * segments by escaping text. Mirrors the server-side escape guarantee.
 */
export function renderSegmentsToHtml(segments) {
  return segments
    .map((seg) => {
      const safe = escapeText(seg.text);
      if (!seg.marked) return safe;
      const cls = HL_CLASS[seg.type] || HL_CLASS.text;
      return `<mark class="${cls}" data-hl="${seg.type || 'text'}">${safe}</mark>`;
    })
    .join('');
}

export function escapeText(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Distinguish a CURRENT result from a HISTORICAL one and produce the badge
 * label the UI shows (点击后定位其对应章节版本).
 */
export function versionBadge(result) {
  if (result.isCurrent) return { kind: 'current', label: `当前版 ${result.version}` };
  return { kind: 'historical', label: `历史版 ${result.version}` };
}
