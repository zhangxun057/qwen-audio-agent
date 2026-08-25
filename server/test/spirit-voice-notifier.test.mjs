import assert from 'node:assert/strict'
import test from 'node:test'
import { SpiritVoiceNotifier } from '../src/voice/spirit-voice-notifier.mjs'

function notifier({ gate = { onDuty: true, notifyEnabled: true } } = {}) {
  const calls = []
  const gateCalls = []
  const value = new SpiritVoiceNotifier({
    spiritTaskClient: {
      notificationGates: async (userId, signal, options = {}) => {
        gateCalls.push({ userId, signal, options })
        const skipsDuty = options.checkOnDuty === false
        return {
          passed: gate.notifyEnabled === true && (skipsDuty || gate.onDuty === true),
          onDutyCheckSkipped: skipsDuty,
          onDuty: skipsDuty ? null : gate.onDuty === true,
          notifyEnabled: gate.notifyEnabled === true,
          userId,
        }
      },
    },
    ttsApiKey: 'tts-secret',
    uploadUrl: 'https://upload.example.test/audio',
    uploadToken: 'upload-secret',
    appKey: 'app-key',
    appMasterSecret: 'master-secret',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (url.includes('/tts/')) {
        const data = Buffer.from('audio-bytes').toString('base64')
        return new Response(`${JSON.stringify({ data })}\n`)
      }
      if (url.includes('upload.example.test')) {
        return new Response(JSON.stringify({
          data: { fileUrl: 'https://cdn.example.test/voice/demo.wav' },
        }), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        ret: 'SUCCESS',
        data: { msg_id: 'message-1' },
      }), { headers: { 'Content-Type': 'application/json' } })
    },
  })
  return { value, calls, gateCalls }
}

test('skips the on-duty check, generates audio, uploads it and sends an alias push', async () => {
  const { value, calls, gateCalls } = notifier({
    gate: { onDuty: false, notifyEnabled: true },
  })
  const result = await value.notify({
    recipientId: '2078987_hotel_10082',
    recipientName: '黄维维',
    text: '您有一个新任务【801房送2瓶水】，请立即执行。',
  })

  assert.equal(result.status, 'sent')
  assert.equal(result.messageId, 'message-1')
  assert.deepEqual(gateCalls[0].options, { checkOnDuty: false })
  assert.equal(calls.length, 3)
  const push = JSON.parse(calls[2].init.body)
  assert.equal(push.alias, '2078987')
  assert.equal(push.payload.extra.audioUrl, 'https://cdn.example.test/voice/demo.wav')
  assert.match(push.payload.body.text, /\|demo$/u)
})

test('does not call paid notification services when a gate is closed', async () => {
  const { value, calls } = notifier({
    gate: { onDuty: true, notifyEnabled: false },
  })
  const result = await value.notify({
    recipientId: '2079435_hotel_10082',
    recipientName: '刘璇',
    text: '测试提醒',
  })

  assert.equal(result.status, 'skipped_by_gate')
  assert.equal(calls.length, 0)
})
