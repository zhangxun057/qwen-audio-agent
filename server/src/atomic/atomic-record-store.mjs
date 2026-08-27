import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const STORE_VERSION = 2
const MAX_RECORDS = 20_000
const MAX_TEXT = 8_000
const MAX_DETAILS = 16_000
const MAX_ATTRIBUTES = 64

const OBJECT_TYPES = Object.freeze([
  'room',
  'stay',
  'guest',
  'order',
  'task',
  'item',
  'service',
  'operation',
  'employee',
  'location',
])

const RECORD_CATEGORIES = Object.freeze([
  '物品',
  '客人',
  '酒店',
  '其他',
])

// Older local records used a fine-grained event enum. Keep an explicit
// migration table so those records remain readable without asking the
// realtime model to choose these implementation-oriented names again.
const LEGACY_EVENT_TYPES = Object.freeze([
  'item_consumed',
  'item_loaned',
  'item_returned',
  'item_sold',
  'item_replenished',
  'inventory_verified',
  'inventory_adjusted',
  'room_issue_reported',
  'room_issue_diagnosed',
  'guest_complaint',
  'stay_constraint',
  'lost_found',
  'lost_deposited',
  'handover',
  'service_delivered',
  'public_issue',
])

const LEGACY_EVENT_DEFAULTS = Object.freeze({
  item_consumed: { category: '物品', action: '消耗' },
  item_loaned: { category: '物品', action: '借出' },
  item_returned: { category: '物品', action: '归还' },
  item_sold: { category: '物品', action: '售出' },
  item_replenished: { category: '物品', action: '补入' },
  inventory_verified: { category: '物品', action: '库存核实' },
  inventory_adjusted: { category: '物品', action: '库存调整' },
  room_issue_reported: { category: '酒店', action: '异常报告' },
  room_issue_diagnosed: { category: '酒店', action: '故障核实' },
  guest_complaint: { category: '客人', action: '投诉' },
  stay_constraint: { category: '客人', action: '住店要求' },
  lost_found: { category: '物品', action: '拾获' },
  lost_deposited: { category: '物品', action: '交存' },
  handover: { category: '酒店', action: '交接' },
  service_delivered: { category: '客人', action: '服务完成' },
  public_issue: { category: '酒店', action: '运行变化' },
})

const EVENT_TYPE_ALIASES = Object.freeze({
  item_consumption: 'item_consumed',
  item_consumption_record: 'item_consumed',
  item_loan: 'item_loaned',
  item_return: 'item_returned',
  item_sale: 'item_sold',
  item_replenish: 'item_replenished',
  room_issue: 'room_issue_reported',
  room_issue_report: 'room_issue_reported',
  room_issue_diagnosis: 'room_issue_diagnosed',
  lost_report: 'lost_found',
})

const REQUIRED_FACTS = Object.freeze({
  item_consumed: ['itemId', 'quantity', 'unit'],
  item_loaned: ['itemId', 'quantity', 'unit'],
  item_returned: ['itemId', 'quantity', 'unit'],
  item_sold: ['itemId', 'quantity', 'unit'],
  item_replenished: ['itemId', 'quantity', 'unit'],
  inventory_verified: ['itemId', 'countedQuantity', 'unit'],
  inventory_adjusted: ['itemId', 'quantity', 'unit', 'reason'],
  room_issue_reported: ['issueCode', 'observation'],
  room_issue_diagnosed: ['issueCode', 'diagnosis'],
  guest_complaint: ['complaintCode', 'statement'],
  stay_constraint: ['predicate', 'operator', 'value', 'scope'],
  lost_found: ['description'],
  lost_deposited: ['description', 'depositLocation'],
  handover: ['subject', 'content'],
  service_delivered: ['serviceCode'],
  public_issue: ['issueCode', 'observation'],
})

function text(value, label, max = MAX_TEXT, { required = false } = {}) {
  const result = String(value ?? '').trim()
  if (required && !result) throw new Error(`${label}不能为空`)
  if (result.length > max) throw new Error(`${label}不能超过 ${max} 个字符`)
  return result
}

function optionalText(value, label, max = MAX_TEXT) {
  if (value === undefined || value === null) return undefined
  const result = text(value, label, max)
  return result || undefined
}

function objectType(value, label = '对象类型') {
  const result = text(value, label, 32, { required: true }).toLowerCase()
  if (!OBJECT_TYPES.includes(result)) {
    throw new Error(`${label}必须是 ${OBJECT_TYPES.join('、')} 之一`)
  }
  return result
}

function objectRef(value, label = '主对象') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}必须是 JSON 对象`)
  }
  return {
    type: objectType(value.type, `${label}.type`),
    id: text(value.id, `${label}.id`, 160, { required: true }),
  }
}

function canonicalEventType(value, label = '事件类型') {
  const raw = text(value, label, 80, { required: true }).toLowerCase()
  if (raw === 'inventory_counted') {
    throw new Error('盘点是任务动作，不是事件；请写 inventory_verified 或 inventory_adjusted')
  }
  const result = EVENT_TYPE_ALIASES[raw] || raw
  if (!LEGACY_EVENT_TYPES.includes(result)) {
    throw new Error(`${label}不在旧版兼容范围内`)
  }
  return result
}

function canonicalCategory(value, label = '记录类别') {
  const raw = text(value, label, 80, { required: true }).toLocaleLowerCase()
  const aliases = {
    '物品': '物品',
    item: '物品',
    goods: '物品',
    '客人': '客人',
    '住客': '客人',
    guest: '客人',
    stay: '客人',
    '酒店': '酒店',
    '酒店运行': '酒店',
    hotel: '酒店',
    operation: '酒店',
    '其他': '其他',
    other: '其他',
    misc: '其他',
  }
  const result = aliases[raw]
  if (!result) throw new Error(`${label}必须是 ${RECORD_CATEGORIES.join('、')} 之一`)
  return result
}

function normalizeFacts(value) {
  if (value === undefined || value === null) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('facts 必须是 JSON 对象')
  }
  return normalizeAttributes(value)
}

function normalizeEntity(value, label = '实体') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}必须是 JSON 对象`)
  }
  return {
    type: objectType(value.type, `${label}.type`),
    id: text(value.id, `${label}.id`, 160, { required: true }),
    ...(optionalText(value.role, `${label}.role`, 80) ? { role: text(value.role, `${label}.role`, 80) } : {}),
  }
}

function normalizeEntities(value, legacyPrimary, legacyRelations) {
  const entities = []
  if (Array.isArray(value)) {
    for (const [index, entity] of value.slice(0, 32).entries()) {
      entities.push(normalizeEntity(entity, `entities[${index}]`))
    }
  } else if (value !== undefined && value !== null) {
    throw new Error('entities 必须是 JSON 数组')
  }
  // Accept the old shape while migrating existing callers. The canonical
  // shape is entities[{type,id,role}], not a free-form relations dictionary.
  if (legacyPrimary) {
    const primary = objectRef(legacyPrimary, '主对象')
    if (!entities.some(entity => entity.type === primary.type && entity.id === primary.id)) {
      entities.unshift({ ...primary, role: 'primary' })
    }
  }
  if (legacyRelations && typeof legacyRelations === 'object' && !Array.isArray(legacyRelations)) {
    for (const [key, raw] of Object.entries(legacyRelations).slice(0, 32)) {
      const match = key.match(/^(room|stay|guest|order|task|item|service|operation|employee|location)Id$/u)
      if (!match) continue
      const id = optionalText(raw, `关联字段 ${key}`, 160)
      if (!id || entities.some(entity => entity.type === match[1] && entity.id === id)) continue
      entities.push({ type: match[1], id, role: 'related' })
    }
  }
  return entities
}

function requireFactFields(eventType, facts, input) {
  const missing = (REQUIRED_FACTS[eventType] || []).filter(key => {
    const value = facts[key]
    return value === undefined || value === null || value === ''
  })
  if (missing.length) {
    throw new Error(`${eventType} 缺少事实字段：${missing.join('、')}`)
  }
  for (const key of ['quantity', 'countedQuantity']) {
    if (facts[key] === undefined) continue
    const number = Number(facts[key])
    if (!Number.isFinite(number) || number < 0) throw new Error(`${eventType}.${key} 必须是非负数字`)
  }
  if (eventType === 'inventory_verified' && !input.sourceTaskId) {
    throw new Error('inventory_verified 必须关联产生盘点结果的任务 sourceTaskId')
  }
}

function entityTypes(entities) {
  return new Set(entities.map(entity => entity.type))
}

function validateEntityCoverage(eventType, entities) {
  const types = entityTypes(entities)
  if (['item_consumed', 'item_loaned', 'item_returned', 'item_sold', 'item_replenished', 'inventory_verified', 'inventory_adjusted'].includes(eventType) && !types.has('item')) {
    throw new Error(`${eventType} 必须关联 item 实体；不能只在 relations 里写物品名称`)
  }
  if (eventType === 'item_sold' && !types.has('stay') && !types.has('order')) {
    throw new Error('item_sold 必须关联 stay 或 order 实体')
  }
  if (eventType === 'stay_constraint' && !types.has('stay')) {
    throw new Error('stay_constraint 必须关联 stay 实体')
  }
  if (['room_issue_reported', 'room_issue_diagnosed'].includes(eventType) && !types.has('room')) {
    throw new Error(`${eventType} 必须关联 room 实体`)
  }
}

function buildSummary(eventType, facts, entities) {
  const roomId = entities.find(entity => entity.type === 'room')?.id
  const room = roomId?.startsWith('room:') ? roomId.slice('room:'.length) : roomId
  const item = facts.itemName || facts.itemId
  const quantity = facts.quantity === undefined ? '' : `${facts.quantity}${facts.unit || ''}`
  if (eventType === 'item_consumed') return `${room ? `${room}房` : ''}消耗${item || '物品'}${quantity}`
  if (eventType === 'item_loaned') return `${room ? `${room}房` : ''}借出${item || '物品'}${quantity}`
  if (eventType === 'item_returned') return `${room ? `${room}房` : ''}归还${item || '物品'}${quantity}`
  if (eventType === 'item_sold') return `${room ? `${room}房` : ''}销售${item || '物品'}${quantity}`
  if (eventType === 'item_replenished') return `补充${item || '物品'}${quantity}`
  if (eventType === 'inventory_verified') return `盘点核实${item || '物品'}${facts.countedQuantity}${facts.unit || ''}`
  if (eventType === 'inventory_adjusted') return `库存调整${item || '物品'}${quantity}`
  if (eventType === 'room_issue_reported') return `${room ? `${room}房` : ''}${facts.observation}`
  if (eventType === 'room_issue_diagnosed') return `${room ? `${room}房` : ''}${facts.diagnosis}`
  if (eventType === 'guest_complaint') return `客诉：${facts.statement}`
  if (eventType === 'stay_constraint') return `住店要求：${facts.value}`
  if (eventType === 'lost_found') return `拾获：${facts.description}`
  if (eventType === 'lost_deposited') return `失物交存：${facts.description}`
  if (eventType === 'handover') return `交接：${facts.subject}`
  if (eventType === 'service_delivered') return `服务完成：${facts.serviceCode}`
  if (eventType === 'public_issue') return `公共事项：${facts.observation}`
  return eventType
}

function normalizeRelations(value) {
  if (value === undefined || value === null) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('关联对象必须是 JSON 对象')
  }
  const result = {}
  for (const [key, raw] of Object.entries(value).slice(0, 24)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/u.test(key)) {
      throw new Error(`关联字段 ${key} 不合法`)
    }
    const valueText = optionalText(raw, `关联字段 ${key}`, 160)
    if (valueText) result[key] = valueText
  }
  return result
}

function normalizeAttributes(value) {
  if (value === undefined || value === null) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('补充属性必须是 JSON 对象')
  }
  const entries = Object.entries(value).slice(0, MAX_ATTRIBUTES)
  return Object.fromEntries(entries.map(([key, raw]) => {
    if (!/^[a-zA-Z一-鿿][a-zA-Z0-9_一-鿿]*$/u.test(key)) {
      throw new Error(`补充属性字段 ${key} 不合法`)
    }
    if (raw === null || typeof raw === 'number' || typeof raw === 'boolean') {
      return [key, raw]
    }
    if (typeof raw === 'string') return [key, raw.slice(0, 1000)]
    return [key, JSON.stringify(raw).slice(0, 2000)]
  }))
}

function normalizeActor(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}必须是 JSON 对象`)
  }
  return {
    id: text(value.id, `${label}.id`, 160, { required: true }),
    ...(optionalText(value.name, `${label}.name`, 160) ? { name: text(value.name, `${label}.name`, 160) } : {}),
  }
}

function normalizeActors(value) {
  if (value === undefined || value === null) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('actors 必须是 JSON 对象')
  return {
    ...(value.factReporter ? { factReporter: normalizeActor(value.factReporter, 'actors.factReporter') } : {}),
    ...(value.performedBy ? { performedBy: normalizeActor(value.performedBy, 'actors.performedBy') } : {}),
  }
}

function normalizeDate(value, label, fallback) {
  const source = optionalText(value, label, 80)
  if (!source) return fallback
  const parsed = new Date(source)
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label}不是有效时间`)
  return parsed.toISOString()
}

function normalizeRecord(input, {
  ownerId,
  actorId = '',
  actorName = '',
  now = new Date(),
} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('记录必须是 JSON 对象')
  }
  const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString()
  const hasUnifiedShape = input.category !== undefined || input.content !== undefined
  const hasLegacyCanonicalShape = !hasUnifiedShape
    && (input.eventType !== undefined || input.facts !== undefined || input.entities !== undefined)
  const hasCanonicalShape = hasUnifiedShape || hasLegacyCanonicalShape
  const legacyEventType = hasUnifiedShape
    ? undefined
    : canonicalEventType(
        input.eventType === undefined ? input.recordType : input.eventType,
        input.eventType === undefined ? '记录类型' : '事件类型',
      )
  const legacyDefaults = legacyEventType ? LEGACY_EVENT_DEFAULTS[legacyEventType] : null
  const category = hasUnifiedShape
    ? canonicalCategory(input.category)
    : legacyDefaults.category
  const action = optionalText(input.action, '事实动作', 120)
    || legacyDefaults?.action
    || '记录'
  const facts = normalizeFacts(input.facts)
  // Compatibility with the previous tool contract. New callers must put
  // business fields in facts; this mapping is only for old saved/test data.
  if (!hasCanonicalShape) {
    for (const key of ['quantity', 'unit']) {
      if (facts[key] === undefined && input[key] !== undefined) facts[key] = input[key]
    }
    for (const [key, value] of Object.entries(input.attributes || {})) {
      if (facts[key] === undefined) facts[key] = value
    }
    for (const key of ['itemId', 'issueCode', 'observation', 'diagnosis', 'statement', 'description']) {
      if (facts[key] === undefined && input.attributes?.[key] !== undefined) facts[key] = input.attributes[key]
    }
  }
  const entities = normalizeEntities(input.entities, input.primary, input.relations)
  if (hasLegacyCanonicalShape) {
    requireFactFields(legacyEventType, facts, input)
    validateEntityCoverage(legacyEventType, entities)
  }
  const primary = input.primary
    ? objectRef(input.primary, '主对象')
    : entities.find(entity => entity.role === 'primary') || undefined
  const legacySummary = legacyEventType
    ? buildSummary(legacyEventType, facts, entities)
    : ''
  const content = hasUnifiedShape
    ? text(input.content, '记录内容', MAX_DETAILS, { required: true })
    : text(input.summary || legacySummary, '记录内容', MAX_DETAILS, { required: true })
  const summary = content.length > 500 ? `${content.slice(0, 497)}...` : content
  const status = optionalText(input.status, '记录状态', 80) || 'open'
  const quantityValue = facts.quantity === undefined ? input.quantity : facts.quantity
  const quantity = quantityValue === undefined || quantityValue === null
    ? undefined
    : Number(quantityValue)
  if (quantity !== undefined && (!Number.isFinite(quantity) || quantity < 0)) {
    throw new Error('数量必须是非负数字')
  }
  const recordId = optionalText(input.recordId, 'recordId', 160) || `record-${randomUUID()}`
  const sourceTrigger = optionalText(input.sourceTrigger, 'sourceTrigger', 40)
  if (sourceTrigger && !['user_turn', 'task_transition', 'pms_event', 'manual'].includes(sourceTrigger)) {
    throw new Error('sourceTrigger 必须是 user_turn、task_transition、pms_event 或 manual')
  }
  const actors = normalizeActors(input.actors)
  return {
    recordId,
    ownerId: text(ownerId, 'ownerId', 160, { required: true }),
    schemaVersion: hasUnifiedShape ? 'hotel-event.v2' : 'hotel-event.v1-migrated',
    recordType: category,
    eventType: category,
    category,
    action,
    content,
    ...(legacyEventType ? { legacyEventType } : {}),
    summary,
    ...(optionalText(input.details, '记录详情', MAX_DETAILS) ? { details: text(input.details, '记录详情', MAX_DETAILS) } : {}),
    status,
    occurredAt: normalizeDate(input.occurredAt, '发生时间', nowIso),
    createdAt: normalizeDate(input.createdAt, '创建时间', nowIso),
    updatedAt: nowIso,
    ...(primary ? { primary } : {}),
    entities,
    facts,
    relations: normalizeRelations(input.relations),
    ...(quantity === undefined ? {} : { quantity }),
    ...(optionalText(facts.unit || input.unit, '数量单位', 40) ? { unit: text(facts.unit || input.unit, '数量单位', 40) } : {}),
    attributes: normalizeAttributes(input.attributes),
    actors: {
      ...(actors.factReporter ? { factReporter: actors.factReporter } : {}),
      ...(actors.performedBy ? { performedBy: actors.performedBy } : {}),
      ...(text(actorId, 'actorId', 160) ? { relayedBy: { id: text(actorId, 'actorId', 160), name: text(actorName, 'actorName', 160) } } : {}),
      recordedBy: { id: text(actorId || ownerId, 'recordedBy', 160, { required: true }), name: text(actorName, 'actorName', 160) },
    },
    timing: {
      occurredAt: normalizeDate(input.occurredAt, '发生时间', nowIso),
      recordedAt: nowIso,
    },
    source: {
      channel: 'voice',
      ...(sourceTrigger ? { trigger: sourceTrigger } : { trigger: input.sourceTaskId ? 'task_transition' : 'user_turn' }),
      ...(text(actorId, 'actorId', 160) ? { actorId: text(actorId, 'actorId', 160) } : {}),
      ...(text(actorName, 'actorName', 160) ? { actorName: text(actorName, 'actorName', 160) } : {}),
      ...(optionalText(input.sourceTaskId, '来源任务 ID', 160) ? { taskId: text(input.sourceTaskId, '来源任务 ID', 160) } : {}),
      ...(optionalText(input.sourceTransitionId, '来源状态版本', 160) ? { transitionId: text(input.sourceTransitionId, '来源状态版本', 160) } : {}),
      ...(optionalText(input.rawText, '原始事实', MAX_DETAILS) ? { rawText: text(input.rawText, '原始事实', MAX_DETAILS) } : {}),
    },
    idempotencyKey: optionalText(input.idempotencyKey, '幂等键', 240)
      || (optionalText(input.sourceTaskId, '来源任务 ID', 160)
        ? `${category}:${action}:task:${text(input.sourceTaskId, '来源任务 ID', 160)}:transition:${optionalText(input.sourceTransitionId, '来源状态版本', 160) || 'latest'}`
        : `${category}:${recordId}`),
  }
}

function readStore(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    if (Array.isArray(parsed)) return { version: STORE_VERSION, records: parsed }
    if (parsed && Array.isArray(parsed.records)) return parsed
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`原子记录本地存储损坏：${error.message}`)
  }
  return { version: STORE_VERSION, records: [] }
}

function writeStore(filePath, store) {
  mkdirSync(dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  renameSync(temporary, filePath)
}

function normalized(value) {
  return String(value || '').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function storedRecordCategory(record) {
  const legacyType = EVENT_TYPE_ALIASES[record?.legacyEventType || record?.eventType]
    || record?.legacyEventType
    || record?.eventType
  if (LEGACY_EVENT_DEFAULTS[legacyType]?.category) {
    return LEGACY_EVENT_DEFAULTS[legacyType].category
  }
  for (const value of [record?.category, record?.recordType]) {
    if (!value) continue
    try {
      return canonicalCategory(value)
    } catch {
      // Fall through to the legacy event-type mapping below.
    }
  }
  return undefined
}

function recordMatches(record, filters) {
  if (filters.category && storedRecordCategory(record) !== canonicalCategory(filters.category)) return false
  if (filters.status && record.status !== filters.status) return false
  if (filters.objectType) {
    const matchingEntity = (record.entities || []).some(entity => (
      entity.type === filters.objectType
      && (!filters.objectId || entity.id === filters.objectId)
    ))
    const legacyPrimaryMatch = record.primary?.type === filters.objectType
      && (!filters.objectId || record.primary.id === filters.objectId)
    if (!matchingEntity && !legacyPrimaryMatch) return false
  }
  if (filters.objectId) {
    const id = String(filters.objectId)
    const relationKey = `${filters.objectType || ''}Id`
    const values = [
      record.primary?.id,
      ...(record.entities || []).map(entity => entity.id),
      ...(relationKey ? [record.relations?.[relationKey]] : []),
      ...Object.values(record.relations || {}),
    ].filter(Boolean).map(String)
    if (!values.some(value => value === id || normalized(value) === normalized(id))) return false
  }
  if (filters.keyword) {
    const haystack = normalized([
      record.recordType,
      record.eventType,
      record.category,
      record.action,
      record.content,
      record.summary,
      record.details,
      JSON.stringify(record.facts),
      record.primary?.type,
      record.primary?.id,
      JSON.stringify(record.entities),
      JSON.stringify(record.relations),
      JSON.stringify(record.attributes),
    ].join(' '))
    if (!haystack.includes(normalized(filters.keyword))) return false
  }
  if (filters.from && record.occurredAt < filters.from) return false
  if (filters.to && record.occurredAt > filters.to) return false
  return true
}

function projectRecord(record) {
  return {
    recordId: record.recordId,
    schemaVersion: record.schemaVersion,
    recordType: record.recordType,
    eventType: record.eventType,
    category: storedRecordCategory(record) || record.category || record.recordType,
    action: record.action,
    content: record.content || record.summary,
    ...(record.legacyEventType ? { legacyEventType: record.legacyEventType } : {}),
    summary: record.summary,
    details: record.details,
    status: record.status,
    occurredAt: record.occurredAt,
    ...(record.primary ? { primary: record.primary } : {}),
    entities: record.entities,
    facts: record.facts,
    actors: record.actors,
    timing: record.timing,
    source: record.source,
    idempotencyKey: record.idempotencyKey,
    ...(Object.keys(record.relations || {}).length ? { relations: record.relations } : {}),
    ...(record.quantity === undefined ? {} : { quantity: record.quantity, unit: record.unit }),
    attributes: record.attributes,
    ...(record.correction ? { correction: record.correction } : {}),
    ...(record.deletedAt ? { deletedAt: record.deletedAt } : {}),
    sourceTaskId: record.source?.taskId,
  }
}

export class LocalAtomicRecordStore {
  constructor({ filePath } = {}) {
    this.filePath = resolve(String(filePath || 'atomic-records.json'))
    this.serial = Promise.resolve()
  }

  get configured() { return Boolean(this.filePath) }

  async get(recordId, context = {}, { includeDeleted = false } = {}) {
    return this.runSerial(async () => {
      const owner = text(context.ownerId, 'ownerId', 160, { required: true })
      const id = text(recordId, 'recordId', 160, { required: true })
      const store = readStore(this.filePath)
      const record = store.records.find(item => (
        item.ownerId === owner
        && item.recordId === id
        && (includeDeleted || item.status !== 'deleted')
      ))
      return record ? projectRecord(record) : null
    })
  }

  runSerial(operation) {
    const next = this.serial.then(operation, operation)
    this.serial = next.catch(() => {})
    return next
  }

  async write(input, context = {}) {
    return this.runSerial(async () => {
      const store = readStore(this.filePath)
      const next = normalizeRecord(input, context)
      const index = store.records.findIndex(record => (
        record.ownerId === next.ownerId
        && (record.recordId === next.recordId || (
          next.idempotencyKey
          && record.idempotencyKey === next.idempotencyKey
        ))
      ))
      if (index >= 0) {
        next.createdAt = store.records[index].createdAt || next.createdAt
        store.records[index] = next
      } else {
        store.records.unshift(next)
      }
      store.records = store.records.slice(0, MAX_RECORDS)
      writeStore(this.filePath, { version: STORE_VERSION, records: store.records })
      return { action: index >= 0 ? 'updated' : 'created', record: projectRecord(next) }
    })
  }

  async correct({ recordId, action = 'update', patch = {}, replacement = {}, reason = '' } = {}, context = {}) {
    return this.runSerial(async () => {
      const owner = text(context.ownerId, 'ownerId', 160, { required: true })
      const id = text(recordId, 'recordId', 160, { required: true })
      const selectedAction = text(action, '更正动作', 32, { required: true }).toLowerCase()
      if (!['update', 'delete', 'rewrite'].includes(selectedAction)) {
        throw new Error('更正动作必须是 update、delete 或 rewrite')
      }
      const store = readStore(this.filePath)
      const index = store.records.findIndex(item => (
        item.ownerId === owner && item.recordId === id && item.status !== 'deleted'
      ))
      if (index < 0) throw new Error('没有找到要更正的记录')
      const current = store.records[index]
      const nowIso = new Date().toISOString()
      if (selectedAction === 'delete') {
        const deleted = {
          ...current,
          status: 'deleted',
          updatedAt: nowIso,
          deletedAt: nowIso,
          correction: {
            action: 'delete',
            reason: optionalText(reason, '更正原因', 1000) || '用户要求删除',
            correctedAt: nowIso,
          },
        }
        store.records[index] = deleted
        writeStore(this.filePath, { version: STORE_VERSION, records: store.records })
        return { action: 'deleted', record: projectRecord(deleted) }
      }

      const source = selectedAction === 'rewrite' ? replacement : patch
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        throw new Error('更正内容必须是 JSON 对象')
      }
      const nextFacts = source.facts === undefined
        ? current.facts
        : { ...current.facts, ...source.facts }
      const nextInput = {
        ...current,
        ...source,
        recordId: current.recordId,
        ownerId: owner,
        category: source.category || storedRecordCategory(current),
        content: source.content || current.content || current.summary,
        facts: nextFacts,
        entities: source.entities === undefined ? current.entities : source.entities,
        // The gateway owns actor and source metadata. Keep the original
        // creation time while marking this as a manual correction.
        createdAt: current.createdAt,
        sourceTrigger: 'manual',
        idempotencyKey: current.idempotencyKey,
      }
      const next = normalizeRecord(nextInput, {
        ownerId: owner,
        actorId: context.actorId || current.actors?.recordedBy?.id || owner,
        actorName: context.actorName || current.actors?.recordedBy?.name || '',
        now: new Date(nowIso),
      })
      next.createdAt = current.createdAt || next.createdAt
      next.correction = {
        action: selectedAction,
        reason: optionalText(reason, '更正原因', 1000) || '用户要求更正',
        correctedAt: nowIso,
        previous: {
          summary: current.summary,
          category: current.category || current.recordType,
          action: current.action,
          content: current.content || current.summary,
          entities: current.entities,
          facts: current.facts,
        },
      }
      store.records[index] = next
      writeStore(this.filePath, { version: STORE_VERSION, records: store.records })
      return { action: selectedAction === 'rewrite' ? 'rewritten' : 'updated', record: projectRecord(next) }
    })
  }

  async query(filters = {}, context = {}) {
    return this.runSerial(async () => {
      const store = readStore(this.filePath)
      const owner = text(context.ownerId, 'ownerId', 160, { required: true })
      const normalizedFilters = {
        category: optionalText(filters.category || filters.eventType || filters.recordType, '记录类别', 80),
        status: optionalText(filters.status, '记录状态', 80),
        objectType: filters.objectType === undefined ? undefined : objectType(filters.objectType),
        objectId: optionalText(filters.objectId, '对象 ID', 160),
        keyword: optionalText(filters.keyword, '关键词', 500),
        from: normalizeDate(filters.from, '开始时间', undefined),
        to: normalizeDate(filters.to, '结束时间', undefined),
        includeDeleted: filters.includeDeleted === true,
      }
      const limit = Math.min(20, Math.max(1, Number(filters.limit) || 10))
      const records = store.records
        .filter(record => (
          record.ownerId === owner
          && (normalizedFilters.includeDeleted || record.status !== 'deleted')
          && recordMatches(record, normalizedFilters)
        ))
        .sort((left, right) => String(right.occurredAt).localeCompare(String(left.occurredAt)))
        .slice(0, limit)
        .map(projectRecord)
      return { total: records.length, records }
    })
  }
}

export function createAtomicRecordStore({ filePath } = {}) {
  return new LocalAtomicRecordStore({ filePath })
}

export { LEGACY_EVENT_TYPES as EVENT_TYPES, OBJECT_TYPES, RECORD_CATEGORIES }
