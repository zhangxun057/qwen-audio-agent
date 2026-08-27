import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ENTER_SLEEP_TOOL_NAME,
  HOTEL_DIRECT_TOOL_PROFILE,
  SPIRIT_TASK_ADD_COMMENT_TOOL_NAME,
  SPIRIT_TASK_COMPLETE_TOOL_NAME,
  SPIRIT_TASK_CREATE_TOOL_NAME,
  SPIRIT_TASK_DELETE_TOOL_NAME,
  SPIRIT_TASK_START_TOOL_NAME,
  ATOMIC_RECORD_WRITE_TOOL_NAME,
  ATOMIC_RECORD_QUERY_TOOL_NAME,
  frontendTools,
} from '../src/voice/realtime-provider.mjs'

function toolNames(context = {}) {
  return frontendTools({ toolProfile: HOTEL_DIRECT_TOOL_PROFILE, ...context })
    .map(tool => tool.function.name)
}

test('hotel-direct exposes the product tools without backend-agent or reminder tools', () => {
  const names = toolNames()

  for (const name of [
    SPIRIT_TASK_CREATE_TOOL_NAME,
    SPIRIT_TASK_START_TOOL_NAME,
    SPIRIT_TASK_COMPLETE_TOOL_NAME,
    SPIRIT_TASK_ADD_COMMENT_TOOL_NAME,
    SPIRIT_TASK_DELETE_TOOL_NAME,
    'get_current_time',
    'memory',
    'spirit_voice_notify',
    ATOMIC_RECORD_WRITE_TOOL_NAME,
    ATOMIC_RECORD_QUERY_TOOL_NAME,
  ]) {
    assert.ok(names.includes(name), `${name} should be registered`)
  }
  for (const name of [
    'spawn_thinking',
    'schedule_reminder',
    'cancel_agent_task',
    'get_agent_task_status',
    'notes',
    'respond_agent_permission',
  ]) {
    assert.equal(names.includes(name), false, `${name} should not be registered`)
  }
})

test('hotel-direct adds enter_sleep only for clients that support sleeping', () => {
  assert.equal(toolNames().includes(ENTER_SLEEP_TOOL_NAME), false)
  assert.equal(
    toolNames({ client: { states: ['sleeping'] } }).includes(ENTER_SLEEP_TOOL_NAME),
    true,
  )
})

test('task notification responsibilities are explicit in the tool schemas', () => {
  const tools = frontendTools({ toolProfile: HOTEL_DIRECT_TOOL_PROFILE })
  const create = tools.find(tool => tool.function.name === SPIRIT_TASK_CREATE_TOOL_NAME)
  const update = tools.find(tool => tool.function.name === 'spirit_task_update')
  const notify = tools.find(tool => tool.function.name === 'spirit_voice_notify')

  assert.equal('notify' in create.function.parameters.properties, false)
  assert.match(create.function.description, /最多等待通知 5 秒/)
  assert.match(create.function.description, /一次性复述执行人、任务内容和通知结果/)
  assert.match(create.function.description, /不再追加第二条回执/)
  assert.match(update.function.description, /重新分配成功后.*立即向新执行人发送工作通知/)
  assert.match(notify.function.description, /不需要创建任务/)
  assert.match(notify.function.description, /不要在创建任务后再次调用/)
  assert.match(notify.function.description, /最多等待通知 5 秒/)
  assert.match(notify.function.parameters.properties.title.description, /工作通知/)
})

test('event tool uses four broad categories with a content-only fallback', () => {
  const tools = frontendTools({ toolProfile: HOTEL_DIRECT_TOOL_PROFILE })
  const write = tools.find(tool => tool.function.name === ATOMIC_RECORD_WRITE_TOOL_NAME)
  assert.deepEqual(write.function.parameters.required, ['category', 'factState', 'action', 'content'])
  assert.equal('primary' in write.function.parameters.properties, false)
  assert.equal('relations' in write.function.parameters.properties, false)
  assert.equal(write.function.parameters.properties.entities.items.required.includes('id'), true)
  assert.deepEqual(
    write.function.parameters.properties.category.enum,
    ['物品', '客人', '酒店', '其他'],
  )
  assert.equal(write.function.parameters.required.includes('facts'), false)
  assert.equal(write.function.parameters.required.includes('entities'), false)
  for (const field of [
    'sourceTaskId',
    'sourceTransitionId',
    'sourceTrigger',
    'actors',
    'rawText',
  ]) {
    assert.equal(field in write.function.parameters.properties, false, `${field} is Gateway-owned`)
  }
  assert.match(write.function.description, /客人报失归客人/u)
  assert.match(write.function.description, /员工拾获归物品/u)
  assert.match(write.function.description, /role=complainant/u)
  assert.match(write.function.description, /不能冒充投诉人/u)
  assert.match(write.function.description, /不得复读固定模板/u)
  assert.match(write.function.description, /携程订单/u)
  assert.match(write.function.description, /与任务工具互斥/u)
  assert.deepEqual(
    write.function.parameters.properties.factState.enum,
    ['occurred', 'confirmed_arrangement'],
  )
})
