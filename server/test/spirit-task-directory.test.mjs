import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildSpiritTaskUsers,
  normalizeSpiritTaskSummary,
  resolveSpiritAssignee,
} from '../src/voice/spirit-task-directory.mjs'

test('normalizes a spoken hotel request into a compact task title', () => {
  assert.equal(
    normalizeSpiritTaskSummary('8201 房间要求送两瓶水'),
    '8201房送2瓶水',
  )
})

test('resolves an explicit staff name before room routing', () => {
  const assignee = resolveSpiritAssignee({
    assigneeName: '曲俊宇',
    roomNumber: '801',
  })

  assert.equal(assignee.userId, '2079529_hotel_10082')
  assert.equal(assignee.matchedBy, 'name')
})

test('accepts the common speech-to-text homophone for Liu Jiahao', () => {
  const assignee = resolveSpiritAssignee({ request: '给刘家豪派一个送水任务' })

  assert.equal(assignee.name, '刘嘉豪')
  assert.equal(assignee.userId, '2080056_hotel_10082')
})

test('maps configured room prefixes to demo floor owners', () => {
  const cases = [
    ['801', '黄维维'],
    ['8201', '黄维维'],
    ['1001', '黄维维'],
    ['1601', '刘嘉豪'],
    ['1701', '章栩媚'],
    ['1801', '汪桥'],
    ['1901', '吴镓松'],
    ['2001', '刘璇'],
    ['2101', '郭颖2'],
    ['2201', '刘至璇'],
    ['2301', '曲俊宇'],
    ['2401', '郭颖'],
    ['2501', '刘至璇'],
    ['2601', '刘至璇'],
    ['2801', '刘至璇'],
  ]

  for (const [roomNumber, expectedName] of cases) {
    assert.equal(
      resolveSpiritAssignee({ roomNumber }).name,
      expectedName,
      `${roomNumber} should route to ${expectedName}`,
    )
  }
})

test('builds creator and executor records required by Spirit', () => {
  const users = buildSpiritTaskUsers(resolveSpiritAssignee({ roomNumber: '801' }))

  assert.equal(users.length, 2)
  assert.equal(users[0].userRole, 'CREATOR')
  assert.equal(users[1].userRole, 'EXECUTOR')
  assert.equal(users[1].userId, '2078987_hotel_10082')
  assert.equal(users[1].channelCode, '10082')
})
