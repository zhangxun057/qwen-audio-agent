import { readFileSync } from 'node:fs'
import { config } from '../core/config.mjs'

const DEFINITIONS = [
  {
    id: 'international-us-iran-2026-08',
    label: '美伊战争近期局势',
    version: '2026-08-17/AP-snapshot',
    keywords: [
      '战争资料', '战争资讯', '战争信息', '时政资料', '国际资讯', '国际新闻',
      '战争', '谈判结束', '谈判以后', '美联社', '伊朗赔偿',
      '美伊战争', '美伊冲突', '美伊', '美国和伊朗', '美国与伊朗', '美国伊朗',
      '伊美战争', '伊美', '伊朗战争', '美一战争', '霍尔木兹', '国际时政',
    ],
    file: './knowledge-contexts/international-current-affairs.md',
  },
  {
    id: 'taiwu-tianmu-2026-07',
    label: '太吾绘卷：天幕心帷',
    version: '2026-07-24/Steam-official',
    keywords: [
      // “游戏资料”是本轮语音实验的保底口令。其余词覆盖实际测试中
      // Realtime ASR 对两个生僻专名产生的常见近音转写。
      '游戏资料', '周天', '周天运转', '周天筛选', '五行转移', '精益求精',
      '太吾绘卷', '太古绘卷', '泰五绘卷', '泰五汇卷', '太武绘卷',
      '太武汇卷', '太五绘卷', '太五汇卷', '太吾汇卷', '泰武汇卷',
      '天幕心帷', '天幕星帷', '天幕星维', '天目星帷', '天目星维',
      '天目新维', '天幕新维', '天目心维', '天幕新闻', '天目新闻',
      '绘卷', '汇卷', '太吾', '太武', '泰五',
    ],
    file: './knowledge-contexts/taiwu-tianmu.md',
  },
  {
    id: 'semiconductor-memory-2026',
    label: '半导体存储产业：长鑫、三星、海力士、美光',
    version: '2026-08-17/public-snapshot',
    keywords: [
      '存储资料', '半导体存储', '存储芯片', '长鑫', '三星存储',
      '海力士', '美光', 'DRAM', 'HBM', 'NAND', '内存产业',
    ],
    capacityThemes: [
      '区分市场份额、营收增速、产能占比和出货量，不能把不同指标直接互换。',
      'HBM 属于堆叠式 DRAM，其供给同时受晶圆、良率、封装、测试和客户认证约束。',
      '产业分析需要同时观察三星、SK 海力士、美光与长鑫的产品组合和扩产兑现。',
      'AI 需求会通过 HBM 产能配置影响通用 DRAM 的供需，但影响程度需以季度数据验证。',
    ],
    file: './knowledge-contexts/semiconductor-memory-2026.md',
  },
  {
    id: 'enterprise-workbench-local',
    label: '本地项目：企业级智能体工作台',
    version: '2026-08-17/local-sanitized',
    keywords: [
      '工作台资料', '企业工作台', '智能体工作台', '企业级智能体',
      '全双工项目', '语音工作台', '本地工作台',
    ],
    capacityThemes: [
      '语音前台负责低延迟交互，Gateway 负责状态与路由，后台 Agent 和工具负责执行。',
      '动态知识包只有在路由器命中后才进入单次回答，基础会话不预载大型语料。',
      '未注册主题保持模型和 Agent 的正常能力，不能被知识库等待状态劫持。',
      '页面必须区分关键词命中、资料加载和真正创建携带知识的回答三个状态。',
    ],
    file: './knowledge-contexts/enterprise-workbench-local.md',
  },
  {
    id: 'zhui-ai-project-local',
    label: '本地项目：锥AI人物一致性',
    version: '2026-08-17/local-sanitized',
    keywords: [
      '锥AI资料', '追AI资料', '锥爱资料', '追爱资料', '锥AI项目',
      '人物一致性', '人物聚类', '角色聚类', '社会图谱项目',
    ],
    capacityThemes: [
      '人物一致性需要时间、文本、视觉、共现关系和人工反馈交叉验证。',
      '高置信锚点与冲突样本应走不同路径，保守合并优于强行归类。',
      '任何角色映射都应保存来源证据、置信依据、冲突理由和回滚关系。',
      '单一脸部距离不能覆盖上下文证据，尤其不能把弱匹配升级为确定身份。',
    ],
    file: './knowledge-contexts/zhui-ai-project-local.md',
  },
  {
    id: 'world-cup-2026',
    label: '2026 FIFA 世界杯赛况',
    version: '2026-08-17/FIFA-result-snapshot',
    keywords: [
      '世界杯资料', '世界杯', '足球资料', '世界杯决赛',
      '西班牙夺冠', '西班牙阿根廷', '足球世界杯',
    ],
    capacityThemes: [
      '冠军、决赛对手、最终比分、进球者和进球时间是不同字段。',
      '西班牙经过加时赛一比零战胜阿根廷，不能说成常规时间内取胜。',
      '费兰·托雷斯在加时赛第一百零六分钟进球。',
      '本包只保证决赛核心赛果，不覆盖未列出的全部小组赛与个人奖项。',
    ],
    file: './knowledge-contexts/world-cup-2026.md',
  },
]

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s，。！？、,.!?：:；;“”"'（）()《》〈〉·—_-]+/g, '')
}

function charLength(value) {
  return [...String(value || '')].length
}

function takeChars(value, limit) {
  return [...String(value || '')].slice(0, limit).join('')
}

function extractValidationMetadata(source) {
  const text = String(source || '')
  const validationMarkers = [...text.matchAll(/本题校验标记[：:]\s*[“"']?([^”"'。\s]+)/g)]
    .map(match => match[1])
    .filter(Boolean)
  const privateResidualCode = text.match(/本包私有口令是[“"']([^”"']+)[”"']/)?.[1] || null
  return {
    validationMarkers: [...new Set(validationMarkers)],
    privateResidualCode,
  }
}

function removeInternalKnowledgeSections(source) {
  const lines = String(source || '').split(/\r?\n/)
  const output = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/)
    const title = heading?.[2] || ''
    const isValidation = heading && /校验题/.test(title)
    const isResidual = heading && /残留检测|回答边界/.test(title)
    if (!isValidation && !isResidual) {
      output.push(line)
      index += 1
      continue
    }

    // Validation sections contain nested questions, so skip until the next
    // same-level section. Residual/boundary sections are flat in the source
    // files; stop at the next heading so later project excerpts remain facts.
    const level = heading[1].length
    index += 1
    while (index < lines.length) {
      const nextHeading = lines[index].match(/^(#{1,6})\s+(.+?)\s*$/)
      if (nextHeading && (
        (isValidation && nextHeading[1].length <= level)
        || (isResidual && nextHeading)
      )) break
      index += 1
    }
  }
  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function capacityRecord(definition, index) {
  const serial = String(index).padStart(4, '0')
  const themes = Array.isArray(definition.capacityThemes)
    ? definition.capacityThemes
    : []
  const theme = themes.length
    ? themes[(index - 1) % themes.length]
    : `本记录属于“${definition.label}”的容量控制区，不新增核心事实。`
  return [
    '',
    `### ${definition.label}容量占位记录 ${serial}`,
    `检索锚点：${definition.id}-${serial}。`,
    theme,
    '这是一条用于容量测试的背景事实，不新增核心结论。',
  ].join('\n')
}

function expandForCapacityTest(source, definition) {
  const target = Math.min(
    config.keywordKnowledgeTargetChars,
    config.keywordKnowledgeMaxChars,
  )
  let content = String(source || '').trim()
  let index = 1
  while (charLength(content) < target) {
    content += capacityRecord(definition, index++)
  }
  return takeChars(content, target)
}

export const KEYWORD_KNOWLEDGE_CONTEXTS = Object.freeze(DEFINITIONS.map(definition => {
  const source = readFileSync(new URL(definition.file, import.meta.url), 'utf8').trim()
  const metadata = extractValidationMetadata(source)
  const content = expandForCapacityTest(
    removeInternalKnowledgeSections(source),
    definition,
  )
  return Object.freeze({
    id: definition.id,
    label: definition.label,
    version: definition.version,
    keywords: Object.freeze([...definition.keywords]),
    content,
    validationMarkers: Object.freeze(metadata.validationMarkers),
    privateResidualCode: metadata.privateResidualCode,
    chars: charLength(content),
    sourceChars: charLength(source),
  })
}))

export function matchKeywordKnowledgeContext(text = '') {
  const input = normalize(text)
  if (!input) return null
  for (const context of KEYWORD_KNOWLEDGE_CONTEXTS) {
    const keyword = context.keywords.find(candidate => (
      input.includes(normalize(candidate))
    ))
    if (keyword) return { context, keyword }
  }
  return null
}

export function keywordKnowledgeContextSummary() {
  return KEYWORD_KNOWLEDGE_CONTEXTS.map(context => ({
    id: context.id,
    label: context.label,
    version: context.version,
    keywords: [...context.keywords],
    chars: context.chars,
    sourceChars: context.sourceChars,
  }))
}
