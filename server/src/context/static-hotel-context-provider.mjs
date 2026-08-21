import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { HotelContextError } from './hotel-context-error.mjs'

const SAFE_CONTEXT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/

export class StaticHotelContextProvider {
  constructor({ directory } = {}) {
    this.directory = resolve(String(directory || '.'))
  }

  async getContext({ contextId } = {}) {
    const id = String(contextId || '').trim()
    if (!SAFE_CONTEXT_ID.test(id)) {
      throw new HotelContextError('contextId 格式无效', {
        code: 'INVALID_CONTEXT_ID',
        status: 400,
      })
    }
    const filePath = resolve(this.directory, `${id}.json`)
    let source
    try {
      source = await readFile(filePath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new HotelContextError('没有找到指定的语音上下文', {
          code: 'CONTEXT_NOT_FOUND',
          status: 404,
          cause: error,
        })
      }
      throw new HotelContextError('读取本地语音上下文失败', {
        code: 'CONTEXT_READ_FAILED',
        status: 500,
        cause: error,
      })
    }
    try {
      const payload = JSON.parse(source)
      const promptFile = String(payload.promptFile || '').trim()
      if (promptFile) {
        const promptPath = resolve(this.directory, promptFile)
        const promptRelativePath = relative(this.directory, promptPath)
        if (
          !promptRelativePath
          || promptRelativePath.startsWith('..')
          || resolve(this.directory, promptRelativePath) !== promptPath
        ) {
          throw new HotelContextError('promptFile 必须位于上下文目录内', {
            code: 'INVALID_CONTEXT',
            status: 500,
          })
        }
        payload.prompt = await readFile(promptPath, 'utf8')
        delete payload.promptFile
      }
      return payload
    } catch (error) {
      if (error instanceof HotelContextError) throw error
      throw new HotelContextError('本地语音上下文不是有效 JSON', {
        code: 'INVALID_CONTEXT',
        status: 500,
        cause: error,
      })
    }
  }
}
