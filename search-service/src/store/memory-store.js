// In-memory implementation of the relational repository.
// Mirrors schema.sql tables; provides the same operations a SQL-backed
// repository would. Deterministic ids and synchronous semantics make the
// generation/visibility rules directly testable.

let _seq = 0;
const rid = (p) => `${p}_${(++_seq).toString(36)}${Date.now().toString(36)}`;
export function resetIds() {
  _seq = 0;
}

export class RelationalStore {
  constructor() {
    this.documents = new Map(); // id -> {id, slug, currentVer}
    this.versions = new Map(); // id -> {id, documentId, label, title, status}
    this.sections = new Map(); // id -> section
    this.visibility = []; // {documentId, principalId, allowed, updatedAt}
    this.versionVisibility = []; // {versionId, principalId, allowed}
    this.generations = new Map(); // id -> gen
    this.active = new Map(); // scope -> {generationId, switchedAt}
    this.indexSections = new Map(); // genId -> Map(sectionId -> {documentId,versionId,visibleSnapshot})
    this.revocations = [];
  }

  /* ---------------- documents & versions ---------------- */

  createDocument({ slug }) {
    const id = rid('doc');
    this.documents.set(id, { id, slug, currentVer: null, createdAt: now() });
    return id;
  }

  getDocument(id) {
    return this.documents.get(id) || null;
  }

  findBySlug(slug) {
    for (const d of this.documents.values()) if (d.slug === slug) return d;
    return null;
  }

  /**
   * Add a version. Draft versions are NOT indexable. Publishing is explicit and
   * marks all its sections frozen; it never mutates earlier versions.
   */
  addVersion(documentId, { label, title, status = 'draft' }) {
    const doc = this.documents.get(documentId);
    if (!doc) throw new Error(`unknown document ${documentId}`);
    for (const v of this.versions.values()) {
      if (v.documentId === documentId && v.label === label) {
        throw new Error(`duplicate version ${label}`);
      }
    }
    const id = rid('ver');
    this.versions.set(id, {
      id,
      documentId,
      label,
      title,
      status,
      createdAt: now(),
    });
    if (status === 'published' && doc.currentVer == null) doc.currentVer = label;
    return id;
  }

  getVersion(id) {
    return this.versions.get(id) || null;
  }

  getVersionByLabel(documentId, label) {
    for (const v of this.versions.values()) {
      if (v.documentId === documentId && v.label === label) return v;
    }
    return null;
  }

  listVersions(documentId) {
    return [...this.versions.values()]
      .filter((v) => v.documentId === documentId)
      .sort((a, b) => (a.label < b.label ? 1 : -1));
  }

  publishVersion(versionId) {
    const v = this.versions.get(versionId);
    if (!v) throw new Error('unknown version');
    v.status = 'published';
    // newest published label becomes current
    const doc = this.documents.get(v.documentId);
    doc.currentVer = v.label;
    return v;
  }

  addSection(versionId, { anchor, title, body, ordinal, fields = [], apis = [], errors = [] }) {
    const v = this.versions.get(versionId);
    if (!v) throw new Error('unknown version');
    const id = rid('sec');
    const section = {
      id,
      versionId,
      anchor,
      title,
      body,
      ordinal,
      contentHash: hash(body + title + anchor),
      declaredFields: fields,
      declaredApis: apis,
      declaredErrors: errors,
    };
    this.sections.set(id, section);
    return section;
  }

  listSections(versionId) {
    return [...this.sections.values()]
      .filter((s) => s.versionId === versionId)
      .sort((a, b) => a.ordinal - b.ordinal);
  }

  getSection(id) {
    return this.sections.get(id) || null;
  }

  /** Published versions only — drafts must never enter an index. */
  listPublishedVersions() {
    return [...this.versions.values()].filter((v) => v.status === 'published');
  }

  /* ---------------- visibility ---------------- */

  setVisibility(documentId, principalId, allowed) {
    const existing = this.visibility.find(
      (x) => x.documentId === documentId && x.principalId === principalId
    );
    if (existing) {
      existing.allowed = allowed ? 1 : 0;
      existing.updatedAt = now();
    } else {
      this.visibility.push({
        documentId,
        principalId,
        allowed: allowed ? 1 : 0,
        updatedAt: now(),
      });
    }
  }

  setVersionVisibility(versionId, principalId, allowed) {
    const existing = this.versionVisibility.find(
      (x) => x.versionId === versionId && x.principalId === principalId
    );
    if (existing) {
      existing.allowed = allowed ? 1 : 0;
    } else {
      this.versionVisibility.push({
        versionId,
        principalId,
        allowed: allowed ? 1 : 0,
        updatedAt: now(),
      });
    }
  }

  listVisibilityFor(documentIds) {
    const set = new Set(documentIds);
    return this.visibility.filter((v) => set.has(v.documentId));
  }

  listAllVisibility() {
    return [...this.visibility];
  }

  listVersionVisibilityFor(versionIds) {
    const set = new Set(versionIds);
    return this.versionVisibility.filter((v) => set.has(v.versionId));
  }

  /* ---------------- generations ---------------- */

  createGeneration({ scope = 'all' }) {
    const id = rid('gen');
    this.generations.set(id, {
      id,
      status: 'building',
      scope,
      docCount: 0,
      sectionCount: 0,
      builtAt: null,
      activatedAt: null,
      checkpoint: { lastVersionId: null, lastOrdinal: -1, done: [] },
    });
    this.indexSections.set(id, new Map());
    return id;
  }

  getGeneration(id) {
    return this.generations.get(id) || null;
  }

  saveCheckpoint(genId, checkpoint) {
    const g = this.generations.get(genId);
    g.checkpoint = checkpoint;
  }

  recordIndexedSection(genId, section, visibleSnapshot) {
    this.indexSections.get(genId).set(section.id, {
      documentId: this.versions.get(section.versionId).documentId,
      versionId: section.versionId,
      visibleSnapshot: visibleSnapshot ? 1 : 0,
    });
  }

  isSectionIndexed(genId, sectionId) {
    return this.indexSections.has(genId) && this.indexSections.get(genId).has(sectionId);
  }

  finalizeGeneration(genId, counts) {
    const g = this.generations.get(genId);
    g.status = 'ready';
    g.builtAt = now();
    g.docCount = counts.docCount;
    g.sectionCount = counts.sectionCount;
  }

  /** Atomic pointer switch. Old active becomes 'ready' (still queryable via
   *  held cursors until retired); new becomes 'active'. */
  activateGeneration(genId) {
    const g = this.generations.get(genId);
    if (g.status !== 'ready') throw new Error('cannot activate a non-ready generation');
    const prev = this.active.get(g.scope);
    if (prev) {
      const pg = this.generations.get(prev.generationId);
      if (pg) pg.status = 'ready';
    }
    g.status = 'active';
    g.activatedAt = now();
    this.active.set(g.scope, { generationId: genId, switchedAt: now() });
  }

  getActiveGenerationId(scope = 'all') {
    return this.active.get(scope)?.generationId || this.active.get('all')?.generationId || null;
  }

  activeScopes() {
    return [...this.active.keys()];
  }

  retireGeneration(genId) {
    const g = this.generations.get(genId);
    if (!g) return;
    g.status = 'retired';
    for (const [scope, a] of this.active) {
      if (a.generationId === genId) this.active.delete(scope);
    }
  }

  listGenerations() {
    return [...this.generations.values()];
  }

  getGenerationSections(genId) {
    return this.indexSections.get(genId) || new Map();
  }

  /* ---------------- revocation ---------------- */

  logRevocation(entry) {
    this._revSeq = (this._revSeq || 0) + 1;
    this.revocations.push({
      id: this._revSeq,
      filterApplied: 0,
      sweptAt: null,
      createdAt: now(),
      ...entry,
    });
    return this.revocations[this.revocations.length - 1];
  }

  markSwept(revId) {
    const r = this.revocations.find((x) => x.id === revId);
    if (r) r.sweptAt = now();
  }

  listRevocations() {
    return [...this.revocations];
  }
}

function now() {
  return Date.now();
}

// stable FNV hash (cp-safe)
function hash(str) {
  let h = 0x811c9dc5;
  for (const c of str) {
    h = Math.imul(h ^ c.codePointAt(0), 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
