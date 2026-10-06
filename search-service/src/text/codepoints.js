// Code-point-safe string utilities.
//
// HARD RULE (see README "偏移正确性"):
//   Tokenizer offsets are always positions in *code points* of a specific
//   "view" (raw / stripped / normalized). They are NEVER used directly as
//   JavaScript UTF-16 indices or byte offsets. Conversion between views goes
//   through OffsetMap, and conversion to UTF-16 goes through codePointAt.

/** Iterate code points with their UTF-16 start index. */
export function* codePoints(str) {
  for (let i = 0; i < str.length; ) {
    const cp = str.codePointAt(i);
    yield { cp, start: i, end: i + (cp > 0xffff ? 2 : 1) };
    i += cp > 0xffff ? 2 : 1;
  }
}

export function codePointLength(str) {
  let n = 0;
  for (const _ of codePoints(str)) n++;
  return n;
}

/** Slice by code-point offsets [start, end). Safe around surrogate pairs. */
export function cpSlice(str, start, end = Infinity) {
  let s = Math.max(0, start);
  let e = end === Infinity ? Infinity : end;
  let idx = 0;
  let out = '';
  for (const { start: u16, end: u16end } of codePoints(str)) {
    if (idx >= s && idx < e) out += str.slice(u16, u16end);
    idx++;
    if (idx >= e) break;
  }
  return out;
}

/** Convert a code-point index into a UTF-16 index. */
export function cpToUtf16(str, cpIndex) {
  let idx = 0;
  for (const { start } of codePoints(str)) {
    if (idx === cpIndex) return start;
    idx++;
  }
  return str.length;
}

export function isWordCodePoint(cp) {
  // letters/digits (covers ASCII + Unicode letters/digits), underscore.
  if (cp === 0x5f) return true; // _
  const ch = String.fromCodePoint(cp);
  return /[\p{L}\p{N}]/u.test(ch);
}

export function isAsciiDigit(cp) {
  return cp >= 0x30 && cp <= 0x39;
}

export function isAsciiUpper(cp) {
  return cp >= 0x41 && cp <= 0x5a;
}

export function isAsciiLower(cp) {
  return cp >= 0x61 && cp <= 0x7a;
}

export function toLowerCp(str) {
  return Array.from(str).map((c) => c.toLowerCase()).join('');
}

export function sha1Short(str) {
  // FNV-1a 64-bit style short stable hash (deterministic; not crypto-grade).
  // Sufficient for content change detection in tests / in-memory store.
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  let i = 0;
  for (const c of str) {
    const code = c.codePointAt(0);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((code + i) >>> 0), 0x01000193) >>> 0;
    i++;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
}
