import assert from 'node:assert/strict'
import { assignMeetingSpeaker, meetingDetailView } from '../src/domain/meetingCommands'
import type { MeetingTurn } from '../src/domain/editorSnapshots'

const turns: MeetingTurn[] = [
  { id: 'turn-a', text: '本周完成方案', start: 0, end: 3, speaker: null },
  { id: 'turn-b', text: '我负责审核', start: 4, end: 6, speaker: 2 },
]
const changed = assignMeetingSpeaker(turns, 'turn-a', 1, 2)
assert.equal(changed[0].speaker, 1)
assert.equal(turns[0].speaker, null, 'speaker correction does not mutate earlier snapshots')
assert.equal(changed[1], turns[1], 'unrelated speaker assignments remain intact')
assert.equal(changed[0].text, turns[0].text)
assert.equal(changed[0].start, turns[0].start)
for (const turnId of ['missing', '', null, 1]) {
  assert.throws(() => assignMeetingSpeaker(turns, turnId, 1, 2))
}
for (const speaker of [0, -1, 3, 1.5, '1', null, NaN, Infinity]) {
  assert.throws(() => assignMeetingSpeaker(turns, 'turn-a', speaker, 2))
}
assert.equal(assignMeetingSpeaker(turns, 'turn-b', 4, 4)[1].speaker, 4)
assert.equal(meetingDetailView('summary'), 'summary')
assert.equal(meetingDetailView('transcript'), 'transcript')
for (const view of ['', 'notes', 'mindmap', null, {}, true]) assert.throws(() => meetingDetailView(view))
console.log('meeting command smoke tests passed')
