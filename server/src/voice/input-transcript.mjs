const STREAMING_INPUT_TRANSCRIPT_EVENTS = new Set([
  'conversation.item.input_audio_transcription.delta',
  'conversation.item.input_audio_transcription.text',
])

export function streamingInputTranscript(event) {
  if (!STREAMING_INPUT_TRANSCRIPT_EVENTS.has(event?.type)) return ''
  return `${String(event.text || '')}${String(event.stash || '')}`.trim()
}

function normalized(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim()
}

export function mergeInputTranscriptSegments(previous, next) {
  const left = normalized(previous)
  const right = normalized(next)
  if (!left) return right
  if (!right || left === right) return left
  if (right.startsWith(left) || right.includes(left)) return right
  if (left.endsWith(right) || left.includes(right)) return left

  const overlapLimit = Math.min(left.length, right.length)
  for (let size = overlapLimit; size > 0; size -= 1) {
    if (left.slice(-size) === right.slice(0, size)) {
      return `${left}${right.slice(size)}`
    }
  }
  const separator = /[a-z0-9]$/iu.test(left) && /^[a-z0-9]/iu.test(right)
    ? ' '
    : ''
  return `${left}${separator}${right}`
}

export class InputTranscriptAssembler {
  constructor({ maxTurns = 100, maxItemsPerTurn = 20 } = {}) {
    this.maxTurns = maxTurns
    this.maxItemsPerTurn = maxItemsPerTurn
    this.turns = new Map()
    this.sequence = 0
  }

  update({ turnId, itemId, content, final = false } = {}) {
    const id = String(turnId || '').trim()
    const text = normalized(content)
    if (!id || !text) return ''
    let turn = this.turns.get(id)
    if (!turn) {
      turn = { items: new Map() }
      this.turns.set(id, turn)
      while (this.turns.size > this.maxTurns) {
        this.turns.delete(this.turns.keys().next().value)
      }
    }
    const key = String(itemId || `turn:${id}`)
    const existing = turn.items.get(key)
    const settled = final && existing?.content?.includes(text)
      ? existing.content
      : text
    turn.items.set(key, {
      sequence: existing?.sequence || ++this.sequence,
      content: settled,
      final: final || existing?.final || false,
    })
    while (turn.items.size > this.maxItemsPerTurn) {
      turn.items.delete(turn.items.keys().next().value)
    }
    return [...turn.items.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .reduce((result, item) => mergeInputTranscriptSegments(result, item.content), '')
  }

  discard(turnId) {
    if (turnId) this.turns.delete(String(turnId))
  }
}
