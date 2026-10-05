const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”'
}

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul'
])
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template'])

function decodeEntity(entity) {
  if (entity[1] === '#') {
    const hex = entity[2] === 'x' || entity[2] === 'X'
    const code = Number.parseInt(entity.slice(hex ? 3 : 2), hex ? 16 : 10)
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return entity
    try {
      return String.fromCodePoint(code)
    } catch {
      return entity
    }
  }
  return NAMED_ENTITIES[entity.slice(1, -1).toLowerCase()] ?? entity
}

/**
 * Convert the indexed/snippet presentation of HTML to safe plain text.
 * Markup, attribute names and values are intentionally discarded, so a query
 * cannot match hidden HTML. The output map contains UTF-16 code-unit offsets
 * into the input; all later token offsets are translated through this map.
 *
 * @param {string} html
 */
export function htmlToText(html) {
  let text = ''
  const map = []
  const tagStack = []
  let lastUnit = 0
  let lastPoint = 0

  function pointOffset(unitOffset) {
    if (unitOffset < lastUnit) {
      lastUnit = 0
      lastPoint = 0
    }
    if (unitOffset > lastUnit) {
      lastPoint += Array.from(html.slice(lastUnit, unitOffset)).length
      lastUnit = unitOffset
    }
    return lastPoint
  }

  function emit(value, sourceStart) {
    // Both output indexes and source offsets are Unicode code points so the
    // browser can split highlight ranges without cutting surrogate pairs.
    const valuePointOffset = pointOffset(sourceStart)
    const chars = Array.from(value)
    for (let i = 0; i < chars.length; i += 1) {
      text += chars[i]
      map.push(valuePointOffset + i)
    }
    if (chars.length) {
      lastUnit = sourceStart + value.length
      lastPoint = valuePointOffset + chars.length
    }
  }

  for (let i = 0; i < html.length;) {
    if (html[i] === '<') {
      const close = html.indexOf('>', i + 1)
      if (close === -1) {
        // Treat malformed trailing '<' as literal text rather than hiding it.
        emit('<', i)
        i += 1
        continue
      }

      const rawTag = html.slice(i + 1, close)
      const isClosing = rawTag.startsWith('/')
      const name = rawTag.replace(/^\/?/, '').split(/[\s/>]/, 1)[0]?.toLowerCase() ?? ''
      if (SKIP_TAGS.has(name)) {
        if (!isClosing) {
          const end = html.search(new RegExp(`</${name}\\s*>`, 'i'))
          const next = end === -1 || end < i ? html.length : end
          tagStack.length = 0
          i = next === html.length ? next : next + name.length + 3
          continue
        }
        i = close + 1
        continue
      }

      if (!isClosing && BLOCK_TAGS.has(name) && text.length > 0 && !text.endsWith('\n')) {
        text += '\n'
        // Newline is presentation-only and has no source character.
        map.push(-1)
      }
      if (!rawTag.endsWith('/')) {
        if (isClosing) tagStack.pop()
        else if (name) tagStack.push(name)
      }
      i = close + 1
      continue
    }

    const nextTag = html.indexOf('<', i + 1)
    const raw = html.slice(i, nextTag === -1 ? undefined : nextTag)
    let cursor = i
    const entityPattern = /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi
    let match
    let last = 0
    while ((match = entityPattern.exec(raw))) {
      if (match.index > last) emit(raw.slice(last, match.index), cursor + last)
      emit(decodeEntity(match[0]), cursor + match.index)
      last = match.index + match[0].length
    }
    if (last < raw.length) emit(raw.slice(last), cursor + last)
    i = nextTag === -1 ? html.length : nextTag
  }

  // Presentation whitespace is normalized without changing source maps.
  const normalizedText = text.replace(/[ \t\r\f]+/g, ' ').replace(/\n\s*/g, '\n').trim()
  const unitPrefix = text.indexOf(normalizedText)
  // trim plus the deterministic replacements above means prefix is exact.
  const start = unitPrefix === -1 ? 0 : Array.from(text.slice(0, unitPrefix)).length
  const normalizedChars = Array.from(normalizedText)
  const sourceMap = normalizedChars.map((_, idx) => map[start + idx] ?? -1)
  return { text: normalizedText, map: sourceMap }
}

/**
 * Unicode-aware lowercase + NFKC normalization. The returned map uses code
 * point offsets in both normalized and original strings. Expanded normalization
 * maps extra destination characters back to their originating code point.
 *
 * @param {string} input
 */
export function normalizeForSearch(input) {
  let text = ''
  const map = []
  const sourceChars = Array.from(input)
  let sourcePointOffset = 0
  for (const ch of sourceChars) {
    const normalized = ch.normalize('NFKC').toLowerCase()
    const parts = Array.from(normalized)
    for (let i = 0; i < parts.length; i += 1) {
      text += parts[i]
      map.push(sourcePointOffset)
    }
    sourcePointOffset += 1
  }
  return { text, map }
}

function isCJK(ch) {
  const cp = ch.codePointAt(0)
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0xf900 && cp <= 0xfaff)
  )
}

function isLatinWord(ch) {
  return /[\p{L}\p{N}]/u.test(ch) && !isCJK(ch)
}

/**
 * Natural-language analyzer. Latin words remain whole terms; CJK runs use
 * overlapping bigrams, the same rule in indexing and querying.
 */
export function analyzeNatural(input) {
  const { text, map: normMap } = normalizeForSearch(input)
  const tokens = []
  const chars = Array.from(text)
  let run = []

  function flushCJK() {
    if (run.length === 1) {
      const start = normMap[run[0].index]
      tokens.push({ term: run[0].ch, start, end: start + 1 })
    } else {
      for (let i = 0; i < run.length - 1; i += 1) {
        const first = run[i]
        const second = run[i + 1]
        const start = normMap[first.index]
        tokens.push({ term: first.ch + second.ch, start, end: normMap[second.index] + 1 })
      }
    }
    run = []
  }

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]
    if (isCJK(ch)) {
      run.push({ ch, index: i })
      continue
    }
    flushCJK()
    if (isLatinWord(ch)) {
      let j = i
      let term = ''
      while (j < chars.length && isLatinWord(chars[j])) {
        term += chars[j]
        j += 1
      }
      const start = normMap[i]
      // Find the original code point after all expanded destination chars.
      let endUnit = j
      while (endUnit < normMap.length && normMap[endUnit] === start) endUnit += 1
      const end = endUnit < normMap.length ? normMap[endUnit] : Array.from(input).length
      tokens.push({ term, start, end })
      i = j - 1
    }
  }
  flushCJK()
  return tokens
}

function splitIdentifier(raw) {
  // camelCase / PascalCase / kebab-case / snake_case, preserving digit runs.
  const words = []
  for (const match of raw.matchAll(/[^\p{Z}\p{P}\s.]+/gu)) {
    const word = match[0]
    const base = match.index
    const boundaries = [0]
    for (let i = 1; i < word.length; i += 1) {
      const prev = word[i - 1]
      const cur = word[i]
      const next = word[i + 1] ?? ''
      if (/[a-z]/.test(prev) && /[A-Z]/.test(cur)) boundaries.push(i)
      else if (/[A-Z]/.test(prev) && /[A-Z]/.test(cur) && /[a-z]/.test(next)) boundaries.push(i)
      else if (/\d/.test(prev) !== /\d/.test(cur) && /[A-Za-z]/.test(prev + cur)) boundaries.push(i)
    }
    boundaries.push(word.length)
    for (let i = 0; i < boundaries.length - 1; i += 1) {
      words.push({ value: word.slice(boundaries[i], boundaries[i + 1]), offset: base + boundaries[i] })
    }
  }
  return words
}

/**
 * Code analyzer. It keeps whole identifiers and also emits their case parts.
 * Example: getUserProfile => getuserprofile, get, user, profile.
 */
export function analyzeCode(input) {
  const tokens = []
  const seen = new Set()

  for (const match of input.matchAll(/[\p{L}\p{N}_$-]+/gu)) {
    const raw = match[0]
    const start = Array.from(input.slice(0, match.index)).length
    const variants = [
      { value: raw, offset: 0 },
      ...splitIdentifier(raw)
    ]
    for (const variant of variants) {
      const term = normalizeForSearch(variant.value).text
      const variantStart = start + Array.from(raw.slice(0, variant.offset)).length
      const length = Array.from(variant.value).length
      if (!term || seen.has(term + '@' + variantStart)) continue
      seen.add(term + '@' + variantStart)
      tokens.push({ term, start: variantStart, end: variantStart + length })
    }
  }
  return tokens
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
