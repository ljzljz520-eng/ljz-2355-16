// Minimal zero-dependency HTTP layer exposing the search API.
//
// Routes:
//   GET /api/search?q=&version=&includeHistorical=&limit=&cursor=
//   GET /api/health
//
// Auth: principals are taken from the simplified `x-principals` header
// (comma separated) for the demo/test harness; production would resolve them
// from the session/token. Anonymous always includes '*'.

import http from 'node:http';
import { URL } from 'node:url';
import { SearchError } from '../index/search-engine.js';

export function createServer(engine, { auth } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/health') {
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/search' && req.method === 'GET') {
        const principals = resolvePrincipals(req, auth);
        const params = {
          q: url.searchParams.get('q') || '',
          version: url.searchParams.get('version') || 'current',
          includeHistorical: url.searchParams.get('includeHistorical') === 'true',
          limit: url.searchParams.get('limit') || undefined,
          cursor: url.searchParams.get('cursor') || undefined,
          radius: url.searchParams.get('radius') || undefined,
        };
        const result = engine.search(params, { principals });
        return json(res, result.httpStatus || 200, result);
      }
      return json(res, 404, { status: 'error', code: 'NOT_FOUND' });
    } catch (err) {
      if (err instanceof SearchError) {
        return json(res, err.status, { status: 'error', code: err.code, message: err.message });
      }
      return json(res, 500, { status: 'error', code: 'INTERNAL', message: String(err.message || err) });
    }
  });
}

function resolvePrincipals(req, auth) {
  const header = req.headers['x-principals'];
  const principals = new Set(['*']);
  if (header) String(header).split(',').map((s) => s.trim()).filter(Boolean).forEach((p) => principals.add(p));
  if (typeof auth === 'function') {
    for (const p of auth(req) || []) principals.add(p);
  }
  return [...principals];
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}
