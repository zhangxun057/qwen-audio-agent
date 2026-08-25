import { createHash } from 'node:crypto'
import { HotelContextError } from './hotel-context-error.mjs'
import { HttpHotelContextProvider } from './http-hotel-context-provider.mjs'
import { StaticHotelContextProvider } from './static-hotel-context-provider.mjs'

const DEFAULT_MAX_PROMPT_CHARS = 32_000

function requiredText(value, field, { max = 200 } = {}) {
  const text = String(value || '').trim()
  if (!text) {
    throw new HotelContextError(`上下文字段 ${field} 不能为空`, {
      code: 'INVALID_CONTEXT',
      status: 502,
    })
  }
  return [...text].slice(0, max).join('')
}

function validDate(value, field) {
  const text = requiredText(value, field, { max: 80 })
  const timestamp = Date.parse(text)
  if (!Number.isFinite(timestamp)) {
    throw new HotelContextError(`上下文字段 ${field} 不是有效时间`, {
      code: 'INVALID_CONTEXT',
      status: 502,
    })
  }
  return { text, timestamp }
}

export function normalizeHotelContext(payload, {
  contextId,
  userId,
  maxPromptChars = DEFAULT_MAX_PROMPT_CHARS,
  now = new Date(),
} = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HotelContextError('上下文服务没有返回 JSON 对象', {
      code: 'INVALID_CONTEXT',
      status: 502,
    })
  }
  const actualContextId = requiredText(payload.contextId, 'contextId')
  const expectedContextId = String(contextId || '').trim()
  if (expectedContextId && actualContextId !== expectedContextId) {
    throw new HotelContextError('上下文 ID 与请求不匹配', {
      code: 'CONTEXT_NOT_FOUND',
      status: 404,
    })
  }
  const subject = payload.subject && typeof payload.subject === 'object'
    ? payload.subject
    : {}
  const actualUserId = requiredText(subject.userId, 'subject.userId')
  const expectedUserId = String(userId || '').trim()
  if (expectedUserId && actualUserId !== expectedUserId) {
    throw new HotelContextError('当前用户没有匹配的语音上下文', {
      code: 'CONTEXT_NOT_FOUND',
      status: 404,
    })
  }
  const prompt = String(payload.prompt || '').trim()
  if (!prompt) {
    throw new HotelContextError('上下文 prompt 不能为空', {
      code: 'INVALID_CONTEXT',
      status: 502,
    })
  }
  const promptChars = [...prompt].length
  if (promptChars > maxPromptChars) {
    throw new HotelContextError(
      `上下文 prompt 超过 ${maxPromptChars} 字符上限`,
      { code: 'CONTEXT_TOO_LARGE', status: 413 },
    )
  }
  const generatedAt = validDate(payload.generatedAt, 'generatedAt')
  const expiresAt = validDate(payload.expiresAt, 'expiresAt')
  const nowTimestamp = now instanceof Date ? now.getTime() : Date.parse(now)
  if (expiresAt.timestamp <= nowTimestamp) {
    throw new HotelContextError('语音上下文已经过期', {
      code: 'CONTEXT_EXPIRED',
      status: 410,
    })
  }
  if (expiresAt.timestamp <= generatedAt.timestamp) {
    throw new HotelContextError('上下文 expiresAt 必须晚于 generatedAt', {
      code: 'INVALID_CONTEXT',
      status: 502,
    })
  }
  const estimatedTokens = Number(payload.estimatedTokens)
  return {
    contextId: actualContextId,
    version: requiredText(payload.version, 'version'),
    generatedAt: generatedAt.text,
    expiresAt: expiresAt.text,
    subject: {
      userId: actualUserId,
      displayName: String(subject.displayName || '').trim(),
      hotelId: String(subject.hotelId || '').trim(),
    },
    sections: payload.sections && typeof payload.sections === 'object'
      && !Array.isArray(payload.sections)
      ? payload.sections
      : {},
    prompt,
    estimatedTokens: Number.isFinite(estimatedTokens) && estimatedTokens > 0
      ? Math.round(estimatedTokens)
      : null,
    contentHash: `sha256:${createHash('sha256').update(prompt).digest('hex')}`,
  }
}

function initialHealth({ mode, contextId, userId, configured }) {
  return {
    mode,
    configured,
    contextId: contextId || null,
    version: null,
    subjectUserId: userId || null,
    promptChars: 0,
    status: configured ? 'idle' : 'disabled',
    fallback: false,
    lastError: null,
  }
}

export class HotelContextService {
  constructor({
    mode = 'off',
    contextId = '',
    userId = '',
    provider = null,
    fallbackProvider = null,
    mockProvider = null,
    maxPromptChars = DEFAULT_MAX_PROMPT_CHARS,
    now = () => new Date(),
    logger = null,
  } = {}) {
    this.mode = mode
    this.contextId = String(contextId || '').trim()
    this.userId = String(userId || '').trim()
    this.provider = provider
    this.fallbackProvider = fallbackProvider
    this.mockProvider = mockProvider
    this.maxPromptChars = maxPromptChars
    this.now = now
    this.logger = logger
    this.configured = mode !== 'off'
      && Boolean(this.contextId && (this.userId || mode !== 'mock') && provider)
    this.state = initialHealth({
      mode,
      contextId: this.contextId,
      userId: this.userId,
      configured: this.configured,
    })
  }

  resolveUserId(ownerId) {
    return this.userId || String(ownerId || '').trim()
  }

  async loadFrom(provider, { contextId, userId, signal }) {
    const payload = await provider.getContext({ contextId, userId, signal })
    return normalizeHotelContext(payload, {
      contextId,
      userId,
      maxPromptChars: this.maxPromptChars,
      now: this.now(),
    })
  }

  recordReady(context, { fallback = false } = {}) {
    this.state = {
      mode: this.mode,
      configured: this.configured,
      contextId: context.contextId,
      version: context.version,
      subjectUserId: context.subject.userId,
      promptChars: [...context.prompt].length,
      status: 'ready',
      fallback,
      lastError: null,
    }
    return context
  }

  recordError(error) {
    this.state = {
      ...this.state,
      status: 'error',
      fallback: false,
      lastError: error?.message || String(error),
    }
  }

  async getContext({
    contextId = this.contextId,
    userId,
    ownerId,
    signal,
  } = {}) {
    if (!this.configured) return null
    const resolvedUserId = String(userId || this.resolveUserId(ownerId)).trim()
    try {
      const context = await this.loadFrom(this.provider, {
        contextId,
        userId: resolvedUserId,
        signal,
      })
      return this.recordReady(context)
    } catch (error) {
      if (this.fallbackProvider && this.fallbackProvider !== this.provider) {
        try {
          const fallback = await this.loadFrom(this.fallbackProvider, {
            contextId,
            userId: resolvedUserId,
            signal,
          })
          this.logger?.warn?.('hotel_context.fallback', {
            contextId,
            userId: resolvedUserId,
            error,
          })
          const context = this.recordReady(fallback, { fallback: true })
          this.state.lastError = error?.message || String(error)
          return context
        } catch (fallbackError) {
          this.recordError(fallbackError)
          throw fallbackError
        }
      }
      this.recordError(error)
      throw error
    }
  }

  async resolveForSession(options = {}) {
    try {
      return await this.getContext(options)
    } catch (error) {
      this.logger?.warn?.('hotel_context.session_load_failed', {
        contextId: options.contextId || this.contextId,
        ownerId: options.ownerId || null,
        error,
      })
      return null
    }
  }

  async getMockContext({ contextId, userId, signal } = {}) {
    if (!this.mockProvider) {
      throw new HotelContextError('本地 Context Mock 未启用', {
        code: 'MOCK_DISABLED',
        status: 404,
      })
    }
    return this.loadFrom(this.mockProvider, {
      contextId,
      userId,
      signal,
    })
  }

  warmup() {
    if (!this.configured) return Promise.resolve(null)
    return this.resolveForSession()
  }

  health() {
    return { ...this.state }
  }
}

export function createHotelContextServiceFromConfig({ config, logger } = {}) {
  const mockProvider = new StaticHotelContextProvider({
    directory: config.contextMockDirectory,
  })
  let provider = null
  if (config.contextMode === 'mock') {
    provider = mockProvider
  } else if (config.contextMode === 'http' && config.contextServiceUrl) {
    provider = new HttpHotelContextProvider({
      baseUrl: config.contextServiceUrl,
      token: config.contextServiceToken,
      timeoutMs: config.contextServiceTimeoutMs,
    })
  }
  return new HotelContextService({
    mode: config.contextMode,
    contextId: config.contextId,
    userId: config.contextUserId,
    provider,
    fallbackProvider: (
      config.contextMode === 'http' && config.contextFallbackToMock
        ? mockProvider
        : null
    ),
    mockProvider: config.contextMode === 'off' ? null : mockProvider,
    maxPromptChars: config.contextMaxPromptChars,
    logger,
  })
}
