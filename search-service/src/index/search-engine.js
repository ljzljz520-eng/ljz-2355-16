// Search engine: queries the ACTIVE generation for a scope, re-checks
// permissions at query time, builds typed snippets, and paginates with an
// opaque keyset cursor.
//
// Version semantics:
//   version='current' -> active 'all' index, only isCurrent hits
//   version=<label>   -> active index for that label (or 'all'), results tagged
//                        current/historical relative to the doc's current version
//   version='all'     -> active 'all' index across versions
// includeHistorical=true adds historical hits alongside current ones.
//
// A building (incomplete) generation is NEVER served as an empty result:
// callers get status 'not_ready' (HTTP 503). No generation at all ->
// 'no_index'. These are distinct from a completed search with zero hits.

import { parseQuery } from '../text/analyzers.js';
import { buildSnippet } from '../snippet/snippet.js';
import { HL } from '../snippet/snippet.js';

const TYPE_FROM_TERM = (t) => (t.isErrorCode ? HL.ERROR : t.isCode ? HL.API : HL.TEXT);

export class SearchError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class SearchEngine {
  constructor(store, indexer, permissions) {
    this.store = store;
    this.indexer = indexer;
    this.permissions = permissions;
  }

  /**
   * Resolve which generation serves a request.
   * @returns {{genId,index,status}|{status:'not_ready'|'no_index'}}
   */
  resolveGeneration(scope) {
    // 1) an ACTIVE generation for the exact scope always serves requests
    const activeId =
      scope === 'all'
        ? this.store.getActiveGenerationId('all')
        : this.store.active.get(scope)?.generationId || null;
    let genId = activeId;
    let gen = genId ? this.store.getGeneration(genId) : null;

    if (!gen) {
      // 2) an in-flight BUILDING generation for the exact scope: the index is
      //    known to exist but is incomplete -> not_ready (never "no matches").
      //    A READY-but-not-activated generation is also not served yet.
      const pending = this.store
        .listGenerations()
        .filter((g) => g.scope === scope && (g.status === 'building' || g.status === 'ready'))
        .sort((a, b) => (a.id < b.id ? 1 : -1))[0];
      if (pending) {
        return { status: 'not_ready', genId: pending.id, reason: pending.status };
      }
      // 3) a version scope with nothing of its own is served by the 'all' index
      if (scope !== 'all') return this.resolveGeneration('all');
      return { status: 'no_index' };
    }
    if (gen.status === 'building') return { status: 'not_ready', genId };
    if (gen.status === 'retired') return { status: 'retired', genId };
    return { status: 'ready', genId, index: this.indexer.getIndex(genId) };
  }

  search(rawParams, ctx) {
    const params = normalizeParams(rawParams);
    const cursor = params.cursor ? decodeCursor(params.cursor) : null;
    if (params.cursor && (!cursor || cursor.v !== 1)) {
      throw new SearchError('INVALID_CURSOR', '无法识别的分页游标', 400);
    }

    const scope = params.version && params.version !== 'current' && params.version !== 'all'
      ? params.version
      : 'all';
    const resolved = this.resolveGeneration(scope);

    if (resolved.status === 'not_ready') {
      return {
        status: 'not_ready',
        httpStatus: 503,
        message: '索引正在构建，尚未完成；不能把未完成索引当作“无匹配”返回。',
        indexCoverage: { complete: false },
        results: [],
      };
    }
    if (resolved.status === 'no_index') {
      return {
        status: 'no_index',
        httpStatus: 503,
        message: '该版本尚无可检索索引。',
        indexCoverage: { complete: false },
        results: [],
      };
    }
    if (resolved.status === 'retired') {
      throw new SearchError('STALE_CURSOR', '该索引代次已退役，请重新发起查询', 410);
    }

    const genId = resolved.genId;
    const index = resolved.index;

    // Cursor must belong to the same generation+query (old cursor guard).
    if (cursor) {
      if (cursor.genId !== genId) {
        throw new SearchError(
          'STALE_CURSOR',
          '游标属于旧索引代次，结果集已更新，请从头检索',
          410
        );
      }
      if (cursor.q !== params.q) {
        throw new SearchError('STALE_CURSOR', '游标与当前查询不一致', 410);
      }
      if (cursor.version !== params.version) {
        throw new SearchError('STALE_CURSOR', '游标与当前版本过滤不一致', 410);
      }
    }

    const terms = parseQuery(params.q);
    const candidates = this._collect(index, terms);

    // version filtering
    let hits = [...candidates.values()];
    if (params.version === 'current') {
      hits = hits.filter((h) => h.doc.isCurrent);
    } else if (params.version && params.version !== 'all') {
      hits = hits.filter((h) => h.doc.versionLabel === params.version);
    }
    if (!params.includeHistorical) {
      hits = hits.filter((h) => h.doc.isCurrent);
    }

    // query-time permission recheck + immediate revocation filter
    const filtered = [];
    let hiddenRevoked = 0;
    let hiddenForbidden = 0;
    for (const h of hits) {
      const decision = this.permissions.filterHit(
        { documentId: h.doc.documentId, versionId: h.doc.versionId },
        { principals: ctx.principals || ['*'], generationId: genId }
      );
      if (!decision.allowed) {
        if (decision.reason === 'revoked') hiddenRevoked++;
        else hiddenForbidden++;
        continue;
      }
      filtered.push(h);
    }

    // scoring
    for (const h of filtered) this._score(h, terms, index, params);
    filtered.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.doc.ordinal !== b.doc.ordinal) return a.doc.ordinal - b.doc.ordinal;
      return a.doc.sectionId < b.doc.sectionId ? -1 : 1;
    });

    // keyset pagination over the sorted ordering
    const rows = filtered.map((h) => this._render(h, terms, genId, params));
    const total = rows.length;
    let startIdx = 0;
    if (cursor) {
      const afterKey = cursor.after;
      const pos = rows.findIndex((r) => r._key === afterKey);
      if (pos === -1) {
        // the referenced item vanished (permission/index changed); tell client
        throw new SearchError(
          'STALE_CURSOR',
          '游标位置已失效（结果集发生变化），请重新检索',
          410
        );
      }
      startIdx = pos + 1;
    }
    const page = rows.slice(startIdx, startIdx + params.limit);
    const last = page[page.length - 1];
    const nextCursor =
      page.length && startIdx + page.length < total
        ? encodeCursor({
            v: 1,
            genId,
            q: params.q,
            version: params.version,
            after: last._key,
          })
        : null;

    // coverage flags (restored-but-not-reindexed docs => partial coverage)
    const dirtyDocs = [...this.permissions.restoredDoc];
    const coverage = {
      complete: dirtyDocs.length === 0,
      staleDocuments: dirtyDocs,
      generation: { id: genId, status: 'active' },
    };

    return {
      status: 'ok',
      httpStatus: 200,
      query: params.q,
      version: params.version,
      includeHistorical: params.includeHistorical,
      total,
      returned: page.length,
      offset: startIdx,
      nextCursor,
      indexCoverage: coverage,
      filtered: { hiddenRevoked, hiddenForbidden },
      results: page.map(stripKey),
    };
  }

  _collect(index, terms) {
    const candidates = new Map();
    const ensure = (docId, sectionId) => {
      const key = sectionId;
      if (!candidates.has(key)) {
        candidates.set(key, { doc: index.getDoc(sectionId), matches: [], score: 0 });
      }
      return candidates.get(key);
    };
    for (const term of terms) {
      const postings =
        term.origin === 'code'
          ? index.codePostings.get(term.term)
          : index.textPostings.get(term.term);
      if (postings) {
        for (const [sectionId, ps] of postings) {
          const h = ensure(null, sectionId);
          for (const p of ps) {
            const type = p.type !== 'text' ? p.type : TYPE_FROM_TERM(term);
            h.matches.push({ start: p.start, end: p.end, type, term: term.term, origin: term.origin });
          }
        }
      }
    }
    return candidates;
  }

  _score(hit, terms, index) {
    const doc = hit.doc;
    let score = 0;
    const matchedTerms = new Set(hit.matches.map((m) => m.term));
    for (const m of hit.matches) {
      if (m.type === HL.ERROR) score += 8;
      else if (m.type === HL.API) score += 5;
      else if (m.type === HL.FIELD) score += 4;
      else score += 2;
      if (m.start < 120) score += 1; // early-in-body relevance
    }
    // title hits
    for (const t of terms) {
      const set = t.origin === 'code' ? index.titleCode : index.titleText;
      if (set.get(t.term)?.has(doc.sectionId)) score += 6;
    }
    // all-terms coverage bonus
    const all = terms.length;
    if (all > 1) {
      let covered = 0;
      for (const t of terms) if (matchedTerms.has(t.term)) covered++;
      score += (covered / all) * 10;
    }
    if (doc.isCurrent) score += 0.5;
    hit.score = score;
  }

  _render(hit, terms, genId, params) {
    const doc = hit.doc;
    // de-dup overlapping matches for snippet
    const matches = [...hit.matches].sort((a, b) => a.start - b.start);
    const snippet = buildSnippet(doc.views, matches, { radius: params.radius });

    const url = `/${doc.docSlug}/${doc.versionLabel}#${doc.anchor}`;
    return {
      _key: `${hit.score.toFixed(4)}:${doc.ordinal}:${doc.sectionId}`,
      documentId: doc.documentId,
      sectionId: doc.sectionId,
      title: doc.title,
      url,
      deepLink: {
        slug: doc.docSlug,
        version: doc.versionLabel,
        anchor: doc.anchor,
        rawStart: snippet.anchor.rawStart,
        rawEnd: snippet.anchor.rawEnd,
      },
      version: doc.versionLabel,
      isCurrent: doc.isCurrent,
      historical: doc.historical,
      generation: genId,
      score: Number(hit.score.toFixed(4)),
      snippet: {
        html: snippet.html,
        segments: snippet.segments,
        strippedStart: snippet.strippedStart,
        strippedEnd: snippet.strippedEnd,
      },
    };
  }
}

function stripKey(r) {
  const { _key, ...rest } = r;
  return rest;
}

function normalizeParams(p) {
  const q = (p.q || '').trim();
  return {
    q,
    version: p.version || 'current',
    includeHistorical: !!p.includeHistorical,
    limit: clampInt(p.limit, 1, 50, 10),
    radius: clampInt(p.radius, 8, 200, 36),
    cursor: p.cursor || null,
  };
}

function clampInt(v, min, max, dft) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return dft;
  return Math.max(min, Math.min(max, n));
}

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16);
}
function encodeCursor(obj) {
  const payload = { ...obj };
  const sig = fnv(JSON.stringify(payload));
  return Buffer.from(JSON.stringify({ payload, sig }), 'utf8').toString('base64url');
}
function decodeCursor(str) {
  try {
    const outer = JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));
    if (!outer || typeof outer !== 'object' || !outer.payload || !outer.sig) return null;
    // integrity check: reject tampered / lenient-parsed garbage
    if (fnv(JSON.stringify(outer.payload)) !== outer.sig) return null;
    // round-trip must reproduce the token exactly
    if (encodeCursor(outer.payload) !== str) return null;
    return outer.payload;
  } catch {
    return null;
  }
}
