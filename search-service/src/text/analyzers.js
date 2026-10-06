// Analyzers turn a plain-text view into tokens. Every token carries its
// half-open range in *view code points*; ranges are converted to raw source
// positions only later via OffsetMap. We never reinterpret a token index as a
// raw character position.
//
// Two distinct rule sets (per requirement "代码标识符与自然语言可采用不同分析规则"):
//   - textAnalyzer : NFKC normalize + lowercase, split on non-word, emit CJK
//                    unigrams + bigrams so 中文检索 works without a dictionary.
//   - codeAnalyzer : keep identifiers case-sensitively AND their sub-parts
//                    (camelCase / snake_case / kebab), capture error codes like
//                    E4001 / ERR_TIMEOUT, and dotted field paths. A lowercase
//                    companion token is emitted for case-insensitive recall.

import { codePoints } from './codepoints.js';
import { mapFromTransform } from './offset-map.js';

const isWord = (cp) => {
  if (cp === 0x5f) return true;
  return /[\p{L}\p{N}]/u.test(String.fromCodePoint(cp));
};

const isCjk = (cp) =>
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x20000 && cp <= 0x2a6df);

function token(text, start, end, opts = {}) {
  return {
    term: text,
    start,
    end,
    position: start,
    ...opts,
  };
}

/* ------------------------------------------------------------------ */
/* Natural language analyzer                                           */
/* ------------------------------------------------------------------ */

/**
 * Normalize for matching: NFKC + lowercase, per code point, returning the
 * normalized view AND an OffsetMap back to the input view.
 */
export function normalizeView(view) {
  const map = mapFromTransform(view, (_cp, ch) => ch.normalize('NFKC').toLowerCase());
  // Rebuild normalized text by applying the same transform.
  let normalized = '';
  for (const { cp } of codePoints(view)) {
    normalized += String.fromCodePoint(cp).normalize('NFKC').toLowerCase();
  }
  return { text: normalized, map };
}

export function textAnalyze(view) {
  const { text: norm, map: normMap } = normalizeView(view);
  const chars = Array.from(norm);
  const tokens = [];

  const emitWord = (ws, we) => {
    const raw = chars.slice(ws, we).join('');
    // detect CJK
    const cps = Array.from(raw);
    let cjkRun = -1;
    let ci = 0;
    // Split mixed runs: we process code points of raw.
    const arr = Array.from(raw);
    let i = 0;
    while (i < arr.length) {
      const cp = arr[i].codePointAt(0);
      if (isCjk(cp)) {
        let j = i;
        const runStartCp = ws + i;
        const runChars = [];
        while (j < arr.length && isCjk(arr[j].codePointAt(0))) {
          runChars.push(arr[j]);
          j++;
        }
        // unigrams
        for (let k = 0; k < runChars.length; k++) {
          tokens.push(token(runChars[k], runStartCp + k, runStartCp + k + 1, { kind: 'cjk' }));
        }
        // bigrams
        for (let k = 0; k + 1 < runChars.length; k++) {
          tokens.push(
            token(runChars[k] + runChars[k + 1], runStartCp + k, runStartCp + k + 2, {
              kind: 'cjk_bigram',
            })
          );
        }
        i = j;
      } else {
        // latin/digit word token (already lowercased/normalized)
        let j = i;
        const localStart = ws + i;
        while (
          j < arr.length &&
          !isCjk(arr[j].codePointAt(0)) &&
          isWord(arr[j].codePointAt(0))
        ) {
          j++;
        }
        if (j > i) {
          tokens.push(token(arr.slice(i, j).join(''), localStart, ws + j, { kind: 'word' }));
        }
        i = j === i ? i + 1 : j;
      }
    }
  };

  let start = 0;
  let inWord = false;
  for (let i = 0; i <= chars.length; i++) {
    const cp = i < chars.length ? chars[i].codePointAt(0) : -1;
    const w = cp !== -1 && isWord(cp);
    if (w && !inWord) {
      start = i;
      inWord = true;
    } else if (!w && inWord) {
      emitWord(start, i);
      inWord = false;
    }
  }

  return { tokens, normMap };
}

/* ------------------------------------------------------------------ */
/* Code identifier analyzer                                            */
/* ------------------------------------------------------------------ */

// Error codes: E1234, ERR_FOO, HTTP_404, 404-style standalone digits handled
// separately via captureErrorCode.
const ERROR_CODE_PATTERNS = [
  /^[EW]\d{3,5}$/,
  /^ERR[_-]?.+$/,
  /^ERROR[_-]?.+$/,
  /^(HTTP|STATUS)[_-]\d{3}$/,
  /^\d{3,4}$/,
];

export function isErrorCodeTerm(term) {
  return ERROR_CODE_PATTERNS.some((re) => re.test(term));
}

function splitIdentifier(ident) {
  // snake / kebab parts, then camel parts.
  const parts = [];
  const rough = ident.split(/[_-]/).filter(Boolean);
  for (const part of rough) {
    // camelCase / digit boundaries, no dropped leading letter:
    // getUserIDCard -> get, User, ID, Card ; E4001 -> E, 4001
    const m = part.match(/[A-Z]+(?=[A-Z][a-z]|\d|$)|[A-Z]?[a-z]+|\d+/g);
    if (m) parts.push(...m);
    else parts.push(part);
  }
  return parts;
}

// A plausible ASCII-ish code token: contains an ASCII letter/digit and is not
// pure CJK (natural language goes through the text analyzer instead).
const looksLikeCode = (term) =>
  /[A-Za-z0-9]/.test(term) && Array.from(term).some((c) => !isCjk(c.codePointAt(0)));

/**
 * Analyze source code-ish text. Keeps full identifier spans and emits subparts.
 * Tokens are tagged kind: 'ident' | 'part' | 'errcode' | 'number' | 'path'.
 */
export function codeAnalyze(view) {
  const chars = Array.from(view);
  const tokens = [];
  const isIdentChar = (c) => /[\p{L}\p{N}_$-]/u.test(c);

  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    // Identifier must START with a letter/digit/underscore (not '-', '.').
    if (!/[\p{L}\p{N}_$]/u.test(c)) {
      i++;
      continue;
    }
    let j = i;
    let dashOk = true;
    let dotOk = true;
    while (j < chars.length) {
      const cc = chars[j];
      if (/[\p{L}\p{N}_$]/u.test(cc)) {
        j++;
        dashOk = true;
        dotOk = true;
      } else if (
        cc === '-' &&
        dashOk &&
        j + 1 < chars.length &&
        /[\p{L}\p{N}_$]/u.test(chars[j + 1])
      ) {
        j++;
        dashOk = false;
      } else if (
        cc === '.' &&
        dotOk &&
        j + 1 < chars.length &&
        /[\p{L}\p{N}_$]/u.test(chars[j + 1])
      ) {
        j++;
        dotOk = false;
      } else break;
    }
    const full = chars.slice(i, j).join('');
    const isPath = full.includes('.');
    const fullKind = isErrorCodeTerm(full.replace(/\./g, '_'))
      ? 'errcode'
      : isPath
        ? 'path'
        : 'ident';
    tokens.push(token(full, i, j, { kind: fullKind }));
    // case-insensitive companion
    const lower = full.toLowerCase();
    if (lower !== full) tokens.push(token(lower, i, j, { kind: 'ident_lc', shadow: true }));

    // subparts with code-point-safe local offsets
    if (!isPath) {
      const parts = splitIdentifier(full);
      const fullArr = Array.from(full);
      let searchFrom = 0;
      for (const p of parts) {
        const pArr = Array.from(p);
        let found = -1;
        for (let k = searchFrom; k + pArr.length <= fullArr.length; k++) {
          let match = true;
          for (let m = 0; m < pArr.length; m++) {
            if (fullArr[k + m] !== pArr[m]) {
              match = false;
              break;
            }
          }
          if (match) {
            found = k;
            break;
          }
        }
        const ps = i + (found === -1 ? searchFrom : found);
        const pe = ps + pArr.length;
        // A lone single-letter/single-digit sub-part (e.g. the "E" in E4001)
        // is too noisy to index as a recall token; the FULL identifier and the
        // meaningful multi-char parts remain searchable.
        if (pArr.length < 2 && fullArr.length > 1) {
          if (found !== -1) searchFrom = found + pArr.length;
          continue;
        }
        const kind = isErrorCodeTerm(p) ? 'errcode' : 'part';
        tokens.push(token(p, ps, pe, { kind }));
        const lcp = p.toLowerCase();
        if (lcp !== p) tokens.push(token(lcp, ps, pe, { kind: 'part_lc', shadow: true }));
        if (found !== -1) searchFrom = found + pArr.length;
      }
    }
    i = j;
  }
  return { tokens, normMap: null };
}

/**
 * Parse a user query string into structured terms using BOTH analyzers.
 * Returns terms with flags hinting whether they look like error codes /
 * identifiers, used for field & error-code boosting.
 */
export function parseQuery(query) {
  const text = textAnalyze(query);
  const code = codeAnalyze(query);
  const terms = new Map();
  const add = (t, origin) => {
    const key = origin === 'code' ? `c:${t.term.toLowerCase()}` : `t:${t.term}`;
    if (!terms.has(key)) {
      terms.set(key, {
        term: t.term.toLowerCase(),
        rawTerm: t.term,
        origin,
        isCode: origin === 'code',
        isErrorCode: origin === 'code' && (t.kind === 'errcode' || isErrorCodeTerm(t.term)),
        isIdent: origin === 'code' && (t.kind === 'ident' || t.kind === 'path' || t.kind === 'part'),
      });
    }
  };
  for (const t of text.tokens) add(t, 'text');
  for (const t of code.tokens) {
    // Skip shadow companions and don't treat CJK natural words as code.
    if (t.shadow) continue;
    if (!looksLikeCode(t.term)) continue;
    add(t, 'code');
  }
  return [...terms.values()];
}
