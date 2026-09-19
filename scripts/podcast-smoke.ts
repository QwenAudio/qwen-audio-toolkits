import assert from 'node:assert/strict'
import {
  chunkPodcastSource,
  parsePodcastScript,
  podcastScriptPrompt,
  voiceParameters,
} from '../src/domain/podcast'

const paragraphs = Array.from({ length: 8 }, (_, index) =>
  `Section ${index + 1}. ${'Evidence and explanation. '.repeat(12)}`,
).join('\n\n')
const chunked = chunkPodcastSource(paragraphs, 420, 12)
assert.ok(chunked.chunks.length > 1)
assert.equal(chunked.truncated, false)
assert.ok(chunked.chunks.every((chunk) => chunk.length <= 420))

const limited = chunkPodcastSource(paragraphs, 220, 2)
assert.equal(limited.chunks.length, 2)
assert.equal(limited.truncated, true)

const script = parsePodcastScript(`\`\`\`json
{
  "title": "Attention Explained",
  "language": "en",
  "turns": [
    {"speaker": "HOST", "text": "What is the central idea?"},
    {"speaker": "GUEST", "text": "The paper replaces recurrence with attention."}
  ]
}
\`\`\``)
assert.equal(script.turns[0].speaker, 'A')
assert.equal(script.turns[1].speaker, 'B')
assert.match(podcastScriptPrompt('source', 'for beginners', 'brief', 'en'), /for beginners/)
assert.deepEqual(voiceParameters('voice-1', true, 0), { voice: 'voice-1' })
assert.deepEqual(voiceParameters('7', false, 0), { sid: 7 })
assert.deepEqual(voiceParameters('invalid', false, 1), { sid: 1 })
assert.deepEqual(voiceParameters('', true, 0), {})
assert.throws(() => parsePodcastScript('{"turns":[{"speaker":"A","text":"Only one"}]}'))

console.log('AI podcast: chunking, prompt construction, script validation, and voice routing passed.')
