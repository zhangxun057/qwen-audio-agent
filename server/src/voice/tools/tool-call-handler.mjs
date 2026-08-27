import {
  CANCEL_AGENT_TASK_TOOL_NAME,
  SCHEDULE_REMINDER_TOOL_NAME,
  DELEGATE_TOOL_NAME,
  GET_AGENT_TASK_STATUS_TOOL_NAME,
  GET_CURRENT_TIME_TOOL_NAME,
  ENTER_SLEEP_TOOL_NAME,
  NOTES_TOOL_NAME,
  MEMORY_TOOL_NAME,
  RESPOND_AGENT_PERMISSION_TOOL_NAME,
  SPIRIT_TASK_LIST_TOOL_NAME,
  SPIRIT_TASK_DETAIL_TOOL_NAME,
  SPIRIT_TASK_COMMENTS_TOOL_NAME,
  SPIRIT_TASK_CREATE_TOOL_NAME,
  SPIRIT_TASK_UPDATE_TOOL_NAME,
  SPIRIT_TASK_START_TOOL_NAME,
  SPIRIT_TASK_COMPLETE_TOOL_NAME,
  SPIRIT_TASK_UPDATE_STATUS_TOOL_NAME,
  SPIRIT_TASK_ADD_COMMENT_TOOL_NAME,
  SPIRIT_TASK_DELETE_TOOL_NAME,
  SPIRIT_VOICE_NOTIFY_TOOL_NAME,
  ATOMIC_RECORD_WRITE_TOOL_NAME,
  ATOMIC_RECORD_QUERY_TOOL_NAME,
  ATOMIC_RECORD_CORRECT_TOOL_NAME,
} from '../realtime-provider.mjs'
import { currentTimeSnapshot } from '../../conversation/frontend-agent-context.mjs'
import { canonicalScope, isMemoryDocument } from '../../core/memory-scopes.mjs'
import {
  buildSpiritTaskExecutor,
  buildSpiritTaskUsers,
  normalizeSpiritTaskSummary,
  resolveSpiritAssignee,
  SPIRIT_DEMO_CHANNEL,
  SPIRIT_DEMO_SELF_TEST_ACCOUNT,
} from '../spirit-task-directory.mjs'
import {
  SPIRIT_TASK_RECORD_SOURCES,
  SPIRIT_TASK_STATUSES,
} from '../spirit-task-direct.mjs'
import { buildRecordVoiceConfirmation } from '../../conversation/record-presentation.mjs'

const SENSITIVE_MEMORY = /(?:pass(?:word)?|secret|api[_ -]?key|access[_ -]?token|credential|验证码|密码|密钥|令牌|\bsk-[a-z0-9_-]+)/i
const TASK_NOTIFICATION_WAIT_MS = 5_000
const ATOMIC_FACT_STATES = new Set(['occurred', 'confirmed_arrangement'])

function failure(errorCode, userMessage, {
  retryable = false,
  status = 'failed',
  ...details
} = {}) {
  return {
    status,
    error: true,
    error_code: errorCode,
    user_message: userMessage,
    retryable,
    ...details,
  }
}

const ATOMIC_RECORD_BUSINESS_FIELDS = Object.freeze([
  'category',
  'action',
  'content',
  'facts',
  'entities',
  'occurredAt',
  'details',
  'status',
])

const ATOMIC_RECORD_CATEGORIES = new Set([
  '物品',
  '客人',
  '酒店',
  '其他',
  // Historical model outputs remain readable during the migration.
  '住客',
  '酒店运行',
])

const ATOMIC_ENTITY_TYPES = new Set([
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

function atomicBusinessInput(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}
  return Object.fromEntries(
    ATOMIC_RECORD_BUSINESS_FIELDS
      .filter(field => Object.hasOwn(source, field))
      .map(field => [field, source[field]]),
  )
}

function atomicMinimumInput(value) {
  const source = atomicBusinessInput(value)
  const content = typeof source.content === 'string' ? source.content.trim() : ''
  if (!content) return null
  const category = typeof source.category === 'string' ? source.category.trim() : ''
  return {
    // A malformed category must not turn an otherwise complete fact into a
    // failed voice interaction. "其他" is deliberately the open fallback.
    category: ATOMIC_RECORD_CATEGORIES.has(category)
      ? category
      : '其他',
    content,
  }
}

function speechFragment(value) {
  return String(value || '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[。！？!?；;]+$/u, '')
}

function taskDispatchConfirmation({ summary, assigneeName, notificationStatus, selfTest = false }) {
  const task = speechFragment(summary) || '这项任务'
  const assignee = speechFragment(assigneeName) || '执行人'
  const base = selfTest
    ? `已创建自测任务，执行人${assignee}：${task}`
    : `已派给${assignee}：${task}`
  if (selfTest || notificationStatus === 'disabled') return `${base}；按要求不发送通知。`
  if (notificationStatus === 'sent') return `${base}；通知已发送。`
  if (notificationStatus === 'skipped_by_gate') return `${base}；接收人关闭了通知。`
  if (notificationStatus === 'timeout') return `${base}；通知结果暂未确认。`
  if (notificationStatus === 'not_configured') return `${base}；通知未配置。`
  if (notificationStatus === 'not_available') return `${base}；通知未发送。`
  return `${base}；通知发送失败。`
}

function notificationConfirmation({ recipientName, content, status }) {
  const recipient = speechFragment(recipientName) || '接收人'
  const message = speechFragment(content) || '这条消息'
  if (status === 'sent') return `已通知${recipient}：${message}。`
  if (status === 'skipped_by_gate') return `${recipient}关闭了通知，未发送：${message}。`
  if (status === 'timeout') return `已向${recipient}发起通知：${message}；结果暂未确认。`
  return `未能通知${recipient}：${message}。`
}

async function settleWithTimeout(promise, timeoutMs) {
  let timer
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({
      status: 'timeout',
      timeoutMs,
    }), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function correctionTargetWord(transcript) {
  const source = String(transcript || '').trim()
  if (!/(?:改|更正|纠正|记错|不是)/u.test(source)) return ''
  return [...source.matchAll(/今天|明天|后天|昨天|前天/gu)].at(-1)?.[0] || ''
}

function deriveCorrectionChanges(current, transcript) {
  if (!current || !transcript) return {}
  const source = String(current.content || current.summary || '').trim()
  if (!source) return {}
  const targetWord = correctionTargetWord(transcript)
  if (targetWord) {
    const dateWords = /今天|明天|后天|昨天|前天/gu
    const replacement = source.replace(dateWords, targetWord)
    if (replacement !== source) return { content: replacement }
  }

  const roomMatch = transcript.match(/(?:不是|原来是)\s*(\d{3,4})\s*房?(?:间)?[^，。；;]*?(?:改成|是)\s*(\d{3,4})\s*房?(?:间)?/u)
  if (roomMatch && source.includes(roomMatch[1])) {
    const [, previousRoom, nextRoom] = roomMatch
    const nextEntities = Array.isArray(current.entities)
      ? current.entities.map(entity => entity?.type === 'room'
        ? { ...entity, id: `room:${nextRoom}` }
        : entity)
      : undefined
    return {
      content: source.replaceAll(previousRoom, nextRoom),
      ...(nextEntities ? { entities: nextEntities } : {}),
    }
  }
  return {}
}

function atomicBestEffortInput(value) {
  const source = atomicBusinessInput(value)
  const minimum = atomicMinimumInput(source)
  if (!minimum) return null
  const result = { ...minimum }

  for (const [field, limit] of [['action', 120], ['details', 8_000], ['status', 80]]) {
    const candidate = typeof source[field] === 'string' ? source[field].trim() : ''
    if (candidate && candidate.length <= limit) result[field] = candidate
  }
  if (typeof source.occurredAt === 'string' && Number.isFinite(new Date(source.occurredAt).getTime())) {
    result.occurredAt = source.occurredAt
  }
  if (source.facts && typeof source.facts === 'object' && !Array.isArray(source.facts)) {
    const facts = Object.fromEntries(Object.entries(source.facts)
      .filter(([key]) => /^[a-zA-Z一-鿿][a-zA-Z0-9_一-鿿]*$/u.test(key))
      .map(([key, raw]) => {
        if (['quantity', 'countedQuantity'].includes(key)) {
          const numeric = Number(raw)
          if (!Number.isFinite(numeric) || numeric < 0) return null
          return [key, numeric]
        }
        if (raw === null || ['string', 'number', 'boolean'].includes(typeof raw)) return [key, raw]
        try {
          return [key, JSON.stringify(raw).slice(0, 2_000)]
        } catch {
          return null
        }
      })
      .filter(Boolean))
    if (Object.keys(facts).length) result.facts = facts
  }
  if (Array.isArray(source.entities)) {
    const entities = source.entities
      .filter(entity => entity && typeof entity === 'object' && !Array.isArray(entity))
      .map(entity => ({
        type: String(entity.type || '').trim().toLowerCase(),
        id: String(entity.id || entity.mention || entity.name || '').trim(),
        role: typeof entity.role === 'string' ? entity.role.trim() : '',
      }))
      .filter(entity => (
        ATOMIC_ENTITY_TYPES.has(entity.type)
        && entity.id
        && entity.id.length <= 160
        && (!entity.role || entity.role.length <= 80)
      ))
      .map(entity => ({
        type: entity.type,
        id: entity.id,
        ...(entity.role ? { role: entity.role } : {}),
      }))
    if (entities.length) result.entities = entities
  }
  return result
}

class TaskReferenceError extends Error {
  constructor(code, userMessage) {
    super(userMessage)
    this.code = code
    this.userMessage = userMessage
  }
}

function compactTaskText(value) {
  return String(value || '')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function normalizeTaskReference(value) {
  return compactTaskText(value)
    .replace(/(?:这个|那个|刚才|刚刚|上一(?:个|项)|任务|那项)/gu, '')
}

const SPIRIT_TASK_TIME_ZONE = 'Asia/Shanghai'

const TASK_MUTATION_TOOLS = new Set([
  SPIRIT_TASK_CREATE_TOOL_NAME,
  SPIRIT_TASK_UPDATE_TOOL_NAME,
  SPIRIT_TASK_START_TOOL_NAME,
  SPIRIT_TASK_COMPLETE_TOOL_NAME,
  SPIRIT_TASK_UPDATE_STATUS_TOOL_NAME,
  SPIRIT_TASK_ADD_COMMENT_TOOL_NAME,
  SPIRIT_TASK_DELETE_TOOL_NAME,
])

function standardTaskDurationMinutes(request) {
  const text = String(request || '').replace(/\s+/gu, '')
  if (!text) return null
  const extended = /跨楼层|跨区|跨区域/u.test(text)
  if (/(?:客房)?送[^，。；;]{0,20}(?:水|毛巾|物)|送到房/u.test(text)) return extended ? 12 : 7
  if (/(?:住中|续住|退房)?清洁|清洁房间/u.test(text)) return 30
  if (/(?:身份核验)?开门|核验.*开门/u.test(text)) return extended ? 12 : 7
  if (/(?:住中需求|续住|换房|延迟退房|叫醒)/u.test(text)) return extended ? 12 : 7
  return null
}

function parseSpiritLocalDateTime(value) {
  const text = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(text)) return null
  const date = new Date(`${text.replace(' ', 'T')}+08:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatSpiritLocalDateTime(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: SPIRIT_TASK_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date).map(part => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

function resolveSpiritPlanTimes({ request, executeTime, completeTime, now = new Date() }) {
  let resolvedExecute = String(executeTime || '').trim() || undefined
  let resolvedComplete = String(completeTime || '').trim() || undefined
  const duration = standardTaskDurationMinutes(request)
  if (duration) {
    if (resolvedExecute && !resolvedComplete) {
      const start = parseSpiritLocalDateTime(resolvedExecute)
      if (start) resolvedComplete = formatSpiritLocalDateTime(
        new Date(start.getTime() + duration * 60_000),
      )
    } else if (!resolvedExecute && resolvedComplete) {
      const deadline = parseSpiritLocalDateTime(resolvedComplete)
      if (deadline) resolvedExecute = formatSpiritLocalDateTime(
        new Date(deadline.getTime() - duration * 60_000),
      )
    } else if (!resolvedExecute && !resolvedComplete) {
      resolvedComplete = formatSpiritLocalDateTime(
        new Date(now.getTime() + duration * 60_000),
      )
    }
  }
  return {
    executeTime: resolvedExecute,
    completeTime: resolvedComplete,
    status: resolvedExecute ? 'PENDING_RECEIPT' : 'IN_PROGRESS',
  }
}

function taskRecords(result) {
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.records)) return result.records
  if (Array.isArray(result?.list)) return result.list
  if (Array.isArray(result?.tasks)) return result.tasks
  return []
}

function taskIdFromRecord(record) {
  return String(record?.taskId || record?.id || '').trim()
}

function taskCandidateLabel(record) {
  const id = taskIdFromRecord(record)
  const summary = String(record?.summary || record?.title || '').trim()
  const users = Array.isArray(record?.users) ? record.users : []
  const assignee = users
    .filter(user => String(user?.userRole || '').toUpperCase() === 'EXECUTOR')
    .map(user => String(user?.userName || user?.name || '').trim())
    .filter(Boolean)
    .join('、')
  return [summary, assignee, id].filter(Boolean).join('｜')
}

function projectTaskUser(user) {
  return {
    userId: user?.userId,
    userName: user?.userName || user?.name,
    userRole: user?.userRole || user?.roleCode,
  }
}

function projectTaskRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record
  const users = Array.isArray(record.users)
    ? record.users.map(projectTaskUser)
    : Array.isArray(record.executors)
      ? record.executors.map(projectTaskUser)
      : []
  const executor = users.find(user => String(user?.userRole || '').toUpperCase() === 'EXECUTOR')
  const creator = users.find(user => String(user?.userRole || '').toUpperCase() === 'CREATOR')
  const statusLabels = {
    PENDING_ADMISSION: '待受理',
    PENDING_RECEIPT: '待受理',
    TODO: '待处理',
    IN_PROGRESS: '进行中',
    PENDING_APPROVAL: '待审批',
    DONE: '已完成',
    EXCEPTION: '异常',
  }
  return {
    taskId: record.taskId || record.id,
    summary: record.summary || record.title,
    description: record.description,
    taskOpeningPrompt: record.taskOpeningPrompt,
    status: record.status,
    statusLabel: statusLabels[record.status] || record.status,
    acceptTime: record.acceptTime,
    executeTime: record.executeTime,
    completeTime: record.completeTime,
    completionRemark: record.completionRemark,
    createTime: record.createTime,
    executor,
    creator,
    users,
    subTasks: Array.isArray(record.subTasks)
      ? record.subTasks.slice(0, 20).map(subTask => ({
          taskId: subTask?.taskId || subTask?.id,
          summary: subTask?.summary || subTask?.title,
          status: subTask?.status,
        }))
      : [],
  }
}

function projectTaskQueryResult(toolName, result) {
  if (toolName === SPIRIT_TASK_LIST_TOOL_NAME) {
    if (Array.isArray(result)) return result.map(projectTaskRecord)
    if (result && typeof result === 'object') {
      const records = taskRecords(result)
      return {
        current: result.current,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: result.totalPages,
        records: records.map(projectTaskRecord),
      }
    }
  }
  if (toolName === SPIRIT_TASK_DETAIL_TOOL_NAME) return projectTaskRecord(result)
  if (toolName === SPIRIT_TASK_COMMENTS_TOOL_NAME) {
    const projectComment = comment => ({
      id: comment?.id,
      content: comment?.content || comment?.remark || comment?.text,
      recordSource: comment?.recordSource,
      operatorName: comment?.operatorName || comment?.userName,
      createTime: comment?.createTime,
    })
    if (Array.isArray(result)) return result.slice(0, 100).map(projectComment)
    if (result && typeof result === 'object') {
      const records = taskRecords(result)
      return {
        total: result.total,
        records: records.slice(0, 100).map(projectComment),
      }
    }
  }
  return result
}

export class ToolCallHandler {
  constructor({
    taskManager,
    ownerId,
    sessionId,
    transcripts,
    getFrontend,
    getTurnId,
    getTurnGeneration,
    coordinator,
    backendAvailability = null,
    memoryService,
    notesStore,
    getClientContext = () => ({}),
    getConversationContext = () => [],
    getTaskContext = () => [],
    getRecordContext = () => [],
    getEnterpriseContext = async () => null,
    onTaskContextChanged = () => {},
    onMemoryChanged = () => {},
    respondPermission,
    permissionPolicy,
    onPermissionDeliveryFailed = () => {},
    requestClientState = () => {},
    spiritTaskClient = null,
    spiritVoiceNotifier = null,
    atomicRecordStore = null,
    atomicSpaceProvider = null,
    taskNotificationWaitMs = TASK_NOTIFICATION_WAIT_MS,
    onConversationMessage = () => {},
    onRecordFact = () => {},
    onRecordClarification = () => {},
    onToolConfirmationPending = () => {},
  }) {
    this.taskManager = taskManager
    this.ownerId = ownerId
    this.sessionId = sessionId
    this.transcripts = transcripts
    this.getFrontend = getFrontend
    this.getTurnId = getTurnId
    this.getTurnGeneration = getTurnGeneration
    this.coordinator = coordinator
    this.backendAvailability = backendAvailability
    this.memoryService = memoryService
    this.notesStore = notesStore
    this.getClientContext = getClientContext
    this.getConversationContext = getConversationContext
    this.getTaskContext = getTaskContext
    this.getRecordContext = getRecordContext
    this.getEnterpriseContext = getEnterpriseContext
    this.onTaskContextChanged = onTaskContextChanged
    this.onMemoryChanged = onMemoryChanged
    this.respondPermission = respondPermission
    this.permissionPolicy = permissionPolicy
    this.onPermissionDeliveryFailed = onPermissionDeliveryFailed
    this.requestClientState = requestClientState
    this.spiritTaskClient = spiritTaskClient
    this.spiritVoiceNotifier = spiritVoiceNotifier
    this.atomicRecordStore = atomicRecordStore
    this.atomicSpaceProvider = atomicSpaceProvider
    this.taskNotificationWaitMs = Math.max(1, Number(taskNotificationWaitMs) || TASK_NOTIFICATION_WAIT_MS)
    this.onConversationMessage = onConversationMessage
    this.onRecordFact = onRecordFact
    this.onRecordClarification = onRecordClarification
    this.onToolConfirmationPending = onToolConfirmationPending
    this.gatewayApprovedPermissions = new Set()
    this.processedCalls = new Set()
    this.turnTasks = new Map()
    this.turnOperationModes = new Map()
    this.atomicWriteFailures = new Map()
    this.deferredToolResponses = new Map()
  }

  claimTurnOperation(turnId, mode) {
    const key = String(turnId || '').trim()
    if (!key) return true
    const current = this.turnOperationModes.get(key)
    if (current && current !== mode) return false
    this.turnOperationModes.set(key, mode)
    if (this.turnOperationModes.size > 200) {
      this.turnOperationModes.delete(this.turnOperationModes.keys().next().value)
    }
    return true
  }

  releaseTurnOperation(turnId, mode) {
    const key = String(turnId || '').trim()
    if (!key || this.turnOperationModes.get(key) !== mode) return false
    this.turnOperationModes.delete(key)
    return true
  }

  isStale(turnId, generation) {
    return (
      generation !== this.getTurnGeneration()
      || Boolean(turnId && this.getTurnId() && turnId !== this.getTurnId())
    )
  }

  async sendOutput(callId, output, turnId, taskId, options) {
    const {
      responseContext,
      ...frontendOptions
    } = options || {}
    const frontend = this.getFrontend?.()
    if (!frontend || typeof frontend.sendFunctionOutput !== 'function') {
      if (output?.status === 'ok' && output?.source === 'spirit-api-direct') {
        this.onTaskContextChanged(output)
      }
      return { skipped: true, reason: 'realtime_unavailable' }
    }
    const delivery = await frontend.sendFunctionOutput(
      callId,
      output,
      { turnId, taskId, ...(responseContext || {}) },
      frontendOptions,
    )
    if (!delivery && frontend.ready === false) {
      return { skipped: true, reason: 'realtime_not_ready' }
    }
    if (output?.status === 'ok' && output?.source === 'spirit-api-direct') {
      this.onTaskContextChanged(output)
    }
    return delivery
  }

  async sendConfirmedOutput(callId, output, turnId, taskId, confirmation) {
    const liveFrontend = this.getFrontend?.()
    let delivery
    try {
      if (typeof liveFrontend?.speak === 'function') {
        delivery = await this.sendOutput(callId, output, turnId, taskId, {
          createResponse: false,
        })
        if (!delivery?.skipped && !delivery?.failed) {
          delivery = await liveFrontend.speak(confirmation, 'agent', { turnId, taskId }, {
            verbatim: true,
          })
        }
      } else {
        delivery = await this.sendOutput(callId, output, turnId, taskId, {
          response: {
            instructions: [
              `只说下面这句话，不要改写：${confirmation}`,
              '不要朗读任务 ID、用户 ID、记录 ID、接口名或内部字段。',
            ].join(' '),
          },
        })
      }
    } catch (error) {
      delivery = { failed: true, error: String(error?.message || error) }
    }
    if (delivery?.reason === 'realtime_unavailable'
      || delivery?.reason === 'realtime_not_ready'
      || delivery?.failed
      || delivery?.timedOut
      || delivery?.cancelled) {
      this.onToolConfirmationPending({ content: confirmation, turnId })
    }
    return delivery
  }

  async speakBackgroundConfirmation(content, { turnId, taskId } = {}) {
    const confirmation = String(content || '').trim()
    if (!confirmation) return
    this.onConversationMessage({
      role: 'assistant',
      content: confirmation,
      source: 'tool-result',
      turnId,
    })
    const liveFrontend = this.getFrontend?.()
    if (typeof liveFrontend?.speak !== 'function' || liveFrontend.ready === false) {
      this.onToolConfirmationPending({ content: confirmation, turnId })
      return
    }
    try {
      const delivery = await liveFrontend.speak(
        confirmation,
        'agent',
        { turnId, taskId },
        { verbatim: true },
      )
      if (delivery?.failed || delivery?.timedOut || delivery?.cancelled || delivery?.skipped) {
        this.onToolConfirmationPending({ content: confirmation, turnId })
      }
    } catch {
      this.onToolConfirmationPending({ content: confirmation, turnId })
    }
  }

  beginDeferredToolResponse(responseId, { turnId, turnGeneration } = {}) {
    const key = String(responseId || '')
    if (!key) return null
    const batch = this.deferredToolResponses.get(key) || {
      pending: 0,
      sourceDone: false,
      failed: false,
      suppressResponse: false,
      turnId,
      turnGeneration,
    }
    if (!this.deferredToolResponses.has(key) && this.deferredToolResponses.size >= 100) {
      this.deferredToolResponses.delete(this.deferredToolResponses.keys().next().value)
    }
    batch.pending += 1
    this.deferredToolResponses.set(key, batch)
    return key
  }

  async completeDeferredToolResponse(responseId, { failed = false } = {}) {
    const batch = this.deferredToolResponses.get(responseId)
    if (!batch) return
    batch.pending = Math.max(0, batch.pending - 1)
    batch.failed ||= failed
    await this.flushDeferredToolResponse(responseId, batch)
  }

  async finishToolResponse(responseId, { suppressResponse = false } = {}) {
    const key = String(responseId || '')
    const batch = this.deferredToolResponses.get(key)
    if (!batch) return
    batch.sourceDone = true
    batch.suppressResponse ||= suppressResponse
    await this.flushDeferredToolResponse(key, batch)
  }

  async flushDeferredToolResponse(responseId, batch) {
    if (!batch.sourceDone || batch.pending > 0) return
    this.deferredToolResponses.delete(responseId)
    if (batch.failed || batch.suppressResponse) return
    await this.getFrontend()?.ensureResponse?.({
      turnId: batch.turnId,
      turnGeneration: batch.turnGeneration,
    })
  }

  async closeStaleCall(callId, turnId) {
    await this.sendOutput(
      callId,
      {
        status: 'superseded',
        message: '用户已经开始了新一轮，这次尚未提交。',
      },
      turnId,
      null,
      { createResponse: false },
    )
  }

  forwardCoordinatorEvent(event, onEvent) {
    const permission = event?.permission
    if (
      event?.type === 'backend.permission.resolved'
      && permission?.id
      && this.gatewayApprovedPermissions.delete(permission.id)
    ) return
    if (
      event?.type !== 'backend.permission.requested'
      || !permission?.id
      || !this.respondPermission
      || !this.permissionPolicy?.shouldAutoAllow(
        this.ownerId,
        this.sessionId,
      )
    ) {
      onEvent(event)
      return
    }
    this.gatewayApprovedPermissions.add(permission.id)
    let approval
    try {
      approval = this.respondPermission(
        permission.id,
        'always',
        { ownerId: this.ownerId },
      )
    } catch {
      this.gatewayApprovedPermissions.delete(permission.id)
      onEvent(event)
      return
    }
    Promise.resolve(approval)
      .then(() => this.gatewayApprovedPermissions.delete(permission.id))
      .catch(() => {
        if (this.gatewayApprovedPermissions.delete(permission.id)) {
          onEvent(event)
        }
      })
  }

  createWork({ turnId, objective, verbatimRequest, submissionKey }) {
    let workId = ''
    const task = this.taskManager.create({
      objective,
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      turnId,
      submissionKey,
      laneKey: `coordinator:${this.ownerId}`,
      laneLimit: 1,
      runner: async (_ignored, { onEvent, signal }) => {
        // The verbatim request was pinned at acceptance and is almost
        // certainly settled by now; awaiting it never blocks the receipt.
        const resolved = (await verbatimRequest) || {}
        return this.coordinator.run({
          originalRequest: resolved.originalRequest || objective,
          objective,
          conversationContext: this.getConversationContext(),
          userMemories: this.memoryService?.list(this.ownerId, { limit: 64 }) || [],
          timeZone: this.getClientContext()?.timeZone,
          workingDirectory: this.getClientContext()?.workingDirectory,
        }, {
          ownerId: this.ownerId,
          sessionId: this.sessionId,
          turnId,
          coordinationRunId: workId,
          signal,
          onEvent: event => this.forwardCoordinatorEvent(event, onEvent),
        })
      },
      canceler: async ({ previousStatus, abort }) => {
        if (previousStatus === 'delegated') {
          const result = await this.coordinator.cancelDelegatedWork(
            workId,
            { ownerId: this.ownerId },
          )
          abort()
          return result
        }
        abort()
        return {
          route: 'adapter',
          layer: previousStatus === 'finalizing' ? 'finalizing' : 'coordinator',
        }
      },
    })
    workId = task.id
    this.turnTasks.set(turnId, task.id)
    if (this.turnTasks.size > 100) {
      this.turnTasks.delete(this.turnTasks.keys().next().value)
    }
    return task
  }

  async handleScheduleReminder(callId, turnId, args) {
    const executeAt = Date.parse(args.execute_at)
    if (!executeAt || executeAt <= Date.now()) {
      await this.sendOutput(callId, {
        status: 'error',
        error: true,
        error_code: 'invalid_time',
        user_message: '触发时间无效或已过期，请提供一个未来的时间。',
      }, turnId)
      return
    }

    const type = args.type === 'task' ? 'task' : 'reminder'
    const recurrence = args.recurrence || 'once'

    // For type='task', build a coordinator runner that will execute the
    // objective when the scheduled task fires. The coordinator singleton
    // and ownerId are safe to capture — they outlive the voice session.
    const coordinator = this.coordinator
    const memoryService = this.memoryService
    const runner = type === 'task'
      ? async (objective, context) => coordinator.run({
          originalRequest: objective,
          objective,
          conversationContext: [],
          // Resolve at execution time so a future task sees the user's latest
          // model and long-term memory, not a snapshot from when it was set.
          userMemories: memoryService?.list(
            context.ownerId,
            { limit: 64 },
          ) || [],
        }, {
          ownerId: context.ownerId,
          sessionId: context.sessionId,
          turnId: context.turnId,
          coordinationRunId: context.taskId,
          signal: context.signal,
          onEvent: context.onEvent,
        })
      : null

    const task = this.taskManager.createScheduled({
      objective: args.reminder,
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      turnId,
      schedule: { at: executeAt, recurrence },
      type,
      runner,
    })

    await this.sendOutput(callId, {
      status: 'scheduled',
      reminder_id: task.id,
      execute_at: args.execute_at,
      type,
      recurrence,
    }, turnId, task.id, {
      response: {
        instructions: [
          '用一句自然的话确认已设好提醒，包含具体时间和内容。',
          '不要调用工具，不要重复确认。',
        ].join(' '),
      },
    })
  }

  async handle(event, callContext = {}) {
    const callId = event.call_id || event.item?.call_id || ''
    const toolName = event.name || event.item?.name || ''
    if (!callId) throw new Error('Realtime 工具调用缺少 call_id')
    if (this.processedCalls.has(callId)) return
    this.processedCalls.add(callId)
    if (this.processedCalls.size > 500) {
      this.processedCalls.delete(this.processedCalls.values().next().value)
    }

    const turnId = callContext.turnId
      || event.__voiceContext?.turnId
      || this.getTurnId()
    const generation = Number.isInteger(callContext.turnGeneration)
      ? callContext.turnGeneration
      : Number.isInteger(event.__voiceContext?.turnGeneration)
        ? event.__voiceContext.turnGeneration
        : this.getTurnGeneration()
    let args = {}
    try {
      args = JSON.parse(event.arguments || '{}')
    } catch {
      // Invalid arguments are handled as missing fields below.
    }

    if (this.isStale(turnId, generation)) {
      await this.closeStaleCall(callId, turnId)
      return
    }

    const operationMode = [
      ATOMIC_RECORD_WRITE_TOOL_NAME,
      ATOMIC_RECORD_CORRECT_TOOL_NAME,
    ].includes(toolName)
      ? 'event'
      : TASK_MUTATION_TOOLS.has(toolName)
        ? 'task'
        : null
    if (operationMode && !this.claimTurnOperation(turnId, operationMode)) {
      await this.sendOutput(callId, failure(
        'exclusive_task_event_choice',
        '这一轮已经选择了任务操作，不能同时写事件。任务产生的事实由后续慢模型处理。',
        { retryable: false },
      ), turnId)
      return
    }

    if (toolName === GET_CURRENT_TIME_TOOL_NAME) {
      await this.getCurrentTime(callId, turnId)
      return
    }
    if (toolName === MEMORY_TOOL_NAME) {
      const responseId = callContext.responseId || event.response_id || ''
      const deferred = this.beginDeferredToolResponse(responseId, {
        turnId,
        turnGeneration: generation,
      })
      try {
        await this.memory(callId, turnId, args, deferred
          ? { createResponse: false }
          : undefined)
      } catch (error) {
        await this.completeDeferredToolResponse(deferred, { failed: true })
        throw error
      }
      await this.completeDeferredToolResponse(deferred)
      return
    }
    if (toolName === NOTES_TOOL_NAME) {
      await this.notes(callId, turnId, args)
      return
    }
    if (toolName === SCHEDULE_REMINDER_TOOL_NAME) {
      await this.handleScheduleReminder(callId, turnId, args)
      return
    }
    if (toolName === CANCEL_AGENT_TASK_TOOL_NAME) {
      await this.cancelAgentTask(callId, turnId, args)
      return
    }
    if (toolName === GET_AGENT_TASK_STATUS_TOOL_NAME) {
      await this.getAgentTaskStatus(callId, turnId, args)
      return
    }
    if (toolName === RESPOND_AGENT_PERMISSION_TOOL_NAME) {
      await this.respondAgentPermission(callId, turnId, args)
      return
    }
    if (toolName === ENTER_SLEEP_TOOL_NAME) {
      await this.enterSleep(callId, turnId)
      return
    }
    if ([
      SPIRIT_TASK_LIST_TOOL_NAME,
      SPIRIT_TASK_DETAIL_TOOL_NAME,
      SPIRIT_TASK_COMMENTS_TOOL_NAME,
    ].includes(toolName)) {
      await this.handleSpiritTask(callId, turnId, toolName, args)
      return
    }
    if (toolName === SPIRIT_TASK_CREATE_TOOL_NAME) {
      await this.createSpiritTask(callId, turnId, args)
      return
    }
    if (toolName === SPIRIT_TASK_UPDATE_TOOL_NAME) {
      await this.updateSpiritTask(callId, turnId, args)
      return
    }
    if (toolName === SPIRIT_TASK_START_TOOL_NAME) {
      await this.startSpiritTask(callId, turnId, args)
      return
    }
    if (toolName === SPIRIT_TASK_COMPLETE_TOOL_NAME) {
      await this.completeSpiritTask(callId, turnId, args)
      return
    }
    if (toolName === SPIRIT_TASK_UPDATE_STATUS_TOOL_NAME) {
      await this.updateSpiritTaskStatus(callId, turnId, args)
      return
    }
    if (toolName === SPIRIT_TASK_ADD_COMMENT_TOOL_NAME) {
      await this.addSpiritTaskComment(callId, turnId, args)
      return
    }
    if (toolName === SPIRIT_TASK_DELETE_TOOL_NAME) {
      await this.deleteSpiritTask(callId, turnId, args)
      return
    }
    if (toolName === SPIRIT_VOICE_NOTIFY_TOOL_NAME) {
      await this.notifySpiritUser(callId, turnId, args)
      return
    }
    if (toolName === ATOMIC_RECORD_WRITE_TOOL_NAME) {
      await this.writeAtomicRecord(callId, turnId, args)
      return
    }
    if (toolName === ATOMIC_RECORD_QUERY_TOOL_NAME) {
      await this.queryAtomicRecords(callId, turnId, args)
      return
    }
    if (toolName === ATOMIC_RECORD_CORRECT_TOOL_NAME) {
      await this.correctAtomicRecord(callId, turnId, args)
      return
    }
    if (toolName !== DELEGATE_TOOL_NAME) {
      await this.sendOutput(
        callId,
        failure('unsupported_tool', '当前无法执行这个操作。'),
        turnId,
      )
      return
    }

    const pendingPermissionTask = this.taskManager.list({
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      active: true,
    }).find(task => task.authorization?.status === 'pending')
    if (pendingPermissionTask) {
      await this.sendOutput(
        callId,
        {
          status: 'authorization_pending',
          error: true,
          error_code: 'permission_decision_required',
          authorization_id: pendingPermissionTask.authorization.id,
          operation: pendingPermissionTask.authorization.summary,
          user_message: '当前有一项权限请求正在等待用户决定，不能把本轮回答提交成新工作。',
          retryable: true,
        },
        turnId,
        pendingPermissionTask.id,
        {
          response: {
            instructions: [
              '当前有一项权限请求正在等待决定，本轮不能调用 spawn_thinking。',
              '重新结合刚才提出的具体权限问题和本轮用户原话判断。',
              '若用户已自然表达同意或拒绝，立即调用 respond_agent_permission；按语义判断，不要要求固定口令。',
              '若用户没有作出决定，只用一句自然的话继续确认。',
              '绝对不要代替用户同意，也不要声称权限已经生效。',
            ].join(' '),
          },
        },
      )
      return
    }

    // Receipt-based acceptance: this receipt only acknowledges intake, so it
    // must not wait on ASR timing or a live backend round trip. Availability
    // comes from the cached snapshot; a backend that looks healthy here but
    // fails at dispatch surfaces through the failed-task announcement path.
    const availability = this.backendAvailability?.snapshot()
      || { configured: true, ok: true, known: false }
    if (availability.configured === false) {
      await this.sendOutput(
        callId,
        failure(
          'backend_unavailable',
          '当前未配置后台 Agent，无法执行需要后台处理的任务。你仍然可以继续普通聊天。',
          { retryable: false },
        ),
        turnId,
        null,
        {
          response: {
            instructions: [
              '直接向用户说明当前未配置后台 Agent，无法执行这项后台任务。',
              '不要再次调用后台工具，也不要声称任务已经创建或正在执行。',
              '可以继续完成不需要后台 Agent 的聊天和回答。',
            ].join('\n'),
          },
        },
      )
      return
    }
    if (availability.known && availability.ok === false) {
      await this.sendOutput(
        callId,
        failure(
          'backend_unavailable',
          '后台 Agent 当前未连接。你仍然可以继续普通聊天，后台恢复后再执行这项工作。',
          { retryable: true },
        ),
        turnId,
        null,
        {
          response: {
            instructions: [
              '直接向用户说明后台 Agent 当前未连接，暂时无法执行这项后台任务。',
              '不要再次调用后台工具，也不要声称任务已经创建或正在执行。',
              '可以继续完成不需要后台 Agent 的聊天和回答。',
            ].join('\n'),
          },
        },
      )
      return
    }

    let objective = String(args.objective || '').replace(/\s+/g, ' ').trim()
    if (!objective) {
      // Rare model slip: only this fallback path waits for the transcript.
      const resolved = await this.transcripts.resolveDelegation(turnId, '')
      if (this.isStale(turnId, generation)) {
        await this.closeStaleCall(callId, turnId)
        return
      }
      objective = String(resolved.originalRequest || '').trim()
    }
    if (!objective) {
      await this.sendOutput(
        callId,
        failure(
          'missing_objective',
          '没有获得完整、可执行的目标，需要用户补充必要信息。',
          { retryable: true },
        ),
        turnId,
      )
      return
    }

    const existingId = this.turnTasks.get(turnId)
    if (existingId) {
      await this.sendOutput(
        callId,
        {
          status: 'duplicate',
          work_id: existingId,
          message: '这一轮已经提交，不要重复执行。',
        },
        turnId,
        existingId,
        {
          response: {
            instructions: [
              '这个任务已经在本轮成功提交，不要再次调用工具。',
              '结合本轮调用工具前已经对用户说过的内容，自主判断是否需要回应。',
              '如果此前已经说明正在处理，不要重复、改写或补充确认，直接结束本次响应。',
              '只有此前没有作出任何确认时，才用包含具体任务对象的短句说明已经开始处理。',
              '不要把 accepted 或 duplicate 说成任务已经完成。',
            ].join(' '),
          },
        },
      )
      return
    }

    let task
    try {
      const submissionKey = [
        'delegation',
        this.sessionId,
        turnId || callId,
      ].join(':')
      // Pin the verbatim user request without blocking the receipt: the
      // transcript waiter registers now, so the ASR result is captured even
      // if the per-connection ring buffer evicts that turn before the FIFO
      // lane dispatches this work. resolveDelegation never rejects and a
      // closed session resolves to the model-provided objective.
      const verbatimRequest = this.transcripts.resolveDelegation(
        turnId,
        objective,
      )
      task = this.createWork({
        turnId,
        objective,
        verbatimRequest,
        submissionKey,
      })
    } catch {
      await this.sendOutput(
        callId,
        failure(
          'work_submission_failed',
          '暂时没有成功提交这次请求，请稍后重试。',
          { retryable: true },
        ),
        turnId,
      )
      return
    }
    await this.sendOutput(
      callId,
      task.reused
        ? {
            status: 'duplicate',
            work_id: task.id,
            message: '这一轮已经提交，不要重复执行。',
          }
        : {
            status: 'accepted',
            marker: '[thinking]',
            work_id: task.id,
          },
      turnId,
      task.id,
      {
        // Always let Realtime close the tool-call turn itself. Whether it
        // should say anything is a semantic decision based on what it already
        // said before invoking the tool.
        response: {
          instructions: [
            '结合本轮调用工具前已经对用户说过的内容，自主判断是否需要回应。',
            '如果此前已经说明正在处理，不要重复、改写或补充确认，直接结束本次响应。',
            '只有此前没有作出任何确认时，才用包含具体任务对象的短句说明已经开始处理；避免“好的、收到”等通用承接语。',
            'accepted 或 duplicate 只代表任务已经提交，不代表已经完成。',
          ].join(' '),
        },
      },
    )
  }

  async resolveSpiritTaskId(args = {}) {
    const directId = String(args.taskId || '').trim()
    if (directId) return directId

    const reference = String(args.reference || '').trim()
    const facts = Array.isArray(this.getTaskContext?.())
      ? this.getTaskContext().filter(fact => String(fact?.taskId || '').trim())
      : []
    const normalizedReference = normalizeTaskReference(reference)
    const genericReference = !normalizedReference
    if (genericReference && facts.length) {
      return String(facts[0].taskId).trim()
    }

    const factMatches = normalizedReference
      ? facts.filter(fact => {
          const haystack = compactTaskText([
            fact.summary,
            fact.assignee,
            fact.note,
            fact.taskId,
          ].join(' '))
          return haystack.includes(normalizedReference) || normalizedReference.includes(haystack)
        })
      : []
    if (factMatches.length === 1) return String(factMatches[0].taskId).trim()
    if (factMatches.length > 1) {
      throw new TaskReferenceError(
        'task_reference_ambiguous',
        `找到多个相近任务：${factMatches.slice(0, 3).map(fact => fact.summary || fact.taskId).join('、')}，请说清房号或标题。`,
      )
    }

    if (!this.spiritTaskClient?.list) {
      throw new TaskReferenceError('task_reference_missing', '没有找到可定位的任务，请说房号或任务标题。')
    }
    const keyword = reference.match(/\d{3,5}/u)?.[0] || reference
    const result = await this.spiritTaskClient.list({
      keyword: keyword || undefined,
      requestNum: 20,
      taskView: 'ALL',
    })
    const records = taskRecords(result)
    const normalizedCandidates = normalizedReference
      ? records.filter(record => {
          const haystack = compactTaskText([
            record?.summary,
            record?.title,
            record?.description,
            ...(Array.isArray(record?.users)
              ? record.users.flatMap(user => [user?.userName, user?.name])
              : []),
            taskIdFromRecord(record),
          ].join(' '))
          return haystack.includes(normalizedReference) || normalizedReference.includes(haystack)
        })
      : records
    if (normalizedCandidates.length === 1) return taskIdFromRecord(normalizedCandidates[0])
    if (normalizedCandidates.length > 1) {
      throw new TaskReferenceError(
        'task_reference_ambiguous',
        `找到多个相近任务：${normalizedCandidates.slice(0, 3).map(taskCandidateLabel).join('；')}，请说清房号或标题。`,
      )
    }
    throw new TaskReferenceError(
      'task_reference_not_found',
      reference
        ? `没有找到“${reference}”对应的任务，请说房号或任务标题。`
        : '没有找到可定位的任务，请说房号或任务标题。',
    )
  }

  async existingSpiritAssignee(taskId) {
    if (!this.spiritTaskClient?.detail) return null
    const detail = await this.spiritTaskClient.detail(taskId)
    const users = detail?.users || detail?.executors || detail?.task?.users
    if (!Array.isArray(users)) return null
    const executor = users.find(user => (
      String(user?.userRole || user?.roleCode || '').toUpperCase() === 'EXECUTOR'
    ))
    if (!executor?.userId) return null
    return {
      userId: String(executor.userId).trim(),
      name: String(executor.userName || executor.name || '').trim(),
    }
  }

  async taskStateNotification(assignee, text) {
    if (!assignee?.userId) return { status: 'not_available' }
    if (!this.spiritVoiceNotifier?.configured) return { status: 'not_configured' }
    try {
      const notificationPromise = this.spiritVoiceNotifier.notify({
        recipientId: assignee.userId,
        recipientName: assignee.name,
        title: '工作通知',
        text,
      }).catch(error => ({
        status: 'failed',
        error: String(error?.message || error),
      }))
      return await settleWithTimeout(
        notificationPromise,
        this.taskNotificationWaitMs,
      )
    } catch (error) {
      return {
        status: 'failed',
        error: String(error?.message || error),
      }
    }
  }

  async handleSpiritTask(callId, turnId, toolName, args) {
    if (!this.spiritTaskClient) {
      await this.sendOutput(callId, {
        status: 'error', error: true, error_code: 'task_tool_unavailable',
        user_message: '当前没有连接到 Spirit 任务 API。', retryable: true,
      }, turnId)
      return
    }
    try {
      const taskId = toolName === SPIRIT_TASK_LIST_TOOL_NAME
        ? ''
        : await this.resolveSpiritTaskId(args)
      const enterpriseContext = toolName === SPIRIT_TASK_LIST_TOOL_NAME
        ? await this.getEnterpriseContext()
        : null
      const subjectUserId = String(enterpriseContext?.subject?.userId || '').trim()
      const result = toolName === SPIRIT_TASK_LIST_TOOL_NAME
        ? await this.spiritTaskClient.list({
            ...args,
            userId: args.scope === 'MY' ? subjectUserId : undefined,
            requestNum: Math.min(20, Number(args.requestNum) || 20),
          })
        : toolName === SPIRIT_TASK_DETAIL_TOOL_NAME
          ? await this.spiritTaskClient.detail(taskId)
          : await this.spiritTaskClient.comments(taskId)
      const projectedResult = projectTaskQueryResult(toolName, result)
      await this.sendOutput(callId, {
        status: 'ok', source: 'spirit-api-direct', result: projectedResult,
      }, turnId, toolName === SPIRIT_TASK_LIST_TOOL_NAME ? null : taskId, {
        response: {
          instructions: [
            '第一句话直接说任务信息，不要任何开场、概述或查询确认。',
            '禁止说“我查到了”“目前系统中”“给您说几个”“任务列表如下”。',
            '列表逐条只说标题、状态、执行人等用户需要的字段；能一句说清就只说一句。',
            '优先使用结果中的 statusLabel 和 executor.userName；状态使用自然中文，不要朗读英文枚举值。',
            '不要提后台 Agent、函数名、接口名、缓存或内部字段。',
            '结果为空时只说“没有查到任务”。',
          ].join(' '),
        },
      })
    } catch (error) {
      await this.sendOutput(callId, {
        status: 'error', error: true,
        error_code: error?.code || 'task_query_failed',
        user_message: String(error?.message || error), retryable: true,
      }, turnId, null, {
        response: {
          instructions: '简短说明任务服务当前不可用或登录态失效，不要声称已经查到结果。',
        },
      })
    }
  }

  async createSpiritTask(callId, turnId, args) {
    if (!this.spiritTaskClient) {
      await this.sendOutput(callId, failure(
        'task_tool_unavailable',
        '当前没有连接到 Spirit 任务 API。',
        { retryable: true },
      ), turnId)
      return
    }
    try {
      const request = String(args.request || '').trim()
      if (!request) throw new Error('创建任务需要保留用户原话')
      const selfTest = args.selfTest === true
      if (
        selfTest
        && !(
          /(?:自测|测试)/u.test(request)
          && /(?:不|别|无需|不要)(?:发送|发)?(?:任何人)?(?:语音)?通知/u.test(request)
        )
      ) {
        throw new Error('selfTest 只允许用于用户明确提出且要求不通知任何人的自测任务')
      }
      const enterpriseContext = await this.getEnterpriseContext()
      const creator = {
        userId: String(enterpriseContext?.subject?.userId || '').trim(),
        userName: String(enterpriseContext?.subject?.displayName || '').trim(),
      }
      if (!creator.userId || !creator.userName) {
        throw new Error('当前会话没有可用的登录身份，不能创建任务')
      }
      const selfRequested = /(?:我自己|我本人|给我|由我执行)/u.test(
        `${String(args.assigneeName || '')} ${request}`,
      )
      const assignee = selfTest
        ? {
            name: SPIRIT_DEMO_SELF_TEST_ACCOUNT.userName,
            userId: SPIRIT_DEMO_SELF_TEST_ACCOUNT.userId,
            department: '系统自测',
            floors: [],
            matchedBy: 'self-test',
            matchedFloor: null,
          }
        : selfRequested
          ? {
              name: creator.userName,
              userId: creator.userId,
              department: '当前登录用户',
              floors: [],
              matchedBy: 'current-login-identity',
              matchedFloor: null,
            }
          : resolveSpiritAssignee({
            assigneeName: args.assigneeName,
            roomNumber: args.roomNumber,
            floor: args.floor,
            request,
          })
      const summary = normalizeSpiritTaskSummary(args.summary || request)
      const description = String(args.description || request).trim()
      const plan = resolveSpiritPlanTimes({
        request,
        executeTime: args.executeTime,
        completeTime: args.completeTime,
      })
      const payload = {
        summary,
        description,
        taskOpeningPrompt: request,
        originalRequest: {
          sourceConversationId: '',
          sourceChatId: '',
          requestPayload: {
            text: request,
            files: [],
          },
        },
        status: plan.status,
        ...(plan.executeTime ? { executeTime: plan.executeTime } : {}),
        ...(plan.completeTime ? { completeTime: plan.completeTime } : {}),
        ...SPIRIT_DEMO_CHANNEL,
        users: buildSpiritTaskUsers(assignee, { creator }),
        recommendedActions: [],
      }
      const created = await this.spiritTaskClient.create(payload)
      const taskId = String(created?.taskId || created?.id || '').trim()
      if (!taskId) throw new Error('任务接口返回成功，但没有 taskId')

      let notification = { status: 'disabled' }
      if (!selfTest) {
        if (!this.spiritVoiceNotifier?.configured) {
          notification = { status: 'not_configured' }
        } else {
          const notificationPromise = this.spiritVoiceNotifier.notify({
            recipientId: assignee.userId,
            recipientName: assignee.name,
            title: '工作通知',
            text: `您有一个新任务【${summary}】，请立即执行。`,
          }).catch(error => ({
            status: 'failed',
            error: String(error?.message || error),
          }))
          notification = await settleWithTimeout(
            notificationPromise,
            this.taskNotificationWaitMs,
          )
        }
      }

      const output = {
        status: 'ok',
        source: 'spirit-api-direct',
        action: 'created',
        taskId,
        summary,
        assignee: {
          name: assignee.name,
          userId: assignee.userId,
          matchedBy: assignee.matchedBy,
          floor: assignee.matchedFloor,
        },
        notification,
        result: created,
      }
      const confirmation = taskDispatchConfirmation({
        summary,
        assigneeName: assignee.name,
        notificationStatus: notification.status,
        selfTest,
      })
      this.onConversationMessage({
        role: 'assistant',
        content: confirmation,
        source: 'tool-result',
        turnId,
      })
      await this.sendConfirmedOutput(callId, output, turnId, taskId, confirmation)
    } catch (error) {
      await this.sendOutput(callId, failure(
        'task_create_failed',
        String(error?.message || error),
        { retryable: true },
      ), turnId, null, {
        response: {
          instructions: '简短说明任务没有创建成功以及真实原因；不得声称已派发或已通知。',
        },
      })
    }
  }

  async updateSpiritTask(callId, turnId, args) {
    if (!this.spiritTaskClient) {
      await this.sendOutput(callId, failure(
        'task_tool_unavailable',
        '当前没有连接到 Spirit 任务 API。',
        { retryable: true },
      ), turnId)
      return
    }
    try {
      const taskId = await this.resolveSpiritTaskId(args)
      const payload = { taskId }
      if (args.status) payload.status = String(args.status)
      if (args.description !== undefined) {
        payload.description = String(args.description || '').trim()
      }
      let assignee = null
      if (args.assigneeName || args.roomNumber || args.floor) {
        assignee = resolveSpiritAssignee({
          assigneeName: args.assigneeName,
          roomNumber: args.roomNumber,
          floor: args.floor,
        })
        payload.executors = [buildSpiritTaskExecutor(assignee)]
      }
      if (!assignee && payload.status) {
        try {
          assignee = await this.existingSpiritAssignee(taskId)
        } catch {
          assignee = null
        }
      }
      const hasPlanTime = ['executeTime', 'completeTime'].some(field => args[field] !== undefined)
      let planTime
      if (hasPlanTime) {
        const current = this.spiritTaskClient.detail
          ? await this.spiritTaskClient.detail(taskId)
          : {}
        planTime = {
          acceptTime: current?.acceptTime ?? null,
          executeTime: args.executeTime ?? current?.executeTime ?? null,
          completeTime: args.completeTime ?? current?.completeTime ?? null,
        }
      }
      if (Object.keys(payload).length === 1 && !hasPlanTime) {
        throw new Error('请至少提供状态、描述、执行人或要求时间')
      }
      const result = Object.keys(payload).length > 1
        ? await this.spiritTaskClient.update(payload)
        : null
      const planResult = hasPlanTime
        ? await this.spiritTaskClient.updatePlanTime(taskId, planTime)
        : null
      const notification = assignee
        ? await this.taskStateNotification(
            assignee,
            payload.executors
              ? '有一项任务已重新分配给您，请立即查看并执行。'
              : '任务状态已更新，请继续处理。',
          )
        : { status: 'not_required' }
      await this.sendOutput(callId, {
        status: 'ok',
        source: 'spirit-api-direct',
        action: 'updated',
        taskId,
        changes: {
          status: payload.status,
          description: payload.description,
          assignee: assignee?.name,
          executeTime: planTime?.executeTime,
          completeTime: planTime?.completeTime,
        },
        notification,
        result,
        planResult,
      }, turnId, taskId, {
        response: {
          instructions: [
            '自然说明实际修改了什么；不要朗读 taskId、userId、接口名或空字段。',
            '只有 notification.status=sent 才能说已经通知；failed、not_configured、not_available 或 skipped_by_gate 必须明确说明任务已改但通知未成功。',
            'notification.status=not_required 表示本次没有需要通知的状态变化，不要谈通知。',
          ].join(' '),
        },
      })
    } catch (error) {
      await this.sendOutput(callId, failure(
        'task_update_failed',
        String(error?.message || error),
        { retryable: true },
      ), turnId)
    }
  }

  async startSpiritTask(callId, turnId, args) {
    if (!this.spiritTaskClient) {
      await this.sendOutput(callId, failure(
        'task_tool_unavailable',
        '当前没有连接到 Spirit 任务 API。',
        { retryable: true },
      ), turnId)
      return
    }
    try {
      const taskId = await this.resolveSpiritTaskId(args)
      let assignee = null
      try { assignee = await this.existingSpiritAssignee(taskId) } catch { assignee = null }
      const result = await this.spiritTaskClient.start(taskId)
      await this.sendOutput(callId, {
        status: 'ok',
        source: 'spirit-api-direct',
        action: 'started',
        taskId,
        notification: await this.taskStateNotification(assignee, '任务已开始执行，请继续处理。'),
        result,
      }, turnId, taskId, {
        response: {
          instructions: '只说任务已经开始或已接手；只有通知结果为 sent 才能说已经通知执行人；不要开场，不要朗读 taskId、接口名或内部字段。',
        },
      })
    } catch (error) {
      await this.sendOutput(callId, failure(
        'task_start_failed',
        String(error?.message || error),
        { retryable: true },
      ), turnId)
    }
  }

  async completeSpiritTask(callId, turnId, args) {
    if (!this.spiritTaskClient) {
      await this.sendOutput(callId, failure(
        'task_tool_unavailable',
        '当前没有连接到 Spirit 任务 API。',
        { retryable: true },
      ), turnId)
      return
    }
    try {
      const taskId = await this.resolveSpiritTaskId(args)
      const completionRemark = args.completionRemark === undefined
        ? undefined
        : String(args.completionRemark || '').trim() || undefined
      if (completionRemark && completionRemark.length > 4_000) {
        throw new Error('完成备注不能超过 4000 个字符')
      }
      let assignee = null
      try { assignee = await this.existingSpiritAssignee(taskId) } catch { assignee = null }
      const result = await this.spiritTaskClient.complete(taskId, completionRemark)
      await this.sendOutput(callId, {
        status: 'ok',
        source: 'spirit-api-direct',
        action: 'completed',
        taskId,
        completionRemark,
        notification: await this.taskStateNotification(assignee, '任务已完成，请查看结果。'),
        result,
      }, turnId, taskId, {
        response: {
          instructions: '直接说任务已完成；有完成说明时用一句自然短句带上。只有通知结果为 sent 才能说已经通知执行人。不要朗读 taskId、接口名或内部字段。',
        },
      })
    } catch (error) {
      await this.sendOutput(callId, failure(
        'task_complete_failed',
        String(error?.message || error),
        { retryable: true },
      ), turnId)
    }
  }

  async updateSpiritTaskStatus(callId, turnId, args) {
    if (!this.spiritTaskClient) {
      await this.sendOutput(callId, failure(
        'task_tool_unavailable',
        '当前没有连接到 Spirit 任务 API。',
        { retryable: true },
      ), turnId)
      return
    }
    try {
      const taskId = await this.resolveSpiritTaskId(args)
      const targetStatus = String(args.targetStatus || '').trim()
      if (!SPIRIT_TASK_STATUSES.includes(targetStatus)) {
        throw new Error('目标状态不是 Spirit 支持的原始状态')
      }
      let assignee = null
      try { assignee = await this.existingSpiritAssignee(taskId) } catch { assignee = null }
      const result = await this.spiritTaskClient.updateStatus(taskId, targetStatus)
      await this.sendOutput(callId, {
        status: 'ok',
        source: 'spirit-api-direct',
        action: 'status_updated',
        taskId,
        targetStatus,
        notification: await this.taskStateNotification(assignee, `任务状态已更新为 ${targetStatus}，请继续处理。`),
        result,
      }, turnId, taskId, {
        response: {
          instructions: '只用自然中文说明任务的新状态；只有通知结果为 sent 才能说已经通知执行人。不要朗读英文状态、taskId、接口名或内部字段。',
        },
      })
    } catch (error) {
      await this.sendOutput(callId, failure(
        'task_status_update_failed',
        String(error?.message || error),
        { retryable: true },
      ), turnId)
    }
  }

  async addSpiritTaskComment(callId, turnId, args) {
    if (!this.spiritTaskClient) {
      await this.sendOutput(callId, failure(
        'task_tool_unavailable',
        '当前没有连接到 Spirit 任务 API。',
        { retryable: true },
      ), turnId)
      return
    }
    try {
      const taskId = await this.resolveSpiritTaskId(args)
      const content = String(args.content || '').trim()
      const recordSource = String(args.recordSource || 'SYSTEM_AUTO').trim()
      if (!content) throw new Error('任务记录内容不能为空')
      if (content.length > 4_000) throw new Error('任务记录不能超过 4000 个字符')
      if (!SPIRIT_TASK_RECORD_SOURCES.includes(recordSource)) {
        throw new Error('任务记录来源不受支持')
      }
      // The direct service token owns attribution until the product login
      // adapter can provide the authenticated user's real identity.
      const result = await this.spiritTaskClient.addComment(
        taskId,
        content,
        recordSource,
      )
      await this.sendOutput(callId, {
        status: 'ok',
        source: 'spirit-api-direct',
        action: 'comment_added',
        taskId,
        recordSource,
        content,
        result,
      }, turnId, taskId, {
        response: {
          instructions: '直接说记录已补充，并用最短自然句概括内容；不要说“评论”、资料来源、taskId、接口名或内部字段。',
        },
      })
    } catch (error) {
      await this.sendOutput(callId, failure(
        'task_comment_failed',
        String(error?.message || error),
        { retryable: true },
      ), turnId)
    }
  }

  async deleteSpiritTask(callId, turnId, args) {
    if (!this.spiritTaskClient) {
      await this.sendOutput(callId, failure(
        'task_tool_unavailable',
        '当前没有连接到 Spirit 任务 API。',
        { retryable: true },
      ), turnId)
      return
    }
    try {
      const taskId = await this.resolveSpiritTaskId(args)
      const transcript = String(
        await this.transcripts?.transcript(turnId) || '',
      ).trim()
      if (args.confirmed !== true || !/(?:删除|删掉|移除|作废)/u.test(transcript)) {
        throw new Error('用户本轮没有明确确认删除，已拒绝执行')
      }
      const result = await this.spiritTaskClient.delete(taskId)
      await this.sendOutput(callId, {
        status: 'ok',
        source: 'spirit-api-direct',
        action: 'deleted',
        taskId,
        result,
      }, turnId, taskId, {
        response: {
          instructions: '只说明指定任务已删除，不要朗读 taskId、接口名或内部字段。',
        },
      })
    } catch (error) {
      await this.sendOutput(callId, failure(
        'task_delete_failed',
        String(error?.message || error),
        { retryable: false },
      ), turnId)
    }
  }

  async writeAtomicRecord(callId, turnId, args) {
    if (!this.atomicRecordStore && !this.atomicSpaceProvider) {
      await this.sendOutput(callId, failure(
        'atomic_record_unavailable',
        '这条记录暂时没有保存。',
        { retryable: true },
      ), turnId, null, {
        response: {
          instructions: '只对用户说：“这条暂时没有记成，我保留着刚才的内容。”不要说存储、接口、工具或配置。',
        },
      })
      return
    }
    const factState = String(args.factState || '').trim()
    if (!ATOMIC_FACT_STATES.has(factState)) {
      this.releaseTurnOperation(turnId, 'event')
      await this.sendOutput(callId, failure(
        'atomic_record_fact_state_required',
        '需要先判断这句话是在报告已经成立的事实，还是要求后续执行。',
        { retryable: true },
      ), turnId, null, {
        response: {
          instructions: [
            '不要向用户提内部字段。重新结合用户原话判断时间性质。',
            '已经发生、观察到或核实的事实，重试记录；已经确认成立但未来生效的预留或安排，也可记录。',
            '仍待执行的“请送、记得留、去检查、安排处理”必须改用任务工具，不能写成已经完成的事件。',
            '只有用户原话本身确实无法判断时，才用一句自然话确认“这是已经办好了，还是需要安排去做？”。',
          ].join(' '),
        },
      })
      return
    }
    const businessInput = atomicBusinessInput(args)
    try {
      const enterpriseContext = await this.getEnterpriseContext()
      const subject = enterpriseContext?.subject || {}
      const transcript = String(await this.transcripts?.transcript(turnId) || '').trim()
      const directArgs = {
        ...businessInput,
        // This handler is the live user voice path. A model cannot forge a
        // PMS or task-transition source; slow-model writers use the store
        // contract directly with their trusted source metadata.
        sourceTrigger: 'user_turn',
        rawText: transcript || undefined,
        // Replayed calls in the same voice turn update the same record. This
        // also makes the minimum-record fallback safe after a failed optional
        // entity or fact validation.
        idempotencyKey: `voice:${this.ownerId}:${String(turnId || callId).slice(0, 160)}`,
      }
      const context = {
        ownerId: this.ownerId,
        actorId: subject.userId || this.ownerId,
        actorName: subject.displayName || '',
      }
      const write = input => (this.atomicSpaceProvider
        ? this.atomicSpaceProvider.writeInstance({
            modelType: 'event',
            input,
            context,
          })
        : this.atomicRecordStore.write(input, context))
      let result
      try {
        result = await write(directArgs)
        } catch (initialError) {
          if (initialError?.code === 'ATOMIC_EVENT_REQUIREMENTS_MISSING') {
            throw initialError
          }
          const bestEffort = atomicBestEffortInput(businessInput)
          if (!bestEffort) throw initialError
          // A malformed optional entity must not erase correctly extracted
          // room, item or timing data. Retry once after stripping only fields
          // that cannot satisfy the compact event contract.
          result = await write({
            ...bestEffort,
            sourceTrigger: directArgs.sourceTrigger,
            rawText: directArgs.rawText,
            idempotencyKey: directArgs.idempotencyKey,
          })
      }
      this.atomicWriteFailures.delete(String(turnId || ''))
      this.onRecordClarification(null)
      const confirmation = buildRecordVoiceConfirmation(result.record)
      // Persist the successful action in the Gateway short-term context too.
      // The realtime provider may be reconnecting when the spoken response is
      // generated; the next turn must still know what was actually saved.
      this.onRecordFact({ record: result.record, operation: result.action || 'created' })
      this.onConversationMessage({
        role: 'assistant',
        content: confirmation,
        source: 'tool-result',
        turnId,
      })
      await this.sendConfirmedOutput(callId, {
        status: 'ok',
        source: 'atomic-record-direct',
        ...result,
      }, turnId, result.record?.recordId, confirmation)
    } catch (error) {
      if (error?.code === 'ATOMIC_EVENT_REQUIREMENTS_MISSING') {
        const guidance = String(
          error.clarificationGuidance
          || '还需要补充一项能够让这条事实准确、可追踪的业务信息',
        ).trim()
        this.onRecordClarification({
          input: businessInput,
          missingFacts: error.missingFacts,
          anyEntityTypes: error.anyEntityTypes,
          anyEntityRoles: error.anyEntityRoles,
          guidance,
          entityHints: error.entityHints,
        })
        await this.sendOutput(callId, failure(
          'atomic_record_needs_clarification',
          '这条事实还需要补充一项关键信息，暂未写入。',
          {
            retryable: true,
            action: error.action,
            missingFacts: error.missingFacts,
            anyEntityTypes: error.anyEntityTypes,
            anyEntityRoles: error.anyEntityRoles,
            clarificationGuidance: guidance,
            entityHints: error.entityHints,
          },
        ), turnId, null, {
          response: {
            instructions: [
              '这条记录尚未写入。结合本轮原话和前面连续对话，先判断用户已经提供了哪些信息；已经说过的内容不得再次询问。',
              `当前仍需补充的业务信息是：${guidance}。`,
              Array.isArray(error.entityHints) && error.entityHints.length
                ? `可参考但不必全部列举的定位线索有：${error.entityHints.join('、')}。`
                : '',
              '由你根据上下文自己组织一句自然追问，只问当前最容易回答的一个关键点。先承接用户刚补充的线索，不得照抄固定模板，不得重复上一轮原句。',
              '例如用户已经说“携程订单”，就承认这是携程渠道，再询问订单号、入住人姓名或入住日期中的一项；不要重新从房号开始盘问。',
              '不要说字段、类型、代码、ID、接口、校验或系统规则。',
            ].filter(Boolean).join(' '),
          },
        })
        return
      }
      const failureKey = String(turnId || '')
      const failures = (this.atomicWriteFailures.get(failureKey) || 0) + 1
      this.atomicWriteFailures.set(failureKey, failures)
      if (this.atomicWriteFailures.size > 200) {
        this.atomicWriteFailures.delete(this.atomicWriteFailures.keys().next().value)
      }
      await this.sendOutput(callId, failure(
        'atomic_record_write_failed',
        failures === 1
          ? '请在内部修正记录内容后重试。'
          : '这条记录暂时没有保存。',
        {
          retryable: failures === 1,
          internal_reason: String(error?.message || error),
        },
      ), turnId, null, {
            response: {
              instructions: failures === 1
                ? '不要对用户说话，不要解释错误。用已有的用户原话修正 atomic_record_write 参数并立即重试一次：只要 category 和完整 content 存在就可以落库；facts 和 entities 能确定多少填多少。不得朗读 internal_reason，不得向用户说字段、类型、代码、ID、接口或校验规则。'
                : '不再重试。只对用户说：“这条暂时没有记成，我保留着刚才的内容。”不得朗读 internal_reason，不得说字段、类型、代码、ID、接口或校验规则。',
        },
      })
    }
  }

  recentRecordFact(reference = '') {
    const context = this.getRecordContext?.()
    const records = Array.isArray(context) ? context : []
    if (!records.length) return null
    const query = speechFragment(reference)
    if (!query || /刚才|刚刚|上一条|那条|这条|最后|最近/u.test(query)) {
      return records[0]
    }
    const compact = value => String(value || '')
      .toLocaleLowerCase()
      .replace(/[\p{P}\p{S}\s]+/gu, '')
    const queryKey = compact(query)
    const exact = records.find(record => {
      const summary = compact(record.summary)
      return queryKey.length >= 3 && (summary.includes(queryKey) || queryKey.includes(summary))
    })
    if (exact) return exact
    const queryChars = new Set([...queryKey])
    return records.find(record => {
      if (queryChars.size < 3) return false
      const summaryChars = new Set([...compact(record.summary)])
      let shared = 0
      for (const char of queryChars) {
        if (summaryChars.has(char)) shared += 1
      }
      return shared / queryChars.size >= 0.6
    }) || null
  }

  async resolveAtomicRecordId(args = {}) {
    const explicit = String(args.recordId || '').trim()
    if (explicit) return explicit
    const reference = String(args.reference || '').trim()
    const recentFact = this.recentRecordFact(reference)
    if (recentFact?.recordId) return recentFact.recordId
    if (!reference) throw new Error('没有找到刚才要更正的记录')
    const room = reference.match(/(?:房间|房)\s*(\d{3,4})/u)?.[1]
      || reference.match(/\b(\d{3,4})\b/u)?.[1]
    const filters = {
      ...(room ? { objectType: 'room', objectId: room } : {}),
      limit: 20,
    }
    let result = this.atomicSpaceProvider
      ? await this.atomicSpaceProvider.queryInstances({
          modelType: 'event',
          filters,
          context: { ownerId: this.ownerId },
        })
      : await this.atomicRecordStore.query(filters, { ownerId: this.ownerId })
    let records = Array.isArray(result?.records) ? result.records : []
    if (!records.length) {
      const fallback = this.atomicSpaceProvider
        ? await this.atomicSpaceProvider.queryInstances({
            modelType: 'event',
            filters: { keyword: reference, limit: 20 },
            context: { ownerId: this.ownerId },
          })
        : await this.atomicRecordStore.query({ keyword: reference, limit: 20 }, { ownerId: this.ownerId })
      records = Array.isArray(fallback?.records) ? fallback.records : []
    }
    if (!records.length) throw new Error('没有找到要更正的记录')
    const recent = /刚才|刚刚|最后|最近/u.test(reference)
    if (records.length > 1 && !recent) {
      const labels = records.slice(0, 3).map(record => record.summary).filter(Boolean)
      throw new Error(`找到多条可能的记录：${labels.join('；')}，请说清房间或事项`)
    }
    return records[0].recordId
  }

  async correctAtomicRecord(callId, turnId, args) {
    if (!this.atomicRecordStore && !this.atomicSpaceProvider) {
      await this.sendOutput(callId, failure(
        'atomic_record_unavailable',
        '当前没有连接到原子记录存储。',
        { retryable: true },
      ), turnId)
      return
    }
    try {
      const transcript = String(await this.transcripts?.transcript(turnId) || '').trim()
      const action = String(args.action || 'update').trim().toLowerCase()
      const explicitlyCorrecting = /(?:改|更正|纠正|重记|记错|不是)/u.test(transcript)
      const explicitlyDeleting = /(?:删|删除)/u.test(transcript)
      if (action === 'delete' && !explicitlyDeleting) {
        throw new Error('删除记录需要用户在当前这句话中明确提出删除')
      }
      const recordId = await this.resolveAtomicRecordId(args)
      const recentFact = this.recentRecordFact(args.reference)
      const suppliedChanges = args.changes && typeof args.changes === 'object'
        ? args.changes
        : {}
      const derivedChanges = action === 'update'
        ? deriveCorrectionChanges(recentFact, transcript)
        : {}
      const changes = { ...derivedChanges, ...suppliedChanges }
      if (action === 'update' && !Object.keys(changes).length) {
        throw new Error(explicitlyCorrecting
          ? '没有识别出需要修改成什么内容'
          : '请直接说明需要改成什么内容')
      }
      if (action === 'rewrite' && !explicitlyCorrecting && !args.replacement?.content) {
        throw new Error('请直接说明重记后的完整内容')
      }
      const subject = await this.getEnterpriseContext()
      const context = {
        ownerId: this.ownerId,
        actorId: subject?.subject?.userId || this.ownerId,
        actorName: subject?.subject?.displayName || '',
      }
      const result = this.atomicSpaceProvider
        ? await this.atomicSpaceProvider.correctInstance({
            modelType: 'event',
            recordId,
            action,
            patch: changes,
            replacement: args.replacement || {},
            reason: args.reason,
            context,
          })
        : await this.atomicRecordStore.correct({
            recordId,
            action,
            patch: changes,
            replacement: args.replacement || {},
          reason: args.reason,
        }, context)
      const labels = { updated: '已修改', rewritten: '已重记', deleted: '已删除' }
      const confirmation = buildRecordVoiceConfirmation(
        result.record,
        labels[result.action] || '已处理',
      )
      this.onRecordFact({
        record: result.record,
        operation: result.action || action,
      })
      this.onConversationMessage({
        role: 'assistant',
        content: confirmation,
        source: 'tool-result',
        turnId,
      })
      let delivery
      try {
        const output = {
          status: 'ok',
          source: 'atomic-record-direct',
          ...result,
        }
        const liveFrontend = this.getFrontend?.()
        if (typeof liveFrontend?.speak === 'function') {
          delivery = await this.sendOutput(
            callId,
            output,
            turnId,
            result.record?.recordId,
            { createResponse: false },
          )
          if (!delivery?.skipped && !delivery?.failed) {
            delivery = await liveFrontend.speak(confirmation, 'agent', { turnId }, {
              verbatim: true,
            })
          }
        } else {
          delivery = await this.sendOutput(callId, output, turnId, result.record?.recordId, {
            response: {
              instructions: [
                `只说下面这句话，不要改写：${confirmation}`,
                '不要朗读记录 ID、接口名或内部字段。',
              ].join(' '),
            },
          })
        }
      } catch (error) {
        delivery = { failed: true, error: String(error?.message || error) }
      }
      if (delivery?.reason === 'realtime_unavailable'
        || delivery?.reason === 'realtime_not_ready'
        || delivery?.failed
        || delivery?.timedOut
        || delivery?.cancelled) {
        this.onToolConfirmationPending({ content: confirmation, turnId })
      }
    } catch (error) {
      await this.sendOutput(callId, failure(
        'atomic_record_correction_failed',
        String(error?.message || error),
        { retryable: false },
      ), turnId, null, {
        response: {
          instructions: '简短说明修改没有完成以及真实原因；如果找到多条候选，请用户补充房间或事项，不要索要记录 ID。',
        },
      })
    }
  }

  async queryAtomicRecords(callId, turnId, args) {
    if (!this.atomicRecordStore && !this.atomicSpaceProvider) {
      await this.sendOutput(callId, failure(
        'atomic_record_unavailable',
        '当前没有连接到原子记录存储。',
        { retryable: true },
      ), turnId)
      return
    }
    try {
      const result = this.atomicSpaceProvider
        ? await this.atomicSpaceProvider.queryInstances({
            modelType: 'event',
            filters: args,
            context: { ownerId: this.ownerId },
          })
        : await this.atomicRecordStore.query(args, { ownerId: this.ownerId })
      const resultWithLocalTimes = this.withLocalRecordTimes(result)
      await this.sendOutput(callId, {
        status: 'ok',
        source: 'atomic-record-direct',
        result: resultWithLocalTimes,
      }, turnId, null, {
        response: {
          instructions: [
            '第一句话直接说记录结果，不要说“我查到了”“根据资料”或工具过程。',
            '按用户问题只说相关记录；结果为空时只说没有查到相关记录。',
            '记录里有待归还、待结算或未关闭事项时要明确说出；不要朗读 recordId、ownerId、接口名和文件路径。',
            '时间按 occurredAtLocal 或 recordedAtLocal（北京时间）表达，不要把 UTC 原始时间直接说给用户。',
          ].join(' '),
        },
      })
    } catch (error) {
      await this.sendOutput(callId, failure(
        'atomic_record_query_failed',
        String(error?.message || error),
        { retryable: true },
      ), turnId, null, {
        response: {
          instructions: '简短说明原子记录暂时查不到以及真实原因，不要编造结果。',
        },
      })
    }
  }

  withLocalRecordTimes(result) {
    const timeZone = this.getClientContext?.()?.timeZone || 'Asia/Shanghai'
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    const localize = record => {
      if (!record || typeof record !== 'object') return record
      const local = value => {
        if (!value) return undefined
        const date = new Date(value)
        return Number.isFinite(date.getTime()) ? formatter.format(date) : undefined
      }
      return {
        ...record,
        timeZone,
        ...(local(record.occurredAt) ? { occurredAtLocal: local(record.occurredAt) } : {}),
        ...(local(record.timing?.recordedAt) ? { recordedAtLocal: local(record.timing.recordedAt) } : {}),
      }
    }
    return {
      ...result,
      records: Array.isArray(result?.records) ? result.records.map(localize) : result?.records,
    }
  }

  async notifySpiritUser(callId, turnId, args) {
    try {
      if (!this.spiritVoiceNotifier?.configured) {
        throw new Error('语音通知接口尚未完整配置')
      }
      const text = String(args.text || '').trim()
      if (!text) throw new Error('语音通知内容不能为空')
      const assignee = resolveSpiritAssignee({
        assigneeName: args.assigneeName,
        roomNumber: args.roomNumber,
        floor: args.floor,
        request: text,
      })
      const notificationPromise = this.spiritVoiceNotifier.notify({
        recipientId: assignee.userId,
        recipientName: assignee.name,
        title: String(args.title || '工作通知').trim(),
        text,
      }).catch(error => ({
        status: 'failed',
        error: String(error?.message || error),
      }))
      const notification = await settleWithTimeout(
        notificationPromise,
        this.taskNotificationWaitMs,
      )
      const output = {
        status: 'ok',
        source: 'spirit-api-direct',
        action: 'voice_notified',
        assignee: { name: assignee.name, userId: assignee.userId },
        text,
        notification,
      }
      const confirmation = notificationConfirmation({
        recipientName: assignee.name,
        content: text,
        status: notification?.status,
      })
      this.onConversationMessage({
        role: 'assistant',
        content: confirmation,
        source: 'tool-result',
        turnId,
      })
      await this.sendConfirmedOutput(callId, output, turnId, null, confirmation)
    } catch (error) {
      await this.sendOutput(callId, failure(
        'voice_notification_failed',
        String(error?.message || error),
        { retryable: true },
      ), turnId)
    }
  }

  async enterSleep(callId, turnId) {
    const supported = this.getClientContext()?.states?.includes('sleeping')
    if (!supported) {
      await this.sendOutput(
        callId,
        failure('unsupported_client_state', '当前入口不支持休眠。'),
        turnId,
      )
      return
    }
    await this.sendOutput(
      callId,
      { status: 'sleeping' },
      turnId,
      null,
      { createResponse: false },
    )
    this.requestClientState('sleeping')
  }

  notifyMemoryChanged() {
    try {
      this.onMemoryChanged()
    } catch {
      // Persistence succeeded even if a live prompt refresh did not.
    }
  }

  async respondAgentPermission(callId, turnId, args) {
    const authorizationId = String(args.authorization_id || '').trim()
    const decision = String(args.decision || '').trim()
    const transcript = String(await this.transcripts.transcript(turnId)).trim()
    if (
      !authorizationId
      || !['always', 'reject'].includes(decision)
      || !transcript
    ) {
      await this.sendOutput(
        callId,
        failure('invalid_permission_response', '没有找到有效的权限请求或决定。'),
        turnId,
      )
      return
    }
    const pendingTask = this.taskManager.list({
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      active: true,
    }).find(task => task.authorization?.id === authorizationId)
    if (!pendingTask) {
      await this.sendOutput(
        callId,
        failure(
          'permission_not_pending',
          '这项权限请求已经失效或不属于当前任务。',
          { retryable: false },
        ),
        turnId,
      )
      return
    }
    if (!this.respondPermission) {
      await this.sendOutput(
        callId,
        failure('permission_unavailable', '当前后台无法接收权限决定。'),
        turnId,
      )
      return
    }
    const previousPermissionMode = this.permissionPolicy?.mode(
      this.ownerId,
      this.sessionId,
    )
    this.permissionPolicy?.applyDecision(
      this.ownerId,
      this.sessionId,
      decision,
    )
    // Receipt-based: the local policy takes effect immediately and the ACP
    // round trip must not delay the spoken confirmation. On delivery failure
    // the policy rolls back and the authorization is still pending on the
    // backend, so the gateway can re-announce it through the existing
    // pending-permission retry path.
    Promise.resolve()
      .then(() => this.respondPermission(
        authorizationId,
        decision,
        { ownerId: this.ownerId },
      ))
      .catch(error => {
        if (previousPermissionMode) {
          this.permissionPolicy?.setMode(
            this.ownerId,
            this.sessionId,
            previousPermissionMode,
          )
        }
        try {
          this.onPermissionDeliveryFailed({
            authorizationId,
            decision,
            taskId: pendingTask.id,
            error: String(error?.message || error),
          })
        } catch {
          // Delivery diagnostics must not break the voice session.
        }
      })
    await this.sendOutput(callId, {
      status: 'submitted',
      authorization_id: authorizationId,
    }, turnId, pendingTask.id, {
      response: {
        instructions: decision === 'always'
          ? [
              '权限决定已提交，并在本会话立即生效。',
              '只用一句简短自然口语确认“已允许，后台继续执行”。',
              '不要重述操作，不要再次询问或调用工具。',
            ].join(' ')
          : [
              '权限决定已提交。',
              '只用一句简短自然口语确认“已拒绝，后台不会执行这项操作”。',
              '不要重述操作，不要再次询问或调用工具。',
            ].join(' '),
      },
    })
  }

  async cancelAgentTask(callId, turnId, args) {
    const requestedId = String(args.work_id || '').trim()
    const targetId = requestedId || this.taskManager.list({
      ownerId: this.ownerId,
      sessionId: this.sessionId,
    }).find(task => [
      'scheduled',
      'queued',
      'running',
      'delegated',
      'finalizing',
    ].includes(task.status))?.id
    if (!targetId) {
      await this.sendOutput(callId, {
        status: 'not_found',
        message: '当前没有仍在排队或执行的工作。',
      }, turnId)
      return
    }
    const relatedQueries = this.taskManager.list({
      ownerId: this.ownerId,
      active: true,
      includeControl: true,
    }).filter(task => (
      task.kind === 'control'
      && task.parentWorkId === targetId
    ))
    await Promise.all(relatedQueries.map(task => (
      this.taskManager.cancel(task.id, { ownerId: this.ownerId })
    )))
    const task = await this.taskManager.cancel(targetId, {
      ownerId: this.ownerId,
    })
    if (!task) {
      await this.sendOutput(callId, {
        status: 'not_active',
        work_id: targetId,
        message: '这项工作已经结束，当前无法取消。',
      }, turnId)
      return
    }
    await this.sendOutput(callId, task.status === 'cancelled' ? {
      status: task.status,
      work_id: task.id,
      message: '已取消这项工作。',
    } : failure(
      'work_cancellation_failed',
      task.error || '没有成功取消这项工作。',
    ), turnId, task.id)
  }

  async getAgentTaskStatus(callId, turnId, args) {
    if (args.list_all === true) {
      const tasks = this.taskManager.list({
        ownerId: this.ownerId,
        sessionId: this.sessionId,
      }).slice(0, 20).map(task => ({
        work_id: task.id,
        status: task.status,
        kind: task.kind,
        objective: String(task.objective || '').slice(0, 300),
        execute_at: task.schedule?.at
          ? new Date(task.schedule.at).toISOString()
          : null,
        recurrence: task.schedule?.recurrence || null,
      }))
      await this.sendOutput(callId, {
        status: tasks.length ? 'ok' : 'empty',
        count: tasks.length,
        tasks,
      }, turnId)
      return
    }
    const requestedId = String(args.work_id || '').trim()
    const task = requestedId
      ? this.taskManager.get(requestedId, { ownerId: this.ownerId })
      : this.taskManager.list({
          ownerId: this.ownerId,
          sessionId: this.sessionId,
        })[0]
    if (!task) {
      await this.sendOutput(callId, {
        status: 'not_found',
        message: '当前语音会话中还没有可查询的后台工作。',
      }, turnId)
      return
    }
    if (task.status === 'delegated') {
      const existing = this.taskManager.list({
        ownerId: this.ownerId,
        sessionId: this.sessionId,
        active: true,
        includeControl: true,
      }).find(item => (
        item.kind === 'control'
        && item.parentWorkId === task.id
      ))
      if (existing) {
        await this.sendOutput(callId, {
          status: 'querying',
          work_id: task.id,
          query_work_id: existing.id,
          message: '这个项目的状态和进度已经在查询中。',
        }, turnId, task.id)
        return
      }
      const transcript = String(
        args.question || await this.transcripts.transcript(turnId) || '',
      ).trim()
      const query = this.taskManager.create({
        kind: 'control',
        parentWorkId: task.id,
        priority: 100,
        objective: `查询“${task.objective.slice(0, 200)}”的状态：${
          transcript || '查询当前状态和进度'
        }`,
        ownerId: this.ownerId,
        sessionId: this.sessionId,
        turnId,
        laneKey: `coordinator:${this.ownerId}`,
        laneLimit: 1,
        runner: async (_ignored, { signal }) => {
          try {
            return await this.coordinator.queryDelegatedWork(
              task.id,
              transcript || '用户想了解这个第三层任务当前的状态和进度。',
              {
                ownerId: this.ownerId,
                signal,
              },
            )
          } catch (error) {
            const latest = this.taskManager.get(task.id, {
              ownerId: this.ownerId,
            })
            if (latest && latest.status !== 'delegated') {
              const messages = {
                completed: '这项工作已经完成，最终结果正在或已经交付。',
                finalizing: '项目执行已经完成，系统正在整理最终结果。',
                cancelled: '这项工作已经取消。',
                failed: `这项工作已经失败：${latest.error || '没有更多错误信息。'}`,
              }
              return {
                content: messages[latest.status]
                  || `这项工作当前状态是 ${latest.status}。`,
                metadata: {
                  parentWorkId: task.id,
                  resolvedFromLedger: true,
                },
              }
            }
            throw error
          }
        },
        canceler: async ({ abort }) => {
          abort()
          return {
            route: 'gateway',
            layer: 'delegated_status_query',
          }
        },
      })
      await this.sendOutput(callId, {
        status: 'querying',
        work_id: task.id,
        query_work_id: query.id,
        message: '正在查询这个项目的状态和进度，结果出来后会自动告诉你。',
      }, turnId, task.id)
      return
    }
    const lastActivity = task.activity.at(-1)
    const consumesTaskNotification = (
      ['completed', 'failed'].includes(task.status)
      && ['pending', 'delivering'].includes(task.notificationStatus)
    )
    await this.sendOutput(callId, {
      status: 'ok',
      work_id: task.id,
      work_status: task.status,
      objective: task.objective.slice(0, 300),
      elapsed_ms: task.elapsedMs,
      delegation: task.delegation
        ? {
            status: task.delegation.status,
            title: task.delegation.title,
          }
        : null,
      authorization_pending: task.authorization?.status === 'pending',
      last_activity: lastActivity
        ? {
            category: lastActivity.category || lastActivity.kind,
            status: lastActivity.status,
            detail: String(lastActivity.detail || '').slice(0, 160),
          }
        : null,
      result: task.status === 'completed'
        ? String(task.result || '').slice(0, 500)
        : null,
      error: ['failed', 'cancelled'].includes(task.status)
        ? task.error
        : null,
    }, turnId, task.id, consumesTaskNotification
      ? { responseContext: { consumesTaskNotification: true } }
      : undefined)
  }

  async getCurrentTime(callId, turnId) {
    await this.sendOutput(callId, {
      status: 'ok',
      ...currentTimeSnapshot(this.getClientContext()),
    }, turnId)
  }

  async memory(callId, turnId, args, responseOptions) {
    const action = String(args.action || '').trim().toLowerCase()
    const document = canonicalScope(String(args.document || (action === 'read' ? 'all' : '')))
    const oldText = String(args.old_text || '')
    const newText = String(args.new_text || '')
    const hasNewText = Object.prototype.hasOwnProperty.call(args, 'new_text')
    const content = String(args.content || '').trim()
    const proposedContent = action === 'append' ? content : newText
    let output
    if (!this.memoryService) {
      output = failure('memory_unavailable', '前台记忆功能当前不可用。')
    } else if (!['read', 'append', 'replace'].includes(action)) {
      output = failure('invalid_memory_action', '没有识别出要执行的记忆操作。')
    } else if (action === 'read') {
      const scope = document === 'all' ? null : document
      if (scope && !isMemoryDocument(scope)) {
        await this.sendOutput(callId, failure(
          'invalid_memory_document',
          '没有识别出要读取的记忆文档。',
        ), turnId, null, responseOptions)
        return
      }
      const memories = scope
        ? this.memoryService.list(this.ownerId, { scope })
        : this.memoryService.list(this.ownerId)
      output = {
        status: memories.length ? 'ok' : 'not_found',
        count: memories.length,
        documents: memories,
      }
    } else if (!isMemoryDocument(document)) {
      output = failure('invalid_memory_document', '写入记忆时必须指定 user 或 memory。')
    } else if (action === 'append' && !content) {
      output = failure('invalid_memory_edit', 'append 需要明确的 content。')
    } else if (action === 'replace' && (!oldText || !hasNewText)) {
      output = failure('invalid_memory_edit', 'replace 需要精确 old_text 和明确的 new_text。')
    } else if (SENSITIVE_MEMORY.test(proposedContent)) {
      output = failure(
        'sensitive_memory',
        '为了安全，不会保存密码、密钥、验证码或令牌。',
        { status: 'rejected' },
      )
    } else {
      try {
        const change = {
          document,
          edits: action === 'replace' ? [{ old_text: oldText, new_text: newText }] : [],
          append: action === 'append' ? content : '',
        }
        const changes = [change]
        const result = this.memoryService.apply(this.ownerId, changes)
        if (result.changed) this.notifyMemoryChanged()
        output = {
          status: result.changed ? 'updated' : 'unchanged',
          changed: result.changed,
          documents: result.documents,
        }
      } catch (error) {
        if (['stale_document', 'edit_not_found', 'ambiguous_edit'].includes(error.code)) {
          output = failure(
            error.code,
            '记忆文档已经变化或原文没有精确匹配，请重新读取后再修改。',
            {
              retryable: true,
              documents: this.memoryService.list(this.ownerId),
            },
          )
        } else {
          output = failure(
            'memory_write_failed',
            '暂时无法修改记忆，请稍后再试。',
            { retryable: true },
          )
        }
      }
    }
    await this.sendOutput(callId, output, turnId, null, responseOptions)
  }

  async notes(callId, turnId, args) {
    const action = String(args.action || '').trim().toLowerCase()
    const listName = String(args.list || '').trim()
    const items = Array.isArray(args.items)
      ? args.items.map(item => String(item || '').trim()).filter(Boolean).slice(0, 20)
      : []
    let output
    if (!this.notesStore) {
      output = failure('notes_unavailable', '清单功能当前不可用。')
    } else if (!['lists', 'show', 'add', 'remove', 'clear', 'drop'].includes(action)) {
      output = failure('invalid_notes_action', '没有识别出要执行的清单操作。')
    } else if (action === 'lists') {
      const lists = this.notesStore.lists(this.ownerId)
      output = {
        status: lists.length ? 'ok' : 'empty',
        lists,
      }
    } else if (!listName) {
      output = failure('missing_notes_target', '需要明确要操作的清单名称。')
    } else if (action === 'show') {
      output = this.notesStore.show(this.ownerId, listName)
    } else if (action === 'add' || action === 'remove') {
      if (!items.length) {
        output = failure('missing_notes_items', '需要明确要添加或划掉的内容。')
      } else if (items.some(item => SENSITIVE_MEMORY.test(item))) {
        output = failure(
          'sensitive_notes',
          '为了安全，不会保存密码、密钥、验证码或令牌。',
          { status: 'rejected' },
        )
      } else {
        try {
          output = this.notesStore[action](this.ownerId, { list: listName, items })
        } catch {
          output = failure(
            'notes_write_failed',
            '暂时无法更新这条清单，请稍后再试。',
            { retryable: true },
          )
        }
      }
    } else {
      try {
        output = this.notesStore[action](this.ownerId, listName)
      } catch {
        output = failure(
          'notes_write_failed',
          '暂时无法更新这条清单，请稍后再试。',
          { retryable: true },
        )
      }
    }
    await this.sendOutput(callId, output, turnId)
  }
}
