import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  HotelContextService,
} from '../src/context/hotel-context-service.mjs'
import { HttpHotelContextProvider } from '../src/context/http-hotel-context-provider.mjs'
import { StaticHotelContextProvider } from '../src/context/static-hotel-context-provider.mjs'

const NOW = new Date('2026-08-21T08:00:00.000Z')

function payload(overrides = {}) {
  return {
    contextId: 'hotel-test-daily',
    version: 'v1',
    generatedAt: '2026-08-21T06:00:00.000Z',
    expiresAt: '2026-08-22T06:00:00.000Z',
    subject: {
      userId: 'hotel-user-1',
      displayName: '测试用户',
      hotelId: 'hotel-test',
    },
    sections: { routing: '16楼派给测试员工' },
    prompt: '<daily_context>CONTEXT_MARKER_V1</daily_context>',
    estimatedTokens: 120,
    ...overrides,
  }
}

async function fixture(t, value = payload()) {
  const directory = await mkdtemp(join(tmpdir(), 'hotel-context-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(
    join(directory, 'hotel-test-daily.json'),
    JSON.stringify(value),
    'utf8',
  )
  return {
    directory,
    provider: new StaticHotelContextProvider({ directory }),
  }
}

function service(provider, options = {}) {
  return new HotelContextService({
    mode: options.mode || 'mock',
    contextId: 'hotel-test-daily',
    userId: 'hotel-user-1',
    provider,
    fallbackProvider: options.fallbackProvider || null,
    mockProvider: options.mockProvider || provider,
    maxPromptChars: options.maxPromptChars || 1000,
    now: () => NOW,
  })
}

test('loads a static context by contextId and trusted userId', async t => {
  const { provider } = await fixture(t)
  const contextService = service(provider)
  const context = await contextService.getContext()

  assert.equal(context.contextId, 'hotel-test-daily')
  assert.equal(context.subject.userId, 'hotel-user-1')
  assert.match(context.contentHash, /^sha256:[a-f0-9]{64}$/)
  assert.deepEqual(contextService.health(), {
    mode: 'mock',
    configured: true,
    contextId: 'hotel-test-daily',
    version: 'v1',
    subjectUserId: 'hotel-user-1',
    promptChars: 48,
    status: 'ready',
    fallback: false,
    lastError: null,
  })
})

test('rejects a context requested for another user', async t => {
  const { provider } = await fixture(t)
  await assert.rejects(
    service(provider).getContext({ userId: 'hotel-user-2' }),
    error => error.code === 'CONTEXT_NOT_FOUND' && error.status === 404,
  )
})

test('reports a missing contextId without escaping the mock directory', async t => {
  const { provider } = await fixture(t)
  await assert.rejects(
    service(provider).getContext({ contextId: 'missing-context' }),
    error => error.code === 'CONTEXT_NOT_FOUND' && error.status === 404,
  )
  await assert.rejects(
    provider.getContext({ contextId: '../outside' }),
    error => error.code === 'INVALID_CONTEXT_ID' && error.status === 400,
  )
})

test('rejects expired and oversized prompt payloads', async t => {
  const expired = await fixture(t, payload({
    expiresAt: '2026-08-21T07:00:00.000Z',
  }))
  await assert.rejects(
    service(expired.provider).getContext(),
    error => error.code === 'CONTEXT_EXPIRED' && error.status === 410,
  )

  await writeFile(
    join(expired.directory, 'hotel-test-daily.json'),
    JSON.stringify(payload({ prompt: 'x'.repeat(101) })),
    'utf8',
  )
  await assert.rejects(
    service(expired.provider, { maxPromptChars: 100 }).getContext(),
    error => error.code === 'CONTEXT_TOO_LARGE' && error.status === 413,
  )
})

test('falls back to the static provider after an external service timeout', async t => {
  const { provider: fallbackProvider } = await fixture(t)
  const remoteProvider = new HttpHotelContextProvider({
    baseUrl: 'https://context.example.test',
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    }),
  })
  const contextService = service(remoteProvider, {
    mode: 'http',
    fallbackProvider,
    mockProvider: fallbackProvider,
  })
  const context = await contextService.getContext()

  assert.equal(context.version, 'v1')
  assert.equal(contextService.health().fallback, true)
  assert.equal(contextService.health().status, 'ready')
  assert.match(contextService.health().lastError, /超时|取消/)
})
