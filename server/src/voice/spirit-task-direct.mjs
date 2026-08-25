const DEFAULT_BASE_URL = 'https://jjstest.gzlex.com:20001/hotelAi/dify/hotel/v2'
const MAX_RECORDS = 100
const MAX_TEXT = 12_000
const TASK_ID_MAX_LENGTH = 128
const COMMENT_MAX_LENGTH = 4_000
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u
export const SPIRIT_TASK_STATUSES = Object.freeze([
  'PENDING_ADMISSION',
  'PENDING_RECEIPT',
  'TODO',
  'IN_PROGRESS',
  'PENDING_APPROVAL',
  'DONE',
  'EXCEPTION',
])
export const SPIRIT_TASK_VIEWS = Object.freeze([
  'EXECUTE',
  'FOCUS',
  'CURRENT',
  'HISTORY',
  'ALL',
])
export const SPIRIT_TASK_RECORD_SOURCES = Object.freeze([
  'SYSTEM_AUTO',
  'USER_DIALOGUE',
])
const SECRET_ENV_NAMES = [
  'SPIRIT_BEARER_TOKEN',
  // Clear credentials from the obsolete web-login integration too.
  'SPIRIT_ACCESS_TOKEN',
  // Clear obsolete credentials too, so they cannot leak to child processes.
  'SPIRIT_USERNAME',
  'SPIRIT_PASSWORD',
]

function cleanBaseUrl(value) {
  const source = String(value || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL
  const url = new URL(source)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('SPIRIT_API_BASE_URL 只支持 http 或 https')
  }
  return url.toString().replace(/\/$/u, '')
}

function optionalText(value) {
  const text = String(value || '').trim()
  return text || ''
}

function requiredText(value, label, maxLength) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`${label}不能为空`)
  if (text.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`)
  return text
}

function boundedOptionalText(value, label, maxLength) {
  if (value === undefined) return undefined
  const text = String(value ?? '').trim()
  if (!text) return undefined
  if (text.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`)
  return text
}

function normalizedTaskId(value) {
  return requiredText(value, '任务 ID', TASK_ID_MAX_LENGTH)
}

function dateTime(value, label) {
  const text = boundedOptionalText(value, label, 19)
  if (text !== undefined && !DATE_PATTERN.test(text)) {
    throw new Error(`${label}必须使用 yyyy-MM-dd HH:mm:ss 格式`)
  }
  return text
}

function nullableDateTime(value, label) {
  if (value === null) return null
  return dateTime(value, label) ?? null
}

function positiveInteger(value, label, fallback, maximum) {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${label}必须是 1 到 ${maximum} 之间的整数`)
  }
  return resolved
}

function optionalArray(value, label) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`${label}必须是 JSON 数组`)
  return value
}

function optionalObject(value, label) {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error(`${label}必须是 JSON 对象`)
  return value
}

function optionalBoolean(value, label) {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${label}必须是布尔值`)
  return value
}

function supportedValue(value, values, label, fallback) {
  const resolved = value ?? fallback
  if (!values.includes(resolved)) throw new Error(`${label}不受支持`)
  return resolved
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function responseMessage(value, fallback) {
  if (!isRecord(value)) return fallback
  for (const key of ['message', 'msg', 'error']) {
    const message = value[key]
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  return fallback
}

function unwrap(value) {
  if (!isRecord(value)) return value
  if ('success' in value) {
    if (value.success !== true) {
      throw new Error(responseMessage(value, 'Spirit 任务请求失败'))
    }
    return value.data ?? value.result ?? null
  }
  if ('code' in value) {
    if (![0, 200, '0', '200'].includes(value.code)) {
      throw new Error(responseMessage(value, 'Spirit 任务请求失败'))
    }
    return value.data ?? value.result ?? null
  }
  return value
}

function compact(value, depth = 0) {
  // Bound raw API payloads at the transport boundary. The voice handler then
  // projects task responses to a stable business shape before model exposure.
  // Keep task users deep enough for executor names and roles to survive.
  if (depth > 5) return '[truncated]'
  if (typeof value === 'string') {
    return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}...` : value
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_RECORDS).map(item => compact(item, depth + 1))
  }
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, compact(item, depth + 1)]),
  )
}

function queryString(query) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const serialized = params.toString()
  return serialized ? `?${serialized}` : ''
}

async function readJsonResponse(response, label) {
  const body = await response.text()
  try {
    return body === '' ? null : JSON.parse(body)
  } catch {
    throw new Error(`${label}返回了非 JSON（HTTP ${response.status}）`)
  }
}

export class SpiritTaskDirectClient {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    bearerToken = '',
    timeoutMs = 10_000,
    fetchImpl = fetch,
  } = {}) {
    this.baseUrl = cleanBaseUrl(baseUrl)
    this.bearerToken = optionalText(bearerToken)
    this.timeoutMs = timeoutMs
    this.fetchImpl = fetchImpl
  }

  get configured() {
    return Boolean(this.bearerToken)
  }

  async withTimeout(signal, operation) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await operation(controller.signal)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async request(path, {
    method = 'GET',
    body,
    signal,
  } = {}) {
    if (!this.configured) {
      throw new Error('Spirit 直连接口尚未配置 SPIRIT_BEARER_TOKEN')
    }
    return this.withTimeout(signal, async requestSignal => {
      const headers = {
        Accept: 'application/json',
        Authorization: `Bearer ${this.bearerToken}`,
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json'

      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: requestSignal,
      })
      const payload = await readJsonResponse(response, 'Spirit 任务接口')
      if (!response.ok) {
        throw new Error(responseMessage(payload, `Spirit 任务接口请求失败（HTTP ${response.status}）`))
      }
      return compact(unwrap(payload))
    })
  }

  list(args = {}, signal) {
    return this.request(`/task/list${queryString({
      pageNo: positiveInteger(args.pageNo, '页码', 1, 10_000),
      requestNum: positiveInteger(args.requestNum, '每页数量', 100, 100),
      keyword: boundedOptionalText(args.keyword, '关键词', 255),
      source: boundedOptionalText(args.source, '来源', 64),
      taskView: supportedValue(args.taskView, SPIRIT_TASK_VIEWS, '任务视图', 'ALL'),
      userId: boundedOptionalText(args.userId, '用户 ID', 128),
      executeTimeFrom: dateTime(args.executeTimeFrom, '起始时间'),
      executeTimeTo: dateTime(args.executeTimeTo, '结束时间'),
    })}`, { signal })
  }

  detail(taskIdValue, signal) {
    return this.request(`/task/detail${queryString({
      taskId: normalizedTaskId(taskIdValue),
    })}`, { signal })
  }

  detailByConversation(conversationId, signal) {
    return this.request(
      `/task/detailByConversationId${queryString({
        conversationId: requiredText(conversationId, '会话 ID', 128),
      })}`,
      { signal },
    )
  }

  comments(taskIdValue, signal) {
    return this.request(`/task/execution-record/list${queryString({
      taskId: normalizedTaskId(taskIdValue),
    })}`, { signal })
  }

  create(payload, signal) {
    const body = {
      summary: requiredText(payload?.summary, '任务标题', 255),
      tag: boundedOptionalText(payload?.tag, '任务标签', 100),
      description: boundedOptionalText(payload?.description, '任务描述', 16_000),
      taskOpeningPrompt: boundedOptionalText(payload?.taskOpeningPrompt, '执行提示', 16_000),
      needAiGuide: optionalBoolean(payload?.needAiGuide, '是否需要 AI 引导'),
      parentTaskId: boundedOptionalText(payload?.parentTaskId, '父任务 ID', TASK_ID_MAX_LENGTH),
      taskType: boundedOptionalText(payload?.taskType, '任务类型', 64),
      source: boundedOptionalText(payload?.source, '来源', 64),
      sourceId: boundedOptionalText(payload?.sourceId, '来源 ID', 64),
      channelType: boundedOptionalText(payload?.channelType, '渠道类型', 64),
      channelCode: boundedOptionalText(payload?.channelCode, '渠道编码', 128),
      roleCode: boundedOptionalText(payload?.roleCode, '角色编码', 64),
      acceptTime: dateTime(payload?.acceptTime, '计划受理时间'),
      executeTime: dateTime(payload?.executeTime, '计划执行时间'),
      completeTime: dateTime(payload?.completeTime, '计划完成时间'),
      status: payload?.status === undefined
        ? undefined
        : supportedValue(payload.status, SPIRIT_TASK_STATUSES, '任务状态'),
      users: optionalArray(payload?.users, '任务用户'),
      subTasks: optionalArray(payload?.subTasks, '子任务'),
      originalRequest: optionalObject(payload?.originalRequest, '原始需求'),
      recommendedActions: optionalArray(payload?.recommendedActions, '推荐动作'),
    }
    return this.request('/task', { method: 'POST', body, signal })
  }

  update(payload, signal) {
    const body = {
      taskId: normalizedTaskId(payload?.taskId),
      status: payload?.status === undefined
        ? undefined
        : supportedValue(payload.status, SPIRIT_TASK_STATUSES, '任务状态'),
      description: boundedOptionalText(payload?.description, '任务描述', 4_000),
      executors: optionalArray(payload?.executors, '执行人'),
      recommendedActions: optionalArray(payload?.recommendedActions, '推荐动作'),
    }
    return this.request('/task/update', { method: 'POST', body, signal })
  }

  start(taskIdValue, signal) {
    return this.request('/task/start', {
      method: 'POST',
      body: { taskId: normalizedTaskId(taskIdValue) },
      signal,
    })
  }

  complete(taskIdValue, completionRemark, signal) {
    return this.request('/task/complete', {
      method: 'POST',
      body: {
        taskId: normalizedTaskId(taskIdValue),
        completionRemark: boundedOptionalText(completionRemark, '完成备注', 4_000),
      },
      signal,
    })
  }

  updateStatus(taskIdValue, targetStatus, signal) {
    return this.request('/task/ai-update-status', {
      method: 'POST',
      body: {
        taskId: normalizedTaskId(taskIdValue),
        targetStatus: supportedValue(targetStatus, SPIRIT_TASK_STATUSES, '目标状态'),
      },
      signal,
    })
  }

  updatePlanTime(taskIdValue, planTime, signal) {
    if (!isRecord(planTime)) throw new Error('计划时间必须是 JSON 对象')
    for (const field of ['acceptTime', 'executeTime', 'completeTime']) {
      if (!(field in planTime)) throw new Error('计划受理、执行和完成时间必须全部提供')
    }
    return this.request('/task/plan-time', {
      method: 'POST',
      body: {
        taskId: normalizedTaskId(taskIdValue),
        planTime: {
          acceptTime: nullableDateTime(planTime.acceptTime, '计划受理时间'),
          executeTime: nullableDateTime(planTime.executeTime, '计划执行时间'),
          completeTime: nullableDateTime(planTime.completeTime, '计划完成时间'),
        },
      },
      signal,
    })
  }

  updateDailySummary(taskIdValue, content, fullReplace = false, signal) {
    return this.request('/task/daily-summary', {
      method: 'POST',
      body: {
        taskId: normalizedTaskId(taskIdValue),
        content: requiredText(content, '总结内容', 16_000),
        fullReplace: optionalBoolean(fullReplace, '是否全量替换') ?? false,
      },
      signal,
    })
  }

  workload(userIds, queryType = 'TODAY', signal) {
    return this.request('/task/today-workload', {
      method: 'POST',
      body: {
        userIds: boundedOptionalText(userIds, '用户 ID 列表', 6_499),
        queryType: supportedValue(queryType, ['TODAY', 'ALL'], '查询范围', 'TODAY'),
      },
      signal,
    })
  }

  addComment(taskIdValue, content, recordSource = 'SYSTEM_AUTO', operator = {}, signal) {
    const normalizedRecordSource = supportedValue(
      recordSource,
      SPIRIT_TASK_RECORD_SOURCES,
      '任务记录来源',
      'SYSTEM_AUTO',
    )
    const includeOperator = normalizedRecordSource === 'USER_DIALOGUE'
    return this.request('/task/execution-record', {
      method: 'POST',
      body: {
        taskId: normalizedTaskId(taskIdValue),
        recordSource: normalizedRecordSource,
        content: requiredText(content, '评论内容', COMMENT_MAX_LENGTH),
        ...(includeOperator && operator.operatorId
          ? { operatorId: boundedOptionalText(operator.operatorId, '操作者 ID', 128) }
          : {}),
        ...(includeOperator && operator.operatorName
          ? { operatorName: boundedOptionalText(operator.operatorName, '操作者姓名', 255) }
          : {}),
      },
      signal,
    })
  }

  delete(taskIdValue, signal) {
    return this.request(`/task/${encodeURIComponent(normalizedTaskId(taskIdValue))}`, {
      method: 'POST',
      body: {},
      signal,
    })
  }

  async notificationGates(userId, signal, { checkOnDuty = true } = {}) {
    const [duty, notification] = await Promise.all([
      checkOnDuty
        ? this.request(`/work-shifts/on-duty${queryString({ userId })}`, { signal })
        : Promise.resolve(null),
      this.request(`/notifications/status${queryString({ userId })}`, { signal }),
    ])
    const onDuty = checkOnDuty ? duty?.onDuty === true : null
    const notifyEnabled = notification?.enabled === true
    return {
      passed: notifyEnabled && (!checkOnDuty || onDuty),
      onDutyCheckSkipped: !checkOnDuty,
      onDuty,
      notifyEnabled,
    }
  }
}

export function createSpiritTaskClientFromEnvironment(env = process.env) {
  const client = new SpiritTaskDirectClient({
    baseUrl: env.SPIRIT_API_BASE_URL || DEFAULT_BASE_URL,
    bearerToken: env.SPIRIT_BEARER_TOKEN,
  })
  for (const name of SECRET_ENV_NAMES) delete env[name]
  return client
}
