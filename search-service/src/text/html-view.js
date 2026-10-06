// html-view: turn raw section HTML/Markdown into plain text for indexing while
// producing an OffsetMap from stripped cp positions back to raw cp positions.
//
// Requirements served:
//  - "片段含 HTML": snippets must not highlight across a tag boundary and the
//    returned slice must be re-escaped safely (no raw <script> injected into
//    the page). Tags are removed, whitespace collapsed, basic entities decoded.
//  - Stripped offsets are mapped back; callers never index inside tags.

import { codePoints, cpSlice, codePointLength } from './codepoints.js';
import { mapFromEntries } from './offset-map.js';

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

/**
 * Scan raw text, classify spans entirely in CODE-POINT space.
 * Returns segments: {type:'text'|'tag'|'drop', start,end} in raw cp indices.
 *  - 'tag'  : a single markup tag (removed, no text)
 *  - 'drop' : script/style/head content or comments (removed entirely so its
 *             contents never enter the index nor a snippet)
 *  - 'text' : visible text
 */
export function scanSegments(raw) {
  const segments = [];
  const a = Array.from(raw); // code-point array
  const len = a.length;
  let i = 0;
  let textStart = 0;

  const flushText = (end) => {
    if (end > textStart) segments.push({ type: 'text', start: textStart, end });
  };
  const startsSeq = (idx, seq) => {
    if (idx + seq.length > len) return false;
    for (let k = 0; k < seq.length; k++) {
      if (a[idx + k] !== seq[k]) return false;
    }
    return true;
  };

  while (i < len) {
    if (a[i] === '<') {
      // comment: <!-- ... -->
      if (startsSeq(i, ['<', '!', '-', '-'])) {
        let e = i + 4;
        while (e < len && !startsSeq(e, ['-', '-', '>'])) e++;
        e = Math.min(len, e + 3);
        flushText(i);
        segments.push({ type: 'drop', start: i, end: e });
        i = e;
        textStart = i;
        continue;
      }
      // ordinary tag
      let j = i + 1;
      let isTag = false;
      if (j < len && /[a-zA-Z!/?]/.test(a[j])) {
        while (j < len && a[j] !== '>') {
          if (a[j] === '<') break;
          j++;
        }
        if (j < len && a[j] === '>') isTag = true;
      }
      if (isTag) {
        const tagEnd = j + 1;
        const nameMatch = a
          .slice(i + 1, j)
          .join('')
          .replace(/^[\/\s]+/, '')
          .match(/^[a-zA-Z0-9]+/);
        const name = nameMatch ? nameMatch[0].toLowerCase() : '';
        const isOpen = a[i + 1] !== '/';
        const rawElement = ['script', 'style', 'head', 'textarea', 'template'];
        if (isOpen && rawElement.includes(name)) {
          // locate </name ... > in code-point array
          let e = tagEnd;
          let found = -1;
          while (e < len) {
            if (
              a[e] === '<' &&
              a[e + 1] === '/' &&
              a
                .slice(e + 2, e + 2 + name.length)
                .join('')
                .toLowerCase() === name
            ) {
              let k = e + 2 + name.length;
              while (k < len && a[k] !== '>') k++;
              if (k < len) {
                found = k + 1;
                break;
              }
            }
            e++;
          }
          const blockEnd = found === -1 ? len : found;
          flushText(i);
          segments.push({ type: 'tag', start: i, end: tagEnd });
          if (blockEnd > tagEnd) segments.push({ type: 'drop', start: tagEnd, end: blockEnd });
          i = blockEnd;
          textStart = i;
          continue;
        }
        flushText(i);
        segments.push({ type: 'tag', start: i, end: tagEnd });
        i = tagEnd;
        textStart = i;
        continue;
      }
    }
    i++;
  }
  flushText(len);
  return segments;
}

function decodeEntities(text) {
  // Returns decoded string and, for each output cp, the input cp start it
  // originated from (entities contract to 1 cp; &#x... too).
  const chars = Array.from(text);
  const outCps = [];
  const outSrc = [];
  const outSrcEnd = [];
  let i = 0;
  const len = chars.length;
  while (i < len) {
    if (chars[i] === '&') {
      const semi = chars.indexOf(';', i);
      if (semi !== -1 && semi - i <= 12) {
        const body = chars.slice(i + 1, semi).join('');
        let decoded = null;
        if (body[0] === '#') {
          const hex = body[1] === 'x' || body[1] === 'X';
          const num = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
          if (!Number.isNaN(num) && num > 0) {
            try {
              decoded = String.fromCodePoint(num);
            } catch {
              decoded = null;
            }
          }
        } else if (NAMED_ENTITIES[body] != null) {
          decoded = NAMED_ENTITIES[body];
        }
        if (decoded != null) {
          for (const dc of Array.from(decoded)) {
            outCps.push(dc);
            outSrc.push(i);
            outSrcEnd.push(semi + 1);
          }
          i = semi + 1;
          continue;
        }
      }
    }
    outCps.push(chars[i]);
    outSrc.push(i);
    outSrcEnd.push(i + 1);
    i++;
  }
  return { text: outCps.join(''), src: outSrc, srcEnd: outSrcEnd };
}

/**
 * Produce the stripped plain-text view plus an OffsetMap (stripped cp -> raw cp).
 * Whitespace runs (incl. newlines) collapse to a single space.
 */
export function stripHtml(raw) {
  const segments = scanSegments(raw);
  const textParts = [];
  const boundaries = []; // {rawStart, rawEnd} per text segment in raw cp
  for (const seg of segments) {
    if (seg.type === 'text') {
      textParts.push(cpSlice(raw, seg.start, seg.end));
      boundaries.push(seg);
    }
  }
  const outCps = [];
  const outRawStart = [];
  const outRawEnd = [];

  let firstInView = true;
  let lastRealEnd = 0;
  for (let s = 0; s < textParts.length; s++) {
    const part = textParts[s];
    const seg = boundaries[s];
    const { text: decoded, src, srcEnd } = decodeEntities(part);
    const dchars = Array.from(decoded);
    let pendingSpace = false;
    let pendingStart = 0;
    for (let k = 0; k < dchars.length; k++) {
      const c = dchars[k];
      if (/\s/u.test(c)) {
        if (!pendingSpace) pendingStart = seg.start + src[k];
        pendingSpace = true;
        continue;
      }
      if (pendingSpace && !firstInView) {
        outCps.push(' ');
        // collapsed space spans the skipped whitespace up to this char start
        outRawStart.push(pendingStart);
        outRawEnd.push(seg.start + src[k]);
      }
      pendingSpace = false;
      outCps.push(c);
      outRawStart.push(seg.start + src[k]);
      outRawEnd.push(seg.start + srcEnd[k]);
      lastRealEnd = seg.start + srcEnd[k];
      firstInView = false;
    }
  }

  const stripped = outCps.join('');
  const rawLen = codePointLength(raw);
  const map = mapFromEntries(
    outRawStart.map((st) => ({ cp: 0, srcStart: st })),
    rawLen,
    outCps.length,
    lastRealEnd
  );
  return { text: stripped, map };
}

/**
 * Escape a raw-source slice for safe HTML rendering.
 * Used by snippet builder so any '<' from the ORIGINAL text is neutralized.
 */
export function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
