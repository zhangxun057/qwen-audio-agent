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
} from '../realtime-provider.mjs'
import { currentTimeSnapshot } from '../../conversation/frontend-agent-context.mjs'
import { canonicalScope, isMemoryDocument } from '../../core/memory-scopes.mjs'
import {
  buildSpiritTaskUsers,
  normalizeSpiritTaskSummary,
  resolveSpiritAssignee,
  SPIRIT_DEMO_CHANNEL,
  SPIRIT_DEMO_CREATOR,
} from '../spirit-task-directory.mjs'
import {
  SPIRIT_TASK_RECORD_SOURCES,
  SPIRIT_TASK_STATUSES,
} from '../spirit-task-direct.mjs'

const SENSITIVE_MEMORY = /(?:pass(?:word)?|secret|api[_ -]?key|access[_ -]?token|credential|验证码|密码|密钥|令牌|\bsk-[a-z0-9_-]+)/i

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
    onMemoryChanged = () => {},
    respondPermission,
    permissionPolicy,
    onPermissionDeliveryFailed = () => {},
    requestClientState = () => {},
    spiritTaskClient = null,
    spiritVoiceNotifier = null,
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
    this.onMemoryChanged = onMemoryChanged
    this.respondPermission = respondPermission
    this.permissionPolicy = permissionPolicy
    this.onPermissionDeliveryFailed = onPermissionDeliveryFailed
    this.requestClientState = requestClientState
    this.spiritTaskClient = spiritTaskClient
    this.spiritVoiceNotifier = spiritVoiceNotifier
    this.gatewayApprovedPermissions = new Set()
    this.processedCalls = new Set()
    this.turnTasks = new Map()
    this.deferredToolResponses = new Map()
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
    await this.getFrontend()?.sendFunctionOutput(
      callId,
      output,
      { turnId, taskId, ...(responseContext || {}) },
      frontendOptions,
    )
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

  async handleSpiritTask(callId, turnId, toolName, args) {
    if (!this.spiritTaskClient) {
      await this.sendOutput(callId, {
        status: 'error', error: true, error_code: 'task_tool_unavailable',
        user_message: '当前没有连接到 Spirit 任务 API。', retryable: true,
      }, turnId)
      return
    }
    const taskId = String(args.taskId || '').trim()
    if (toolName !== SPIRIT_TASK_LIST_TOOL_NAME && !taskId) {
      await this.sendOutput(callId, {
        status: 'error', error: true, error_code: 'missing_task_id',
        user_message: '查询任务详情需要明确的任务 ID。', retryable: true,
      }, turnId)
      return
    }
    try {
      const result = toolName === SPIRIT_TASK_LIST_TOOL_NAME
        ? await this.spiritTaskClient.list({
            ...args,
            requestNum: Math.min(20, Number(args.requestNum) || 20),
          })
        : toolName === SPIRIT_TASK_DETAIL_TOOL_NAME
          ? await this.spiritTaskClient.detail(taskId)
          : await this.spiritTaskClient.comments(taskId)
      await this.sendOutput(callId, {
        status: 'ok', source: 'spirit-api-direct', result,
      }, turnId, null, {
        response: {
          instructions: [
            '第一句话直接说任务信息，不要任何开场、概述或查询确认。',
            '禁止说“我查到了”“目前系统中”“给您说几个”“任务列表如下”。',
            '列表逐条只说标题、状态、执行人等用户需要的字段；能一句说清就只说一句。',
            '状态使用自然中文：IN_PROGRESS说“进行中”，DONE说“已完成”，PENDING说“待处理”，CANCELLED说“已取消”；不要朗读英文枚举值。',
            '不要提后台 Agent、函数名、接口名、缓存或内部字段。',
            '结果为空时只说“没有查到任务”。',
          ].join(' '),
        },
      })
    } catch (error) {
      await this.sendOutput(callId, {
        status: 'error', error: true, error_code: 'task_query_failed',
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
      const assignee = selfTest
        ? {
            name: SPIRIT_DEMO_CREATOR.userName,
            userId: SPIRIT_DEMO_CREATOR.userId,
            department: '系统自测',
            floors: [],
            matchedBy: 'self-test',
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
        status: 'IN_PROGRESS',
        ...SPIRIT_DEMO_CHANNEL,
        users: buildSpiritTaskUsers(assignee),
        recommendedActions: [],
      }
      const created = await this.spiritTaskClient.create(payload)
      const taskId = String(created?.taskId || created?.id || '').trim()
      if (!taskId) throw new Error('任务接口返回成功，但没有 taskId')

      let notification = { status: 'disabled' }
      if (!selfTest && args.notify !== false) {
        if (!this.spiritVoiceNotifier?.configured) {
          notification = { status: 'not_configured' }
        } else {
          try {
            notification = await this.spiritVoiceNotifier.notify({
              recipientId: assignee.userId,
              recipientName: assignee.name,
              title: '任务提醒',
              text: `您有一个新任务【${summary}】，请立即执行。`,
            })
          } catch (error) {
            notification = {
              status: 'failed',
              error: String(error?.message || error),
            }
          }
        }
      }

      await this.sendOutput(callId, {
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
      }, turnId, null, {
        response: {
          instructions: [
            '直接说“任务已派给某人”，必要时补充通知结果；不要开场或解释过程。',
            '只有 notification.status=sent 才能说语音通知已发送。',
            'skipped_by_gate 表示任务已创建，但接收人关闭通知；当前不检查是否在岗。failed 或 not_configured 也必须明确区分。',
            '不要朗读 taskId、userId、函数名、接口名或内部字段。',
          ].join(' '),
        },
      })
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
      const taskId = String(args.taskId || '').trim()
      if (!taskId) throw new Error('修改任务需要真实 taskId')
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
        payload.executors = [buildSpiritTaskUsers(assignee)[1]]
      }
      if (Object.keys(payload).length === 1) {
        throw new Error('请至少提供状态、描述或新的执行人')
      }
      const result = await this.spiritTaskClient.update(payload)
      await this.sendOutput(callId, {
        status: 'ok',
        source: 'spirit-api-direct',
        action: 'updated',
        taskId,
        changes: {
          status: payload.status,
          description: payload.description,
          assignee: assignee?.name,
        },
        result,
      }, turnId, null, {
        response: {
          instructions: '自然说明实际修改了什么；不要朗读 taskId、userId、接口名或空字段。',
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
      const taskId = String(args.taskId || '').trim()
      if (!taskId) throw new Error('开始任务需要真实 taskId')
      const result = await this.spiritTaskClient.start(taskId)
      await this.sendOutput(callId, {
        status: 'ok',
        source: 'spirit-api-direct',
        action: 'started',
        taskId,
        result,
      }, turnId, null, {
        response: {
          instructions: '只说任务已经开始或已接手；不要开场，不要朗读 taskId、接口名或内部字段。',
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
      const taskId = String(args.taskId || '').trim()
      if (!taskId) throw new Error('完成任务需要真实 taskId')
      const completionRemark = args.completionRemark === undefined
        ? undefined
        : String(args.completionRemark || '').trim() || undefined
      if (completionRemark && completionRemark.length > 4_000) {
        throw new Error('完成备注不能超过 4000 个字符')
      }
      const result = await this.spiritTaskClient.complete(taskId, completionRemark)
      await this.sendOutput(callId, {
        status: 'ok',
        source: 'spirit-api-direct',
        action: 'completed',
        taskId,
        completionRemark,
        result,
      }, turnId, null, {
        response: {
          instructions: '直接说任务已完成；有完成说明时用一句自然短句带上，不要朗读 taskId、接口名或内部字段。',
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
      const taskId = String(args.taskId || '').trim()
      const targetStatus = String(args.targetStatus || '').trim()
      if (!taskId) throw new Error('修改任务状态需要真实 taskId')
      if (!SPIRIT_TASK_STATUSES.includes(targetStatus)) {
        throw new Error('目标状态不是 Spirit 支持的原始状态')
      }
      const result = await this.spiritTaskClient.updateStatus(taskId, targetStatus)
      await this.sendOutput(callId, {
        status: 'ok',
        source: 'spirit-api-direct',
        action: 'status_updated',
        taskId,
        targetStatus,
        result,
      }, turnId, null, {
        response: {
          instructions: '只用自然中文说明任务的新状态；不要朗读英文状态、taskId、接口名或内部字段。',
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
      const taskId = String(args.taskId || '').trim()
      const content = String(args.content || '').trim()
      const recordSource = String(args.recordSource || 'SYSTEM_AUTO').trim()
      if (!taskId) throw new Error('追加任务记录需要真实 taskId')
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
      }, turnId, null, {
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
      const taskId = String(args.taskId || '').trim()
      const transcript = String(
        await this.transcripts?.transcript(turnId) || '',
      ).trim()
      if (!taskId) throw new Error('删除任务需要真实 taskId')
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
      }, turnId, null, {
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
      const notification = await this.spiritVoiceNotifier.notify({
        recipientId: assignee.userId,
        recipientName: assignee.name,
        title: String(args.title || '任务提醒').trim(),
        text,
      })
      await this.sendOutput(callId, {
        status: 'ok',
        source: 'spirit-api-direct',
        action: 'voice_notified',
        assignee: { name: assignee.name, userId: assignee.userId },
        notification,
      }, turnId, null, {
        response: {
          instructions: [
            '只有 notification.status=sent 才能说语音通知已发送。',
            '如果是 skipped_by_gate，只说明接收人关闭了通知；当前不检查是否在岗。不要声称成功。',
            '不要朗读 userId、音频 URL、消息 ID 或内部字段。',
          ].join(' '),
        },
      })
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
