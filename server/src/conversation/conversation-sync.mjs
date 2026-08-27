import { projectRecordFact } from './record-presentation.mjs'

function sessionKey(ownerId, sessionId) {
  return `${ownerId}\u0000${sessionId}`
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function speechKey(value) {
  return clean(value)
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '')
}

function speechNgrams(value, size = 2) {
  const grams = new Set()
  for (let index = 0; index <= value.length - size; index += 1) {
    grams.add(value.slice(index, index + size))
  }
  return grams
}

function equivalentSpeech(left, right) {
  if (left === right) return true
  if (left.length < 8 || right.length < 8) return false
  const leftGrams = speechNgrams(left)
  const rightGrams = speechNgrams(right)
  const shorterSize = Math.min(leftGrams.size, rightGrams.size)
  if (!shorterSize) return false
  let shared = 0
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) shared += 1
  }
  // Delegated acknowledgements often add details around the same short action
  // preview. One third of the shorter message is enough to recognize that
  // paraphrase without suppressing a genuinely different update.
  return shared / shorterSize >= 1 / 3
}

export class ConversationSync {
  constructor({
    maxMessages = 100,
    maxSessions = 500,
    sessionTtlMs = 6 * 60 * 60 * 1000,
  } = {}) {
    this.maxMessages = maxMessages
    this.maxSessions = maxSessions
    this.sessionTtlMs = sessionTtlMs
    this.sessions = new Map()
    this.sequence = 0
  }

  configureRetention(options = {}) {
    Object.assign(this, options)
  }

  state(ownerId, sessionId) {
    this.prune()
    const key = sessionKey(ownerId, sessionId)
    let state = this.sessions.get(key)
    if (!state) {
      this.enforceSessionLimit()
      state = {
        messages: [],
        byId: new Map(),
        taskFacts: new Map(),
        recordFacts: new Map(),
        pendingRecord: null,
        lastAccessedAt: Date.now(),
      }
      this.sessions.set(key, state)
    }
    state.lastAccessedAt = Date.now()
    return state
  }

  peek(ownerId, sessionId) {
    const state = this.sessions.get(sessionKey(ownerId, sessionId))
    if (state) state.lastAccessedAt = Date.now()
    return state || null
  }

  prune(now = Date.now()) {
    this.sessions.forEach((state, key) => {
      if (now - state.lastAccessedAt >= this.sessionTtlMs) this.sessions.delete(key)
    })
  }

  enforceSessionLimit() {
    while (this.sessions.size >= this.maxSessions) {
      const oldest = [...this.sessions.entries()]
        .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt)[0]
      if (!oldest) break
      this.sessions.delete(oldest[0])
    }
  }

  record({
    ownerId,
    sessionId,
    id,
    role,
    content,
    source,
    turnId = null,
    taskId = null,
    taskIds = [],
  }) {
    const normalized = clean(content)
    if (!id || !normalized) return null
    const state = this.state(ownerId, sessionId)
    const existing = state.byId.get(id)
    if (existing) {
      Object.assign(existing, {
        role,
        content: normalized,
        source,
        turnId,
        taskId,
        taskIds: [...new Set((taskIds || []).filter(Boolean))],
      })
      return { ...existing }
    }
    const message = {
      seq: ++this.sequence,
      id,
      role,
      content: normalized,
      source,
      turnId,
      taskId,
      taskIds: [...new Set((taskIds || []).filter(Boolean))],
      createdAt: Date.now(),
    }
    state.messages.push(message)
    state.byId.set(id, message)
    while (state.messages.length > this.maxMessages) {
      const removed = state.messages.shift()
      state.byId.delete(removed.id)
    }
    return { ...message }
  }

  list({ ownerId, sessionId }) {
    this.prune()
    return (this.peek(ownerId, sessionId)?.messages || [])
      .map(message => ({ ...message }))
  }

  recordTaskFact({
    ownerId,
    sessionId,
    taskId,
    summary,
    status,
    assignee,
    note,
  } = {}) {
    const id = clean(taskId)
    if (!id) return null
    const state = this.state(ownerId, sessionId)
    const previous = state.taskFacts.get(id) || { taskId: id }
    const fact = {
      ...previous,
      ...(clean(summary) ? { summary: clean(summary).slice(0, 160) } : {}),
      ...(clean(status) ? { status: clean(status).slice(0, 40) } : {}),
      ...(clean(assignee) ? { assignee: clean(assignee).slice(0, 80) } : {}),
      ...(clean(note) ? { note: clean(note).slice(0, 300) } : {}),
      updatedAt: Date.now(),
    }
    state.taskFacts.set(id, fact)
    while (state.taskFacts.size > 12) {
      const oldest = [...state.taskFacts.entries()]
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]
      if (!oldest) break
      state.taskFacts.delete(oldest[0])
    }
    return { ...fact }
  }

  removeTaskFact({ ownerId, sessionId, taskId } = {}) {
    const state = this.peek(ownerId, sessionId)
    if (!state?.taskFacts) return false
    return state.taskFacts.delete(clean(taskId))
  }

  recordRecordFact({
    ownerId,
    sessionId,
    record,
    operation = 'created',
  } = {}) {
    const fact = projectRecordFact(record, operation)
    if (!fact.recordId) return null
    const state = this.state(ownerId, sessionId)
    state.recordFacts ||= new Map()
    if (fact.operation === 'deleted') {
      state.recordFacts.delete(fact.recordId)
      return fact
    }
    state.recordFacts.set(fact.recordId, {
      ...fact,
      updatedAt: Date.now(),
    })
    while (state.recordFacts.size > 8) {
      const oldest = [...state.recordFacts.entries()]
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]
      if (!oldest) break
      state.recordFacts.delete(oldest[0])
    }
    return { ...state.recordFacts.get(fact.recordId) }
  }

  recordContext({ ownerId, sessionId } = {}) {
    const state = this.peek(ownerId, sessionId)
    if (!state) return []
    state.recordFacts ||= new Map()
    return [...(state?.recordFacts?.values() || [])]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(fact => ({ ...fact }))
  }

  setPendingRecord({ ownerId, sessionId, pending } = {}) {
    const state = this.state(ownerId, sessionId)
    if (!pending) {
      state.pendingRecord = null
      return null
    }
    const input = pending.input && typeof pending.input === 'object'
      ? pending.input
      : {}
    const facts = input.facts && typeof input.facts === 'object' && !Array.isArray(input.facts)
      ? Object.fromEntries(Object.entries(input.facts).slice(0, 24))
      : {}
    const entities = Array.isArray(input.entities)
      ? input.entities.slice(0, 16).map(entity => ({
          type: clean(entity?.type).slice(0, 40),
          id: clean(entity?.id || entity?.mention || entity?.name).slice(0, 160),
          role: clean(entity?.role).slice(0, 80),
        })).filter(entity => entity.type && entity.id)
      : []
    state.pendingRecord = {
      category: clean(input.category).slice(0, 40),
      action: clean(input.action).slice(0, 80),
      content: clean(input.content).slice(0, 500),
      facts,
      entities,
      missingFacts: Array.isArray(pending.missingFacts)
        ? pending.missingFacts.map(clean).filter(Boolean).slice(0, 16)
        : [],
      anyEntityTypes: Array.isArray(pending.anyEntityTypes)
        ? pending.anyEntityTypes.map(clean).filter(Boolean).slice(0, 16)
        : [],
      anyEntityRoles: Array.isArray(pending.anyEntityRoles)
        ? pending.anyEntityRoles.map(clean).filter(Boolean).slice(0, 16)
        : [],
      guidance: clean(pending.guidance).slice(0, 500),
      entityHints: Array.isArray(pending.entityHints)
        ? pending.entityHints.map(clean).filter(Boolean).slice(0, 12)
        : [],
      updatedAt: Date.now(),
    }
    return { ...state.pendingRecord }
  }

  pendingRecordContext({ ownerId, sessionId, maxAgeMs = 15 * 60 * 1000 } = {}) {
    const state = this.peek(ownerId, sessionId)
    const pending = state?.pendingRecord
    if (!pending) return null
    if (Date.now() - pending.updatedAt > maxAgeMs) {
      state.pendingRecord = null
      return null
    }
    return structuredClone(pending)
  }

  taskContext({ ownerId, sessionId } = {}) {
    const state = this.peek(ownerId, sessionId)
    return [...(state?.taskFacts?.values() || [])]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(fact => ({ ...fact }))
  }

  hasEquivalentAssistantSpeech({
    ownerId,
    sessionId,
    turnId,
    content,
  }) {
    const target = speechKey(content)
    if (!target) return false
    return this.list({ ownerId, sessionId }).some(message => (
      message.role === 'assistant'
      && message.turnId === turnId
      && equivalentSpeech(speechKey(message.content), target)
    ))
  }

  frontendContext({ ownerId, sessionId }) {
    const messages = this.list({ ownerId, sessionId })
    const presentedTaskIds = new Set()
    messages
      .filter(message => message.source === 'agent-presentation')
      .forEach(message => {
        if (message.taskId) presentedTaskIds.add(message.taskId)
        message.taskIds?.forEach(taskId => presentedTaskIds.add(taskId))
      })
    return messages.filter(message => (
      [
        'voice-user',
        'text-user',
        'realtime-direct',
        'tool-result',
        'agent-presentation',
      ].includes(message.source)
      || (
        message.source === 'agent-result'
        && message.taskId
        && !presentedTaskIds.has(message.taskId)
      )
    ))
  }

}

export const conversationSync = new ConversationSync()
