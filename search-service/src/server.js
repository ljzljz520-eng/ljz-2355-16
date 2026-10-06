// Runnable demo server: seeds sample data, builds the initial index
// generation, and serves the search API.
//
//   node src/server.js [--port 5174]
//
// Use x-principals: group:admin to see the internal doc. Anonymous is '*'.

import { createServer } from './api/http.js';
import { buildApp } from './demo/seed.js';

const portArg = process.argv.includes('--port')
  ? Number(process.argv[process.argv.indexOf('--port') + 1])
  : 5174;

const app = await buildApp();
await app.indexer.rebuildAndPublish('all');

const server = createServer(app.engine);
server.listen(portArg, () => {
  /* eslint-disable no-console */
  console.log(`[doc-search] API on http://127.0.0.1:${portArg}`);
  console.log(`[doc-search] try: /api/search?q=E4001&version=all&includeHistorical=true`);
  console.log(`[doc-search] internal doc needs header: x-principals: group:admin`);
});

// Expose for ad-hoc debugging / REPL.
export { app, server };
