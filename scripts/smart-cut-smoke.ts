import assert from 'node:assert/strict'
import {
  activeSmartCutWordId,
  buildSmartCutCandidates,
  buildSmartCutSubtitleCues,
  buildSmartCutTextSegments,
  hasUsableSmartCutTimeline,
  manualWordCandidate,
  modelSupportsSmartCutTimeline,
  normalizeSmartCutTranscription,
  smartCutWords,
} from '../src/domain/smartCut'
import type { AsrTranscriptionResult } from '../src/types'

const transcription: AsrTranscriptionResult = {
  clipName: 'smoke.wav',
  text: 'I I Democratic. Um ready.',
  language: 'en',
  duration: 3,
  speechSeconds: 2.5,
  inferenceSeconds: 0.1,
  realTimeFactor: 0.04,
  engine: 'smoke',
  segments: [{
    id: 'segment-1',
    start: 0,
    end: 3,
    text: 'I I Democratic. Um ready.',
    tokens: [
      { text: ' I', start: 0.1, end: 0.2 },
      { text: ' I', start: 0.3, end: 0.4 },
      { text: ' D', start: 0.6, end: 0.7 },
      { text: 'em', start: 0.7, end: 0.8 },
      { text: 'ocratic', start: 0.8, end: 1.2 },
      { text: '.', start: 1.2, end: 1.25 },
      { text: ' Um', start: 1.5, end: 1.75 },
      { text: ' ready', start: 2, end: 2.4 },
      { text: '.', start: 2.4, end: 2.45 },
    ],
  }],
}

const candidates = buildSmartCutCandidates(transcription, null, 3)
const labels = candidates.map((candidate) => candidate.label)
assert(labels.includes('重复词「I」'))
assert(labels.includes('口水词「Um」'))
assert(!labels.includes('口水词「em」'), 'must not cut a subword inside Democratic')

const words = smartCutWords(transcription)
assert(words.some((word) => word.text === 'Democratic.'))
assert(!words.some((word) => word.text === 'em'))
const ready = words.find((word) => word.text === 'ready.')
assert(ready)
const manualCandidate = manualWordCandidate(ready)
assert.equal(manualCandidate.reason, 'manual')
assert.equal(manualCandidate.selected, true)

const textSegments = buildSmartCutTextSegments(transcription, null)
assert(textSegments.length >= 2, 'punctuation should split a single ASR segment')
assert(textSegments.every((segment) => segment.end > segment.start))

const closeVadSegments = buildSmartCutTextSegments({
  ...transcription,
  text: 'hello world',
  segments: [{
    id: 'close-vad',
    start: 0,
    end: 1.5,
    text: 'hello world',
    tokens: [
      { text: ' hello', start: 0.1, end: 0.6 },
      { text: ' world', start: 0.75, end: 1.3 },
    ],
  }],
}, {
  clipName: 'smoke.wav',
  duration: 1.5,
  speechSeconds: 1.05,
  silenceSeconds: 0.45,
  waveform: [],
  segments: [
    { id: 'vad-1', start: 0.1, end: 0.6, duration: 0.5 },
    { id: 'vad-2', start: 0.75, end: 1.3, duration: 0.55 },
  ],
  inferenceSeconds: 0.01,
  realTimeFactor: 0.01,
  threshold: 0.25,
  engine: 'smoke-vad',
})
assert.equal(closeVadSegments.length, 1, 'a short VAD boundary must not fragment a sentence')

const longUnpunctuatedSentence = buildSmartCutTextSegments({
  ...transcription,
  duration: 12,
  text: 'this is one long sentence that must stay together without terminal punctuation',
  segments: [{
    id: 'long-sentence',
    start: 0,
    end: 12,
    text: 'this is one long sentence that must stay together without terminal punctuation',
    tokens: Array.from({ length: 24 }, (_, index) => ({
      text: ` word${index + 1}`,
      start: index * 0.5,
      end: index * 0.5 + 0.4,
    })),
  }],
}, null)
assert.equal(
  longUnpunctuatedSentence.length,
  1,
  'duration and word-count limits must not split a sentence in the middle',
)

const cues = buildSmartCutSubtitleCues(transcription, candidates, 3)
assert(cues.length > 0)
assert(cues.every((cue) => cue.end > cue.start))
assert(cues.every((cue, index) => index === 0 || cue.start >= cues[index - 1].end))
assert(!cues.some((cue) => /\bUm\b/u.test(cue.text)))
assert(cues.some((cue) => cue.text.includes('Democratic')))

assert.equal(activeSmartCutWordId([
  { id: 'dont', segmentId: 'overlap', text: "don't", start: 1, end: 2.1 },
  { id: 'know', segmentId: 'overlap', text: 'know', start: 2, end: 2.8 },
], 2), 'know', 'overlapping timestamps must highlight only the latest word')

const edgeSilences = buildSmartCutCandidates({
  ...transcription,
  duration: 4,
  speechSeconds: 1,
  segments: [{
    id: 'middle',
    start: 1,
    end: 2,
    text: 'hello',
    tokens: [{ text: ' hello', start: 1, end: 2 }],
  }],
}, null, 4, { minimumSilence: 0.5, edgePadding: 0.1 })
assert.equal(edgeSilences[0].label, '片头静音')
assert.equal(edgeSilences.at(-1)?.label, '片尾静音')
assert.equal(edgeSilences.filter((candidate) => candidate.reason === 'silence').length, 2)

assert(modelSupportsSmartCutTimeline({
  capabilities: ['ASR', '词级时间戳'],
} as never))
assert(!modelSupportsSmartCutTimeline({
  capabilities: ['ASR', '多语言'],
} as never))

const apiMilliseconds = normalizeSmartCutTranscription({
  ...transcription,
  duration: 3000,
  segments: [{
    id: 'api-1',
    start: 100,
    end: 2500,
    text: '你好世界',
    tokens: [
      { text: '你好', start: 100, end: 900 },
      { text: '世界', start: 1200, end: 2500 },
    ],
  }],
}, 3)
assert.equal(apiMilliseconds.duration, 3)
assert.equal(apiMilliseconds.segments[0].start, 0.1)
assert.equal(apiMilliseconds.segments[0].tokens[1].end, 2.5)
assert(hasUsableSmartCutTimeline(apiMilliseconds))

const bailianShape = normalizeSmartCutTranscription({
  ...transcription,
  segments: [{
    id: 'api-2',
    begin_time: 250,
    end_time: 1750,
    text: 'test',
    words: [{ text: 'test', begin_time: 250, end_time: 1750 }],
  } as never],
}, 3)
assert.equal(bailianShape.segments[0].start, 0.25)
assert.equal(bailianShape.segments[0].tokens[0].end, 1.75)

const timecodeShape = normalizeSmartCutTranscription({
  ...transcription,
  segments: [{
    id: 'api-3',
    start: '00:00:01.250',
    end: '00:00:02.500',
    text: 'timecode',
    tokens: [{ text: 'timecode', start: '00:00:01.250', end: '00:00:02.500' }],
  } as never],
}, 3)
assert.equal(timecodeShape.segments[0].start, 1.25)
assert.equal(timecodeShape.segments[0].end, 2.5)

console.log('Smart cut smoke tests passed')
