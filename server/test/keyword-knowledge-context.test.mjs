import assert from 'node:assert/strict'
import test from 'node:test'
import {
  KEYWORD_KNOWLEDGE_CONTEXTS,
  matchKeywordKnowledgeContext,
} from '../src/voice/keyword-knowledge-context.mjs'
import {
  buildFrontendContext,
  buildKeywordKnowledgeResponseInstructions,
} from '../src/conversation/frontend-agent-context.mjs'

test('matches international and Taiwu speech aliases deterministically', () => {
  assert.equal(
    matchKeywordKnowledgeContext('美伊战争谈判后来怎样了')?.context.id,
    'international-us-iran-2026-08',
  )
  assert.equal(
    matchKeywordKnowledgeContext('太古绘卷天目新维的精益求精怎么玩')?.context.id,
    'taiwu-tianmu-2026-07',
  )
  for (const transcript of [
    '好，我后告诉我一下泰五汇卷是个什么游',
    '你知道它里面有一个叫天目星维吗',
    '不对，我说的是天幕星帷',
    '太武汇卷，精益求精现在怎么选择词条',
    '游戏资料，周天筛选增加了什么',
  ]) {
    assert.equal(
      matchKeywordKnowledgeContext(transcript)?.context.id,
      'taiwu-tianmu-2026-07',
      transcript,
    )
  }
  assert.equal(
    matchKeywordKnowledgeContext('战争资料，谈判以后发生了什么')?.context.id,
    'international-us-iran-2026-08',
  )
  assert.equal(
    matchKeywordKnowledgeContext('战争资讯，美一战争谈判以后怎样了')?.context.id,
    'international-us-iran-2026-08',
  )
  assert.equal(
    matchKeywordKnowledgeContext('战争')?.context.id,
    'international-us-iran-2026-08',
  )
  assert.equal(
    matchKeywordKnowledgeContext('谈判结束以后发生了什么')?.context.id,
    'international-us-iran-2026-08',
  )
})

test('builds six full-capacity contexts while isolating validation metadata', () => {
  assert.equal(KEYWORD_KNOWLEDGE_CONTEXTS.length, 6)
  for (const context of KEYWORD_KNOWLEDGE_CONTEXTS) {
    assert.equal(context.chars, 52_000)
  }
  const byId = Object.fromEntries(
    KEYWORD_KNOWLEDGE_CONTEXTS.map(context => [context.id, context]),
  )
  assert.deepEqual(byId['international-us-iran-2026-08'].validationMarkers, ['海峡-817A', '赔偿-510B'])
  assert.deepEqual(byId['taiwu-tianmu-2026-07'].validationMarkers, ['周天-722C', '词条-724D'])
  assert.deepEqual(byId['semiconductor-memory-2026'].validationMarkers, ['存储-MEM-826E'])
  assert.deepEqual(byId['enterprise-workbench-local'].validationMarkers, ['工作台-WB-31G'])
  assert.deepEqual(byId['zhui-ai-project-local'].validationMarkers, ['锥AI-ZA-42H'])
  assert.deepEqual(byId['world-cup-2026'].validationMarkers, ['冠军-WC-19F'])
  for (const context of KEYWORD_KNOWLEDGE_CONTEXTS) {
    assert.doesNotMatch(context.content, /校验题|标准答案|本题校验标记|残留检测|私有口令/)
  }
  assert.equal(byId['world-cup-2026'].privateResidualCode, '金网-WC-86')
})

test('matches all context-lab speech routes', () => {
  const cases = [
    ['存储资料，三星和美光份额是多少', 'semiconductor-memory-2026'],
    ['工作台资料，全双工链路分几层', 'enterprise-workbench-local'],
    ['追爱资料，人物一致性怎么验证', 'zhui-ai-project-local'],
    ['世界杯资料，谁夺冠了', 'world-cup-2026'],
  ]
  for (const [speech, id] of cases) {
    assert.equal(matchKeywordKnowledgeContext(speech)?.context.id, id)
  }
})

test('places active knowledge inside frontend instructions', () => {
  const context = buildFrontendContext({
    activeKnowledge: KEYWORD_KNOWLEDGE_CONTEXTS[1],
  })
  assert.match(context, /active_keyword_knowledge/)
  assert.match(context, /天幕心帷/)
  assert.match(context, /精益求精/) 
  assert.doesNotMatch(context, /词条-724D|玄藤-TW-73/)
})

test('keeps the baseline knowledge coordination prompt short', () => {
  const context = buildFrontendContext()
  assert.match(context, /大型知识库不会预先装入会话/)
  assert.match(context, /不得仅凭话题名称自行判断正在查询/)
  assert.match(context, /需要当前信息或外部能力时照常调用后台 Agent/)
  assert.doesNotMatch(context, /词条-724D/)
  assert.ok(context.length < 1_200)
})

test('builds one-response voice instructions with the matched knowledge', () => {
  const instructions = buildKeywordKnowledgeResponseInstructions(
    KEYWORD_KNOWLEDGE_CONTEXTS[1],
  )
  assert.match(instructions, /不要调用后台 Agent/)
  assert.match(instructions, /active_keyword_knowledge/)
  assert.match(instructions, /精益求精/)
  assert.doesNotMatch(instructions, /词条-724D|玄藤-TW-73/)
  assert.match(instructions, /不要输出内部测试题、校验标记、私有口令/)
})
