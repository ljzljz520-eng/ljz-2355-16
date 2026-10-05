import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import initSqlJs from 'sql.js'

const require = createRequire(import.meta.url)

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  doc_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_versions (
  doc_id TEXT NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, version)
);

CREATE TABLE IF NOT EXISTS sections (
  doc_id TEXT NOT NULL,
  version TEXT NOT NULL,
  section_id TEXT NOT NULL,
  title TEXT NOT NULL,
  api_name TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  url_path TEXT NOT NULL,
  anchor TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('published', 'draft')),
  is_public INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, version, section_id),
  FOREIGN KEY (doc_id, version) REFERENCES document_versions(doc_id, version) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS section_grants (
  doc_id TEXT NOT NULL,
  version TEXT NOT NULL,
  section_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, version, section_id, principal),
  FOREIGN KEY (doc_id, version, section_id)
    REFERENCES sections(doc_id, version, section_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS index_generations (
  generation_id TEXT PRIMARY KEY,
  doc_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building', 'ready', 'failed', 'stale')),
  shard_path TEXT NOT NULL,
  terms_count INTEGER NOT NULL DEFAULT 0,
  docs_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  finalized_at TEXT
);

CREATE TABLE IF NOT EXISTS active_generations (
  doc_version TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  FOREIGN KEY (generation_id) REFERENCES index_generations(generation_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS build_checkpoints (
  generation_id TEXT NOT NULL REFERENCES index_generations(generation_id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL,
  version TEXT NOT NULL,
  section_id TEXT NOT NULL,
  shard_file TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  PRIMARY KEY (generation_id, doc_id, version, section_id)
);
`

export class RelationalStore {
  constructor(db, dbPath) {
    this.db = db
    this.dbPath = dbPath
  }

  static async open(dbPath) {
    const SQL = await initSqlJs({
      locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
    })
    await fs.mkdir(path.dirname(dbPath), { recursive: true })
    let db
    try {
      const bytes = await fs.readFile(dbPath)
      db = new SQL.Database(bytes)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      db = new SQL.Database()
    }
    db.run(SCHEMA)
    const store = new RelationalStore(db, dbPath)
    await store.save()
    return store
  }

  async save() {
    const data = this.db.export()
    const tmp = `${this.dbPath}.tmp-${process.pid}-${Date.now()}`
    await fs.writeFile(tmp, Buffer.from(data))
    await fs.rename(tmp, this.dbPath)
  }

  run(sql, params = []) {
    this.db.run(sql, params)
  }

  query(sql, params = []) {
    const stmt = this.db.prepare(sql)
    stmt.bind(params)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  }

  get(sql, params = []) {
    return this.query(sql, params)[0] ?? null
  }

  transaction(fn) {
    this.db.run('BEGIN')
    try {
      const result = fn()
      this.db.run('COMMIT')
      return result
    } catch (error) {
      this.db.run('ROLLBACK')
      throw error
    }
  }

  async transactional(fn) {
    this.db.run('BEGIN')
    try {
      const result = await fn()
      this.db.run('COMMIT')
      await this.save()
      return result
    } catch (error) {
      this.db.run('ROLLBACK')
      throw error
    }
  }

  upsertVersion({ docId, title, version, current = false, now = new Date().toISOString() }) {
    this.run(
      `INSERT INTO documents(doc_id,title,created_at,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(doc_id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at`,
      [docId, title, now, now]
    )
    this.run(
      `INSERT INTO document_versions(doc_id,version,is_current,created_at) VALUES(?,?,?,?)
       ON CONFLICT(doc_id,version) DO UPDATE SET is_current=excluded.is_current`,
      [docId, version, current ? 1 : 0, now]
    )
    if (current) {
      this.run(
        `UPDATE document_versions
         SET is_current = CASE WHEN doc_id = ? AND version = ? THEN 1 ELSE 0 END`,
        [docId, version]
      )
    }
  }

  upsertSection(input) {
    const now = new Date().toISOString()
    this.upsertVersion({
      docId: input.docId,
      title: input.docTitle ?? input.title,
      version: input.version,
      current: input.current ?? false,
      now
    })
    this.run(
      `INSERT INTO sections(
        doc_id,version,section_id,title,api_name,error_code,body_html,url_path,anchor,
        ordinal,status,is_public,content_hash,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(doc_id,version,section_id) DO UPDATE SET
        title=excluded.title, api_name=excluded.api_name, error_code=excluded.error_code,
        body_html=excluded.body_html, url_path=excluded.url_path, anchor=excluded.anchor,
        ordinal=excluded.ordinal, status=excluded.status, is_public=excluded.is_public,
        content_hash=excluded.content_hash, updated_at=excluded.updated_at`,
      [
        input.docId, input.version, input.sectionId, input.title,
        input.apiName ?? '', input.errorCode ?? '', input.bodyHtml ?? '',
        input.urlPath ?? '', input.anchor ?? '', input.ordinal ?? 0,
        input.status ?? 'published', input.isPublic === false ? 0 : 1,
        input.contentHash ?? '', now
      ]
    )
    if (Array.isArray(input.allowPrincipals)) this.replaceGrants(input, 'allow', now)
    if (Array.isArray(input.denyPrincipals)) this.replaceGrants(input, 'deny', now)
  }

  replaceGrants(input, effect, now) {
    this.run(
      `DELETE FROM section_grants
       WHERE doc_id=? AND version=? AND section_id=? AND effect=? AND expires_at IS NULL`,
      [input.docId, input.version, input.sectionId, effect]
    )
    for (const principal of effect === 'allow' ? input.allowPrincipals : input.denyPrincipals) {
      this.run(
        `INSERT INTO section_grants(doc_id,version,section_id,principal,effect,expires_at,created_at)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(doc_id,version,section_id,principal) DO UPDATE SET
           effect=excluded.effect, expires_at=excluded.expires_at`,
        [input.docId, input.version, input.sectionId, principal, effect, null, now]
      )
    }
  }

  setTemporaryGrant({ docId, version, sectionId, principal, effect, expiresAt }) {
    const now = new Date().toISOString()
    this.run(
      `INSERT INTO section_grants(doc_id,version,section_id,principal,effect,expires_at,created_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(doc_id,version,section_id,principal) DO UPDATE SET
         effect=excluded.effect, expires_at=excluded.expires_at`,
      [docId, version, sectionId, principal, effect, expiresAt, now]
    )
  }

  clearTemporaryGrants(at = new Date().toISOString()) {
    this.run('DELETE FROM section_grants WHERE expires_at IS NOT NULL AND expires_at <= ?', [at])
  }

  getSection(version, docId, sectionId) {
    return this.get(
      `SELECT * FROM sections WHERE version=? AND doc_id=? AND section_id=?`,
      [version, docId, sectionId]
    )
  }

  listPublishedSections(docVersion) {
    return this.query(
      `SELECT s.*, dv.is_current
       FROM sections s
       JOIN document_versions dv ON dv.doc_id=s.doc_id AND dv.version=s.version
       WHERE s.version=? AND s.status='published'
       ORDER BY s.doc_id, s.ordinal, s.section_id`,
      [docVersion]
    )
  }

  getActiveVersionMeta(version) {
    const rows = this.query(
      `SELECT doc_id, MAX(is_current) AS is_current FROM document_versions
       WHERE version=? GROUP BY version`,
      [version]
    )
    return rows[0] ?? null
  }

  isCurrentVersion(version) {
    const row = this.get(
      `SELECT MAX(is_current) AS current FROM document_versions WHERE version=?`,
      [version]
    )
    return Boolean(row?.current)
  }

  principals(section, effect, at = new Date().toISOString()) {
    return this.query(
      `SELECT principal FROM section_grants
       WHERE doc_id=? AND version=? AND section_id=? AND effect=?
         AND (expires_at IS NULL OR expires_at > ?)`,
      [section.doc_id, section.version, section.section_id, effect, at]
    ).map((row) => row.principal)
  }

  isAllowed(section, auth, at = new Date().toISOString()) {
    if (!auth?.userId) return false
    const principals = new Set([auth.userId, ...(auth.groups ?? [])])
    for (const principal of principals) {
      const deny = this.get(
        `SELECT 1 FROM section_grants
         WHERE doc_id=? AND version=? AND section_id=? AND principal=? AND effect='deny'
           AND (expires_at IS NULL OR expires_at > ?)
         LIMIT 1`,
        [section.doc_id, section.version, section.section_id, principal, at]
      )
      if (deny) return false
    }
    if (section.is_public) return true
    for (const principal of principals) {
      const allow = this.get(
        `SELECT 1 FROM section_grants
         WHERE doc_id=? AND version=? AND section_id=? AND principal=? AND effect='allow'
           AND (expires_at IS NULL OR expires_at > ?)
         LIMIT 1`,
        [section.doc_id, section.version, section.section_id, principal, at]
      )
      if (allow) return true
    }
    return false
  }

  createGeneration(generationId, docVersion, shardPath, now = new Date().toISOString()) {
    this.run(
      `INSERT INTO index_generations(generation_id,doc_version,status,shard_path,created_at)
       VALUES(?,?, 'building', ?,?)`,
      [generationId, docVersion, shardPath, now]
    )
  }

  getGeneration(generationId) {
    return this.get(`SELECT * FROM index_generations WHERE generation_id=?`, [generationId])
  }

  findResumableGeneration(docVersion) {
    return this.get(
      `SELECT * FROM index_generations
       WHERE doc_version=? AND status='building'
       ORDER BY created_at DESC, generation_id DESC LIMIT 1`,
      [docVersion]
    )
  }

  getActiveGeneration(docVersion) {
    return this.get(
      `SELECT g.* FROM active_generations a
       JOIN index_generations g ON g.generation_id=a.generation_id
       WHERE a.doc_version=? AND g.status='ready'`,
      [docVersion]
    )
  }

  upsertCheckpoint(generationId, section, shardFile, contentHash, now = new Date().toISOString()) {
    this.run(
      `INSERT INTO build_checkpoints(generation_id,doc_id,version,section_id,shard_file,content_hash,indexed_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(generation_id,doc_id,version,section_id)
       DO UPDATE SET shard_file=excluded.shard_file,content_hash=excluded.content_hash,indexed_at=excluded.indexed_at`,
      [generationId, section.doc_id, section.version, section.section_id, shardFile, contentHash, now]
    )
  }

  listCheckpoints(generationId) {
    return this.query(`SELECT * FROM build_checkpoints WHERE generation_id=?`, [generationId])
  }

  activateGeneration(generationId, termsCount, docsCount, now = new Date().toISOString()) {
    const generation = this.getGeneration(generationId)
    if (!generation) throw new Error(`Unknown generation: ${generationId}`)
    this.transaction(() => {
      this.run(
        `UPDATE index_generations
         SET status='ready', terms_count=?, docs_count=?, finalized_at=?, published_at=COALESCE(published_at,?), error=NULL
         WHERE generation_id=?`,
        [termsCount, docsCount, now, now, generationId]
      )
      this.run(
        `INSERT INTO active_generations(doc_version,generation_id,activated_at) VALUES(?,?,?)
         ON CONFLICT(doc_version) DO UPDATE SET generation_id=excluded.generation_id, activated_at=excluded.activated_at`,
        [generation.doc_version, generationId, now]
      )
      this.run(
        `UPDATE index_generations SET status='stale', published_at=NULL
         WHERE doc_version=? AND status='ready' AND generation_id<>?`,
        [generation.doc_version, generationId]
      )
    })
  }

  failGeneration(generationId, error) {
    this.run(`UPDATE index_generations SET status='failed', error=? WHERE generation_id=?`, [
      String(error?.message ?? error), generationId
    ])
  }
}
