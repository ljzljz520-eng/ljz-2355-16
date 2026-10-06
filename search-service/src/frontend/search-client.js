// Thin browser client for the search API. Centralizes version handling and
// surfaces the three distinct non-result states so the UI never confuses them:
//   not_ready / no_index (503, index unavailable) vs ok + total=0 (no match).

export class SearchClient {
  constructor(base = '/api', { principals } = {}) {
    this.base = base;
    this.principals = principals;
  }

  async search(params, { signal } = {}) {
    const q = new URLSearchParams();
    q.set('q', params.q || '');
    q.set('version', params.version || 'current');
    if (params.includeHistorical) q.set('includeHistorical', 'true');
    if (params.limit) q.set('limit', String(params.limit));
    if (params.cursor) q.set('cursor', params.cursor);
    if (params.radius) q.set('radius', String(params.radius));

    const headers = {};
    if (this.principals && this.principals.length) {
      headers['x-principals'] = this.principals.join(',');
    }
    const res = await fetch(`${this.base}/search?${q.toString()}`, {
      headers,
      signal,
    });
    const body = await res.json().catch(() => null);
    if (!body) return { status: 'transport_error', results: [] };
    body.httpStatus = res.status;
    return body;
  }
}
