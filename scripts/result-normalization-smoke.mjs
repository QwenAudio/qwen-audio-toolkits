import assert from 'node:assert/strict'
import { normalizeHarnessResult } from '../src/domain/results.ts'

const normalized = normalizeHarnessResult({
  speakerCount: 3,
  segments: [
    { start: 0, end: 1, speaker: 'Speaker 4', speakerIndex: 3 },
    { start: 2, end: 3, speaker: 'Speaker 4', speakerIndex: 3 },
    { start: 4, end: 5, speaker: 'Speaker 9', speakerIndex: 8 },
    { start: 6, end: 7, speaker: 'Speaker 22', speakerIndex: 21 },
    { start: 8, end: 9, speaker: 'Speaker 9', speakerIndex: 8 },
  ],
})

assert.deepEqual(
  normalized.segments.map((segment) => segment.label),
  ['SPK 1', 'SPK 1', 'SPK 2', 'SPK 3', 'SPK 2'],
)
console.log(JSON.stringify({ speakerLabels: normalized.segments.map((item) => item.label) }))
