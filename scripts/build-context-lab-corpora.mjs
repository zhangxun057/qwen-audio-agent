import { createReadStream, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const outputRoot = resolve(projectRoot, 'server/src/voice/knowledge-contexts')

const enterpriseSession = 'C:/Users/44452/.codex/sessions/2026/08/14/rollout-2026-08-14T09-21-39-019ffddc-45c4-7671-ae27-3497bfdb8d20.jsonl'
const zhuiSession = 'C:/Users/44452/.codex/sessions/2026/08/12/rollout-2026-08-12T10-03-15-019ff3b5-a2e5-7ee0-b0ba-0edb20f55212.jsonl'

const transportBlock = /<(?:environment_context|in-app-browser-context|app-context|skills_instructions|permissions instructions)[^>]*>[\s\S]*?<\/(?:environment_context|in-app-browser-context|app-context|skills_instructions|permissions instructions)>/gi
const credentialLike = /(?:api[_ -]?key|access[_ -]?token|secret|password|密码|密钥|验证码|authorization|bearer\s+|sk-[A-Za-z0-9_-]{10,})/i
const privateTopic = /(?:身份证|手机号|家庭住址|孩子对话|朋友圈|女儿|儿子|照片|人脸|录音原文|微信号)/i
const highEntropy = /\b[A-Za-z0-9_-]{32,}\b/g

function sanitize(text) {
  return String(text || '')
    .replace(transportBlock, '')
    .replace(/C:\\Users\\44452/gi, '<USER_HOME>')
    .replace(/D:\\个人资料/gi, '<LOCAL_PROJECTS>')
    .replace(highEntropy, '<REDACTED_TOKEN>')
    .replace(/\r/g, '')
    .trim()
}

function messageText(payload) {
  if (!Array.isArray(payload?.content)) return ''
  return payload.content
    .map(item => item?.text || '')
    .filter(Boolean)
    .join('\n')
}

async function extractSessionMessages(file, {
  include,
  maxChars = 20_000,
} = {}) {
  const selected = []
  let chars = 0
  const lines = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of lines) {
    if (chars >= maxChars) break
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const payload = event?.payload
    if (
      event?.type !== 'response_item'
      || payload?.type !== 'message'
      || !['user', 'assistant'].includes(payload?.role)
    ) continue
    let text = sanitize(messageText(payload))
    if (!text || credentialLike.test(text) || privateTopic.test(text)) continue
    if (include && !include.test(text)) continue
    text = [...text].slice(0, 2200).join('')
    const record = `\n\n### 会话技术摘录\n角色：${payload.role === 'user' ? '用户' : '助手'}\n${text}`
    if (chars + record.length > maxChars) break
    selected.push(record)
    chars += record.length
  }
  return selected.join('')
}

function safeFileExcerpt(path, maxChars = 9000) {
  const text = sanitize(readFileSync(path, 'utf8'))
  if (credentialLike.test(text)) return ''
  return [...text].slice(0, maxChars).join('')
}

function pythonStructure(path, maxChars = 6000) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const selected = []
  for (const line of lines) {
    if (privateTopic.test(line) || credentialLike.test(line)) continue
    if (
      /^\s*(?:def |class |async def )/.test(line)
      || /^\s*#/.test(line)
      || /^\s*(?:"""|''')/.test(line)
    ) selected.push(sanitize(line))
  }
  return [...selected.join('\n')].slice(0, maxChars).join('')
}

const enterpriseHeader = `# 企业级智能体工作台本地项目知识包

资料快照：2026-08-17。来源为本地 qwen-audio-agent 项目文档与经脱敏的技术会话摘录。

## 核心结论

- 工作台采用语音前台、Gateway 调度层、后台 Agent/工具层的分层结构。
- 全双工模型负责低延迟听说；需要实时资料、企业系统读写或复杂执行时，由 Gateway 路由到知识包或后台 Agent。
- 动态知识实验的基础会话只携带短协议；大型知识包通过单次 response instructions 注入，不预先塞进常驻会话。
- 注册包命中后显示“已命中，正在加载知识库”，真正创建携带资料的回答时才显示“知识库已动态注入”。
- 未注册主题不得进入无限等待，应由模型正常回答或调用后台 Agent。

## 校验题

问题：工作台资料里，全双工语音链路分成哪三层？

标准答案：语音前台、Gateway 调度层、后台 Agent/工具层。回答末尾补充“本题校验标记：工作台-WB-31G”。

## 残留检测

本包私有口令是“蓝桥-WB-47”。除非用户明确询问“刚才工作台资料里的私有口令”，否则不得主动说出。
`

const zhuiHeader = `# 锥AI项目技术知识包

资料快照：2026-08-17。来源为本地锥AI项目的技术脚本结构和经脱敏的 Codex 技术会话；照片、人物姓名、家庭对话、原始音频和凭据均未纳入。

## 核心结论

- 项目围绕长期内容流中的人物一致性、角色聚类、证据链回溯和冲突复核展开。
- 技术流程强调先形成候选聚类，再用时间、文本、图像理解、共现关系和人工反馈做交叉验证。
- 自动合并必须保守：高置信锚点可直接合并，冲突样本进入复核队列，不能用单一脸部相似度覆盖上下文证据。
- 输出不仅要给聚类编号，还要保存来源帖子、证据强度、冲突理由和可回滚映射。

## 校验题

问题：锥AI资料里，人物一致性为什么不能只靠脸部相似度？

标准答案：因为还需要时间、文本、共现关系、图像理解和人工反馈交叉验证，冲突样本必须进入复核队列。回答末尾补充“本题校验标记：锥AI-ZA-42H”。

## 残留检测

本包私有口令是“棱镜-ZAI-64”。除非用户明确询问“刚才锥AI资料里的私有口令”，否则不得主动说出。
`

const enterpriseConversation = await extractSessionMessages(enterpriseSession, {
  include: /(?:全双工|语音|上下文|知识库|RAG|Agent|智能体|Gateway|飞书|工具|动态注入)/i,
})
const enterpriseDocs = [
  'README_ZH.md',
  'docs/architecture.zh.md',
  'docs/voice-frontends/speech-to-speech.zh.md',
].map(path => `\n\n## 本地项目文档摘录：${path}\n${safeFileExcerpt(resolve(projectRoot, path), 7000)}`)
  .join('')

const zhuiConversation = await extractSessionMessages(zhuiSession, {
  include: /(?:流程|算法|模型|聚类|一致性|角色|证据|回归|样本|脚本|架构|验证|冲突)/i,
})
const zhuiScripts = [
  'semantic_aligned_role_mapping.py',
  'person_consistency_validation_loop.py',
  'build_person_graph_v1.py',
  'run_weflow_post_group_analysis.py',
].map(name => {
  const path = resolve('D:/个人资料/锥AI项目/scripts', name)
  return `\n\n## 技术脚本结构：${name}\n${pythonStructure(path)}`
}).join('')

writeFileSync(
  resolve(outputRoot, 'enterprise-workbench-local.md'),
  `${enterpriseHeader}${enterpriseConversation}${enterpriseDocs}\n`,
)
writeFileSync(
  resolve(outputRoot, 'zhui-ai-project-local.md'),
  `${zhuiHeader}${zhuiConversation}${zhuiScripts}\n`,
)

console.log(JSON.stringify({
  enterpriseChars: [...`${enterpriseHeader}${enterpriseConversation}${enterpriseDocs}`].length,
  zhuiChars: [...`${zhuiHeader}${zhuiConversation}${zhuiScripts}`].length,
}, null, 2))
