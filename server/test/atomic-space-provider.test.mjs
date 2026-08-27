import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createAtomicRecordStore } from '../src/atomic/atomic-record-store.mjs'
import { createAtomicSpaceProvider } from '../src/atomic/atomic-space-provider.mjs'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-space-provider-'))
  const recordStore = createAtomicRecordStore({ filePath: join(directory, 'records.json') })
  const provider = createAtomicSpaceProvider({
    directory: fileURLToPath(new URL('../../config/hotel-direct/atomic-space-mock', import.meta.url)),
    recordStore,
  })
  return { directory, provider }
}

test('returns four broad record categories and an open fallback from get_index', async () => {
  const { directory, provider } = await fixture()
  try {
    const index = await provider.getIndex()
    assert.equal(index.version, 2)
    assert.deepEqual(index.writeContracts.event.minimumInput, ['category', 'content'])
    assert.deepEqual(
      Object.keys(index.writeContracts.event.categories),
      ['物品', '客人', '酒店', '其他'],
    )
    assert.equal(index.writeContracts.event.categories.其他.allowEmptyFacts, true)
    assert.equal(index.writeContracts.event.categories.其他.allowEmptyEntities, true)
    assert.deepEqual(
      index.writeContracts.event.categories.物品.actionRules.借出.requiredFacts,
      ['itemName', 'quantity', 'unit'],
    )
    assert.deepEqual(
      index.writeContracts.event.categories.客人.actionRules.投诉.requiredFacts,
      ['statement'],
    )
    assert.deepEqual(
      index.writeContracts.event.categories.客人.actionRules.投诉.anyEntityRoles,
      ['complainant'],
    )
    assert.equal(
      index.writeContracts.event.categories.客人.actionRules.投诉.requireTraceableEntity,
      true,
    )
    assert.equal(
      index.writeContracts.event.categories.客人.actionRules.要求.requireTraceableEntity,
      true,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('requires a useful borrower reference for a standard loan event', async () => {
  const { directory, provider } = await fixture()
  try {
    await assert.rejects(
      provider.writeInstance({
        modelType: 'event',
        input: {
          category: '物品',
          action: '借出',
          content: '借出一把雨伞给客人使用',
          facts: { itemName: '雨伞', quantity: 1, unit: '把' },
        },
        context: { ownerId: 'demo', actorId: 'employee:zhang', actorName: '张洵' },
      }),
      error => {
        assert.equal(error.code, 'ATOMIC_EVENT_REQUIREMENTS_MISSING')
        assert.deepEqual(error.missingFacts, [])
        assert.deepEqual(error.anyEntityTypes, ['room', 'stay', 'guest', 'employee'])
        assert.match(error.clarificationGuidance, /借给谁/u)
        return true
      },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('normalizes a natural loan action and fills a known item unit', async () => {
  const { directory, provider } = await fixture()
  try {
    const result = await provider.writeInstance({
      modelType: 'event',
      input: {
        category: '物品',
        action: '借用',
        content: '2015房借用雨伞1把',
        facts: { itemName: '雨伞', quantity: 1 },
        entities: [{ type: 'room', id: '2015房' }],
      },
      context: { ownerId: 'demo', actorId: 'employee:zhang', actorName: '张洵' },
    })
    assert.equal(result.record.action, '借出')
    assert.equal(result.record.facts.unit, '把')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('requires a complainant anchor before saving a complaint', async () => {
  const { directory, provider } = await fixture()
  try {
    await assert.rejects(
      provider.writeInstance({
        modelType: 'event',
        input: {
          category: '客人',
          action: '投诉',
          content: '客人投诉房间太吵',
          facts: { statement: '房间太吵' },
        },
        context: { ownerId: 'demo', actorId: 'employee:zhang', actorName: '张洵' },
      }),
      error => {
        assert.equal(error.code, 'ATOMIC_EVENT_REQUIREMENTS_MISSING')
        assert.deepEqual(error.missingFacts, [])
        assert.deepEqual(error.anyEntityTypes, ['room', 'stay', 'order', 'guest'])
        assert.deepEqual(error.anyEntityRoles, ['complainant'])
        assert.match(error.clarificationGuidance, /定位具体投诉人/u)
        assert.deepEqual(error.entityHints, ['房号', '客人姓名', '具体订单号', '入住日期'])
        return true
      },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('does not mistake the complained-about room for the complainant', async () => {
  const { directory, provider } = await fixture()
  try {
    await assert.rejects(
      provider.writeInstance({
        modelType: 'event',
        input: {
          category: '客人',
          action: '投诉',
          content: '有人投诉801房夜间噪音太大',
          facts: { statement: '801房夜间噪音太大' },
          entities: [{ type: 'room', id: '801房', role: 'complaint_target' }],
        },
        context: { ownerId: 'demo', actorId: 'employee:zhang', actorName: '张洵' },
      }),
      error => {
        assert.equal(error.code, 'ATOMIC_EVENT_REQUIREMENTS_MISSING')
        assert.match(error.clarificationGuidance, /定位具体投诉人/u)
        return true
      },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('treats a generic OTA order as a partial clue instead of a traceable complainant', async () => {
  const { directory, provider } = await fixture()
  try {
    await assert.rejects(
      provider.writeInstance({
        modelType: 'event',
        input: {
          category: '客人',
          action: '投诉',
          content: '携程订单客人投诉房间太吵',
          facts: { statement: '房间太吵' },
          entities: [{ type: 'order', id: '携程订单', role: 'complainant' }],
        },
        context: { ownerId: 'demo', actorId: 'employee:zhang', actorName: '张洵' },
      }),
      error => {
        assert.equal(error.code, 'ATOMIC_EVENT_REQUIREMENTS_MISSING')
        assert.equal(error.requireTraceableEntity, true)
        assert.match(error.clarificationGuidance, /定位具体投诉人/u)
        return true
      },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('accepts a natural unresolved order once it contains enough identifying clues', async () => {
  const { directory, provider } = await fixture()
  try {
    const result = await provider.writeInstance({
      modelType: 'event',
      input: {
        category: '客人',
        action: '投诉',
        content: '明天入住的李先生携程订单客人投诉房间太吵',
        facts: { statement: '房间太吵' },
        entities: [{
          type: 'order',
          id: '明天入住的李先生携程订单',
          role: 'complainant',
        }],
      },
      context: { ownerId: 'demo', actorId: 'employee:zhang', actorName: '张洵' },
    })
    assert.equal(result.record.action, '投诉')
    assert.equal(result.record.entities[0].type, 'order')
    assert.equal(result.record.entities[0].resolution, undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('requires a traceable guest anchor for guest requests as well as complaints', async () => {
  const { directory, provider } = await fixture()
  try {
    await assert.rejects(
      provider.writeInstance({
        modelType: 'event',
        input: {
          category: '客人',
          action: '要求',
          content: '明天入住的客人要求预留S01停车位',
          facts: { request: '预留S01停车位' },
          entities: [{ type: 'guest', id: '客人', role: 'guest' }],
        },
        context: { ownerId: 'demo', actorId: 'employee:zhang', actorName: '张洵' },
      }),
      error => {
        assert.equal(error.code, 'ATOMIC_EVENT_REQUIREMENTS_MISSING')
        assert.match(error.clarificationGuidance, /哪位可追踪客人/u)
        return true
      },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('moves a known standard action out of the fallback category before validation', async () => {
  const { directory, provider } = await fixture()
  try {
    await assert.rejects(
      provider.writeInstance({
        modelType: 'event',
        input: {
          category: '其他',
          action: '客诉',
          content: '客人投诉房间太吵',
          facts: { statement: '房间太吵' },
        },
        context: { ownerId: 'demo', actorId: 'employee:zhang', actorName: '张洵' },
      }),
      error => {
        assert.equal(error.code, 'ATOMIC_EVENT_REQUIREMENTS_MISSING')
        assert.equal(error.action, '投诉')
        return true
      },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('keeps the complainant room separate from the complained-about room', async () => {
  const { directory, provider } = await fixture()
  try {
    const result = await provider.writeInstance({
      modelType: 'event',
      input: {
        category: '客人',
        action: '投诉',
        content: '315房客人投诉801房夜间噪音太大',
        facts: { statement: '801房夜间噪音太大' },
        entities: [
          { type: 'room', id: '315房', role: 'complainant' },
          { type: 'room', id: '801房', role: 'complaint_target' },
        ],
      },
      context: { ownerId: 'demo', actorId: 'employee:zhang', actorName: '张洵' },
    })
    assert.deepEqual(
      result.record.entities.filter(entity => entity.type === 'room'),
      [
        { type: 'room', id: 'room:315', role: 'complainant' },
        { type: 'room', id: 'room:801', role: 'complaint_target' },
      ],
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('resolves natural room item and stay mentions without making the model know IDs', async () => {
  const { directory, provider } = await fixture()
  try {
    provider.getMetaModel = async () => {
      throw new Error('get_meta_model 不应进入快路径')
    }
    const result = await provider.writeInstance({
      modelType: 'event',
      input: {
        category: '物品',
        action: '借出',
        content: '2615房本次住店已借出充电器2个',
        facts: { itemName: '充电器', quantity: 2, unit: '个' },
        entities: [
          { type: 'room', id: '2615房', role: 'room' },
          { type: 'stay', id: '本次住店', role: 'stay' },
        ],
      },
      context: { ownerId: 'demo', actorId: 'employee:zhang', actorName: '张洵' },
    })
    assert.deepEqual(
      result.record.entities.filter(entity => ['room', 'stay', 'item'].includes(entity.type)),
      [
        { type: 'room', id: 'room:2615', role: 'room' },
        { type: 'stay', id: 'stay:20260825-zhang', role: 'stay' },
        { type: 'item', id: 'item:charger', role: 'item' },
      ],
    )
    assert.equal(result.record.category, '物品')
    assert.equal(result.record.action, '借出')
    assert.equal(result.record.facts.itemId, 'item:charger')
    assert.equal(result.record.content, '2615房本次住店已借出充电器2个')
    const recalled = await provider.queryInstances({
      modelType: 'event',
      filters: { objectId: '2615房' },
      context: { ownerId: 'demo' },
    })
    assert.equal(recalled.total, 1)
    assert.equal(recalled.records[0].recordId, result.record.recordId)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('keeps a guest air-conditioner report as one guest fact until verification', async () => {
  const { directory, provider } = await fixture()
  try {
    const result = await provider.writeInstance({
      modelType: 'event',
      input: {
        // A stale cached context may still send the previous display name.
        // The provider must preserve that record by normalizing it first.
        category: '住客',
        action: '投诉',
        content: '2615房本次住店的客人投诉空调不制冷并要求换房，设备故障原因尚未核实',
        facts: {
          statement: '空调不制冷',
          request: '换房',
          result: '设备原因未核实',
        },
        entities: [
          { type: 'room', id: '2615', role: 'complainant' },
          { type: 'stay', id: '本次住店', role: 'complainant' },
        ],
      },
      context: { ownerId: 'demo', actorId: 'employee:zhang', actorName: '张洵' },
    })
    assert.equal(result.record.category, '客人')
    assert.equal(result.record.action, '投诉')
    assert.match(result.record.content, /要求换房/u)
    assert.match(result.record.content, /尚未核实/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('records a found item at a public location without requiring a room or item atom', async () => {
  const { directory, provider } = await fixture()
  try {
    const result = await provider.writeInstance({
      modelType: 'event',
      input: {
        category: '物品',
        action: '拾获',
        content: '张洵在18楼电梯门口拾获一双皮鞋',
        facts: { objectName: '一双皮鞋', location: '18楼电梯门口' },
        entities: [{ type: 'location', id: '18楼电梯门口', role: 'location' }],
      },
      context: { ownerId: 'demo', actorId: 'employee:zhang', actorName: '张洵' },
    })
    assert.deepEqual(result.record.entities, [
      { type: 'location', id: 'location:floor-18:elevator-lobby', role: 'location' },
    ])
    assert.equal(result.record.facts.objectName, '一双皮鞋')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('derives an open-world location from facts when the model supplies no entities', async () => {
  const { directory, provider } = await fixture()
  try {
    const result = await provider.writeInstance({
      modelType: 'event',
      input: {
        category: '物品',
        action: '拾获',
        content: '在18楼电梯门口拾获一双皮鞋',
        facts: { objectName: '一双皮鞋', location: '18楼电梯门口' },
      },
      context: { ownerId: 'demo', actorId: 'employee:zhang', actorName: '张洵' },
    })
    assert.equal(result.record.entities[0].id, 'location:floor-18:elevator-lobby')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('keeps an unregistered item recordable with a stable unresolved item id', async () => {
  const { directory, provider } = await fixture()
  try {
    const input = {
      category: '物品',
      action: '借出',
      content: '2615房已借出电动牙刷1把',
      facts: { itemName: '电动牙刷', quantity: 1, unit: '把' },
      entities: [{ type: 'room', id: '2615房' }],
    }
    const first = await provider.writeInstance({
      modelType: 'event', input,
      context: { ownerId: 'demo', actorId: 'employee:zhang', actorName: '张洵' },
    })
    const second = await provider.writeInstance({
      modelType: 'event', input,
      context: { ownerId: 'demo', actorId: 'employee:zhang', actorName: '张洵' },
    })
    const firstItem = first.record.entities.find(entity => entity.type === 'item')
    const secondItem = second.record.entities.find(entity => entity.type === 'item')
    assert.match(firstItem.id, /^item:unresolved:[a-f0-9]{12}$/u)
    assert.equal(secondItem.id, firstItem.id)
    assert.equal(first.record.facts.itemName, '电动牙刷')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('records a room number that is absent from the preloaded room index', async () => {
  const { directory, provider } = await fixture()
  try {
    const result = await provider.writeInstance({
      modelType: 'event',
      input: {
        category: '物品',
        action: '借出',
        content: '1501房已借出充电宝1个',
        facts: { itemName: '充电宝', quantity: 1, unit: '个' },
        entities: [{ type: 'room', id: '1501房' }],
      },
      context: { ownerId: 'demo', actorId: 'employee:zhang', actorName: '张洵' },
    })
    assert.equal(result.record.entities[0].id, 'room:1501')
    assert.equal(result.record.entities.find(entity => entity.type === 'item').id, 'item:power-bank')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('writes a complete content-only fallback with no facts or entities', async () => {
  const { directory, provider } = await fixture()
  try {
    const result = await provider.writeInstance({
      modelType: 'event',
      input: {
        category: '其他',
        content: '今日夜班交接时需留意一楼入口处的临时指示牌',
      },
      context: { ownerId: 'demo', actorId: 'employee:zhang', actorName: '张洵' },
    })
    assert.equal(result.record.category, '其他')
    assert.equal(result.record.action, '记录')
    assert.deepEqual(result.record.facts, {})
    assert.deepEqual(result.record.entities, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('does not block the record when a mentioned dynamic entity cannot be resolved', async () => {
  const { directory, provider } = await fixture()
  try {
    const result = await provider.writeInstance({
      modelType: 'event',
      input: {
        category: '其他',
        content: '当前记录与尚未同步的住店记录有关',
        entities: [{ type: 'stay', id: '尚未同步的住店记录' }],
      },
      context: { ownerId: 'demo', actorId: 'employee:zhang', actorName: '张洵' },
    })
    assert.match(result.record.entities[0].id, /^stay:unresolved:[a-f0-9]{12}$/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
