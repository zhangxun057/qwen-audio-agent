import assert from 'node:assert/strict'
import test from 'node:test'
import { ToolCallHandler } from '../src/voice/tools/tool-call-handler.mjs'

function harness({ client = {}, notifier = null, transcript = '' } = {}) {
  const outputs = []
  const handler = new ToolCallHandler({
    taskManager: null,
    ownerId: 'owner-1',
    sessionId: 'session-1',
    transcripts: { transcript: async () => transcript },
    getFrontend: () => ({
      sendFunctionOutput: async (...args) => outputs.push(args),
    }),
    getTurnId: () => 'turn-1',
    getTurnGeneration: () => 1,
    spiritTaskClient: client,
    spiritVoiceNotifier: notifier,
  })
  return { handler, outputs }
}

test('creates a normalized floor-routed task and notifies the selected executor', async () => {
  let payload
  let notificationInput
  const { handler, outputs } = harness({
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
  })

  await handler.createSpiritTask('call-1', 'turn-1', {
    request: '8201 房间要求送两瓶水',
    roomNumber: '8201',
  })

  assert.equal(payload.summary, '8201房送2瓶水')
  assert.equal(payload.description, '8201 房间要求送两瓶水')
  assert.equal(payload.taskOpeningPrompt, '8201 房间要求送两瓶水')
  assert.equal(payload.originalRequest.requestPayload.text, '8201 房间要求送两瓶水')
  assert.equal(payload.status, 'IN_PROGRESS')
  assert.equal(payload.users[1].userName, '黄维维')
  assert.equal(notificationInput.recipientId, '2078987_hotel_10082')
  assert.equal(outputs[0][1].status, 'ok')
  assert.equal(outputs[0][1].notification.status, 'sent')
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

  assert.equal(payload.users[1].userId, '2079698_hotel_10082')
  assert.equal(payload.users[1].userName, '全双工语音助手')
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
