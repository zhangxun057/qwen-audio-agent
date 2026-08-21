import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createSpiritTaskClientFromEnvironment,
  SpiritTaskDirectClient,
} from '../src/voice/spirit-task-direct.mjs'

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('reads Spirit tasks directly through the service API with bearer auth', async () => {
  const calls = []
  const client = new SpiritTaskDirectClient({
    baseUrl: 'https://spirit.example.test/hotelAi/dify/hotel/v2',
    bearerToken: 'service-token',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return jsonResponse({ success: true, data: { total: 0, records: [] } })
    },
  })

  const first = await client.list({ requestNum: 5 })
  const second = await client.list({ pageNo: 2 })

  assert.deepEqual(first, { total: 0, records: [] })
  assert.deepEqual(second, { total: 0, records: [] })
  assert.equal(calls.length, 2)
  assert.match(calls[0].url, /\/hotelAi\/dify\/hotel\/v2\/task\/list\?pageNo=1&requestNum=5&taskView=ALL$/)
  assert.equal(calls[0].init.headers.Authorization, 'Bearer service-token')
  assert.equal(calls[0].init.headers['X-User-Id'], undefined)
  assert.equal(calls[0].init.headers.accesstoken, undefined)
})

test('reports service authentication failures without attempting a web login', async () => {
  let requests = 0
  const client = new SpiritTaskDirectClient({
    baseUrl: 'https://spirit.example.test/hotelAi/dify/hotel/v2',
    bearerToken: 'expired-token',
    fetchImpl: async () => {
      requests += 1
      return jsonResponse({ message: 'expired' }, 401)
    },
  })

  await assert.rejects(client.list(), /expired/)
  assert.equal(requests, 1)
})

test('writes Spirit tasks and checks notification gates through the same service API', async () => {
  const calls = []
  const client = new SpiritTaskDirectClient({
    baseUrl: 'https://spirit.example.test/hotelAi/dify/hotel/v2',
    bearerToken: 'service-token',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (url.includes('/work-shifts/on-duty')) {
        return jsonResponse({ success: true, data: { onDuty: true } })
      }
      if (url.includes('/notifications/status')) {
        return jsonResponse({ success: true, data: { enabled: true } })
      }
      if (url.endsWith('/task')) {
        return jsonResponse({ success: true, data: { taskId: 'task-1' } })
      }
      return jsonResponse({ success: true, data: null })
    },
  })

  assert.deepEqual(await client.create({ summary: '801房送水' }), { taskId: 'task-1' })
  await client.update({ taskId: 'task-1', status: 'DONE' })
  await client.delete('task-1')
  assert.deepEqual(await client.notificationGates('2078987_hotel_10082'), {
    passed: true,
    onDutyCheckSkipped: false,
    onDuty: true,
    notifyEnabled: true,
  })

  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { summary: '801房送水' })
  assert.match(calls[2].url, /\/task\/task-1$/u)
  assert.equal(calls[2].init.method, 'POST')
})

test('can skip the on-duty request while retaining the notification switch gate', async () => {
  const calls = []
  const client = new SpiritTaskDirectClient({
    baseUrl: 'https://spirit.example.test/hotelAi/dify/hotel/v2',
    bearerToken: 'service-token',
    fetchImpl: async url => {
      calls.push(url)
      if (url.includes('/work-shifts/on-duty')) {
        throw new Error('on-duty endpoint must not be called')
      }
      return jsonResponse({ success: true, data: { enabled: true } })
    },
  })

  assert.deepEqual(
    await client.notificationGates(
      '2078987_hotel_10082',
      undefined,
      { checkOnDuty: false },
    ),
    {
      passed: true,
      onDutyCheckSkipped: true,
      onDuty: null,
      notifyEnabled: true,
    },
  )
  assert.equal(calls.length, 1)
  assert.match(calls[0], /\/notifications\/status/u)
})

test('removes launch secrets from the environment after creating the client', () => {
  const env = {
    SPIRIT_API_BASE_URL: 'https://spirit.example.test/hotelAi/dify/hotel/v2',
    SPIRIT_BEARER_TOKEN: 'service-token',
    SPIRIT_ACCESS_TOKEN: 'trusted-access-token',
    SPIRIT_USERNAME: 'obsolete-user',
    SPIRIT_PASSWORD: 'obsolete-password',
  }

  const client = createSpiritTaskClientFromEnvironment(env)

  assert.equal(client.configured, true)
  assert.equal(env.SPIRIT_BEARER_TOKEN, undefined)
  assert.equal(env.SPIRIT_ACCESS_TOKEN, undefined)
  assert.equal(env.SPIRIT_USERNAME, undefined)
  assert.equal(env.SPIRIT_PASSWORD, undefined)
})

test('fails clearly when the direct service bearer token is absent', async () => {
  const client = new SpiritTaskDirectClient({
    baseUrl: 'https://spirit.example.test/hotelAi/dify/hotel/v2',
  })

  await assert.rejects(client.list(), /SPIRIT_BEARER_TOKEN/)
})
