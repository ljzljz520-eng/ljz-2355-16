import path from 'node:path'
import { analyzeCode, analyzeNatural } from './text.js'
import { GenerationIndex, FIELD_WEIGHTS, contentHash, aclHash } from './index-engine.js'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50
const SEARCHABLE_FIELDS = new Set(['title', 'apiName', 'errorCode', 'body'])

export class SearchError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

function toBase64Url(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function fromBase64Url(value) {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw new SearchError(400, 'INVALID_CURSOR', '搜索游标格式无效')
  }
}

function uniqueTerms(values) {
  return [...new Set(values.filter(Boolean))]
}

export function parseQuery(query) {
  return String(query ?? '').trim().split(/\s+/u).filter(Boolean).map((segment) => {
    const natural = analyzeNatural(segment).map((token) => token.term)
    const code = analyzeCode(segment).map((token) => token.term)
    return { segment, terms: uniqueTerms([...natural, ...code]) }
  })
}

function mergeRanges(ranges) {
  const sorted = ranges
    .map(([start, end]) => [start, end])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const result = []
  for (const range of sorted) {
    const last = result[result.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else result.push(range)
  }
  return result.map(([start, end]) => ({ start, end }))
}

function buildSnippet(text, ranges, radius = 42) {
  if (!ranges.length) return null
  const first = ranges[0]
  const chars = Array.from(text)
  let start = Math.max(0, first.start - radius)
  let end = Math.min(chars.length, first.end + radius)
  if (start > 0) {
    while (start > first.start - radius && /\s/.test(chars[start - 1] ?? '')) start -= 1
    while (start > 0 && !/[\s,.;:!?。，；：！？]/.test(chars[start - 1] ?? '')) start -= 1
  }
  if (end < chars.length) {
    while (end < chars.length && !/[\s,.;:!?。，；：！？]/.test(chars[end] ?? '')) end += 1
  }
  const highlights = ranges
    .filter((range) => range.end > start && range.start < end)
    .map((range) => ({ start: Math.max(range.start, start) - start, end: Math.min(range.end, end) - start }))
  return {
    text: chars.slice(start, end).join(''),
    start,
    end,
    highlights: mergeRanges(highlights.map((range) => [range.start, range.end]))
  }
}

export class SearchService {
  constructor(store, rootDir) {
    this.store = store
    this.rootDir = rootDir
    this.indexCache = new Map()
  }

  async loadGeneration(generationRow) {
    if (!generationRow) return null
    const file = path.join(this.rootDir, 'generations', generationRow.generation_id, 'index.json')
    if (this.indexCache.has(generationRow.generation_id)) return this.indexCache.get(generationRow.generation_id)
    try {
      const index = await GenerationIndex.open(file)
      this.indexCache.set(generationRow.generation_id, index)
      return index
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new SearchError(410, 'GENERATION_UNAVAILABLE', '该索引代次已不可用')
      }
      throw error
    }
  }

  /**
   * Rebuild the active generation when indexed ACL snapshots are stale. Search
   * already filters authoritatively at query time; this second step removes
   * stale postings from the active physical index in the background.
   */
  async refreshStaleAcl(version, builder) {
    const activeRow = this.store.getActiveGeneration(version)
    if (!activeRow) return { refreshed: false, reason: 'NO_ACTIVE_GENERATION' }
    const index = await this.loadGeneration(activeRow)
    const now = new Date().toISOString()
    let stale = false
    for (const doc of Object.values(index.data.documents)) {
      const section = this.store.getSection(doc.version, doc.docId, doc.sectionId)
      if (!section || section.status !== 'published') {
        stale = true
        break
      }
      const indexed = aclHash(
        { status: 'published', is_public: doc.isPublic ? 1 : 0 },
        doc.allowed ?? [],
        doc.denied ?? []
      )
      const current = aclHash(
        section,
        this.store.principals(section, 'allow', now),
        this.store.principals(section, 'deny', now)
      )
      if (indexed !== current) {
        stale = true
        break
      }
    }
    if (!stale) return { refreshed: false, generationId: activeRow.generation_id }
    const generationId = await builder.buildOrResume(version)
    await builder.finalize(generationId)
    this.indexCache.delete(generationId)
    return { refreshed: true, generationId }
  }

  async search(rawQuery, auth, options = {}) {
    const query = String(rawQuery ?? '').trim()
    if (!query) throw new SearchError(400, 'EMPTY_QUERY', '搜索关键词不能为空')
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(options.limit ?? DEFAULT_LIMIT)))
    const requestedFields = String(options.fields ?? 'title,apiName,errorCode,body')
      .split(',').map((field) => field.trim()).filter(Boolean)
    const fields = requestedFields.length ? requestedFields : [...SEARCHABLE_FIELDS]
    for (const field of fields) {
      if (!SEARCHABLE_FIELDS.has(field)) throw new SearchError(400, 'UNSUPPORTED_FIELD', `不支持的字段：${field}`)
    }

    let cursor = null
    if (options.cursor) {
      cursor = fromBase64Url(options.cursor)
      if (!cursor?.generationId || !cursor.version || !cursor.query) {
        throw new SearchError(400, 'INVALID_CURSOR', '搜索游标内容不完整')
      }
      if (cursor.query !== query) throw new SearchError(410, 'STALE_CURSOR', '搜索条件已变化，请从第一页重新查询')
    }

    const version = options.version || cursor?.version
    if (!version) throw new SearchError(400, 'MISSING_VERSION', '必须指定文档版本')

    let generationRow
    let historicalCursor = false
    let buildingGenerationId = null
    if (cursor) {
      generationRow = this.store.getGeneration(cursor.generationId)
      if (!generationRow || generationRow.doc_version !== version || !['ready', 'stale'].includes(generationRow.status)) {
        throw new SearchError(410, 'STALE_CURSOR',('旧游标对应的索引已清除，请重新搜索'))
      }
      const active = this.store.getActiveGeneration(version)
      historicalCursor = !active || active.generation_id !== cursor.generationId
    } else if (options.generationId) {
      generationRow = this.store.getGeneration(options.generationId)
      if (!generationRow || generationRow.doc_version !== version || !['ready', 'stale'].includes(generationRow.status)) {
        throw new SearchError(404, 'GENERATION_NOT_FOUND', '指定的索引代次不存在或尚未发布')
      }
    } else {
      const building = this.store.findResumableGeneration(version)
      buildingGenerationId = building?.generation_id ?? null
      generationRow = this.store.getActiveGeneration(version)
      if (!generationRow) {
        // A building generation is never reported as zero matches.
        throw new SearchError(503, 'INDEX_NOT_READY', '该版本索引尚未发布完成', {
          building: Boolean(building)
        })
      }
    }

    const index = await this.loadGeneration(generationRow)
    const groups = parseQuery(query)
    const candidates = new Map()

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      let matchedAny = false
      for (const term of groups[groupIndex].terms) {
        for (const field of fields) {
          const entries = index.data.postings[term]?.[field]
          if (!entries) continue
          for (const entry of entries) {
            const doc = index.data.documents[entry.key]
            if (!doc) continue
            // The relational store is authoritative. Index ACL is still kept in
            // shards so postings can be physically narrowed by background refresh;
            // a temporary grant restore must not require waiting for that refresh.
            if (!candidates.has(entry.key)) candidates.set(entry.key, { doc, groups: new Map() })
            const candidate = candidates.get(entry.key)
            if (!candidate.groups.has(groupIndex)) candidate.groups.set(groupIndex, [])
            candidate.groups.get(groupIndex).push({ field, ranges: entry.ranges })
            matchedAny = true
          }
        }
      }
      if (!matchedAny) {
        return this.emptyResult({
          version,
          generationRow,
          historicalCursor,
          cursorStale: false,
          buildingGenerationId
        })
      }
    }

    const now = new Date().toISOString()
    const scored = []
    const aclMismatches = []
    for (const candidate of candidates.values()) {
      if (candidate.groups.size !== groups.length) continue
      const { doc } = candidate
      const section = this.store.getSection(doc.version, doc.docId, doc.sectionId)
      // Query-time authority check: publication status, latest ACL and temporary denies.
      const principals = new Set([auth?.userId, ...(auth?.groups ?? [])].filter(Boolean))
      const indexAllowed = doc.isPublic
        || principalIntersects(doc.allowed, auth)
      const indexDenied = (doc.denied ?? []).some((principal) => principals.has(principal))
      if (!section || section.status !== 'published') continue
      const queryAllowed = this.store.isAllowed(section, auth, now)
      const effectiveIndexAllowed = indexAllowed && !indexDenied
      if (effectiveIndexAllowed !== queryAllowed) {
        aclMismatches.push({ key: doc.key, indexAllowed: effectiveIndexAllowed, queryAllowed })
      }
      if (!queryAllowed) continue
      const currentHash = contentHash(section)
      if (doc.contentHash && doc.contentHash !== currentHash) continue

      const highlights = {}
      let score = 0
      for (const [, matches] of candidate.groups) {
        for (const match of matches) {
          if (!highlights[match.field]) highlights[match.field] = []
          highlights[match.field].push(...match.ranges)
          score += (FIELD_WEIGHTS[match.field] ?? 1) * match.ranges.length
        }
      }
      for (const field of Object.keys(highlights)) {
        highlights[field] = mergeRanges(highlights[field])
      }
      score += candidate.doc.ordinal === 0 ? 0 : 0.001 / (candidate.doc.ordinal + 1)
      scored.push({ doc, section, score, highlights, indexAllowed: effectiveIndexAllowed, queryAllowed })
    }

    scored.sort((a, b) => b.score - a.score || a.doc.key.localeCompare(b.doc.key))
    const startIndex = cursor
      ? 1 + scored.findIndex((item) => item.doc.key === cursor.afterKey && item.score === cursor.afterScore)
      : 0
    if (cursor && startIndex === 0) {
      // Existing cursor page boundary is gone after revocation/cleanup.
      throw new SearchError(410, 'STALE_CURSOR', '旧游标位置已失效，请重新搜索')
    }
    const page = scored.slice(startIndex, startIndex + limit)
    const next = page.length === limit && startIndex + limit < scored.length
      ? {
          generationId: generationRow.generation_id,
          version,
          query,
          afterScore: page[page.length - 1].score,
          afterKey: page[page.length - 1].doc.key
        }
      : null

    return {
      hits: page.map((item) => this.toHit(item, generationRow)),
      page: { next: next ? toBase64Url(next) : null, hasMore: Boolean(next) },
      meta: {
        version,
        generationId: generationRow.generation_id,
        generationStatus: generationRow.status,
        isCurrent: !historicalCursor && this.store.isCurrentVersion(version),
        totalCandidates: scored.length,
        aclMismatches,
        ...(buildingGenerationId ? { buildingGenerationId } : {}),
        ...(historicalCursor ? { cursorStale: true } : {})
      }
    }
  }

  emptyResult({ version, generationRow, historicalCursor, buildingGenerationId = null }) {
    return {
      hits: [],
      page: { next: null, hasMore: false },
      meta: {
        version,
        generationId: generationRow.generation_id,
        generationStatus: generationRow.status,
        isCurrent: !historicalCursor && this.store.isCurrentVersion(version),
        totalCandidates: 0,
        aclMismatches: [],
        ...(buildingGenerationId ? { buildingGenerationId } : {}),
        ...(historicalCursor ? { cursorStale: true } : {})
      }
    }
  }

  toHit(item, generationRow) {
    const { doc, highlights } = item
    let snippet = null
    const fieldOrder = ['errorCode', 'apiName', 'title', 'body']
    const snippetField = fieldOrder.find((field) => highlights[field]?.length)
    if (snippetField) {
      const text = doc[snippetField]
      if (snippetField === 'body') {
        snippet = buildSnippet(text, highlights.body)
      } else {
        snippet = { text, start: 0, end: Array.from(text).length, highlights: highlights[snippetField] }
      }
      if (snippet) snippet.field = snippetField
    }

    return {
      docId: doc.docId,
      version: doc.version,
      sectionId: doc.sectionId,
      versionState: doc.isCurrent ? 'current' : 'historical',
      title: doc.title,
      apiName: doc.apiName,
      errorCode: doc.errorCode,
      url: doc.url,
      score: item.score,
      acl: { indexed: item.indexAllowed, queried: item.queryAllowed },
      generation: {
        id: generationRow.generation_id,
        publishedAt: generationRow.published_at ?? generationRow.finalized_at ?? null
      },
      highlights,
      fields: {
        title: doc.title,
        apiName: doc.apiName,
        errorCode: doc.errorCode
      },
      snippet
    }
  }
}

function principalIntersects(allowed, auth) {
  const principals = new Set([auth?.userId, ...(auth?.groups ?? [])].filter(Boolean))
  return (allowed ?? []).some((principal) => principals.has(principal))
}
