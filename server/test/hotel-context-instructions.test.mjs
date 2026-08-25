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
})

test('keeps the proven hotel-direct prompt only as a load-failure fallback', () => {
  const instructions = buildFrontendInstructions({
    toolProfile: HOTEL_DIRECT_TOOL_PROFILE,
  })

  assert.match(instructions, /<spirit_task_dispatch>/)
  assert.match(instructions, /1601房派刘嘉豪/)
  assert.doesNotMatch(instructions, /<enterprise_context/)
})
