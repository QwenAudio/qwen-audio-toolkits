import assert from 'node:assert/strict'
import { readMeetingSnapshot, readSmartCutSnapshot, readVideoDubbingSnapshot } from '../src/domain/editorSnapshots'

const candidate = {
  id: 'manual-word-1', reason: 'manual', start: 1, end: 1.4,
  label: '手动删除「嗯」', detail: '手动选择', confidence: 'high', selected: true,
}
const smartCut = readSmartCutSnapshot({
  version: 1, stage: 'preview',
  media: { sourcePath: '/media/source.mp4', sourceName: 'source.mp4', audioPath: '/cache/source.wav', duration: 12 },
  transcription: {
    text: '嗯 你好', sourceAudioDataUrl: 'data:audio/wav;base64,NOT_PERSISTED',
    sourceAudioFilePath: '/cache/source.wav', segments: [
      { id: 'segment-1', start: 1, end: 2, text: '嗯 你好', tokens: [
        { text: '嗯', start: 1, end: 1.4 }, { text: '你好', start: 1.4, end: 2 },
      ] },
    ],
  },
  vadResult: { segments: [{ id: 'vad-1', start: 1, end: 2 }], sourceAudioDataUrl: 'data:audio/wav;base64,OMIT' },
  candidates: [candidate], history: [[{ ...candidate, selected: false }]],
  instruction: '保留片头，去掉嗯', minimumSilence: 0.8, edgePadding: 0.2,
  includeSubtitles: false, selectedAsrModelId: 'asr.saved', selectedLlmModelId: '',
  plannerPreferences: { preserveLeadingSilence: true, removeFillers: true },
  currentTime: 4.2, samples: [0.1, 0.5],
  exportedVideoPath: '/exports/final.mp4',
  audioClip: { url: 'blob:gone', file: 'DO_NOT_KEEP' },
})!
assert.equal(smartCut.stage, 'preview')
assert.equal(smartCut.media?.audioPath, '/cache/source.wav')
assert.deepEqual(smartCut.candidates[0], { ...candidate, visualSimilarity: undefined, visualStable: undefined, visualAvailable: undefined })
assert.equal(smartCut.history[0][0].selected, false)
assert.equal(smartCut.transcription?.segments[0].tokens[1].text, '你好')
assert.equal(smartCut.includeSubtitles, false)
assert.equal(smartCut.selectedLlmModelId, '')
assert.equal(smartCut.currentTime, 4.2)
assert.equal(smartCut.plannerPreferences?.preserveLeadingSilence, true)
assert.equal(smartCut.exportedVideoPath, '/exports/final.mp4')
assert.doesNotMatch(JSON.stringify(smartCut), /data:|blob:|NOT_PERSISTED|audioClip/u)
assert.deepEqual(readSmartCutSnapshot(JSON.parse(JSON.stringify(smartCut))), smartCut)

const interruptedCut = readSmartCutSnapshot({ ...smartCut, stage: 'transcribing' })!
assert.equal(interruptedCut.stage, 'review')
assert.equal(interruptedCut.interrupted, true)
assert.equal(interruptedCut.candidates[0].selected, true)
const readyCut = readSmartCutSnapshot({ ...smartCut, stage: 'transcribing', transcription: null })!
assert.equal(readyCut.stage, 'ready')
assert.equal(readyCut.media?.sourcePath, '/media/source.mp4')

const meeting = readMeetingSnapshot({
  version: 1, source: 'system', recording: true, elapsed: 6,
  turns: [{ id: 'turn-1', text: '周五提交方案', start: 2, end: 7, speaker: 3 }],
  summary: '## 行动项\n- 周五提交方案', summaryView: 'mindmap', summaryUpdatedAt: 1234,
  audioChunks: ['data:audio/wav;base64,OMIT'], sessionId: 'not-restorable',
})!
assert.equal(meeting.interrupted, true)
assert.equal(meeting.elapsed, 7)
assert.equal(meeting.turns[0].speaker, 3)
assert.equal(meeting.summaryView, 'mindmap')
assert.equal(meeting.summaryUpdatedAt, 1234)
assert.equal(meeting.source, 'system')
assert.doesNotMatch(JSON.stringify(meeting), /audioChunks|sessionId|recording/u)
assert.deepEqual(readMeetingSnapshot(JSON.parse(JSON.stringify(meeting))), meeting)

const dubbing = readVideoDubbingSnapshot({
  version: 1, taskId: 'old-task', outputDir: '/cache/dubbing',
  progress: { taskId: 'old-task', status: 'running', stage: 'dubbing', progress: 64, completedUnits: 4, totalUnits: 9 },
  turns: [{ id: 'dialogue-1', speaker: 'Alice', start: 1, end: 3, sourceText: 'Hello', text: '你好', rhythmSegments: [
    { id: 'rhythm-1', start: 1, end: 3, sourceText: 'Hello', text: '你好' },
  ] }],
  audioAnalysis: { engine: 'test', musicScore: 0.8, decision: 'separate_and_mix', tags: [{ label: 'Music', probability: 0.8 }] },
})!
assert.equal(dubbing.progress?.status, 'failed')
assert.equal(dubbing.progress?.stage, 'interrupted')
assert.equal(dubbing.progress?.progress, 64)
assert.equal(dubbing.progress?.completedUnits, 4)
assert.equal(dubbing.outputDir, '/cache/dubbing')
assert.equal(dubbing.turns[0].rhythmSegments?.[0].text, '你好')
assert.equal(dubbing.audioAnalysis?.decision, 'separate_and_mix')
assert.equal(dubbing.taskId, 'old-task')
const completed = readVideoDubbingSnapshot({ ...dubbing, progress: {
  ...dubbing.progress, status: 'completed', stage: 'completed', outputVideoPath: '/exports/dub.mp4', subtitlePath: '/exports/dub.srt',
} })!
assert.equal(completed.progress?.status, 'completed')
assert.equal(completed.progress?.outputVideoPath, '/exports/dub.mp4')
assert.equal(completed.progress?.subtitlePath, '/exports/dub.srt')
assert.deepEqual(readVideoDubbingSnapshot(JSON.parse(JSON.stringify(completed))), completed)

for (const value of [null, [], 'corrupt', 42, { version: 2 }]) {
  assert.equal(readSmartCutSnapshot(value), null)
  assert.equal(readMeetingSnapshot(value), null)
  assert.equal(readVideoDubbingSnapshot(value), null)
}
assert.doesNotThrow(() => readSmartCutSnapshot({
  version: 1, media: [], transcription: { text: 'draft', segments: [null, {}, { text: 'hello', tokens: [null] }] },
  candidates: [null, {}, { ...candidate, end: -1 }], history: [null, {}], samples: [null, Infinity, 0.5],
}))
assert.equal(readSmartCutSnapshot({ version: 1, media: { sourcePath: 'blob:expired', duration: 1 } })?.media, null)
assert.equal(readMeetingSnapshot({ version: 1, turns: [null, { text: 'saved', speaker: -3 }] })?.turns[0].speaker, null)
assert.equal(readVideoDubbingSnapshot({ version: 1, progress: { turns: [null], outputVideoPath: 'data:video/mp4;base64,OMIT' } })?.progress?.outputVideoPath, undefined)
console.log('editor snapshot smoke tests passed')
