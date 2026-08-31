#!/usr/bin/env node

import express from 'express'
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAtomicRecordStore } from '../server/src/atomic/atomic-record-store.mjs'
import { createAtomicSpaceProvider } from '../server/src/atomic/atomic-space-provider.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.HOTEL_RECORD_TEST_PORT || 3121)
const ownerId = String(process.env.HOTEL_RECORD_TEST_OWNER || 'hotel-record-test').trim()
const actorId = String(process.env.HOTEL_RECORD_TEST_ACTOR_ID || 'record-test-user').trim()
const actorName = String(process.env.HOTEL_RECORD_TEST_ACTOR_NAME || '测试员工').trim()
const indexDirectory = resolve(
  root,
  process.env.HOTEL_RECORD_TEST_INDEX_DIR || 'config/hotel-direct/atomic-space-mock',
)
const dataPath = resolve(
  root,
  process.env.HOTEL_RECORD_TEST_DATA || 'runtime/hotel-record-test/records.json',
)

mkdirSync(dirname(dataPath), { recursive: true })

const recordStore = createAtomicRecordStore({ filePath: dataPath })
const atomicSpace = createAtomicSpaceProvider({
  directory: indexDirectory,
  recordStore,
})

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '256kb' }))
app.use((request, response, next) => {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Hotel-Record-Test', 'local-only')
  next()
})

const context = () => ({
  ownerId,
  actorId,
  actorName,
})

function errorMessage(error) {
  return String(error?.message || error || '操作失败').trim()
}

function sendError(response, error, status = 400) {
  response.status(status).json({
    status: 'error',
    message: errorMessage(error),
    code: error?.code || 'record_test_error',
    ...(error?.missingFacts ? { missingFacts: error.missingFacts } : {}),
    ...(error?.anyEntityTypes ? { anyEntityTypes: error.anyEntityTypes } : {}),
    ...(error?.clarificationGuidance ? { clarificationGuidance: error.clarificationGuidance } : {}),
  })
}

app.get('/api/health', (_request, response) => {
  response.json({
    status: 'ok',
    mode: 'record-only-local',
    ownerId,
    dataPath,
    indexDirectory,
  })
})

app.get('/api/index', async (_request, response) => {
  try {
    response.json({ status: 'ok', index: await atomicSpace.getIndex() })
  } catch (error) {
    sendError(response, error, 500)
  }
})

app.get('/api/records', async (request, response) => {
  try {
    const filters = {}
    for (const key of [
      'category',
      'action',
      'objectType',
      'objectId',
      'keyword',
      'status',
      'from',
      'to',
    ]) {
      if (request.query[key]) filters[key] = request.query[key]
    }
    if (request.query.includeDeleted === 'true') filters.includeDeleted = true
    if (request.query.limit) filters.limit = request.query.limit
    const result = await atomicSpace.queryInstances({
      modelType: 'event',
      filters,
      context: { ownerId },
    })
    response.json({ status: 'ok', ...result })
  } catch (error) {
    sendError(response, error)
  }
})

app.post('/api/records/write', async (request, response) => {
  try {
    const body = request.body || {}
    const result = await atomicSpace.writeInstance({
      modelType: 'event',
      input: {
        category: body.category,
        action: body.action,
        content: body.content,
        facts: body.facts,
        entities: body.entities,
        occurredAt: body.occurredAt,
        details: body.details,
        status: body.status,
        sourceTrigger: 'manual',
        rawText: body.rawText,
        idempotencyKey: body.idempotencyKey,
      },
      context: context(),
    })
    response.json({ status: 'ok', ...result })
  } catch (error) {
    sendError(response, error)
  }
})

app.post('/api/records/correct', async (request, response) => {
  try {
    const body = request.body || {}
    const result = await atomicSpace.correctInstance({
      modelType: 'event',
      recordId: body.recordId,
      action: body.action || 'update',
      patch: body.patch || {},
      replacement: body.replacement || {},
      reason: body.reason,
      context: context(),
    })
    response.json({ status: 'ok', ...result })
  } catch (error) {
    sendError(response, error)
  }
})

app.use(express.static(resolve(root, 'test/hotel-record-test'), {
  index: 'index.html',
  extensions: ['html'],
}))

app.get('*', (_request, response) => {
  response.sendFile(resolve(root, 'test/hotel-record-test/index.html'))
})

const server = createServer(app)
server.listen(port, '127.0.0.1', () => {
  console.log(`酒店记事独立测试：http://127.0.0.1:${port}/`)
  console.log(`数据文件：${dataPath}`)
  console.log('此入口不连接语音、远程 WebSocket、任务系统或正式环境。')
})

function stop() {
  server.close(() => process.exit(0))
}

process.once('SIGINT', stop)
process.once('SIGTERM', stop)
