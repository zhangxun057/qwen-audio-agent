import assert from 'node:assert/strict'
import test from 'node:test'
import {
  InputTranscriptAssembler,
  mergeInputTranscriptSegments,
  streamingInputTranscript,
} from '../src/voice/input-transcript.mjs'

test('combines the confirmed ASR prefix with its mutable streaming suffix', () => {
  assert.equal(streamingInputTranscript({
    type: 'conversation.item.input_audio_transcription.delta',
    text: '帮我查一下',
    stash: '今天的天气',
  }), '帮我查一下今天的天气')
})

test('supports the alternate Qwen ASR streaming event name', () => {
  assert.equal(streamingInputTranscript({
    type: 'conversation.item.input_audio_transcription.text',
    text: '打开项目',
    stash: '',
  }), '打开项目')
})

test('ignores unrelated realtime events', () => {
  assert.equal(streamingInputTranscript({
    type: 'response.audio_transcript.delta',
    text: '不是用户输入',
  }), '')
})

test('merges separate ASR items from one voice turn instead of overwriting the first', () => {
  const transcripts = new InputTranscriptAssembler()
  assert.equal(transcripts.update({
    turnId: 'voice-1',
    itemId: 'item-a',
    content: '明天早上酒店门口因马拉松封路，',
  }), '明天早上酒店门口因马拉松封路，')
  assert.equal(transcripts.update({
    turnId: 'voice-1',
    itemId: 'item-b',
    content: '10点钟',
  }), '明天早上酒店门口因马拉松封路，10点钟')
})

test('does not duplicate overlapping or repeated ASR segments', () => {
  assert.equal(
    mergeInputTranscriptSegments('酒店门口封路', '封路时间10点'),
    '酒店门口封路时间10点',
  )
  assert.equal(mergeInputTranscriptSegments('10点钟', '10点钟'), '10点钟')
})

test('keeps a longer visible preview when Qwen completes with only its short tail', () => {
  const transcripts = new InputTranscriptAssembler()
  transcripts.update({
    turnId: 'voice-2',
    itemId: 'item-a',
    content: '马拉松封路时间是10点钟',
  })
  assert.equal(transcripts.update({
    turnId: 'voice-2',
    itemId: 'item-a',
    content: '10点钟',
    final: true,
  }), '马拉松封路时间是10点钟')
})
