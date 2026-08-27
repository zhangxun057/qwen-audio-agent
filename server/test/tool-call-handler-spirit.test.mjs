import assert from 'node:assert/strict'
import test from 'node:test'
import { ToolCallHandler } from '../src/voice/tools/tool-call-handler.mjs'

function harness({ client = {}, notifier = null, transcript = '', enterpriseContext = {
  subject: { userId: '2079697_hotel_10082', displayName: '张洵' },
}, onTaskContextChanged = () => {}, directSpeech = false, taskNotificationWaitMs } = {}) {
  const outputs = []
  const spoken = []
  const messages = []
  const handler = new ToolCallHandler({
    taskManager: null,
    ownerId: 'owner-1',
    sessionId: 'session-1',
    transcripts: { transcript: async () => transcript },
    getEnterpriseContext: async () => enterpriseContext,
    getFrontend: () => ({
      sendFunctionOutput: async (...args) => outputs.push(args),
      ...(directSpeech ? {
        speak: async (...args) => {
          spoken.push(args)
          return { completed: true }
        },
      } : {}),
    }),
    getTurnId: () => 'turn-1',
    getTurnGeneration: () => 1,
    spiritTaskClient: client,
    spiritVoiceNotifier: notifier,
    taskNotificationWaitMs,
    onTaskContextChanged,
    onConversationMessage: message => messages.push(message),
  })
  return { handler, outputs, spoken, messages }
}

test('creates a normalized floor-routed task and returns one combined notification receipt', async () => {
  let payload
  let notificationInput
  const { handler, outputs, spoken, messages } = harness({
    client: {
      create: async value => {
        payload = value
        return { taskId: 'task-801' }
      },
    },
    notifier: {
      configured: true,
      notify: async value => {
        notificationInput = value
        return { status: 'sent', messageId: 'message-1' }
      },
    },
    directSpeech: true,
  })

  await handler.createSpiritTask('call-1', 'turn-1', {
    request: '8201 房间要求送两瓶水',
    roomNumber: '8201',
    notify: false,
  })

  assert.equal(payload.summary, '8201房送2瓶水')
  assert.equal(payload.users[0].userId, '2079697_hotel_10082')
  assert.equal(payload.users[0].userName, '张洵')
  assert.equal(payload.description, '8201 房间要求送两瓶水')
  assert.equal(payload.taskOpeningPrompt, '8201 房间要求送两瓶水')
  assert.equal(payload.originalRequest.requestPayload.text, '8201 房间要求送两瓶水')
  assert.equal(payload.status, 'IN_PROGRESS')
  assert.equal(payload.users[1].userName, '黄维维')
  assert.equal(notificationInput.recipientId, '2078987_hotel_10082')
  assert.equal(outputs[0][1].status, 'ok')
  assert.equal(outputs[0][1].notification.status, 'sent')
  assert.equal(spoken.length, 1)
  assert.equal(spoken[0][0], '已派给黄维维：8201房送2瓶水；通知已发送。')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].content, '已派给黄维维：8201房送2瓶水；通知已发送。')
})

test('returns after the notification wait limit without a second acknowledgement', async () => {
  const { handler, outputs, spoken, messages } = harness({
    client: {
      create: async () => ({ taskId: 'task-timeout' }),
    },
    notifier: {
      configured: true,
      notify: async () => new Promise(() => {}),
    },
    directSpeech: true,
    taskNotificationWaitMs: 5,
  })

  await handler.createSpiritTask('call-timeout', 'turn-1', {
    request: '8201 房间要求送两瓶水',
    roomNumber: '8201',
  })

  assert.equal(outputs[0][1].status, 'ok')
  assert.equal(outputs[0][1].notification.status, 'timeout')
  assert.equal(spoken.length, 1)
  assert.equal(spoken[0][0], '已派给黄维维：8201房送2瓶水；通知结果暂未确认。')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].content, '已派给黄维维：8201房送2瓶水；通知结果暂未确认。')

  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(spoken.length, 1)
  assert.equal(messages.length, 1)
})

test('confirms a standalone notification with recipient and message content', async () => {
  const { handler, outputs, spoken } = harness({
    notifier: {
      configured: true,
      notify: async () => ({ status: 'sent', messageId: 'message-notify' }),
    },
    directSpeech: true,
  })

  await handler.notifySpiritUser('call-notify', 'turn-1', {
    assigneeName: '吴镓松',
    text: '明早八点到前台开会',
  })

  assert.equal(outputs[0][1].status, 'ok')
  assert.equal(spoken[0][0], '已通知吴镓松：明早八点到前台开会。')
})

test('returns a single bounded receipt when a standalone notification times out', async () => {
  const { handler, outputs, spoken, messages } = harness({
    notifier: {
      configured: true,
      notify: async () => new Promise(() => {}),
    },
    directSpeech: true,
    taskNotificationWaitMs: 5,
  })

  await handler.notifySpiritUser('call-notify-timeout', 'turn-1', {
    assigneeName: '吴镓松',
    text: '明早八点到前台开会',
  })

  assert.equal(outputs[0][1].status, 'ok')
  assert.equal(outputs[0][1].notification.status, 'timeout')
  assert.equal(spoken.length, 1)
  assert.equal(messages.length, 1)
  assert.equal(spoken[0][0], '已向吴镓松发起通知：明早八点到前台开会；结果暂未确认。')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(spoken.length, 1)
})

test('does not require a preloaded room card when dispatching a 1501 task', async () => {
  let payload
  const { handler, outputs } = harness({
    client: {
      create: async value => {
        payload = value
        return { taskId: 'task-1501' }
      },
    },
    notifier: { configured: false },
  })

  await handler.createSpiritTask('call-1501', 'turn-1', {
    request: '1501房借一个充电宝',
    roomNumber: '1501',
  })

  assert.equal(payload.summary, '1501房借1个充电宝')
  assert.equal(payload.users[1].userName, '黄维维')
  assert.equal(outputs[0][1].status, 'ok')
})

test('resolves “给我自己” from the trusted login identity', async () => {
  let payload
  const { handler, outputs } = harness({
    client: {
      create: async value => {
        payload = value
        return { taskId: 'task-self-login' }
      },
    },
    notifier: { configured: false },
  })

  await handler.createSpiritTask('call-self-login', 'turn-1', {
    request: '创建一个测试任务，发给我自己：检查测试房间',
    assigneeName: '我自己',
  })

  assert.equal(payload.users[0].userId, '2079697_hotel_10082')
  assert.equal(payload.users[1].userId, '2079697_hotel_10082')
  assert.equal(payload.users[1].userName, '张洵')
  assert.equal(outputs[0][1].status, 'ok')
})

test('derives Spirit plan time and pending status in the Gateway', async () => {
  let payload
  const { handler } = harness({
    client: {
      create: async value => {
        payload = value
        return { taskId: 'task-plan-derived' }
      },
    },
    notifier: { configured: false },
  })

  await handler.createSpiritTask('call-plan-derived', 'turn-1', {
    request: '明天 09:00 给 8201 房送两瓶水',
    roomNumber: '8201',
    executeTime: '2026-08-22 09:00:00',
  })

  assert.equal(payload.status, 'PENDING_RECEIPT')
  assert.equal(payload.executeTime, '2026-08-22 09:00:00')
  assert.equal(payload.completeTime, '2026-08-22 09:07:00')
  assert.equal(payload.description.includes('09:07'), false)
})

test('derives the start time backward from a standard-action deadline', async () => {
  let payload
  const { handler } = harness({
    client: {
      create: async value => {
        payload = value
        return { taskId: 'task-plan-backward' }
      },
    },
    notifier: { configured: false },
  })

  await handler.createSpiritTask('call-plan-backward', 'turn-1', {
    request: '8201 房送水，今天 18 点前完成',
    roomNumber: '8201',
    completeTime: '2026-08-21 18:00:00',
  })

  assert.equal(payload.status, 'PENDING_RECEIPT')
  assert.equal(payload.executeTime, '2026-08-21 17:53:00')
  assert.equal(payload.completeTime, '2026-08-21 18:00:00')
})

test('publishes successful Spirit task results to short-term task memory', async () => {
  const changed = []
  const { handler } = harness({
    client: { create: async () => ({ taskId: 'task-memory' }) },
    notifier: { configured: false },
    onTaskContextChanged: output => changed.push(output),
  })
  await handler.createSpiritTask('call-memory', 'turn-1', {
    request: '8201房送两瓶水', roomNumber: '8201',
  })
  assert.equal(changed.length, 1)
  assert.equal(changed[0].taskId, 'task-memory')
  assert.equal(changed[0].action, 'created')
})

test('caps voice task queries at twenty records while the source client stays general', async () => {
  let query
  const { handler, outputs } = harness({
    client: {
      list: async args => {
        query = args
        return { total: 0, records: [] }
      },
    },
  })

  await handler.handleSpiritTask('call-list', 'turn-1', 'spirit_task_list', {
    requestNum: 100,
  })

  assert.equal(query.requestNum, 20)
  assert.equal(outputs[0][1].status, 'ok')
})

test('projects Spirit status enums into stable voice-facing labels', async () => {
  const { handler, outputs } = harness({
    client: {
      list: async () => ({
        total: 1,
        records: [{
          taskId: 'task-status-label',
          summary: '状态字段测试',
          status: 'PENDING_ADMISSION',
          users: [{ userId: 'u-1', userName: '张洵', userRole: 'EXECUTOR' }],
        }],
      }),
    },
  })

  await handler.handleSpiritTask('call-status-label', 'turn-1', 'spirit_task_list', {
    keyword: '状态字段测试',
  })

  assert.equal(outputs[0][1].result.records[0].statusLabel, '待受理')
  assert.equal(outputs[0][1].result.records[0].executor.userName, '张洵')
})

test('creates an isolated self-test task without notifying staff', async () => {
  let payload
  let notified = false
  const { handler, outputs } = harness({
    client: {
      create: async value => {
        payload = value
        return { taskId: 'task-self-test' }
      },
    },
    notifier: {
      configured: true,
      notify: async () => {
        notified = true
        return { status: 'sent' }
      },
    },
  })

  await handler.createSpiritTask('call-self-test', 'turn-1', {
    request: '创建一个全双工自测任务，不通知任何人',
    summary: '全双工模型工具调用自测',
    selfTest: true,
  })

  assert.equal(payload.users[1].userId, 'demo-user-hotel-10082')
  assert.equal(payload.users[0].userName, '张洵')
  assert.equal(payload.users[1].userName, '语音助手自测')
  assert.equal(notified, false)
  assert.equal(outputs[0][1].notification.status, 'disabled')
})

test('rejects self-test mode when the request is not an explicit test', async () => {
  let created = false
  const { handler, outputs } = harness({
    client: {
      create: async () => {
        created = true
        return { taskId: 'unexpected' }
      },
    },
  })

  await handler.createSpiritTask('call-invalid-self-test', 'turn-1', {
    request: '给客房送两瓶水',
    selfTest: true,
  })

  assert.equal(created, false)
  assert.equal(outputs[0][1].error_code, 'task_create_failed')
})

test('refuses ordinary creation when the session has no trusted login identity', async () => {
  let created = false
  const { handler, outputs } = harness({
    enterpriseContext: { subject: {} },
    client: {
      create: async () => {
        created = true
        return { taskId: 'unexpected' }
      },
    },
  })

  await handler.createSpiritTask('call-no-identity', 'turn-1', {
    request: '8201房送两瓶水',
    roomNumber: '8201',
  })

  assert.equal(created, false)
  assert.equal(outputs[0][1].error_code, 'task_create_failed')
  assert.match(outputs[0][1].user_message, /登录身份/)
})

test('updates a task with a deterministic assignee mapping', async () => {
  let payload
  const { handler, outputs } = harness({
    client: {
      update: async value => {
        payload = value
        return null
      },
    },
  })

  await handler.updateSpiritTask('call-2', 'turn-1', {
    taskId: 'task-1',
    status: 'DONE',
    assigneeName: '曲俊宇',
  })

  assert.equal(payload.taskId, 'task-1')
  assert.equal(payload.status, 'DONE')
  assert.equal(payload.executors[0].userId, '2079529_hotel_10082')
  assert.equal(outputs[0][1].action, 'updated')
})

test('resolves a natural task reference from short-term task facts without asking for taskId', async () => {
  let receivedTaskId = ''
  const { handler, outputs } = harness({
    client: {
      update: async value => {
        receivedTaskId = value.taskId
        return { updated: true }
      },
    },
  })
  handler.getTaskContext = () => [{
    taskId: 'task-604',
    summary: '604房住中清洁预约',
    status: 'IN_PROGRESS',
  }]

  await handler.updateSpiritTask('call-reference', 'turn-1', {
    reference: '604房那个任务',
    description: '请在住客允许时完成清洁',
  })

  assert.equal(receivedTaskId, 'task-604')
  assert.equal(outputs[0][1].action, 'updated')
})

test('updates plan complete time through the task update intent', async () => {
  let call
  const { handler, outputs } = harness({
    client: {
      detail: async () => ({
        acceptTime: null,
        executeTime: null,
        completeTime: null,
      }),
      updatePlanTime: async (...args) => {
        call = args
        return { updated: true }
      },
    },
  })
  handler.getTaskContext = () => [{
    taskId: 'task-plan',
    summary: '801房送水',
  }]

  await handler.updateSpiritTask('call-plan', 'turn-1', {
    reference: '801房送水',
    completeTime: '2026-08-21 18:00:00',
  })

  assert.deepEqual(call, [
    'task-plan',
    {
      acceptTime: null,
      executeTime: null,
      completeTime: '2026-08-21 18:00:00',
    },
  ])
  assert.equal(outputs[0][1].action, 'updated')
})

test('notifies the new executor immediately after reassignment', async () => {
  let notificationInput
  const { handler, outputs } = harness({
    client: { update: async () => ({ updated: true }) },
    notifier: {
      configured: true,
      notify: async value => {
        notificationInput = value
        return { status: 'sent', messageId: 'reassign-message' }
      },
    },
  })

  await handler.updateSpiritTask('call-reassign', 'turn-1', {
    taskId: 'task-401',
    assigneeName: '吴镓松',
  })

  assert.equal(notificationInput.recipientId, '2078921_hotel_10082')
  assert.equal(notificationInput.title, '工作通知')
  assert.equal(outputs[0][1].notification.status, 'sent')
  assert.equal(outputs[0][2].taskId, 'task-401')
})

test('bounds lifecycle notification waits as well as task creation waits', async () => {
  const { handler, outputs } = harness({
    client: {
      update: async () => ({ updated: true }),
    },
    notifier: {
      configured: true,
      notify: async () => new Promise(() => {}),
    },
    taskNotificationWaitMs: 5,
  })

  await handler.updateSpiritTask('call-reassign-timeout', 'turn-1', {
    taskId: 'task-401',
    assigneeName: '吴镓松',
  })

  assert.equal(outputs[0][1].action, 'updated')
  assert.equal(outputs[0][1].notification.status, 'timeout')
})

test('starts and completes tasks through the dedicated lifecycle endpoints', async () => {
  const calls = []
  const { handler, outputs } = harness({
    client: {
      start: async taskId => calls.push(['start', taskId]),
      complete: async (taskId, remark) => calls.push(['complete', taskId, remark]),
    },
  })

  await handler.startSpiritTask('call-start', 'turn-1', { taskId: 'task-1' })
  await handler.completeSpiritTask('call-complete', 'turn-1', {
    taskId: 'task-1',
    completionRemark: '房间检查完成',
  })

  assert.deepEqual(calls, [
    ['start', 'task-1'],
    ['complete', 'task-1', '房间检查完成'],
  ])
  assert.equal(outputs[0][1].action, 'started')
  assert.equal(outputs[1][1].action, 'completed')
})

test('updates a supported status and rejects invented status values', async () => {
  const calls = []
  const { handler, outputs } = harness({
    client: {
      updateStatus: async (taskId, status) => calls.push([taskId, status]),
    },
  })

  await handler.updateSpiritTaskStatus('call-status', 'turn-1', {
    taskId: 'task-1',
    targetStatus: 'EXCEPTION',
  })
  await handler.updateSpiritTaskStatus('call-invalid-status', 'turn-1', {
    taskId: 'task-1',
    targetStatus: 'CANCELLED',
  })

  assert.deepEqual(calls, [['task-1', 'EXCEPTION']])
  assert.equal(outputs[0][1].action, 'status_updated')
  assert.equal(outputs[1][1].error_code, 'task_status_update_failed')
})

test('adds a bounded execution record without inventing operator identity', async () => {
  let received
  const { handler, outputs } = harness({
    client: {
      addComment: async (...args) => {
        received = args
        return null
      },
    },
  })

  await handler.addSpiritTaskComment('call-comment', 'turn-1', {
    taskId: 'task-1',
    content: '查房发现电视无法开机',
    recordSource: 'USER_DIALOGUE',
  })

  assert.deepEqual(received, ['task-1', '查房发现电视无法开机', 'USER_DIALOGUE'])
  assert.equal(outputs[0][1].action, 'comment_added')
})

test('rejects deletion unless the current user turn explicitly says delete', async () => {
  let deleted = false
  const { handler, outputs } = harness({
    client: {
      delete: async () => {
        deleted = true
        return null
      },
    },
    transcript: '把这个任务给我看看',
  })

  await handler.deleteSpiritTask('call-3', 'turn-1', {
    taskId: 'task-1',
    confirmed: true,
  })

  assert.equal(deleted, false)
  assert.equal(outputs[0][1].error_code, 'task_delete_failed')
})

test('deletes only after an explicit current-turn confirmation', async () => {
  let deletedTaskId = ''
  const { handler, outputs } = harness({
    client: {
      delete: async taskId => {
        deletedTaskId = taskId
        return null
      },
    },
    transcript: '确认删除这个任务',
  })

  await handler.deleteSpiritTask('call-4', 'turn-1', {
    taskId: 'task-1',
    confirmed: true,
  })

  assert.equal(deletedTaskId, 'task-1')
  assert.equal(outputs[0][1].action, 'deleted')
})
