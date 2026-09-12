import assert from 'node:assert/strict'
import { planPodcastAudio, podcastAudioIsCurrent, resolvePodcastSegments, type PodcastSegmentCache, type PodcastVoiceSettings } from '../src/domain/podcastAudio'
import type { PodcastScript } from '../src/domain/podcast'
import { readPodcastSnapshot } from '../src/domain/podcastSnapshot'

const script: PodcastScript = {
  title: 'A saved episode', language: 'zh-CN',
  turns: [
    { id: 'first', speaker: 'A', text: '为什么要保存草稿？' },
    { id: 'second', speaker: 'B', text: '这样就可以继续编辑。' },
    { id: 'third', speaker: 'A', text: '我们下期再见。' },
  ],
}
const settings: PodcastVoiceSettings = {
  modelId: 'tts', modelVersion: 'v1', providerId: 'local', apiModel: false,
  supportsLanguage: true, voiceA: '0', voiceB: '1', speed: 1,
}
const original = planPodcastAudio(script, settings)
assert.equal(podcastAudioIsCurrent(null, original), false)
assert.equal(podcastAudioIsCurrent(original.fingerprint, null), false)
assert.equal(podcastAudioIsCurrent(original.fingerprint, original), true)

const changedScripts: PodcastScript[] = [
  { ...script, turns: script.turns.map((turn, index) => index === 1 ? { ...turn, text: '这一段改了。' } : turn) },
  { ...script, turns: script.turns.map((turn, index) => index === 1 ? { ...turn, speaker: 'A' } : turn) },
  { ...script, turns: [...script.turns, { id: 'empty', speaker: 'B', text: '' }] },
  { ...script, turns: script.turns.slice(1) },
  { ...script, turns: [...script.turns].reverse() },
  { ...script, language: 'en' },
]
for (const edited of changedScripts) {
  assert.equal(podcastAudioIsCurrent(original.fingerprint, planPodcastAudio(edited, settings)), false)
}
for (const changed of [
  { voiceA: '2' }, { voiceB: '3' }, { speed: 1.2 }, { modelId: 'another' },
  { modelVersion: 'v2' }, { providerId: 'cloud' },
]) {
  assert.equal(podcastAudioIsCurrent(original.fingerprint, planPodcastAudio(script, { ...settings, ...changed })), false)
}
// Restoring exactly the saved content and parameters restores export eligibility.
const restored = JSON.parse(JSON.stringify({ script, settings, fingerprint: original.fingerprint }))
assert.equal(podcastAudioIsCurrent(restored.fingerprint, planPodcastAudio(restored.script, restored.settings)), true)
assert.equal(planPodcastAudio({ ...script, title: 'Renamed episode' }, settings).fingerprint, original.fingerprint)
assert.equal(planPodcastAudio({ ...script, language: 'en' }, { ...settings, supportsLanguage: false }).fingerprint,
  planPodcastAudio(script, { ...settings, supportsLanguage: false }).fingerprint)
assert.equal(planPodcastAudio(script, { ...settings, voiceA: ' 00 ' }).fingerprint, original.fingerprint)

let cache: PodcastSegmentCache = {}
const calls: string[] = []
const progress: number[] = []
await assert.rejects(resolvePodcastSegments(original, cache, async (segment) => {
  calls.push(segment.turnId)
  if (segment.turnId === 'second') throw new Error('provider interrupted')
  return `/audio/${segment.turnId}.wav`
}, (next) => { cache = next }, (completed) => { progress.push(completed) }), /provider interrupted/)
assert.deepEqual(calls, ['first', 'second'])
assert.equal(cache[original.segments[0].key], '/audio/first.wav')
assert.equal(cache[original.segments[1].key], undefined)
assert.deepEqual(progress, [1])

calls.length = 0
const resumed = await resolvePodcastSegments(original, JSON.parse(JSON.stringify(cache)), async (segment) => {
  calls.push(segment.turnId)
  return `/audio/${segment.turnId}.wav`
}, (next) => { cache = next }, () => {})
assert.deepEqual(calls, ['second', 'third'])
assert.deepEqual(resumed.map((segment) => segment.turnId), ['first', 'second', 'third'])
assert.deepEqual(resumed.map((segment) => segment.pauseAfterMs), [320, 320, 0])

calls.length = 0
const editedPlan = planPodcastAudio(changedScripts[0], settings)
await resolvePodcastSegments(editedPlan, cache, async (segment) => {
  calls.push(segment.turnId)
  return `/audio/edited-${segment.turnId}.wav`
}, (next) => { cache = next }, () => {})
assert.deepEqual(calls, ['second'], 'editing one turn should only synthesize that turn')
assert.ok(cache[original.segments[1].key], 'the previous version remains reusable after undo')

const reordered = planPodcastAudio({ ...script, turns: [script.turns[2], script.turns[0], script.turns[1]] }, settings)
const reorderedAudio = await resolvePodcastSegments(reordered, cache, async () => {
  throw new Error('reordering must reuse existing speech')
}, () => {}, () => {})
assert.deepEqual(reorderedAudio.map((segment) => segment.filePath), ['/audio/third.wav', '/audio/first.wav', '/audio/second.wav'])
assert.deepEqual(reorderedAudio.map((segment) => segment.pauseAfterMs), [220, 320, 0], 'pauses must follow the new adjacent speakers')

const withDuplicateAndBlank = planPodcastAudio({ ...script, turns: [
  ...script.turns, { ...script.turns[0], id: 'duplicate' }, { id: 'blank', speaker: 'B', text: ' ' },
] }, settings)
const duplicateAudio = await resolvePodcastSegments(withDuplicateAndBlank, cache, async () => {
  throw new Error('identical speech in a new turn should reuse its audio')
}, () => {}, () => {})
assert.deepEqual(duplicateAudio.map((segment) => segment.turnId), ['first', 'second', 'third', 'duplicate'])
assert.equal(duplicateAudio.at(-1)?.filePath, '/audio/first.wav')
assert.equal(duplicateAudio.at(-1)?.pauseAfterMs, 0)

const savedOutput = {
  filePath: '/audio/mix.wav', fileName: 'mix.wav', duration: 3, sampleRate: 24000,
  channels: 1, sizeBytes: 144044, segmentCount: 3, waveform: [0, 0.5, 0],
  cues: [
    { turnId: 'first', start: 0, end: 1 }, { turnId: 'second', start: 1, end: 2 },
    { turnId: 'third', start: 2, end: 3 },
  ],
}
const snapshot = {
  version: 1, source: { text: 'Saved source', fileName: 'source.txt', characterCount: 12, truncated: false },
  sourcePath: '/source.txt', script, output: savedOutput, outputFingerprint: original.fingerprint,
  voiceA: settings.voiceA, voiceB: settings.voiceB, speed: 1, segmentCache: cache,
}
const decoded = readPodcastSnapshot(snapshot)!
assert.deepEqual(decoded.script, script)
assert.deepEqual(decoded.output, savedOutput)
assert.deepEqual(decoded.segmentCache, cache)
assert.equal(podcastAudioIsCurrent(decoded.outputFingerprint, planPodcastAudio(decoded.script!, settings)), true)
assert.equal(readPodcastSnapshot(null), null)
assert.equal(readPodcastSnapshot([]), null)
assert.equal(readPodcastSnapshot({ version: 999 }), null)

const damaged = readPodcastSnapshot({
  ...snapshot,
  sourcePath: { path: '/source.txt' },
  source: { ...snapshot.source, characterCount: 'broken' },
  script: { title: 'Keep the title', language: null, turns: null },
  output: { ...savedOutput, waveform: { invalid: true } },
  segmentCache: {
    [original.segments[0].key]: '/audio/first.wav',
    [original.segments[1].key]: { path: '/audio/second.wav' },
    [original.segments[2].key]: 'blob:expired',
    invalid: '/audio/invalid.wav',
  },
  speed: NaN, voiceA: { id: '1' }, speakerAName: [], instruction: false,
  length: {}, language: [], stage: 'synthesizing',
})!
assert.ok(damaged, 'a damaged version 1 snapshot still marks the project restored and prevents auto-start')
assert.deepEqual(damaged.script, { title: 'Keep the title', language: 'auto', turns: [] })
assert.equal(damaged.source?.text, 'Saved source')
assert.equal(damaged.source?.characterCount, 'Saved source'.length)
assert.equal(damaged.sourcePath, '')
assert.equal(damaged.output, null)
assert.equal(damaged.outputFingerprint, null)
assert.deepEqual(damaged.segmentCache, { [original.segments[0].key]: '/audio/first.wav' })
assert.equal(damaged.speed, 1)
assert.equal(damaged.voiceA, '')
assert.equal(damaged.instruction, '')
assert.equal('stage' in damaged, false)
assert.doesNotThrow(() => planPodcastAudio(damaged.script!, { ...settings, voiceA: damaged.voiceA, speed: damaged.speed }))

const partialScript = readPodcastSnapshot({ ...snapshot, script: { ...script, turns: [
  null, 'bad row', script.turns[0], { ...script.turns[0], text: 'Keep duplicate row text' },
  { text: 'Keep text with a damaged role', speaker: null }, { id: 'bad-text', speaker: 'B', text: {} },
] } })!
assert.deepEqual(partialScript.script?.turns.map((turn) => turn.text), [script.turns[0].text, 'Keep duplicate row text', 'Keep text with a damaged role'])
assert.equal(new Set(partialScript.script?.turns.map((turn) => turn.id)).size, 3)
assert.equal(podcastAudioIsCurrent(partialScript.outputFingerprint, planPodcastAudio(partialScript.script!, settings)), false)
for (const badOutput of [
  { ...savedOutput, filePath: 'data:audio/wav;base64,broken' },
  { ...savedOutput, duration: Infinity }, { ...savedOutput, sampleRate: 0 },
  { ...savedOutput, cues: null }, { ...savedOutput, cues: [{ turnId: 'first', start: 2, end: 1 }] },
  { ...savedOutput, cues: [{ turnId: 'first', start: 0, end: 99 }] },
]) {
  const recovered = readPodcastSnapshot({ ...snapshot, output: badOutput })!
  assert.equal(recovered.output, null)
  assert.deepEqual(recovered.script, script, 'invalid output metadata must not discard the draft')
}

console.log('Podcast audio versions: export freshness, partial retries, cache/order/pauses, and damaged snapshot recovery passed.')
