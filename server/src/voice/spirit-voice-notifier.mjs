import { createHash, randomUUID } from 'node:crypto'

const DEFAULT_TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
const DEFAULT_PUSH_URL = 'https://msgapi.umeng.com/api/send'
const DEFAULT_RESOURCE_ID = 'seed-tts-2.0'
const DEFAULT_SPEAKER = 'zh_female_vv_uranus_bigtts'
const SECRET_ENV_NAMES = [
  'BYTEDANCE_TTS_API_KEY',
  'AUDIO_UPLOAD_TOKEN',
  'UMENG_APPKEY',
  'UMENG_APP_MASTER_SECRET',
]

function optionalText(value) {
  return String(value || '').trim()
}

function cleanAlias(value) {
  const source = optionalText(value)
  return source.match(/^(\d+)/u)?.[1] || source
}

function responseMessage(value, fallback) {
  if (!value || typeof value !== 'object') return fallback
  return String(value.message || value.msg || value.error || fallback)
}

async function jsonResponse(response, label) {
  const text = await response.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`${label}返回了非 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok) throw new Error(responseMessage(parsed, `${label}失败（HTTP ${response.status}）`))
  return parsed
}

export function decodeByteDanceTtsResponse(raw) {
  const text = new TextDecoder().decode(raw)
  const chunks = []
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue
    const event = JSON.parse(line)
    if (event.data) chunks.push(Buffer.from(event.data, 'base64'))
  }
  if (!chunks.length) throw new Error('TTS 响应没有音频数据')
  return Buffer.concat(chunks)
}

function audioCode(audioUrl) {
  return optionalText(audioUrl).match(/\/([^/?#]+)\.(?:wav|mp3|m4a|caf)(?:[?#].*)?$/iu)?.[1] || ''
}

function expireTime(now = new Date()) {
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  const pad = value => String(value).padStart(2, '0')
  return `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())} ${pad(tomorrow.getHours())}:${pad(tomorrow.getMinutes())}:${pad(tomorrow.getSeconds())}`
}

export class SpiritVoiceNotifier {
  constructor({
    spiritTaskClient,
    ttsApiKey = '',
    ttsUrl = DEFAULT_TTS_URL,
    ttsResourceId = DEFAULT_RESOURCE_ID,
    ttsSpeaker = DEFAULT_SPEAKER,
    uploadUrl = '',
    uploadToken = '',
    appKey = '',
    appMasterSecret = '',
    pushUrl = DEFAULT_PUSH_URL,
    senderName = '全双工语音助手',
    fetchImpl = fetch,
  } = {}) {
    this.spiritTaskClient = spiritTaskClient
    this.ttsApiKey = optionalText(ttsApiKey)
    this.ttsUrl = optionalText(ttsUrl) || DEFAULT_TTS_URL
    this.ttsResourceId = optionalText(ttsResourceId) || DEFAULT_RESOURCE_ID
    this.ttsSpeaker = optionalText(ttsSpeaker) || DEFAULT_SPEAKER
    this.uploadUrl = optionalText(uploadUrl)
    this.uploadToken = optionalText(uploadToken)
    this.appKey = optionalText(appKey)
    this.appMasterSecret = optionalText(appMasterSecret)
    this.pushUrl = optionalText(pushUrl) || DEFAULT_PUSH_URL
    this.senderName = optionalText(senderName) || '全双工语音助手'
    this.fetchImpl = fetchImpl
  }

  get configured() {
    return Boolean(
      this.spiritTaskClient
      && this.ttsApiKey
      && this.uploadUrl
      && this.uploadToken
      && this.appKey
      && this.appMasterSecret
    )
  }

  async generateAudio(text) {
    const response = await this.fetchImpl(this.ttsUrl, {
      method: 'POST',
      headers: {
        'X-Api-Key': this.ttsApiKey,
        'X-Api-Resource-Id': this.ttsResourceId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        req_params: {
          text,
          speaker: this.ttsSpeaker,
          audio_params: {
            format: 'wav',
            sample_rate: 16000,
            loudness_rate: 100,
          },
        },
      }),
    })
    if (!response.ok) throw new Error(`TTS 请求失败（HTTP ${response.status}）`)
    return decodeByteDanceTtsResponse(new Uint8Array(await response.arrayBuffer()))
  }

  async uploadAudio(audio) {
    const form = new FormData()
    const fileName = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.wav`
    form.append('file', new Blob([audio], { type: 'audio/wav' }), fileName)
    const response = await this.fetchImpl(this.uploadUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.uploadToken}` },
      body: form,
    })
    const payload = await jsonResponse(response, '语音上传接口')
    const fileUrl = optionalText(payload?.data?.fileUrl)
    if (!fileUrl) throw new Error('语音上传响应缺少 data.fileUrl')
    return fileUrl
  }

  buildPushPayload({ recipientId, title, text, audioUrl }) {
    const code = audioCode(audioUrl)
    const bodyText = code ? `${text}|${code}` : text
    return {
      appkey: this.appKey,
      timestamp: Date.now(),
      description: '任务语音提醒',
      payload: {
        display_type: 'notification',
        body: {
          ticker: title,
          text: bodyText,
          title,
          after_open: 'go_custom',
          custom: '1',
          play_sound: true,
        },
        extra: {
          audioUrl,
          senderName: this.senderName,
          type: 'walkie_talkie',
        },
      },
      type: 'customizedcast',
      alias_type: 'uid',
      alias: cleanAlias(recipientId),
      umeng_category: 0,
      mipush: true,
      mi_activity: 'com.guilvshuwang.hotelAdmin.view.SplashActivity',
      channel_properties: {
        huawei_channel_importance: 'NORMAL',
        huawei_channel_category: 'WORK',
        xiaomi_channel_id: '148867',
        oppo_category: 'CONTENT',
        oppo_notify_level: '1',
        vivo_category: 'ORDER',
        honor_channel_importance: 'TODO',
      },
      local_properties: {
        category: 'CATEGORY_REMINDER',
        importance: 'IMPORTANCE_DEFAULT',
      },
      channel_fcm: 0,
      policy: {
        expire_time: expireTime(),
        notification_closed_filter: false,
      },
    }
  }

  async sendPush(payload) {
    const postBody = JSON.stringify(payload)
    const sign = createHash('md5')
      .update(`POST${this.pushUrl}${postBody}${this.appMasterSecret}`)
      .digest('hex')
    const response = await this.fetchImpl(`${this.pushUrl}?sign=${sign}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: postBody,
    })
    const result = await jsonResponse(response, '友盟推送接口')
    if (String(result?.ret || '').toUpperCase() !== 'SUCCESS') {
      throw new Error(responseMessage(result, '友盟推送未返回 SUCCESS'))
    }
    return result
  }

  async notify({ recipientId, recipientName = '', title = '任务提醒', text }) {
    if (!this.configured) throw new Error('语音通知接口尚未完整配置')
    const message = optionalText(text)
    if (!recipientId || !message) throw new Error('语音通知缺少接收人或内容')
    const gate = await this.spiritTaskClient.notificationGates(recipientId, undefined, {
      checkOnDuty: false,
    })
    if (!gate.passed) {
      return {
        status: 'skipped_by_gate',
        recipientId,
        recipientName,
        gate,
      }
    }
    const audio = await this.generateAudio(message)
    const audioUrl = await this.uploadAudio(audio)
    const push = await this.sendPush(this.buildPushPayload({
      recipientId,
      title: optionalText(title) || '任务提醒',
      text: message,
      audioUrl,
    }))
    return {
      status: 'sent',
      recipientId,
      recipientName,
      audioUrl,
      messageId: optionalText(push?.data?.msg_id || push?.data?.msgId),
      gate,
    }
  }
}

export function createSpiritVoiceNotifierFromEnvironment({
  spiritTaskClient,
  env = process.env,
} = {}) {
  const notifier = new SpiritVoiceNotifier({
    spiritTaskClient,
    ttsApiKey: env.BYTEDANCE_TTS_API_KEY,
    ttsUrl: env.BYTEDANCE_TTS_URL || DEFAULT_TTS_URL,
    ttsResourceId: env.BYTEDANCE_TTS_RESOURCE_ID || DEFAULT_RESOURCE_ID,
    ttsSpeaker: env.BYTEDANCE_TTS_SPEAKER || DEFAULT_SPEAKER,
    uploadUrl: env.AUDIO_UPLOAD_URL,
    uploadToken: env.AUDIO_UPLOAD_TOKEN,
    appKey: env.UMENG_APPKEY,
    appMasterSecret: env.UMENG_APP_MASTER_SECRET,
    pushUrl: env.UMENG_PUSH_URL || DEFAULT_PUSH_URL,
    senderName: env.SPIRIT_NOTIFICATION_SENDER_NAME,
  })
  for (const name of SECRET_ENV_NAMES) delete env[name]
  return notifier
}
