const DEFAULT_BASE_URL = 'https://jjstest.gzlex.com:20001/hotelAi/dify/hotel/v2'
const MAX_RECORDS = 100
const MAX_TEXT = 12_000
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
  if (depth > 4) return '[truncated]'
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
      pageNo: args.pageNo || 1,
      requestNum: Math.min(100, args.requestNum || 20),
      keyword: args.keyword,
      source: args.source,
      taskView: args.taskView || 'ALL',
      userId: args.userId,
      executeTimeFrom: args.executeTimeFrom,
      executeTimeTo: args.executeTimeTo,
    })}`, { signal })
  }

  detail(taskId, signal) {
    return this.request(`/task/detail${queryString({ taskId })}`, { signal })
  }

  comments(taskId, signal) {
    return this.request(`/task/execution-record/list${queryString({ taskId })}`, { signal })
  }

  create(payload, signal) {
    return this.request('/task', { method: 'POST', body: payload, signal })
  }

  update(payload, signal) {
    return this.request('/task/update', { method: 'POST', body: payload, signal })
  }

  delete(taskId, signal) {
    return this.request(`/task/${encodeURIComponent(taskId)}`, {
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
