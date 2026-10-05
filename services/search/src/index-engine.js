import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { analyzeCode, analyzeNatural, htmlToText } from './text.js'

export const FIELD_WEIGHTS = {
  errorCode: 10,
  apiName: 8,
  title: 6,
  body: 1
}
const FIELDS = ['title', 'apiName', 'errorCode', 'body']

export function stableHash(input) {
  let h1 = 0xdeadbeef ^ input.length
  let h2 = 0x41c6ce57 ^ input.length
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(13, '0')
}

export function contentHash(section) {
  return stableHash(JSON.stringify([
    section.title, section.api_name, section.error_code, section.body_html,
    section.url_path, section.anchor, section.ordinal
  ]))
}

export function aclHash(section, allowedPrincipals, deniedPrincipals = []) {
  return stableHash(JSON.stringify([
    section.status, section.is_public,
    [...allowedPrincipals].sort(),
    [...deniedPrincipals].sort()
  ]))
}

// Checkpoint hash: content or ACL drift forces a shard rebuild/refinalize.
export function sectionHash(section, allowedPrincipals, deniedPrincipals = []) {
  return stableHash(JSON.stringify([
    contentHash(section),
    aclHash(section, allowedPrincipals, deniedPrincipals)
  ]))
}

function analyzeField(field, text) {
  const analyzer = field === 'apiName' || field === 'errorCode' ? analyzeCode : analyzeNatural
  return analyzer(text).map((token) => ({ ...token, field }))
}

function processSection(row) {
  const parsedBody = htmlToText(row.body_html ?? '')
  const fieldText = {
    title: row.title ?? '',
    apiName: row.api_name ?? '',
    errorCode: row.error_code ?? '',
    body: parsedBody.text
  }
  const terms = []
  for (const field of FIELDS) {
    terms.push(...analyzeField(field, fieldText[field]))
  }
  return {
    key: `${row.version}/${row.doc_id}/${row.section_id}`,
    docId: row.doc_id,
    version: row.version,
    sectionId: row.section_id,
    ordinal: row.ordinal ?? 0,
    title: fieldText.title,
    apiName: fieldText.apiName,
    errorCode: fieldText.errorCode,
    body: fieldText.body,
    url: `${row.url_path || ''}#${row.anchor || row.section_id}`,
    isCurrent: Boolean(row.is_current),
    isPublic: Boolean(row.is_public),
    allowed: row.allowed ?? [],
    denied: row.denied ?? [],
    contentHash: contentHash(row),
    aclHash: aclHash(row, row.allowed ?? [], row.denied ?? []),
    checkpointHash: sectionHash(row, row.allowed ?? [], row.denied ?? []),
    terms,
    bodySourceMap: parsedBody.map
  }
}

async function atomicWriteJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`
  await fs.writeFile(tmp, JSON.stringify(value))
  await fs.rename(tmp, file)
}

async function fileExists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

export class IndexBuilder {
  constructor(store, rootDir) {
    this.store = store
    this.rootDir = rootDir
  }

  async startGeneration(version, { generationId = `gen-${Date.now()}-${randomUUID().slice(0, 8)}` } = {}) {
    const existing = this.store.findResumableGeneration(version)
    if (existing) return existing.generation_id

    const shardPath = path.join(this.rootDir, 'generations', generationId, 'shards')
    this.store.createGeneration(generationId, version, shardPath)
    await this.store.save()
    await fs.mkdir(shardPath, { recursive: true })
    return generationId
  }

  async buildOrResume(version, options = {}) {
    const generationId = await this.startGeneration(version)
    const generation = this.store.getGeneration(generationId)
    const checkpoints = new Map(
      this.store.listCheckpoints(generationId).map((row) => [
        `${row.doc_id}/${row.section_id}`, row
      ])
    )
    const sections = this.store.listPublishedSections(version)
    for (const section of sections) {
      if (options.signal?.aborted) {
        const error = new Error('Index build aborted')
        error.code = 'ABORT_ERR'
        throw error
      }
      const key = `${section.doc_id}/${section.section_id}`
      const allowed = this.store.principals(section, 'allow')
      const denied = this.store.principals(section, 'deny')
      const hash = sectionHash(section, allowed, denied)
      const checkpoint = checkpoints.get(key)
      const shardFile = checkpoint?.shard_file ?? `${section.doc_id}__${section.section_id}.json`
      const shardPath = path.join(generation.shard_path, shardFile)
      if (checkpoint && checkpoint.content_hash === hash && await fileExists(shardPath)) continue

      const processed = processSection({ ...section, allowed, denied })
      await atomicWriteJson(shardPath, processed)
      this.store.upsertCheckpoint(generationId, section, shardFile, hash)
      await this.store.save()
      await options.onProgress?.({
        generationId,
        docId: section.doc_id,
        sectionId: section.section_id,
        indexed: checkpoints.size
      })
    }
    return generationId
  }

  async finalize(generationId) {
    const generation = this.store.getGeneration(generationId)
    if (!generation) throw new Error(`Unknown generation: ${generationId}`)
    const sections = this.store.listPublishedSections(generation.doc_version)
    const checkpoints = new Map(
      this.store.listCheckpoints(generationId).map((row) => [
        `${row.doc_id}/${row.section_id}`, row
      ])
    )

    const docs = []
    const stale = []
    const seen = new Set()
    for (const section of sections) {
      const key = `${section.doc_id}/${section.section_id}`
      seen.add(key)
      const allowed = this.store.principals(section, 'allow')
      const denied = this.store.principals(section, 'deny')
      const hash = sectionHash(section, allowed, denied)
      const checkpoint = checkpoints.get(key)
      const shardFile = checkpoint?.shard_file
      const shardPath = shardFile && path.join(generation.shard_path, shardFile)
      if (!checkpoint || checkpoint.content_hash !== hash || !shardFile || !(await fileExists(shardPath))) {
        stale.push(key)
        continue
      }
      const doc = JSON.parse(await fs.readFile(shardPath, 'utf8'))
      // Recompute ACL at finalize: metadata/grant changes never silently leak.
      doc.allowed = allowed
      doc.denied = denied
      docs.push(doc)
    }

    if (stale.length) {
      const error = new Error(`Index generation is incomplete: ${stale.slice(0, 5).join(', ')}`)
      error.code = 'GENERATION_INCOMPLETE'
      error.staleSections = stale
      throw error
    }

    const postings = new Map()
    for (const doc of docs) {
      for (const token of doc.terms) {
        if (!postings.has(token.term)) postings.set(token.term, new Map())
        const byField = postings.get(token.term)
        if (!byField.has(token.field)) byField.set(token.field, [])
        const entries = byField.get(token.field)
        let entry = entries.find((item) => item.key === doc.key)
        if (!entry) {
          entry = { key: doc.key, ranges: [] }
          entries.push(entry)
        }
        entry.ranges.push([token.start, token.end])
      }
    }

    const documents = Object.fromEntries(docs.map((doc) => [doc.key, doc]))
    const index = {
      version: 1,
      docVersion: generation.doc_version,
      generationId,
      documents,
      postings: Object.fromEntries([...postings].map(([term, byField]) => [
        term,
        Object.fromEntries(byField)
      ]))
    }
    const indexFile = path.join(this.rootDir, 'generations', generationId, 'index.json')
    await atomicWriteJson(indexFile, index)

    this.store.activateGeneration(generationId, postings.size, docs.length)
    await this.store.save()
    return new GenerationIndex(index, indexFile)
  }
}

export class GenerationIndex {
  constructor(data, file) {
    this.data = data
    this.file = file
  }

  static async open(file) {
    const data = JSON.parse(await fs.readFile(file, 'utf8'))
    return new GenerationIndex(data, file)
  }

  get docVersion() {
    return this.data.docVersion
  }
}

export { analyzeField, processSection, FIELDS }
