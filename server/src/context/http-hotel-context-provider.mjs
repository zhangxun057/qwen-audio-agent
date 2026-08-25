import { HotelContextError } from './hotel-context-error.mjs'

function normalizedBaseUrl(value) {
  let url
  try {
    url = new URL(String(value || ''))
  } catch {
    throw new HotelContextError('Context Service URL 无效', {
      code: 'INVALID_CONTEXT_SERVICE_URL',
      status: 500,
    })
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new HotelContextError('Context Service URL 只支持 http 或 https', {
      code: 'INVALID_CONTEXT_SERVICE_URL',
      status: 500,
    })
  }
  return url.toString().replace(/\/+$/, '')
}

export class HttpHotelContextProvider {
  constructor({
    baseUrl,
    token = '',
    timeoutMs = 2500,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.baseUrl = normalizedBaseUrl(baseUrl)
    this.token = String(token || '').trim()
    this.timeoutMs = timeoutMs
    this.fetchImpl = fetchImpl
  }

  async getContext({ contextId, userId, signal } = {}) {
    const url = new URL(
      `${this.baseUrl}/v1/voice-contexts/${encodeURIComponent(contextId)}`,
    )
    url.searchParams.set('userId', userId)
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        signal: controller.signal,
      })
      if (!response.ok) {
        let message = `Context Service 返回 HTTP ${response.status}`
        try {
          const body = await response.json()
          if (body?.error) message = String(body.error)
        } catch {
          // Keep the status-based message when the body is not JSON.
        }
        throw new HotelContextError(message, {
          code: 'CONTEXT_SERVICE_HTTP_ERROR',
          status: response.status,
        })
      }
      return await response.json()
    } catch (error) {
      if (error instanceof HotelContextError) throw error
      if (controller.signal.aborted) {
        throw new HotelContextError('Context Service 请求超时或已取消', {
          code: 'CONTEXT_SERVICE_TIMEOUT',
          status: 504,
          cause: error,
        })
      }
      throw new HotelContextError('Context Service 请求失败', {
        code: 'CONTEXT_SERVICE_UNAVAILABLE',
        status: 502,
        cause: error,
      })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', abort)
    }
  }
}
