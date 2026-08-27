import {
  readFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

// The Gateway only talks to this small provider interface.  The current
// implementation reads local JSON files; the production implementation will
// call the Atomic Space MCP with the same four fast-path operations. The
// optional get_meta_model capability is intentionally not required here.
const DEFAULT_DIRECTORY = resolve('config/hotel-direct/atomic-space-mock')

function readJson(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw new Error(`原子空间 Mock 文件无法读取：${filePath}：${error.message}`)
  }
}

function compact(value) {
  return String(value || '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function text(value) {
  return String(value || '').trim()
}

function stableToken(value) {
  return createHash('sha1')
    .update(compact(value))
    .digest('hex')
    .slice(0, 12)
}

function unresolvedItemId(mention) {
  return `item:unresolved:${stableToken(mention)}`
}

function unresolvedLocationId(mention) {
  return `location:unresolved:${stableToken(mention)}`
}

function composedLocationId(mention) {
  const raw = text(mention)
  const floor = raw.match(/(\d{1,3})\s*楼/u)?.[1]
  const area = raw.includes('电梯')
    ? 'elevator-lobby'
    : raw.includes('走廊')
      ? 'corridor'
      : raw.includes('大堂')
        ? 'lobby'
        : raw.includes('前台')
          ? 'front-desk'
          : raw.includes('餐厅')
            ? 'restaurant'
            : raw.includes('会议')
              ? 'meeting-area'
              : raw.includes('门口')
                ? 'entrance'
                : ''
  if (floor && area) return `location:floor-${floor}:${area}`
  if (floor) return `location:floor-${floor}`
  return ''
}

function canonicalPrefix(type) {
  return `${type}:`
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function eventRequirementError({
  action,
  missingFacts = [],
  anyEntityTypes = [],
  anyEntityRoles = [],
  clarificationGuidance = '',
  entityHints = [],
  requireTraceableEntity = false,
}) {
  const error = new Error(`${action || '事件'}缺少必要业务信息`)
  error.code = 'ATOMIC_EVENT_REQUIREMENTS_MISSING'
  error.action = action
  error.missingFacts = missingFacts
  error.anyEntityTypes = anyEntityTypes
  error.anyEntityRoles = anyEntityRoles
  error.clarificationGuidance = clarificationGuidance
  error.entityHints = entityHints
  error.requireTraceableEntity = requireTraceableEntity
  return error
}

export class MockAtomicSpaceProvider {
  constructor({ directory = DEFAULT_DIRECTORY, recordStore } = {}) {
    this.directory = resolve(String(directory || DEFAULT_DIRECTORY))
    this.recordStore = recordStore || null
    this.index = null
    this.metaModels = null
    this.instances = null
  }

  get configured() {
    return Boolean(this.directory)
  }

  loadIndex() {
    if (!this.index) {
      this.index = readJson(resolve(this.directory, 'index.json'), {
        version: 1,
        tenantScope: 'mock',
        models: {},
        staticInstances: [],
        dynamicModels: [],
        idRules: {},
        writeContracts: {},
      })
    }
    return this.index
  }

  loadMetaModels() {
    if (!this.metaModels) {
      this.metaModels = readJson(resolve(this.directory, 'meta-models.json'), {
        version: 1,
        models: {},
      })
    }
    return this.metaModels
  }

  loadInstances() {
    if (!this.instances) {
      this.instances = readJson(resolve(this.directory, 'instances.json'), {
        version: 1,
        instances: [],
      })
    }
    return this.instances
  }

  // MCP: get_index.  The result is intentionally lightweight; it contains
  // names/aliases/rules, never live inventory counts or full stay records.
  async getIndex() {
    return structuredClone(this.loadIndex())
  }

  // Optional MCP capability for administration/debugging. The fast write path
  // does not call this method; its compact write contract is carried by
  // get_index and cached with the tenant index.
  async getMetaModel(modelType = 'event') {
    const model = this.loadMetaModels().models?.[modelType]
    if (!model) throw new Error(`原子空间没有 ${modelType} 元模型`)
    return structuredClone(model)
  }

  getEventWriteContract(category) {
    const contracts = this.loadIndex().writeContracts?.event
    const raw = text(category)
    const canonical = raw === '住客' ? '客人' : raw === '酒店运行' ? '酒店' : raw
    const definition = contracts?.categories?.[canonical]
    if (!contracts || !definition) {
      throw new Error(`索引没有声明可写入的记录类别：${category || '空类别'}`)
    }
    return definition
  }

  normalizeEventAction(category, action) {
    const raw = text(action)
    if (!raw) return ''
    const rules = this.getEventWriteContract(category)?.actionRules || {}
    for (const [canonical, rule] of Object.entries(rules)) {
      if (raw === canonical || asArray(rule?.aliases).includes(raw)) return canonical
    }
    return raw
  }

  findEventAction(action) {
    const raw = text(action)
    if (!raw) return null
    const categories = this.loadIndex().writeContracts?.event?.categories || {}
    for (const [category, definition] of Object.entries(categories)) {
      for (const [canonical, rule] of Object.entries(definition?.actionRules || {})) {
        if (raw === canonical || asArray(rule?.aliases).includes(raw)) {
          return { category, action: canonical, rule }
        }
      }
    }
    return null
  }

  normalizeEventDescriptor(category, action) {
    const matched = this.findEventAction(action)
    if (matched) return matched
    const canonicalCategory = text(category) === '住客'
      ? '客人'
      : text(category) === '酒店运行'
        ? '酒店'
        : text(category)
    return {
      category: canonicalCategory,
      action: this.normalizeEventAction(canonicalCategory, action),
      rule: null,
    }
  }

  isTraceableEntity(entity) {
    if (!entity || !entity.type || !entity.id) return false
    if (entity.resolution !== 'unresolved') return true
    const mention = compact(entity.mention || entity.id)
    if (!mention) return false
    const genericMentions = this.loadIndex().writeContracts?.event
      ?.traceableEntityPolicy?.genericMentions || {}
    return !asArray(genericMentions[entity.type])
      .map(compact)
      .includes(mention)
  }

  validateEventRequirements(resolved) {
    const contract = this.getEventWriteContract(resolved.category)
    const action = text(resolved.action)
    const rule = contract.actionRules?.[action]
    if (!rule) return

    const facts = resolved.facts || {}
    const missingFacts = asArray(rule.requiredFacts).filter(field => {
      const value = facts[field]
      return value === undefined || value === null || text(value) === ''
    })
    const allowedEntityTypes = asArray(rule.anyEntityTypes)
    const allowedEntityRoles = asArray(rule.anyEntityRoles)
      .map(role => text(role).toLocaleLowerCase())
    const requireTraceableEntity = rule.requireTraceableEntity === true
    const hasRequiredEntity = !allowedEntityTypes.length || asArray(resolved.entities)
      .some(entity => (
        allowedEntityTypes.includes(text(entity?.type).toLocaleLowerCase())
        && (!allowedEntityRoles.length
          || allowedEntityRoles.includes(text(entity?.role).toLocaleLowerCase()))
        && (!requireTraceableEntity || this.isTraceableEntity(entity))
      ))
    if (!missingFacts.length && hasRequiredEntity) return

    throw eventRequirementError({
      action,
      missingFacts,
      anyEntityTypes: hasRequiredEntity ? [] : allowedEntityTypes,
      anyEntityRoles: hasRequiredEntity ? [] : allowedEntityRoles,
      clarificationGuidance: text(rule?.clarificationGuidance)
        || text(rule?.clarification)
        || '补充能够使这条事实准确、可追踪的业务信息',
      entityHints: asArray(rule?.entityHints),
      requireTraceableEntity,
    })
  }

  staticInstances() {
    return asArray(this.loadIndex().staticInstances)
  }

  dynamicInstances() {
    return asArray(this.loadInstances().instances)
  }

  allInstances() {
    return [...this.staticInstances(), ...this.dynamicInstances()]
  }

  findById(type, id) {
    return this.allInstances().find(instance => (
      instance.type === type && instance.id === id
    ))
  }

  aliasesFor(instance) {
    return [instance.id, instance.name, instance.displayName, ...asArray(instance.aliases)]
      .map(compact)
      .filter(Boolean)
  }

  findByAlias(type, mention) {
    const key = compact(mention)
    if (!key) return null
    return this.allInstances().find(instance => (
      instance.type === type && this.aliasesFor(instance).includes(key)
    )) || null
  }

  normalizeRoomNumber(mention) {
    const raw = text(mention)
      .replace(/^room:/u, '')
      .replace(/房间|房号|房/gu, '')
    return /^\d{3,4}$/u.test(raw) ? raw : ''
  }

  async searchInstances({ type, filters = {}, limit = 10 } = {}) {
    const model = this.loadIndex().dynamicModels?.find(item => item.type === type)
    const normalizedType = text(type)
    const candidates = this.allInstances().filter(instance => instance.type === normalizedType)
    const roomId = text(filters.roomId || filters.roomNumber)
    const guestName = compact(filters.guestName)
    const stayId = text(filters.stayId)
    const results = candidates.filter(instance => {
      if (stayId && instance.stayId !== stayId && instance.id !== stayId) return false
      if (guestName && !this.aliasesFor(instance).some(alias => alias.includes(guestName))) return false
      if (roomId) {
        const roomNumber = this.normalizeRoomNumber(roomId)
        const roomIds = [instance.roomId, ...asArray(instance.roomHistory).map(item => item.roomId)]
        const matched = roomIds.some(value => (
          value === roomId || this.normalizeRoomNumber(value) === roomNumber
        ))
        if (!matched) return false
      }
      return true
    }).slice(0, Math.max(1, Math.min(50, Number(limit) || 10)))
    return {
      operation: model?.operation || 'search_instances',
      type: normalizedType,
      total: results.length,
      instances: structuredClone(results),
    }
  }

  async resolveOneEntity(entity, { entities = [] } = {}) {
    const type = text(entity?.type).toLocaleLowerCase()
    const mention = text(entity?.id || entity?.mention || entity?.name)
    if (!type || !mention) throw new Error('实体必须提供 type 和自然语言对象')
    const index = this.loadIndex()
    const rule = index.idRules?.[type]
    let instance = null
    let canonicalId = mention

    if (mention.startsWith(canonicalPrefix(type))) {
      instance = this.findById(type, mention)
    }
    if (!instance && rule?.mode === 'compose' && type === 'room') {
      const roomNumber = this.normalizeRoomNumber(mention)
      if (roomNumber) {
        canonicalId = String(rule.template || 'room:{roomNumber}')
          .replace('{roomNumber}', roomNumber)
        // Room numbers are tenant-local identifiers, not a closed catalog.
        // The index may contain aliases/room metadata, but a newly opened or
        // PMS-only room must still be recordable immediately. MCP can enrich
        // this composed instance later without blocking the voice turn.
        instance = this.findById(type, canonicalId) || { type, id: canonicalId }
      }
    }
    if (!instance) instance = this.findByAlias(type, mention)

    // Locations are open-world objects. A hotel should not have to pre-create
    // every elevator lobby, corridor or temporary collection point before a
    // staff member can report a fact. Prefer a readable floor/area ID and use
    // a stable unresolved ID for an otherwise free-form public place.
    if (!instance && type === 'location') {
      const composed = composedLocationId(mention)
      return {
        type,
        id: composed || unresolvedLocationId(mention),
        role: text(entity.role) || 'location',
      }
    }

    // Items are also open-world at the write boundary. The default catalog
    // covers common hotel supplies, but a rare item (or a guest's personal
    // property) must still be recordable. The deterministic unresolved ID is
    // queryable later and can be reconciled to a catalog item by a slow model.
    if (!instance && type === 'item') {
      return {
        type,
        id: unresolvedItemId(mention),
        role: text(entity.role) || 'item',
      }
    }

    // Dynamic stay/order resolution is the one lookup the fast model should
    // never perform itself.  A room mention gives us the query key.
    if (!instance && type === 'stay') {
      const room = entities.find(item => text(item?.type) === 'room')
      const roomNumber = this.normalizeRoomNumber(room?.id)
      if (roomNumber) {
        const result = await this.searchInstances({
          type: 'stay',
          filters: { roomNumber },
          limit: 2,
        })
        if (result.total === 1) instance = result.instances[0]
      }
    }
    if (!instance && type === 'order') {
      const stay = entities.find(item => text(item?.type) === 'stay')
      if (stay?.id && !String(stay.id).includes(':unresolved:')) {
        const result = await this.searchInstances({
          type: 'order',
          filters: { stayId: stay.id },
          limit: 2,
        })
        if (result.total === 1) instance = result.instances[0]
      }
    }
    if (!instance) return {
      type,
      id: `${type}:unresolved:${stableToken(mention)}`,
      role: text(entity.role) || type,
      resolution: 'unresolved',
      mention,
    }
    return {
      type,
      id: instance.id,
      role: text(entity.role) || type,
    }
  }

  // Natural-language entity mentions enter here as entities[].id.  This keeps
  // the realtime tool compact while ensuring only canonical IDs reach storage.
  async resolveEntities(entities = []) {
    const result = []
    const priority = {
      room: 1,
      item: 2,
      location: 3,
      stay: 4,
      order: 5,
      guest: 6,
      employee: 7,
      task: 8,
      service: 9,
      operation: 10,
    }
    const ordered = asArray(entities)
      .map((entity, index) => ({ entity, index }))
      .sort((left, right) => (
        (priority[text(left.entity?.type).toLocaleLowerCase()] || 99)
        - (priority[text(right.entity?.type).toLocaleLowerCase()] || 99)
        || left.index - right.index
      ))
    for (const { entity } of ordered) {
      // Pass already resolved entities to dynamic stay/order lookups. This is
      // what lets “2615 房 + 本次住店” become a canonical stay ID in one turn.
      result.push(await this.resolveOneEntity(entity, { entities: result }))
    }
    return result
  }

  async resolveEventInput(input = {}) {
    const descriptor = this.normalizeEventDescriptor(input.category, input.action)
    const rawEntities = asArray(input.entities).map(entity => {
      const entityType = text(entity?.type).toLocaleLowerCase()
      const mention = text(entity?.id || entity?.mention || entity?.name)
      if (entityType === 'room'
        && !this.normalizeRoomNumber(mention)
        && /楼|电梯|走廊|大堂|前台|门口|餐厅|会议/iu.test(mention)) {
        return {
          ...entity,
          type: 'location',
          id: text(input.facts?.location || input.facts?.foundLocation) || mention,
          role: text(entity.role) || 'location',
        }
      }
      return entity
    })
    if (!rawEntities.some(entity => text(entity?.type).toLocaleLowerCase() === 'location')
      && text(input.facts?.location || input.facts?.foundLocation)) {
      rawEntities.push({
        type: 'location',
        id: text(input.facts?.location || input.facts?.foundLocation),
        role: 'location',
      })
    }
    const entities = await this.resolveEntities(rawEntities)
    const facts = { ...(input.facts || {}) }
    const itemMention = text(facts.itemName || facts.itemId)
    if (itemMention) {
      const item = await this.resolveOneEntity({ type: 'item', id: itemMention }, { entities })
      facts.itemId = item.id
      facts.itemName = itemMention
      const itemInstance = this.findById('item', item.id)
      if (facts.quantity !== undefined && !text(facts.unit) && text(itemInstance?.defaultUnit)) {
        facts.unit = text(itemInstance.defaultUnit)
      }
      if (item.id.startsWith('item:unresolved:')) {
        facts.itemResolution = 'unresolved'
      }
      if (!entities.some(entity => entity.type === 'item' && entity.id === item.id)) {
        entities.push({ type: 'item', id: item.id, role: 'item' })
      }
    }
    // A room is often the only object spoken by staff. When the current room
    // has exactly one active stay, enrich the event with stay/guest/order so a
    // later checkout or settlement query does not depend on the employee
    // repeating the same context. Ambiguous or absent stays are left alone.
    if (!entities.some(entity => entity.type === 'stay')) {
      const complaint = descriptor.action === '投诉'
      const room = complaint
        ? entities.find(entity => (
            entity.type === 'room'
            && text(entity.role).toLocaleLowerCase() === 'complainant'
          ))
        : entities.find(entity => entity.type === 'room')
      if (room) {
        const stays = await this.searchInstances({
          type: 'stay',
          filters: { roomId: room.id },
          limit: 2,
        })
        if (stays.total === 1) {
          entities.push({ type: 'stay', id: stays.instances[0].id, role: 'stay' })
        }
      }
    }
    const dynamicStay = entities.find(entity => entity.type === 'stay')
    if (dynamicStay) {
      const stay = this.findById('stay', dynamicStay.id)
      if (stay?.roomId && !entities.some(entity => entity.type === 'room')) {
        entities.unshift({ type: 'room', id: stay.roomId, role: 'room' })
      }
      if (stay?.guestId && !entities.some(entity => entity.type === 'guest')) {
        entities.push({ type: 'guest', id: stay.guestId, role: 'guest' })
      }
      if (stay?.orderId && !entities.some(entity => entity.type === 'order')) {
        entities.push({ type: 'order', id: stay.orderId, role: 'order' })
      }
    }
    return {
      ...input,
      category: descriptor.category,
      action: descriptor.action,
      facts,
      entities,
    }
  }

  // MCP: write_instance for an event atom.  The store is only the local
  // persistence adapter; replacing it with an MCP client does not change the
  // Gateway contract.
  async writeInstance({ modelType = 'event', input, context } = {}) {
    if (modelType !== 'event') throw new Error(`Mock 暂不支持写入 ${modelType}`)
    if (!this.recordStore) throw new Error('原子空间未连接记录存储')
    if (text(input?.category)) this.getEventWriteContract(text(input.category))
    const resolved = await this.resolveEventInput(input)
    this.validateEventRequirements(resolved)
    return this.recordStore.write(resolved, context)
  }

  async queryInstances({ modelType = 'event', filters, context } = {}) {
    if (modelType !== 'event') return this.searchInstances({ type: modelType, filters })
    if (!this.recordStore) throw new Error('原子空间未连接记录存储')
    const nextFilters = { ...(filters || {}) }
    if (nextFilters.objectType && nextFilters.objectId) {
      const entity = await this.resolveOneEntity({
        type: nextFilters.objectType,
        id: nextFilters.objectId,
      })
      nextFilters.objectId = entity.id
    } else if (nextFilters.objectId && !nextFilters.keyword) {
      // A broad natural-object query such as “查 1015 房的记录” still has
      // useful recall even when the fast model omitted objectType. The exact
      // typed lookup above remains preferred whenever the type is known.
      nextFilters.keyword = nextFilters.objectId
      delete nextFilters.objectId
    }
    return this.recordStore.query(nextFilters, context)
  }

  // MCP: correct_instance for an event atom. Natural-language entity names
  // in a replacement/update are resolved through the same index used by
  // write_instance before the store validates and persists the correction.
  async correctInstance({
    modelType = 'event',
    recordId,
    action = 'update',
    patch = {},
    replacement = {},
    reason = '',
    context,
  } = {}) {
    if (modelType !== 'event') throw new Error(`Mock 暂不支持更正 ${modelType}`)
    if (!this.recordStore) throw new Error('原子空间未连接记录存储')
    const selected = String(action || 'update').toLowerCase()
    if (selected === 'delete') {
      return this.recordStore.correct({ recordId, action: selected, reason }, context)
    }
    const current = await this.recordStore.get(recordId, context, { includeDeleted: true })
    if (!current) throw new Error('没有找到要更正的记录')
    const source = selected === 'rewrite' ? replacement : patch
    const candidate = {
      ...current,
      ...source,
      facts: { ...(current.facts || {}), ...(source?.facts || {}) },
      entities: source?.entities === undefined ? current.entities : source.entities,
    }
    const resolved = await this.resolveEventInput(candidate)
    const resolvedSource = {
      ...source,
      ...(resolved.facts ? { facts: resolved.facts } : {}),
      ...(resolved.entities ? { entities: resolved.entities } : {}),
    }
    return this.recordStore.correct({
      recordId,
      action: selected,
      patch: selected === 'rewrite' ? {} : resolvedSource,
      replacement: selected === 'rewrite' ? resolvedSource : {},
      reason,
    }, context)
  }
}

export function createAtomicSpaceProvider({ directory, recordStore } = {}) {
  return new MockAtomicSpaceProvider({ directory, recordStore })
}
