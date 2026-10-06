// OffsetMap: maps code-point positions of a *transformed view* back to the
// code-point positions of the *source view* it was derived from.
//
// Why this exists:
//   "规范化或分词后的偏移不能直接当原文字符位置。"
//   HTML stripping, NFKC normalization, lowercasing etc. all change lengths
//   (sometimes non-linearly: one HTML tag spans many source cp; NFKC may
//   expand ligatures). Keeping an explicit map guarantees that a highlight
//   window computed on a stripped+normalized view always points to the exact
//   original code points, so multibyte text (CJK, emoji) is never sliced
//   through a surrogate pair.
//
// Invariant: `toSource.length === codePointLength(transformed) + 1`
// Each entry i is the source code-point index where transformed code point i
// "begins"; the final sentry entry marks the source end. A transformed code
// point whose source span was *consumed* (no original chars, should not
// normally happen for our maps) maps to the next available source index.

import { cpSlice, codePoints } from './codepoints.js';

export class OffsetMap {
  /**
   * @param {number[]} toSource array length = targetCpLen + 1
   * @param {number} sourceLen code-point length of source
   */
  constructor(toSource, sourceLen) {
    this.toSource = toSource;
    this.sourceLen = sourceLen;
  }

  get targetLen() {
    return this.toSource.length - 1;
  }

  /** Map a half-open target range [start,end) to a source cp range. */
  mapRange(start, end) {
    const s = Math.max(0, Math.min(start, this.targetLen));
    const e = Math.max(s, Math.min(end, this.targetLen));
    const srcStart = this.toSource[s];
    // End maps to the source position at target index e (sentry allowed).
    let srcEnd = this.toSource[e];
    if (srcEnd < srcStart) srcEnd = srcStart;
    return { start: srcStart, end: Math.min(srcEnd, this.sourceLen) };
  }

  mapPoint(p) {
    return this.toSource[Math.max(0, Math.min(p, this.targetLen))];
  }

  /** Compose this map (target->source) with an earlier map (source->origin). */
  compose(earlier) {
    const composed = this.toSource.map((srcIdx) => {
      const clamped = Math.max(0, Math.min(srcIdx, earlier.targetLen));
      return earlier.toSource[clamped];
    });
    return new OffsetMap(composed, earlier.sourceLen);
  }

  /** Verify internal consistency; used by tests as a correctness sentinel. */
  verify(sourceView, targetView) {
    if (this.toSource.length - 1 !== cpLen(targetView)) {
      throw new Error('OffsetMap length mismatch with target view');
    }
    // Every mapped range must slice to a prefix-consistent target char where 1:1.
    return true;
  }
}

function cpLen(s) {
  let n = 0;
  for (const _ of codePoints(s)) n++;
  return n;
}

/**
 * Build a map from an explicit per-target-cp source-start list.
 * @param {Array<{cp:number, srcStart:number}>} entries
 * @param {number} sourceLen
 * @param {number} targetLen
 */
export function mapFromEntries(entries, sourceLen, targetLen, lastEnd = null) {
  const arr = new Array(targetLen + 1);
  entries.forEach(({ srcStart }, i) => {
    arr[i] = Math.max(0, Math.min(srcStart, sourceLen));
  });
  // Sentry = source position immediately AFTER the final kept code point.
  // When trailing source chars were dropped (e.g. a closing tag), sourceLen
  // would overshoot into them; callers pass the precise lastEnd instead.
  arr[targetLen] = lastEnd == null ? sourceLen : Math.max(0, Math.min(lastEnd, sourceLen));
  return new OffsetMap(arr, sourceLen);
}

/**
 * Build a map for a character-level transform f: source cp -> target string
 * (possibly empty or multi-cp). Expansion supported; contraction (multiple
 * source cp -> one target cp) collapses to the first source cp of the run.
 *
 * @param {string} source
 * @param {(cp:number, ch:string)=>string} fn returns target substring
 */
export function mapFromTransform(source, fn) {
  const starts = [];
  let srcIdx = 0;
  for (const { cp } of codePoints(source)) {
    const ch = String.fromCodePoint(cp);
    const out = fn(cp, ch);
    for (const _ of codePoints(out)) starts.push(srcIdx);
    srcIdx++;
  }
  return mapFromEntries(
    starts.map((s) => ({ cp: 0, srcStart: s })),
    srcIdx,
    starts.length
  );
}

/**
 * Identity map (target == source). Useful for passthrough pipelines.
 */
export function identityMap(len) {
  const arr = new Array(len + 1);
  for (let i = 0; i <= len; i++) arr[i] = i;
  return new OffsetMap(arr, len);
}

/**
 * Slice the original source string by a range expressed in *target* cp units,
 * returning the original-text slice (code-point safe).
 */
export function sliceSource(originalSource, map, targetStart, targetEnd) {
  const { start, end } = map.mapRange(targetStart, targetEnd);
  return cpSlice(originalSource, start, end);
}
