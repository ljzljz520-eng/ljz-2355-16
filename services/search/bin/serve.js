#!/usr/bin/env node
import { listen } from '../src/server.js'

const runtime = await listen({
  port: Number(process.env.SEARCH_PORT ?? 5180),
  host: process.env.SEARCH_HOST ?? '127.0.0.1',
  dbPath: process.env.SEARCH_DB ?? 'data/search.db',
  indexRoot: process.env.SEARCH_INDEX_ROOT ?? 'data/indexes'
})
console.log(`search snippet service listening on http://127.0.0.1:${runtime.server.address().port}`)
