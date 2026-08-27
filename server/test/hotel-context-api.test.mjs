import assert from 'node:assert/strict'
import { once } from 'node:events'
import { resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createGatewayApplication } from '../src/app/gateway-application.mjs'
import { HotelContextService } from '../src/context/hotel-context-service.mjs'
import { StaticHotelContextProvider } from '../src/context/static-hotel-context-provider.mjs'
import { config } from '../src/core/config.mjs'

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))

test('exposes the production-shaped Context Mock API without leaking its token', async t => {
  const provider = new StaticHotelContextProvider({
    directory: resolve(projectRoot, 'config/hotel-direct/context-mock'),
  })
  const contextService = new HotelContextService({
    mode: 'mock',
    contextId: 'hotel-10082-daily',
    userId: '2079697_hotel_10082',
    provider,
    mockProvider: provider,
    maxPromptChars: 32_000,
  })
  await contextService.warmup()
  const contextToken = 'test-context-service-token'
  const application = createGatewayApplication({
    config: {
      ...config,
      port: 0,
      contextServiceToken: contextToken,
    },
    contextService,
    parentPort: null,
    autoStart: false,
  })
  t.after(() => application.close())
  application.start()
  if (!application.server.listening) {
    await once(application.server, 'listening')
  }
  const address = application.server.address()
  const origin = `http://127.0.0.1:${address.port}`

  const unauthorized = await fetch(
    `${origin}/v1/voice-contexts/hotel-10082-daily?userId=2079697_hotel_10082`,
  )
  assert.equal(unauthorized.status, 401)

  const response = await fetch(
    `${origin}/v1/voice-contexts/hotel-10082-daily?userId=2079697_hotel_10082`,
    { headers: { Authorization: `Bearer ${contextToken}` } },
  )
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.contextId, 'hotel-10082-daily')
  assert.equal(body.subject.userId, '2079697_hotel_10082')
  assert.equal(body.subject.displayName, '张洵')
  assert.match(body.prompt, /当前登录用户：张洵/)
  assert.match(body.prompt, /当前用户 ID：2079697_hotel_10082/)
  assert.doesNotMatch(body.prompt, /张洵总裁|<spirit_task_dispatch>/)
  assert.match(body.contentHash, /^sha256:/)

  const mismatch = await fetch(
    `${origin}/v1/voice-contexts/hotel-10082-daily?userId=someone-else`,
    { headers: { Authorization: `Bearer ${contextToken}` } },
  )
  assert.equal(mismatch.status, 404)

  const healthResponse = await fetch(`${origin}/api/health`)
  const healthText = await healthResponse.text()
  assert.doesNotMatch(healthText, new RegExp(contextToken))
  const health = JSON.parse(healthText)
  assert.deepEqual({ ...health.contextService, promptChars: undefined }, {
    mode: 'mock',
    configured: true,
    contextId: 'hotel-10082-daily',
    version: '2026-08-26-08',
    subjectUserId: '2079697_hotel_10082',
    promptChars: undefined,
    status: 'ready',
    fallback: false,
    lastError: null,
  })
  assert.ok(health.contextService.promptChars > 5228)
})
