const ITEM_LABELS = Object.freeze({
  'mineral-water': '矿泉水',
  water: '水',
  'power-bank': '充电宝',
  powerbank: '充电宝',
  charger: '充电器',
  'phone-charger': '充电器',
  toothbrush: '牙刷',
  toothpaste: '牙膏',
  shampoo: '洗发水',
  'shower-gel': '沐浴露',
  conditioner: '护发素',
  soap: '香皂',
  slippers: '一次性拖鞋',
  comb: '梳子',
  'cotton-swabs': '棉签',
  'tea-bag': '茶包',
  coffee: '咖啡',
  cigarettes: '香烟',
  'instant-noodles': '方便面',
  'latex-pillow': '乳胶枕',
  pillow: '枕头',
  blanket: '被子',
  umbrella: '雨伞',
  cigarette: '香烟',
})

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function sentenceCore(value) {
  return clean(value).replace(/[。！？!?；;，,：:]+$/u, '')
}

function displayId(value) {
  const raw = clean(value)
  if (!raw) return ''
  return raw.replace(/^[a-z_]+:/iu, '').replace(/(?:房间|房)$/u, '').trim()
}

function displayItem(value) {
  const raw = clean(value)
  if (!raw) return ''
  const withoutPrefix = raw.replace(/^[a-z_]+:/iu, '')
  if (withoutPrefix.startsWith('unresolved:')) return ''
  const key = withoutPrefix.toLocaleLowerCase()
  return ITEM_LABELS[key] || withoutPrefix.replaceAll('-', ' ')
}

function displayLocation(value) {
  const raw = clean(value)
  if (!raw) return ''
  const withoutPrefix = raw.replace(/^location:/iu, '')
  if (withoutPrefix.startsWith('unresolved:')) return ''
  const match = withoutPrefix.match(/^floor-(\d+)(?::([a-z-]+))?$/iu)
  if (!match) return raw
  const areas = {
    'elevator-lobby': '电梯门口',
    corridor: '走廊',
    lobby: '大堂',
    'front-desk': '前台',
    restaurant: '餐厅',
    'meeting-area': '会议区',
    entrance: '门口',
  }
  return `${match[1]}楼${areas[match[2]?.toLocaleLowerCase()] || ''}`
}

function entity(record, type) {
  return (Array.isArray(record?.entities) ? record.entities : [])
    .find(item => item?.type === type)
}

function actionIsObjectEvent(action) {
  return /拾获|报失|丢失|遗失/u.test(clean(action))
}

export function buildRecordVoiceConfirmation(record = {}, prefix = '已记录') {
  const room = displayId(entity(record, 'room')?.id)
  const facts = record?.facts && typeof record.facts === 'object'
    ? record.facts
    : {}
  const location = displayLocation(facts.location || entity(record, 'location')?.id)
  const action = clean(record.action)
  const item = displayItem(
    facts.itemName || facts.item || facts.objectName
      || ((actionIsObjectEvent(record?.action) ? facts.description : '') || '')
      || entity(record, 'item')?.name
      || entity(record, 'item')?.label || entity(record, 'item')?.id,
  )
  const quantityValue = facts.quantity ?? record.quantity
  const quantity = quantityValue === undefined || quantityValue === null || quantityValue === ''
    ? ''
    : `${quantityValue}${clean(facts.unit || record.unit)}`
  const subject = room ? `${room}房` : location
  const content = sentenceCore(record.content || record.summary)
  if (clean(record.category || record.recordType) === '客人' && content) {
    return `${prefix}：${content}。`
  }
  const core = [item ? `${item}${quantity}` : '', content, action]
    .find(value => value)
    || '这条记录'
  if (subject && action && item) return `${prefix}：${subject}，${action}${item}${quantity}。`
  if (subject && action && core) {
    if (content) {
      const remainder = sentenceCore(content.replace(subject, '').replace(/^的/u, ''))
      if (remainder) return `${prefix}：${subject}，${remainder}。`
    }
    return `${prefix}：${subject}，${action}。`
  }
  if (action && item) return `${prefix}：${action}${item}${quantity}。`
  if (subject && core) return `${prefix}：${subject}，${core}。`
  return `${prefix}：${sentenceCore(core)}。`
}

export function projectRecordFact(record = {}, operation = 'created') {
  const facts = record?.facts && typeof record.facts === 'object'
    ? record.facts
    : {}
  const room = displayId(entity(record, 'room')?.id)
  const location = displayLocation(facts.location || entity(record, 'location')?.id)
  const item = displayItem(
    facts.itemName || facts.item || entity(record, 'item')?.name
      || entity(record, 'item')?.label || entity(record, 'item')?.id,
  )
  const quantity = facts.quantity ?? record.quantity
  return {
    recordId: clean(record.recordId),
    summary: buildRecordVoiceConfirmation(record, '').replace(/^：/u, '').replace(/[。]$/u, ''),
    category: clean(record.category || record.recordType),
    action: clean(record.action),
    room,
    location,
    item,
    ...(quantity === undefined || quantity === null ? {} : { quantity }),
    unit: clean(facts.unit || record.unit),
    operation: clean(operation) || 'created',
    occurredAt: clean(record.occurredAt || record.timing?.occurredAt),
  }
}
