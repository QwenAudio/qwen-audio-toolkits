import assert from 'node:assert/strict'
import { ensureSmartCutContentRemaining, manualRangeCandidate, SMART_CUT_ACTIONS, validateSmartCutCommand } from '../src/domain/smartCutCommands'
import type { SmartCutCandidate } from '../src/domain/smartCut'

const candidates: SmartCutCandidate[] = [
  { id: 'silence-1', start: 1, end: 2, reason: 'silence', label: 'Pause', detail: '', confidence: 'high', selected: false },
  { id: 'filler-1', start: 4, end: 4.4, reason: 'filler', label: 'Um', detail: '', confidence: 'medium', selected: true },
]
const context = { candidates, duration: 10, asrModelIds: ['asr-ready'], llmModelIds: ['llm-ready'] }
const accept = (action: string, args: Record<string, unknown>) => validateSmartCutCommand({ action, args }, context)
const reject = (action: string, args: Record<string, unknown>) => assert.throws(() => accept(action, args))

assert.deepEqual(accept('cut.configure', { minimumSilence: 0.3, edgePadding: 0.35, includeSubtitles: false }), {
  action: 'cut.configure', args: { minimumSilence: 0.3, edgePadding: 0.35, includeSubtitles: false },
})
assert.deepEqual(accept('cut.configure', { asrModelId: 'asr-ready', llmModelId: '' }).args, { asrModelId: 'asr-ready', llmModelId: '' })
for (const args of [
  {}, { instruction: '' }, { instruction: '   ' }, { instruction: 'a'.repeat(2001) },
  { minimumSilence: 0.29 }, { minimumSilence: 2.01 }, { minimumSilence: Number.NaN }, { minimumSilence: '0.8' },
  { edgePadding: 0.03 }, { edgePadding: 0.36 }, { includeSubtitles: 'false' },
  { asrModelId: 'not-installed' }, { llmModelId: 'not-installed' }, { volume: 1 }, { includeSubtitles: undefined },
]) reject('cut.configure', args)

assert.deepEqual(accept('cut.select', { ids: ['silence-1', 'filler-1'], selected: false }).args, {
  ids: ['silence-1', 'filler-1'], selected: false,
})
for (const args of [
  { ids: [], selected: true }, { ids: ['silence-1', 'silence-1'], selected: true },
  { ids: ['obsolete-id'], selected: true }, { ids: ['silence-1'], selected: 'yes' },
  { ids: [1], selected: true }, { ids: ['silence-1'], selected: false, all: true },
]) reject('cut.select', args)
assert.equal(candidates[0].selected, false, 'Validation must not mutate the project before every argument has been checked')

assert.deepEqual(accept('cut.remove-range', { start: 0, end: 2 }).args, { start: 0, end: 2 })
assert.deepEqual(accept('cut.remove-range', { start: 8, end: 10 }).args, { start: 8, end: 10 })
for (const args of [
  { start: -1, end: 1 }, { start: 9, end: 11 }, { start: 2, end: 2 }, { start: 3, end: 2 },
  { start: 0, end: Number.POSITIVE_INFINITY }, { start: '0', end: 2 }, { start: 0, end: 2, path: '/tmp/elsewhere' },
]) reject('cut.remove-range', args)
assert.throws(() => validateSmartCutCommand({ action: 'cut.remove-range', args: { start: 0, end: 2 } }, { ...context, duration: null }))

for (const action of ['cut.undo', 'cut.analyze', 'cut.preview', 'cut.export']) {
  assert.deepEqual(accept(action, {}).args, {})
  reject(action, { destination: '/tmp/unapproved.mp4' })
}
reject('cut.delete-source-file', {})
assert.throws(() => accept('cut.configure', null as unknown as Record<string, unknown>))
assert.throws(() => accept('cut.configure', [] as unknown as Record<string, unknown>))

const range = manualRangeCandidate(1.25, 2.5)
assert.equal(range.reason, 'manual')
assert.equal(range.selected, true)
assert.equal(range.start, 1.25)
assert.equal(range.end, 2.5)
assert.notEqual(range.id, manualRangeCandidate(1.25, 2.5).id, 'Each reversible range edit needs its own candidate identity')
assert.doesNotThrow(() => ensureSmartCutContentRemaining(candidates, 10))
assert.throws(() => ensureSmartCutContentRemaining([manualRangeCandidate(0, 10)], 10), 'Do not permit deletion of the entire source')
assert.throws(() => ensureSmartCutContentRemaining([manualRangeCandidate(0, 6), manualRangeCandidate(4, 10)], 10), 'Overlapping removals must be checked together, not only interval by interval')
assert.doesNotThrow(() => ensureSmartCutContentRemaining([manualRangeCandidate(0, 6), { ...manualRangeCandidate(4, 10), selected: false }], 10), 'Unselected intervals remain in the output')
const shortcuts = SMART_CUT_ACTIONS.flatMap((definition) => (definition.quickCommands ?? []).map((quick) => ({ action: definition.name, ...quick })))
assert.deepEqual(shortcuts.find(({ text }) => text === '关闭字幕')?.args, { includeSubtitles: false })
assert.equal(shortcuts.some(({ text }) => text === '请告诉我关闭字幕的影响'), false, 'Questions must not become local edit commands')
for (const shortcut of shortcuts) assert.doesNotThrow(() => accept(shortcut.action, shortcut.args))

console.log('Smart-cut commands: strict arguments, ready models, stale candidates, safe ranges, and exact shortcuts passed.')
