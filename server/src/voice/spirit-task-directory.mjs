export const SPIRIT_DEMO_CHANNEL = Object.freeze({
  channelType: 'hotel',
  channelCode: '10082',
  roleCode: '2',
})

export const SPIRIT_DEMO_SELF_TEST_ACCOUNT = Object.freeze({
  userId: 'demo-user-hotel-10082',
  userName: '语音助手自测',
})

export const SPIRIT_DEMO_STAFF = Object.freeze([
  Object.freeze({
    name: '曲宇',
    aliases: Object.freeze([]),
    userId: '2080055_hotel_10082',
    directoryDepartment: '品舍民宿',
    rosterDepartment: '客房部',
    role: '房务中心经理',
    shift: '全天班',
    floors: Object.freeze([]),
    allFloors: false,
    floorFallback: false,
  }),
  Object.freeze({
    name: '施展',
    aliases: Object.freeze([]),
    userId: '2079287_hotel_10082',
    directoryDepartment: '品舍民宿',
    rosterDepartment: '客房部',
    role: '房务中心经理助理',
    shift: '8月21日不上班',
    floors: Object.freeze([]),
    allFloors: false,
    floorFallback: false,
  }),
  Object.freeze({
    name: '杨胜美',
    aliases: Object.freeze([]),
    userId: '2079761_hotel_10082',
    directoryDepartment: '前台部',
    rosterDepartment: '客房部',
    role: '房务中心文员',
    shift: '文员班',
    floors: Object.freeze([]),
    allFloors: false,
    floorFallback: false,
  }),
  Object.freeze({
    name: '张洵',
    aliases: Object.freeze([]),
    userId: '2079697_hotel_10082',
    directoryDepartment: '前台部、客房部',
    rosterDepartment: '客房部',
    role: 'RA 楼层服务员',
    shift: 'RA 早班、中班、夜班',
    floors: Object.freeze([]),
    allFloors: true,
    floorFallback: false,
  }),
  Object.freeze({
    name: '黄维维',
    aliases: Object.freeze([]),
    userId: '2078987_hotel_10082',
    directoryDepartment: '前台部',
    rosterDepartment: '客房部',
    role: 'RA 楼层服务员',
    shift: '中班',
    floors: Object.freeze([]),
    allFloors: true,
    floorFallback: true,
  }),
  Object.freeze({
    name: '曲俊宇',
    aliases: Object.freeze([]),
    userId: '2079529_hotel_10082',
    directoryDepartment: '管家部',
    rosterDepartment: '客房部',
    role: 'RA 楼层服务员',
    shift: 'RA 早班',
    floors: Object.freeze([23]),
    allFloors: false,
    floorFallback: false,
  }),
  Object.freeze({
    name: '刘嘉豪',
    aliases: Object.freeze(['刘家豪']),
    userId: '2080056_hotel_10082',
    directoryDepartment: '前台部',
    rosterDepartment: '客房部',
    role: 'RA 楼层服务员',
    shift: 'RA 早班',
    floors: Object.freeze([16]),
    allFloors: false,
    floorFallback: false,
  }),
  Object.freeze({
    name: '章栩媚',
    aliases: Object.freeze([]),
    userId: '2078972_hotel_10082',
    directoryDepartment: '客房部',
    rosterDepartment: '客房部',
    role: 'RA 楼层服务员',
    shift: 'RA 早班',
    floors: Object.freeze([17]),
    allFloors: false,
    floorFallback: false,
  }),
  Object.freeze({
    name: '汪桥',
    aliases: Object.freeze([]),
    userId: '2079652_hotel_10082',
    directoryDepartment: '管家部',
    rosterDepartment: '客房部',
    role: 'RA 楼层服务员',
    shift: 'RA 早班',
    floors: Object.freeze([18]),
    allFloors: false,
    floorFallback: false,
  }),
  Object.freeze({
    name: '吴镓松',
    aliases: Object.freeze([]),
    userId: '2078921_hotel_10082',
    directoryDepartment: '管家部',
    rosterDepartment: '客房部',
    role: 'RA 楼层服务员',
    shift: 'RA 早班',
    floors: Object.freeze([19]),
    allFloors: false,
    floorFallback: false,
  }),
  Object.freeze({
    name: '刘璇',
    aliases: Object.freeze([]),
    userId: '2079435_hotel_10082',
    directoryDepartment: '客房部',
    rosterDepartment: '客房部',
    role: 'RA 楼层服务员',
    shift: 'RA 早班',
    floors: Object.freeze([20]),
    allFloors: false,
    floorFallback: false,
  }),
  Object.freeze({
    name: '郭颖2',
    aliases: Object.freeze(['郭颖二']),
    userId: '2080057_hotel_10082',
    directoryDepartment: '客房部',
    rosterDepartment: '客房部',
    role: 'RA 楼层服务员',
    shift: 'RA 早班',
    floors: Object.freeze([21]),
    allFloors: false,
    floorFallback: false,
  }),
  Object.freeze({
    name: '刘至璇',
    aliases: Object.freeze([]),
    userId: '2078981_hotel_10082',
    directoryDepartment: '品舍民宿',
    rosterDepartment: '客房部',
    role: 'RA 楼层服务员、RA 楼层领班',
    shift: 'RA 早班、夜班',
    floors: Object.freeze([22, 25, 26, 28]),
    allFloors: true,
    floorFallback: false,
  }),
  Object.freeze({
    name: '郭颖',
    aliases: Object.freeze([]),
    userId: '2079442_hotel_10082',
    directoryDepartment: '管家部',
    rosterDepartment: '客房部',
    role: 'RA 楼层服务员',
    shift: 'RA 早班',
    floors: Object.freeze([24]),
    allFloors: false,
    floorFallback: false,
  }),
])

function compactText(value) {
  return String(value || '').replace(/\s+/gu, '').trim()
}

function chineseInteger(value) {
  const source = String(value || '')
  const digits = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  }
  if (source === '十') return 10
  if (source.includes('十')) {
    const [left, right] = source.split('十')
    return (left ? digits[left] : 1) * 10 + (right ? digits[right] : 0)
  }
  if ([...source].every(character => character in digits)) {
    return Number([...source].map(character => digits[character]).join(''))
  }
  return null
}

export function normalizeSpiritTaskSummary(value) {
  let summary = String(value || '').trim()
  if (!summary) throw new Error('任务内容不能为空')
  summary = summary
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/(\d{3,4})\s*号?房间?/gu, '$1房')
    .replace(/([零一二两三四五六七八九十]+)(?=(?:瓶|份|个|条|套|张|盒|件|桶|杯))/gu, match => {
      const converted = chineseInteger(match)
      return converted === null ? match : String(converted)
    })
    .replace(/^(?:麻烦|请|帮忙|请帮忙)/u, '')
    .replace(/(?:要求|需要)(?=送|拿|补|换|检查|维修|处理)/gu, '')
  for (const staff of SPIRIT_DEMO_STAFF) {
    summary = summary.replace(
      new RegExp(`^给${staff.name}(?:派|安排)(?:一个|一项)?任务[：,:， ]*`, 'u'),
      '',
    )
  }
  summary = summary.replace(/\s+/gu, '').replace(/^[，,:：]+|[，,:：]+$/gu, '')
  if (!summary) throw new Error('无法从原话生成任务标题')
  return [...summary].slice(0, 80).join('')
}

function explicitFloor(value) {
  if (value === undefined || value === null || value === '') return null
  const floor = Number.parseInt(String(value), 10)
  return Number.isInteger(floor) ? floor : null
}

export function extractSpiritFloor({ floor, roomNumber, request = '' } = {}) {
  const direct = explicitFloor(floor)
  if (direct !== null) return direct
  const source = compactText(roomNumber)
    || compactText(request).match(/(\d{3,4})(?:号)?房/u)?.[1]
    || ''
  if (!source) {
    const floorMatch = compactText(request).match(/(\d{1,2})楼/u)
    return floorMatch ? Number.parseInt(floorMatch[1], 10) : null
  }
  const dedicatedFloors = SPIRIT_DEMO_STAFF
    .flatMap(staff => staff.floors)
    .sort((left, right) => String(right).length - String(left).length)
  const dedicated = dedicatedFloors.find(candidate => source.startsWith(String(candidate)))
  if (dedicated !== undefined) return dedicated
  if (/^\d{3}$/u.test(source)) return Number.parseInt(source.slice(0, 1), 10)
  if (/^\d{4}$/u.test(source)) {
    const twoDigitFloor = Number.parseInt(source.slice(0, 2), 10)
    return twoDigitFloor >= 10 && twoDigitFloor <= 31
      ? twoDigitFloor
      : Number.parseInt(source.slice(0, 1), 10)
  }
  return null
}

export function resolveSpiritAssignee({
  assigneeName,
  roomNumber,
  floor,
  request = '',
} = {}) {
  const normalizedName = compactText(assigneeName)
  if (normalizedName) {
    const staff = SPIRIT_DEMO_STAFF.find(entry => (
      compactText(entry.name) === normalizedName
      || entry.aliases.some(alias => compactText(alias) === normalizedName)
      || normalizedName.includes(compactText(entry.name))
      || entry.aliases.some(alias => normalizedName.includes(compactText(alias)))
    ))
    if (!staff) {
      throw new Error(`当前 Demo 只支持派给：${SPIRIT_DEMO_STAFF.map(entry => entry.name).join('、')}`)
    }
    return { ...staff, matchedBy: 'name', matchedFloor: null }
  }

  const requestName = SPIRIT_DEMO_STAFF.find(entry => (
    compactText(request).includes(compactText(entry.name))
    || entry.aliases.some(alias => compactText(request).includes(compactText(alias)))
  ))
  if (requestName) return { ...requestName, matchedBy: 'request-name', matchedFloor: null }

  const matchedFloor = extractSpiritFloor({ floor, roomNumber, request })
  if (matchedFloor === null) {
    throw new Error('请明确执行人姓名，或提供可识别楼层的房号')
  }
  const staff = SPIRIT_DEMO_STAFF.find(entry => entry.floors.includes(matchedFloor))
    || SPIRIT_DEMO_STAFF.find(entry => entry.floorFallback)
  if (!staff) throw new Error(`当前 Demo 尚未配置 ${matchedFloor} 楼负责人`)
  return {
    ...staff,
    matchedBy: staff.floorFallback && !staff.floors.includes(matchedFloor)
      ? 'all-floors-fallback'
      : 'floor',
    matchedFloor,
  }
}

export function buildSpiritTaskUsers(assignee, {
  creator,
  channel = SPIRIT_DEMO_CHANNEL,
} = {}) {
  if (!String(creator?.userId || '').trim() || !String(creator?.userName || '').trim()) {
    throw new Error('创建任务需要当前登录用户身份')
  }
  const common = {
    channelType: channel.channelType,
    channelCode: channel.channelCode,
    roleCode: channel.roleCode,
  }
  return [
    {
      ...common,
      userId: creator.userId,
      userName: creator.userName,
      userRole: 'CREATOR',
    },
    {
      ...buildSpiritTaskExecutor(assignee, { channel }),
    },
  ]
}

export function buildSpiritTaskExecutor(assignee, {
  channel = SPIRIT_DEMO_CHANNEL,
} = {}) {
  return {
    channelType: channel.channelType,
    channelCode: channel.channelCode,
    roleCode: channel.roleCode,
    userId: assignee.userId,
    userName: assignee.name,
    userRole: 'EXECUTOR',
  }
}

export function buildSpiritTaskDispatchContext() {
  const staffLines = SPIRIT_DEMO_STAFF.map(staff => (
    `- ${staff.name}${staff.aliases.length ? `（语音转写别名：${staff.aliases.join('、')}）` : ''}：userId=${staff.userId}；实时人员树部门=${staff.directoryDepartment}；8月21日员工卡片岗位=${staff.rosterDepartment}/${staff.role}；班次=${staff.shift}；负责楼层=${staff.allFloors ? `${staff.floors.length ? `${staff.floors.join('、')}，另有全楼层班次覆盖` : '全楼层'}` : staff.floors.join('、') || '无楼层派单'}`
  ))
  return [
    '<spirit_task_dispatch>',
    'Spirit 任务工具由当前语音入口直接调用业务 API，不经过 DSH 或后台 Agent。',
    '当前 Demo 人员与楼层映射。姓名、ID、实时部门来自人员树；岗位、班次和负责楼层来自用户提供的 8 月 21 日员工原子卡片，两者部门字段存在差异，禁止混称为同一实时来源：',
    ...staffLines,
    '派发规则：用户明确说姓名时姓名优先；否则从房号或“X楼”提取楼层。16至24楼按员工卡片中的专属负责人派发；22、25、26、28楼派刘至璇；没有专属负责人的楼层由黄维维作为当前 Demo 兜底。801、8201 都按8楼识别。',
    '回答房号负责人时只报结果，例如“1601房派刘嘉豪”。禁止说“根据员工卡片”“根据映射”“系统显示”；除非用户追问，不解释依据。',
    '创建任务时调用 spirit_task_create：request 忠实保留用户原话；summary 写成简短任务标题，例如“8201房送2瓶水”；不要把姓名、工具名或执行过程塞进标题。',
    '仅当用户明确说“自测且不通知任何人”时，创建工具可传 selfTest=true；此模式强制派给系统测试账号并关闭通知，不能用于普通酒店任务。',
    '普通任务创建成功后，Gateway 必须立即尝试通知执行人；只有明确的无通知自测才关闭通知。工具返回前不得声称创建或通知成功。',
    '用户不需要提供 taskId 或 userId；用户按房号、标题或自然指代查询、修改、开始、完成、记录或删除任务时，由 Gateway 自动定位真实 taskId；只有没有候选或多个候选时才确认。查询“我的任务”使用当前登录身份。',
    '用户说“要求几点完成”或“改到某时完成”时，在创建或任务修改工具中填写 completeTime；不得把要求完成时间写进 description。',
    '</spirit_task_dispatch>',
  ].join('\n')
}
