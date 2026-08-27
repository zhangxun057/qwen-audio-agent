import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRecordVoiceConfirmation } from '../src/conversation/record-presentation.mjs'

test('falls back to the complete saved fact instead of speaking only the action', () => {
  assert.equal(
    buildRecordVoiceConfirmation({
      action: '借出',
      content: '借出一把雨伞给客人使用。',
      facts: {},
      entities: [],
    }),
    '已记录：借出一把雨伞给客人使用。',
  )
})

test('repeats the room item quantity and unit in a standard loan receipt', () => {
  assert.equal(
    buildRecordVoiceConfirmation({
      action: '借出',
      content: '2016房已借出雨伞1把',
      facts: { itemName: '雨伞', quantity: 1, unit: '把' },
      entities: [
        { type: 'room', id: 'room:2016' },
        { type: 'item', id: 'item:umbrella' },
      ],
    }),
    '已记录：2016房，借出雨伞1把。',
  )
})

test('repeats the complete guest fact when two rooms have different roles', () => {
  assert.equal(
    buildRecordVoiceConfirmation({
      category: '客人',
      action: '投诉',
      content: '315房客人投诉801房夜间噪音太大，影响休息。',
      facts: { statement: '夜间噪音太大，影响休息' },
      entities: [
        { type: 'room', id: 'room:315', role: 'complainant' },
        { type: 'room', id: 'room:801', role: 'complaint_target' },
      ],
    }),
    '已记录：315房客人投诉801房夜间噪音太大，影响休息。',
  )
})
