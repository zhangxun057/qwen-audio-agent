import assert from 'node:assert/strict'
import test from 'node:test'
import { ConversationSync } from '../src/conversation/conversation-sync.mjs'

test('keeps recent voice context isolated by owner and voice session', () => {
  const sync = new ConversationSync()
  sync.record({
    ownerId: 'owner-one',
    sessionId: 'voice-one',
    id: 'user-one',
    role: 'user',
    content: '继续首页',
    source: 'voice-user',
  })
  sync.record({
    ownerId: 'owner-two',
    sessionId: 'voice-one',
    id: 'user-two',
    role: 'user',
    content: '其他人的内容',
    source: 'voice-user',
  })
  assert.deepEqual(
    sync.frontendContext({
      ownerId: 'owner-one',
      sessionId: 'voice-one',
    }).map(item => item.content),
    ['继续首页'],
  )
})

test('deduplicates the same message id and retains agent presentations', () => {
  const sync = new ConversationSync()
  const input = {
    ownerId: 'owner',
    sessionId: 'voice',
    id: 'same',
    role: 'assistant',
    content: '完成',
    source: 'agent-presentation',
    taskId: 'work-one',
  }
  sync.record(input)
  sync.record(input)
  assert.equal(sync.list({ ownerId: 'owner', sessionId: 'voice' }).length, 1)
  assert.equal(
    sync.frontendContext({ ownerId: 'owner', sessionId: 'voice' })[0].content,
    '完成',
  )
})

test('recognizes equivalent assistant speech only within the same voice turn', () => {
  const sync = new ConversationSync()
  sync.record({
    ownerId: 'owner',
    sessionId: 'voice',
    id: 'acknowledgement',
    role: 'assistant',
    content: '正在修改贪吃蛇，让它更酷炫！',
    source: 'realtime-direct',
    turnId: 'turn-one',
  })

  assert.equal(sync.hasEquivalentAssistantSpeech({
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: 'turn-one',
    content: '正在修改贪吃蛇，让它更酷炫。',
  }), true)
  assert.equal(sync.hasEquivalentAssistantSpeech({
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: 'turn-two',
    content: '正在修改贪吃蛇，让它更酷炫。',
  }), false)
  assert.equal(sync.hasEquivalentAssistantSpeech({
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: 'turn-one',
    content: '正在修改登录页面的颜色。',
  }), false)
})

test('recognizes a detailed delegated acknowledgement as the same action preview', () => {
  const sync = new ConversationSync()
  sync.record({
    ownerId: 'owner',
    sessionId: 'voice',
    id: 'progress-preview',
    role: 'assistant',
    content: '正在检查当前目录的项目进度。',
    source: 'realtime-direct',
    turnId: 'turn-progress',
  })

  assert.equal(sync.hasEquivalentAssistantSpeech({
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: 'turn-progress',
    content: '好的老大，我已经开始检查你当前这个 qwen-audio-agent 项目的进度了，会看一下 git 分支、未提交改动和最近提交。',
  }), true)
})

test('keeps bounded recent task facts for follow-up references', () => {
  const sync = new ConversationSync()
  sync.recordTaskFact({
    ownerId: 'owner', sessionId: 'voice', taskId: 'task-1',
    summary: '8201房送2瓶水', status: 'IN_PROGRESS', assignee: '黄维维',
  })
  sync.recordTaskFact({
    ownerId: 'owner', sessionId: 'voice', taskId: 'task-1',
    status: 'DONE', note: '已送达',
  })
  let facts = sync.taskContext({ ownerId: 'owner', sessionId: 'voice' })
  assert.equal(facts.length, 1)
  assert.equal(facts[0].summary, '8201房送2瓶水')
  assert.equal(facts[0].status, 'DONE')
  assert.equal(facts[0].assignee, '黄维维')
  assert.equal(facts[0].note, '已送达')

  for (let index = 2; index <= 14; index += 1) {
    sync.recordTaskFact({
      ownerId: 'owner', sessionId: 'voice', taskId: `task-${index}`,
      summary: `任务${index}`,
    })
  }
  facts = sync.taskContext({ ownerId: 'owner', sessionId: 'voice' })
  assert.equal(facts.length, 12)
  assert.equal(sync.removeTaskFact({
    ownerId: 'owner', sessionId: 'voice', taskId: 'task-14',
  }), true)
  assert.equal(sync.taskContext({ ownerId: 'owner', sessionId: 'voice' }).some(
    fact => fact.taskId === 'task-14',
  ), false)
})

test('includes text turns in reconnect context', () => {
  const sync = new ConversationSync()
  sync.record({
    ownerId: 'owner', sessionId: 'voice', id: 'text-1', role: 'user',
    content: '刚才那个任务是谁执行', source: 'text-user',
  })
  assert.equal(sync.frontendContext({ ownerId: 'owner', sessionId: 'voice' })[0].source, 'text-user')
})
