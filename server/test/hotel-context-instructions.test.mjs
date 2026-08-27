import assert from 'node:assert/strict'
import test from 'node:test'
import { dashscopeProvider } from '../src/voice/providers/dashscope.mjs'
import {
  HOTEL_DIRECT_TOOL_PROFILE,
  buildFrontendInstructions,
} from '../src/voice/realtime-provider.mjs'

function enterpriseContext(version, marker) {
  return {
    contextId: 'hotel-10082-daily',
    version,
    subject: { userId: 'demo-user-hotel-10082' },
    prompt: `<daily_hotel_context>${marker}</daily_hotel_context>`,
  }
}

test('places the Context Service payload in the initial Realtime instructions', () => {
  const session = dashscopeProvider.buildSession({
    configured: true,
    agentContext: {
      toolProfile: HOTEL_DIRECT_TOOL_PROFILE,
      enterpriseContext: enterpriseContext('context-v1', 'MOCK_CONTEXT_V1'),
    },
  })

  assert.match(session.instructions, /<enterprise_context/)
  assert.match(session.instructions, /context_id="hotel-10082-daily"/)
  assert.match(session.instructions, /version="context-v1"/)
  assert.match(session.instructions, /MOCK_CONTEXT_V1/)
  assert.doesNotMatch(session.instructions, /<spirit_task_dispatch>/)
})

test('rebuilds instructions with the new context instead of appending versions', () => {
  const first = buildFrontendInstructions({
    toolProfile: HOTEL_DIRECT_TOOL_PROFILE,
    enterpriseContext: enterpriseContext('context-v1', 'MOCK_CONTEXT_V1'),
  })
  const second = buildFrontendInstructions({
    toolProfile: HOTEL_DIRECT_TOOL_PROFILE,
    enterpriseContext: enterpriseContext('context-v2', 'MOCK_CONTEXT_V2'),
  })

  assert.match(first, /MOCK_CONTEXT_V1/)
  assert.match(second, /MOCK_CONTEXT_V2/)
  assert.doesNotMatch(second, /MOCK_CONTEXT_V1|version="context-v1"/)
  // The tenant prompt can be older than the Gateway runtime.  The compact
  // atomic-record rules must still be appended so open-world rooms/locations
  // cannot be rejected by stale daily context.
  assert.match(second, /特殊物资未命中时也照常记录/u)
  assert.match(second, /失物不是独立类别：客人说丢了东西，记客人“报失”/u)
  assert.match(second, /其他类不要求额外对象或结构化维度/u)
  assert.match(second, /不得连续重复上一轮问题/u)
})

test('keeps the proven hotel-direct prompt only as a load-failure fallback', () => {
  const instructions = buildFrontendInstructions({
    toolProfile: HOTEL_DIRECT_TOOL_PROFILE,
  })

  assert.match(instructions, /<spirit_task_dispatch>/)
  assert.match(instructions, /1601房派刘嘉豪/)
  assert.match(instructions, /任务工具和 atomic_record_write 在同一轮互斥/u)
  assert.match(instructions, /盘点是待执行动作/u)
  assert.doesNotMatch(instructions, /<enterprise_context/)
})

test('injects progressive record clarification without a fixed question template', () => {
  const instructions = buildFrontendInstructions({
    toolProfile: HOTEL_DIRECT_TOOL_PROFILE,
    pendingRecordContext: {
      action: '投诉',
      content: '客人投诉房间太吵',
      facts: { statement: '房间太吵' },
      guidance: '还需要能够定位具体投诉人的线索',
      entityHints: ['房号', '客人姓名', '具体订单号', '入住日期'],
    },
  })

  assert.match(instructions, /<pending_record_clarification>/u)
  assert.match(instructions, /客人投诉房间太吵/u)
  assert.match(instructions, /由你根据上下文自己组织/u)
  assert.match(instructions, /不得重复上一轮原句/u)
  assert.match(instructions, /明天入住的李先生携程订单/u)
  assert.match(instructions, /立即重新调用 atomic_record_write/u)
  assert.match(instructions, /不能为了获得更完整资料继续盘问用户/u)
  assert.doesNotMatch(instructions, /是哪个房间、哪位客人或哪张订单投诉的？/u)
})
