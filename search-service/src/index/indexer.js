// Indexer: builds an index generation with resumable checkpoints and performs
// an atomic generation switch only AFTER a complete successful build.
//
// Guarantees:
//  - Only PUBLISHED versions are indexed. Draft/unpublished metadata is never
//    fed to full-text indexing, so results cannot point at unpublished bodies.
//  - A new generation builds in status 'building'. Search refuses to serve a
//    building generation (status 503 / status:'not_ready') instead of returning
//    an empty result that would be mistaken for "no matches".
//  - On interruption, resume() reuses the checkpoint; already-indexed sections
//    are skipped idempotently. After full build it is finalized ('ready') and
//    only then can it be activated (atomic pointer swap).
//  - Each indexed section records an index-time visibility snapshot.

import { InvertedIndex } from './inverted-index.js';

export class Indexer {
  constructor(store, permissions, { batchSize = 1 } = {}) {
    this.store = store;
    this.permissions = permissions;
    this.batchSize = batchSize;
    this.indexes = new Map(); // genId -> InvertedIndex
  }

  getIndex(genId) {
    if (!this.indexes.has(genId)) this.indexes.set(genId, new InvertedIndex());
    return this.indexes.get(genId);
  }

  /**
   * Start a generation for a scope ('all' or a version label).
   */
  startGeneration(scope = 'all') {
    const genId = this.store.createGeneration({ scope });
    this.indexes.set(genId, new InvertedIndex());
    return genId;
  }

  /** Enumerate the (immutable, published) work items in deterministic order. */
  _workItems(scope) {
    const items = [];
    const versions = this.store.listPublishedVersions();
    for (const v of versions) {
      if (scope !== 'all' && v.label !== scope) continue;
      const doc = this.store.getDocument(v.documentId);
      for (const s of this.store.listSections(v.id)) {
        items.push({
          version: v,
          doc,
          section: s,
          key: `${v.id}:${s.ordinal}`,
        });
      }
    }
    items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return items;
  }

  /**
   * Build up to `maxBatches` batches. Returns {done, indexed, total, genId}.
   * Call repeatedly; done===false means interrupted/incomplete.
   */
  buildBatch(genId, maxBatches = 1) {
    const gen = this.store.getGeneration(genId);
    if (!gen) throw new Error('unknown generation');
    if (gen.status !== 'building') {
      return { done: true, indexed: 0, total: this._workItems(gen.scope).length, genId, already: gen.status };
    }
    const idx = this.getIndex(genId);
    const items = this._workItems(gen.scope);
    const cp = gen.checkpoint;
    const doneKeys = new Set(cp.done || []);

    let batches = 0;
    let indexed = 0;
    for (const item of items) {
      if (doneKeys.has(item.key)) continue;
      if (batches >= maxBatches) break;
      // SECURITY MODEL: all PUBLISHED sections are fully indexed so that a
      // document can be found the moment it is granted to a new principal and
      // so that per-version ACL changes only require a query-time recheck.
      // The index-time snapshot is recorded as a non-authoritative HINT (e.g.
      // "public at build time"); queryPermission at search time is the gate.
      const publicAtBuild = this.permissions.indexPermission(item.doc.id, item.version.id, ['*']);
      const isCurrent = item.doc.currentVer === item.version.label;
      idx.indexSection(item.section, {
        documentId: item.doc.id,
        versionLabel: item.version.label,
        docSlug: item.doc.slug,
        isCurrent,
        historical: !isCurrent,
        visibleSnapshot: publicAtBuild,
      });
      this.store.recordIndexedSection(genId, item.section, publicAtBuild);
      doneKeys.add(item.key);
      indexed++;
      batches++;
    }

    const allDone = items.every((it) => doneKeys.has(it.key));
    this.store.saveCheckpoint(genId, {
      lastVersionId: items.length ? items[items.length - 1].version.id : null,
      lastOrdinal: items.length ? items[items.length - 1].section.ordinal : -1,
      done: [...doneKeys],
    });

    if (allDone) {
      this._finalize(genId, idx);
    }
    return {
      done: allDone,
      indexed,
      total: items.length,
      processed: doneKeys.size,
      genId,
    };
  }

  /** Run to completion, awaiting the provided async tick (simulated work). */
  async buildAll(genId, { onBatch = null } = {}) {
    let res;
    do {
      res = this.buildBatch(genId, this.batchSize);
      if (onBatch) await onBatch(res);
    } while (!res.done);
    return res;
  }

  /** Resume after interruption: simply continue from checkpoint. */
  resume(genId) {
    const gen = this.store.getGeneration(genId);
    if (!gen) throw new Error('unknown generation');
    if (gen.status !== 'building') return { done: true, genId, status: gen.status };
    return this.buildAll(genId);
  }

  _finalize(genId, idx) {
    const genSec = this.store.getGenerationSections(genId);
    let docCount = 0;
    const docs = new Set();
    for (const v of genSec.values()) {
      if (v.visibleSnapshot) {
        docs.add(v.documentId);
      }
    }
    docCount = docs.size;
    this.store.finalizeGeneration(genId, {
      docCount,
      sectionCount: idx.sectionCount,
    });
    // a fully built generation with zero sections is still 'ready' but callers
    // can distinguish "built empty" from "not finished" via status+checkpoint.
  }

  /**
   * Atomic publish. Only a fully-built ('ready') generation may go active.
   * Returns the new active genId. Until this succeeds, search keeps serving the
   * previous active generation.
   */
  publish(genId) {
    const gen = this.store.getGeneration(genId);
    if (!gen) throw new Error('unknown generation');
    if (gen.status !== 'ready') {
      const err = new Error(`generation ${genId} is ${gen.status}, not ready; refusing to publish`);
      err.code = 'GEN_NOT_READY';
      throw err;
    }
    this.store.activateGeneration(genId);
    // restored docs are now covered by the freshly built generation
    for (const docId of this.permissions.restoredDoc) {
      this.permissions.clearDirtyAfterRebuild(docId);
    }
    return genId;
  }

  /** Convenience: build (all) then publish. */
  async rebuildAndPublish(scope = 'all') {
    const genId = this.startGeneration(scope);
    await this.buildAll(genId);
    this.publish(genId);
    return genId;
  }

  /** Retire an old generation (held cursors then report stale). */
  retire(genId) {
    this.store.retireGeneration(genId);
    this.indexes.delete(genId);
  }
}
