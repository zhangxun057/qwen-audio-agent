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

test('preserves the source plugin contracts for task lifecycle and execution records', async () => {
  const calls = []
  const client = new SpiritTaskDirectClient({
    baseUrl: 'https://spirit.example.test/hotelAi/dify/hotel/v2',
    bearerToken: 'service-token',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return jsonResponse({ success: true, data: null })
    },
  })

  await client.start('task-1')
  await client.complete('task-1', '房间检查完成')
  await client.updateStatus('task-1', 'PENDING_APPROVAL')
  await client.updatePlanTime('task-1', {
    acceptTime: '2026-08-21 09:00:00',
    executeTime: null,
    completeTime: '2026-08-21 10:00:00',
  })
  await client.updateDailySummary('task-1', '今日处理记录', true)
  await client.workload('user-1,user-2', 'ALL')
  await client.addComment('task-1', '现场发现灯具损坏', 'USER_DIALOGUE')
  await client.detailByConversation('conversation-1')

  assert.deepEqual(
    calls.map(call => [
      new URL(call.url).pathname,
      call.init.method,
      call.init.body ? JSON.parse(call.init.body) : undefined,
    ]),
    [
      ['/hotelAi/dify/hotel/v2/task/start', 'POST', { taskId: 'task-1' }],
      ['/hotelAi/dify/hotel/v2/task/complete', 'POST', {
        taskId: 'task-1', completionRemark: '房间检查完成',
      }],
      ['/hotelAi/dify/hotel/v2/task/ai-update-status', 'POST', {
        taskId: 'task-1', targetStatus: 'PENDING_APPROVAL',
      }],
      ['/hotelAi/dify/hotel/v2/task/plan-time', 'POST', {
        taskId: 'task-1',
        planTime: {
          acceptTime: '2026-08-21 09:00:00',
          executeTime: null,
          completeTime: '2026-08-21 10:00:00',
        },
      }],
      ['/hotelAi/dify/hotel/v2/task/daily-summary', 'POST', {
        taskId: 'task-1', content: '今日处理记录', fullReplace: true,
      }],
      ['/hotelAi/dify/hotel/v2/task/today-workload', 'POST', {
        userIds: 'user-1,user-2', queryType: 'ALL',
      }],
      ['/hotelAi/dify/hotel/v2/task/execution-record', 'POST', {
        taskId: 'task-1', recordSource: 'USER_DIALOGUE', content: '现场发现灯具损坏',
      }],
      ['/hotelAi/dify/hotel/v2/task/detailByConversationId', 'GET', undefined],
    ],
  )
  assert.equal(new URL(calls.at(-1).url).searchParams.get('conversationId'), 'conversation-1')
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

test('validates source limits and enums before sending a request', async () => {
  let requests = 0
  const client = new SpiritTaskDirectClient({
    baseUrl: 'https://spirit.example.test/hotelAi/dify/hotel/v2',
    bearerToken: 'service-token',
    fetchImpl: async () => {
      requests += 1
      return jsonResponse({ success: true, data: null })
    },
  })

  assert.throws(() => client.list({ requestNum: 101 }), /每页数量/)
  assert.throws(() => client.list({ taskView: 'RECENT' }), /任务视图/)
  assert.throws(() => client.list({ executeTimeFrom: '2026-08-21' }), /yyyy-MM-dd/)
  assert.throws(() => client.create({ summary: '', users: {} }), /任务标题/)
  assert.throws(() => client.updateStatus('task-1', 'CANCELLED'), /目标状态/)
  assert.throws(() => client.addComment('task-1', 'x'.repeat(4_001)), /4000/)
  assert.equal(requests, 0)
})
