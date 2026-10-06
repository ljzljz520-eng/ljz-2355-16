// In-memory inverted index for one generation.
//
// ALL token positions are stored in NORM-view code points (NFKC + lowercase).
// Two posting fields with different analyzers:
//   - "text": natural-language tokens (CJK uni+bigrams, latin/digit words)
//   - "code": identifier tokens (full ident/path, camelCase/snake subparts,
//             error codes). Titles are indexed with a title-boost flag.
//
// Each posting keeps norm-view cp ranges so the snippet builder can reconstruct
// typed highlights (field / api / error / text) and map them back to source.

import { textAnalyze, codeAnalyze } from '../text/analyzers.js';
import { prepareViews } from '../snippet/snippet.js';

export class InvertedIndex {
  constructor() {
    this.textPostings = new Map(); // term -> Map(sectionId -> [{start,end,kind,type}])
    this.codePostings = new Map();
    this.titleText = new Map(); // term -> Set(sectionId)
    this.titleCode = new Map();
    this.docs = new Map(); // sectionId -> stored document
    this.sectionByDoc = new Map(); // documentId -> Set(sectionId)
    this.stats = { sections: 0, docs: new Set() };
  }

  addPosting(map, term, sectionId, p) {
    if (!map.has(term)) map.set(term, new Map());
    const bySec = map.get(term);
    if (!bySec.has(sectionId)) bySec.set(sectionId, []);
    bySec.get(sectionId).push(p);
  }

  addTitle(map, term, sectionId) {
    if (!map.has(term)) map.set(term, new Set());
    map.get(term).add(sectionId);
  }

  indexSection(section, meta) {
    if (this.docs.has(section.id)) return this.docs.get(section.id); // idempotent
    const views = prepareViews(section.body);

    // declared field/api/error spans resolved onto the NORM view
    const declared = buildDeclared(section, views);

    for (const t of textAnalyze(views.norm).tokens) {
      this.addPosting(this.textPostings, t.term, section.id, {
        start: t.start,
        end: t.end,
        kind: t.kind,
        type: declared.typeAt(t.start, t.end),
      });
    }
    for (const t of codeAnalyze(views.norm).tokens) {
      if (t.shadow) continue;
      this.addPosting(this.codePostings, t.term.toLowerCase(), section.id, {
        start: t.start,
        end: t.end,
        kind: t.kind,
        type: declared.typeAt(t.start, t.end, t.kind),
      });
    }

    // titles (norm view)
    const titleNorm = prepareViews(section.title).norm;
    for (const t of textAnalyze(titleNorm).tokens) this.addTitle(this.titleText, t.term, section.id);
    for (const t of codeAnalyze(titleNorm).tokens) {
      if (!t.shadow) this.addTitle(this.titleCode, t.term.toLowerCase(), section.id);
    }

    const stored = {
      sectionId: section.id,
      documentId: meta.documentId,
      versionId: section.versionId,
      versionLabel: meta.versionLabel,
      docSlug: meta.docSlug,
      title: section.title,
      anchor: section.anchor,
      ordinal: section.ordinal,
      isCurrent: meta.isCurrent,
      historical: meta.historical,
      views,
      declared,
      visibleSnapshot: meta.visibleSnapshot,
      contentHash: section.contentHash,
    };
    this.docs.set(section.id, stored);
    if (!this.sectionByDoc.has(meta.documentId)) this.sectionByDoc.set(meta.documentId, new Set());
    this.sectionByDoc.get(meta.documentId).add(section.id);
    this.stats.sections++;
    this.stats.docs.add(meta.documentId);
    return stored;
  }

  getDoc(sectionId) {
    return this.docs.get(sectionId) || null;
  }

  hasSection(sectionId) {
    return this.docs.has(sectionId);
  }

  removeDocument(documentId) {
    const ids = this.sectionByDoc.get(documentId);
    const removed = [];
    if (!ids) return removed;
    for (const sectionId of [...ids]) {
      this._removeSection(sectionId);
      removed.push(sectionId);
    }
    this.sectionByDoc.delete(documentId);
    this.stats.docs.delete(documentId);
    return removed;
  }

  _removeSection(sectionId) {
    this.docs.delete(sectionId);
    for (const map of [this.textPostings, this.codePostings]) {
      for (const [, bySec] of map) bySec.delete(sectionId);
    }
    for (const map of [this.titleText, this.titleCode]) {
      for (const [, s] of map) s.delete(sectionId);
    }
    this.stats.sections--;
  }

  get docCount() {
    return this.stats.docs.size;
  }

  get sectionCount() {
    return this.stats.sections;
  }
}

/**
 * Resolve declared field/api/error names onto NORM-view cp ranges.
 * Declarations carry {name,start,end} (raw cp) from the authoring pipeline;
 * we locate each name in norm text (case-insensitive) preferring the occurrence
 * nearest to its declared raw position (mapped through the views).
 */
function buildDeclared(section, views) {
  const defs = [];
  const push = (arr, type) => {
    for (const d of arr) {
      const name = d.name || d.code;
      if (name != null) defs.push({ name, rawStart: d.start ?? null, type });
    }
  };
  push(section.declaredFields, 'field');
  push(section.declaredApis, 'api');
  push(section.declaredErrors, 'error');

  const normArr = Array.from(views.norm);
  const items = defs.map((d) => {
    const nameNorm = Array.from(d.name.normalize('NFKC').toLowerCase());
    const hits = findAll(normArr, nameNorm);
    let span = null;
    if (hits.length) {
      let best = hits[0];
      if (d.rawStart != null) {
        // map declared raw start -> stripped -> norm target for proximity
        let bestD = Infinity;
        for (const h of hits) {
          const rawAtH = rawCpForNorm(views, h);
          const dist = Math.abs(rawAtH - d.rawStart);
          if (dist < bestD) {
            bestD = dist;
            best = h;
          }
        }
      }
      span = { normStart: best, normEnd: best + nameNorm.length };
    }
    return { ...d, ...(span || { normStart: null, normEnd: null }) };
  });

  return {
    items,
    typeAt(start, end, tokenKind = 'text') {
      let match = null;
      const priority = { error: 3, api: 2, field: 1 };
      for (const it of items) {
        if (it.normStart == null) continue;
        if (start >= it.normStart && end <= it.normEnd) {
          if (!match || priority[it.type] > priority[match.type]) match = it;
        }
      }
      if (match) return match.type;
      // error-code-shaped tokens are typed even without declaration
      if (tokenKind === 'errcode') return 'error';
      return 'text';
    },
  };
}

function findAll(hay, needle) {
  const out = [];
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++) {
      if (hay[i + k] !== needle[k]) continue outer;
    }
    out.push(i);
  }
  return out;
}

function rawCpForNorm(views, normIdx) {
  const stripped = views.normMap.mapPoint(normIdx);
  return views.strippedMap.mapPoint(stripped);
}
