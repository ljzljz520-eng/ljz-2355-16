import http from 'node:http'
import { URL } from 'node:url'
import path from 'node:path'
import { RelationalStore } from './store.js'
import { SearchService, SearchError } from './search.js'
import { IndexBuilder } from './index-engine.js'

export async function createServer({ dbPath, indexRoot } = {}) {
  const store = await RelationalStore.open(dbPath)
  const search = new SearchService(store, indexRoot)
  const builder = new IndexBuilder(store, indexRoot)

  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res, { store, search, builder })
    } catch (error) {
      sendError(res, error)
    }
  })

  return { server, store, search, builder }
}

function authFromRequest(req) {
  const url = new URL(req.url, 'http://internal')
  const userId = req.headers['x-user-id'] || url.searchParams.get('asUser')
  const groups = String(req.headers['x-user-groups'] ?? '')
    .split(',').map((value) => value.trim()).filter(Boolean)
  return userId ? { userId: String(userId), groups } : { userId: 'anonymous', groups: [] }
}

async function readJson(req) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method ?? '')) return {}
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

async function handle(req, res, services) {
  const url = new URL(req.url ?? '/', 'http://internal')
  const pathname = url.pathname
  if (req.method === 'GET' && pathname === '/health') return sendJson(res, { ok: true })
  if (req.method === 'GET' && pathname === '/api/search/v1/snippets') {
    const result = await services.search.search(
      url.searchParams.get('q') ?? '',
      authFromRequest(req),
      {
        version: url.searchParams.get('version'),
        fields: url.searchParams.get('fields') ?? undefined,
        limit: url.searchParams.get('limit') ?? undefined,
        cursor: url.searchParams.get('cursor') ?? undefined,
        generationId: url.searchParams.get('generationId') ?? undefined
      }
    )
    return sendJson(res, result)
  }

  if (req.method === 'POST' && pathname === '/api/admin/index/build') {
    const body = await readJson(req)
    if (!body.version) throw new SearchError(400, 'MISSING_VERSION', '必须指定文档版本')
    const controller = new AbortController()
    const generationId = await services.builder.buildOrResume(body.version, {
      signal: controller.signal,
      onProgress: body.onProgress
    })
    const generation = services.store.getGeneration(generationId)
    return sendJson(res, { generationId, status: generation.status, resumed: true })
  }

  if (req.method === 'POST' && pathname === '/api/admin/index/finalize') {
    const body = await readJson(req)
    if (!body.generationId) throw new SearchError(400, 'MISSING_GENERATION', '必须指定索引代次')
    const index = await services.builder.finalize(body.generationId)
    return sendJson(res, { generationId: index.data.generationId, status: 'ready' })
  }

  if (req.method === 'POST' && pathname === '/api/admin/permissions/refresh') {
    const body = await readJson(req)
    if (!body.version) throw new SearchError(400, 'MISSING_VERSION', '必须指定文档版本')
    const result = await services.search.refreshStaleAcl(body.version, services.builder)
    return sendJson(res, result)
  }

  if (req.method === 'POST' && pathname === '/api/admin/permissions/temporary') {
    const body = await readJson(req)
    const required = ['docId', 'version', 'sectionId', 'principal', 'effect']
    for (const key of required) {
      if (!body[key]) throw new SearchError(400, 'MISSING_FIELD', `缺少字段：${key}`)
    }
    if (!['allow', 'deny'].includes(body.effect)) {
      throw new SearchError(400, 'INVALID_EFFECT', 'effect 只能是 allow 或 deny')
    }
    services.store.setTemporaryGrant({
      docId: body.docId,
      version: body.version,
      sectionId: body.sectionId,
      principal: body.principal,
      effect: body.effect,
      expiresAt: body.expiresAt ?? null
    })
    await services.store.save()
    return sendJson(res, { ok: true, note: '查询时立即生效；后台刷新负责清除旧索引 ACL。' })
  }

  if (req.method === 'POST' && pathname === '/api/admin/sections') {
    const body = await readJson(req)
    services.store.upsertSection(body)
    await services.store.save()
    return sendJson(res, { ok: true, note: '元数据变更不会自动发布尚未构建完成的新正文。' })
  }

  throw new SearchError(404, 'NOT_FOUND', `未找到接口：${pathname}`)
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(JSON.stringify(value))
}

function sendError(res, error) {
  if (error instanceof SyntaxError) {
    return sendJson(res, { error: { code: 'INVALID_JSON', message: '请求体不是合法 JSON' } }, 400)
  }
  const status = error.status ?? error.statusCode ?? 500
  return sendJson(res, {
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: error.message || '服务内部错误',
      details: error.details ?? {}
    }
  }, status)
}

export async function listen(options = {}) {
  const runtime = await createServer({
    dbPath: options.dbPath ?? path.resolve('data/search.db'),
    indexRoot: options.indexRoot ?? path.resolve('data/indexes')
  })
  return new Promise((resolve) => {
    runtime.server.listen(options.port ?? 5180, options.host ?? '127.0.0.1', () => resolve(runtime))
  })
}
