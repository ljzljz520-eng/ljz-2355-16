// Visibility & permission model.
//
// TWO permission moments (requirement: "比较索引内存权限与查询时回查权限"):
//
//  1) INDEX-TIME snapshot (`indexPermission`): when a generation is built, each
//     section records whether it was visible-then. This snapshot can accelerate
//     serving but is NOT trusted for security, because visibility changes
//     afterwards.
//
//  2) QUERY-TIME recheck (`queryPermission`): the authoritative check run on
//     every search against the CURRENT relational visibility rows plus an
//     in-memory immediate revocation set. Even if a posting lives in the active
//     index, a document revoked now is filtered from results IMMEDIATELY,
//     before any physical index cleanup happens.
//
// Background SWEEP physically removes postings of revoked docs (space/stat
// cleanup). Immediate filtering guarantees correctness in the window between
// revoke and sweep.

export const PUBLIC = '*';

export class PermissionService {
  constructor(store) {
    this.store = store;
    // immediate revocation set: `${genId}:${docId}` -> true
    // Applies to all generations when keyed doc-only too; we keep both.
    this.revokedDoc = new Set(); // docId (current visibility deny)
    this.revokedDocGen = new Set(); // `${genId}:${docId}` historical hard revoke
    this.restoredDoc = new Set(); // docId restored but not yet re-indexed
  }

  /* ---------- resolution ---------- */

  /**
   * Authoritative CURRENT permission from relational rows.
   * @param principals array of principal ids the caller has (always includes '*')
   * Deny wins; default deny unless a public/allow rule exists.
   */
  queryPermission(documentId, principals, versionId = null) {
    const pids = new Set(principals);
    pids.add(PUBLIC);

    // document-level
    const docRows = this.store
      .listAllVisibility()
      .filter((r) => r.documentId === documentId && pids.has(r.principalId));
    let docAllowed = null;
    if (docRows.some((r) => r.allowed === 0)) return false; // explicit deny wins
    if (docRows.some((r) => r.allowed === 1)) docAllowed = true;

    // version-level
    let verAllowed = null;
    if (versionId) {
      const verRows = this.store
        .listVersionVisibilityFor([versionId])
        .filter((r) => pids.has(r.principalId));
      if (verRows.some((r) => r.allowed === 0)) return false;
      if (verRows.some((r) => r.allowed === 1)) verAllowed = true;
    }

    if (verAllowed === true) return true;
    if (docAllowed === true) return true;
    return false;
  }

  /** Snapshot permission captured while indexing (visibility as of build). */
  indexPermission(documentId, versionId, principals = [PUBLIC]) {
    return this.queryPermission(documentId, principals, versionId);
  }

  /* ---------- revocation lifecycle ---------- */

  /** Immediate revoke: subsequent queries filter this doc at once. */
  revoke(documentId, { generationId = null, reason = 'visibility' } = {}) {
    this.revokedDoc.add(documentId);
    this.restoredDoc.delete(documentId);
    if (generationId) this.revokedDocGen.add(`${generationId}:${documentId}`);
    for (const genId of this.store.generations.keys()) {
      this.store.logRevocation({
        generationId: genId,
        documentId,
        action: 'revoke',
        filterApplied: nowTs(),
        reason,
      });
    }
  }

  /** Restore visibility. The doc becomes query-visible again BUT its postings
   *  may be stale/missing until the next generation is built, so we flag it
   *  dirty (indexCoverage) rather than silently pretending full coverage. */
  restore(documentId) {
    this.revokedDoc.delete(documentId);
    this.restoredDoc.add(documentId);
    for (const genId of this.store.generations.keys()) {
      this.store.logRevocation({
        generationId: genId,
        documentId,
        action: 'restore',
        filterApplied: nowTs(),
      });
    }
  }

  isRevoked(documentId, generationId = null) {
    if (this.revokedDoc.has(documentId)) return true;
    if (generationId && this.revokedDocGen.has(`${generationId}:${documentId}`)) return true;
    return false;
  }

  isDirtyRestored(documentId) {
    return this.restoredDoc.has(documentId);
  }

  clearDirtyAfterRebuild(documentId) {
    this.restoredDoc.delete(documentId);
  }

  /**
   * Final filter applied to candidate hits at query time.
   * Returns {allowed, reason}.
   */
  filterHit(hit, ctx) {
    const { principals } = ctx;
    const genId = ctx.generationId || null;
    if (this.isRevoked(hit.documentId, genId)) {
      return { allowed: false, reason: 'revoked' };
    }
    // authoritative relational recheck (query-time, never trust snapshot alone)
    if (!this.queryPermission(hit.documentId, principals, hit.versionId)) {
      return { allowed: false, reason: 'forbidden' };
    }
    return { allowed: true };
  }

  /**
   * Background sweep: physically remove revoked documents' postings from a
   * generation index. Returns removed section ids. Safe to run async; immediate
   * filtering already hid them.
   */
  sweepGeneration(index, generationId) {
    const removed = [];
    for (const docId of this.revokedDoc) {
      // removeDocument takes a documentId only (index is already generation
      // scoped); do NOT pass generationId as the documentId.
      removed.push(...index.removeDocument(docId));
    }
    // mark matching revoke logs swept
    for (const rev of this.store.listRevocations()) {
      if (
        rev.generationId === generationId &&
        rev.action === 'revoke' &&
        this.revokedDoc.has(rev.documentId) &&
        !rev.sweptAt
      ) {
        this.store.markSwept(rev.id);
      }
    }
    return removed;
  }
}

function nowTs() {
  return Date.now();
}
