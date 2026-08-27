import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LocalAtomicRecordStore,
} from '../src/atomic/atomic-record-store.mjs'

async function storeFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'qwaudio-atomic-'))
  return new LocalAtomicRecordStore({ filePath: join(directory, 'records.json') })
}

test('writes one canonical record and queries it through room and stay relations', async () => {
  const store = await storeFixture()
  const written = await store.write({
    recordType: 'item_loan',
    summary: '2615房借用充电器2个',
    status: 'pending_return',
    primary: { type: 'stay', id: 'stay-001' },
    relations: { roomId: '2615', guestId: 'guest-001', itemId: 'charger', stayId: 'stay-001' },
    quantity: 2,
    unit: '个',
  }, { ownerId: 'owner', actorId: 'employee-1', actorName: '张洵' })

  assert.equal(written.action, 'created')
  assert.equal(written.record.primary.type, 'stay')
  assert.equal(written.record.quantity, 2)

  const byRoom = await store.query({ objectType: 'room', objectId: '2615' }, { ownerId: 'owner' })
  assert.equal(byRoom.total, 1)
  assert.equal(byRoom.records[0].recordId, written.record.recordId)

  const byStay = await store.query({ objectType: 'stay', objectId: 'stay-001' }, { ownerId: 'owner' })
  assert.equal(byStay.total, 1)
})

test('updates by recordId without duplicating the fact and isolates owners', async () => {
  const store = await storeFixture()
  const first = await store.write({
    recordType: 'room_issue',
    summary: '2615房空调异常',
    primary: { type: 'room', id: '2615' },
  }, { ownerId: 'owner' })
  const updated = await store.write({
    recordId: first.record.recordId,
    recordType: 'room_issue',
    summary: '2615房空调已修复',
    status: 'resolved',
    primary: { type: 'room', id: '2615' },
  }, { ownerId: 'owner' })
  assert.equal(updated.action, 'updated')
  assert.equal((await store.query({}, { ownerId: 'owner' })).total, 1)
  assert.equal((await store.query({}, { ownerId: 'other' })).total, 0)
  const raw = await readFile(store.filePath, 'utf8')
  assert.match(raw, /2615房空调已修复/u)
})

test('writes the unified record shape and keeps task-result writes idempotent', async () => {
  const store = await storeFixture()
  const written = await store.write({
    category: '物品',
    action: '借出',
    content: '2615房本次住店已借出充电器2个',
    facts: { itemName: '充电器', itemId: 'item:charger', quantity: 2, unit: '个' },
    entities: [
      { type: 'room', id: '2615', role: 'room' },
      { type: 'stay', id: 'stay-001', role: 'stay' },
      { type: 'item', id: 'item:charger', role: 'item' },
      { type: 'employee', id: 'employee-li', role: 'performed_by' },
    ],
    sourceTaskId: 'task-001',
    sourceTrigger: 'task_transition',
  }, { ownerId: 'owner', actorId: 'gateway', actorName: 'Gateway' })

  assert.equal(written.record.category, '物品')
  assert.equal(written.record.eventType, '物品')
  assert.equal(written.record.action, '借出')
  assert.equal(written.record.facts.itemId, 'item:charger')
  assert.equal(written.record.entities.length, 4)
  assert.equal(written.record.actors.recordedBy.id, 'gateway')
  assert.equal(written.record.summary, '2615房本次住店已借出充电器2个')

  const duplicate = await store.write({
    category: '物品',
    action: '借出',
    content: '2615房本次住店已借出充电器2个',
    facts: { itemName: '充电器', itemId: 'item:charger', quantity: 2, unit: '个' },
    entities: [{ type: 'item', id: 'item:charger' }],
    sourceTaskId: 'task-001',
    sourceTrigger: 'task_transition',
  }, { ownerId: 'owner', actorId: 'gateway', actorName: 'Gateway' })
  assert.equal(duplicate.action, 'updated')
  assert.equal((await store.query({}, { ownerId: 'owner' })).total, 1)
})

test('keeps the fallback category recordable with only complete natural language', async () => {
  const store = await storeFixture()
  const written = await store.write({
    category: '其他',
    content: '夜班交接时留意一楼入口的临时指示牌',
  }, { ownerId: 'owner', actorId: 'gateway', actorName: 'Gateway' })
  assert.equal(written.record.category, '其他')
  assert.equal(written.record.action, '记录')
  assert.deepEqual(written.record.facts, {})
  assert.deepEqual(written.record.entities, [])
})

test('keeps old fine-grained writes readable through the new category field', async () => {
  const store = await storeFixture()
  const written = await store.write({
    eventType: 'item_loaned',
    facts: { itemId: 'item:charger', quantity: 1, unit: '个' },
    entities: [{ type: 'item', id: 'item:charger' }],
  }, { ownerId: 'owner' })
  assert.equal(written.record.category, '物品')
  assert.equal(written.record.action, '借出')
  assert.equal(written.record.legacyEventType, 'item_loaned')
})
