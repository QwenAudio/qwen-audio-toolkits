import assert from 'node:assert/strict'
import { modelTaxonomy } from '../src/domain/modelTaxonomy.ts'

const taxonomy = (harnessCapability, inputs, outputs) =>
  modelTaxonomy({
    harnessCapabilities: harnessCapability ? [harnessCapability] : [],
    ...(inputs ? { inputs: inputs.map((type) => ({ type })) } : {}),
    ...(outputs ? { outputs: outputs.map((type) => ({ type })) } : {}),
  })

assert.deepEqual(
  taxonomy('audio.enhance'),
  {
    primaryCategory: 'audio',
    secondaryCategory: 'Audio-to-Audio',
    inputModalities: ['Audio'],
    outputModalities: ['Audio'],
  },
)
assert.equal(taxonomy('speech.detect').secondaryCategory, 'Audio-to-Text')
assert.equal(taxonomy('speech.transcribe').secondaryCategory, 'Audio-to-Text')
assert.equal(taxonomy('speech.synthesize').secondaryCategory, 'Text-to-Audio')
assert.equal(taxonomy('text.generate').secondaryCategory, 'Text-to-Text')

assert.deepEqual(taxonomy(null, ['audio', 'text'], ['transcript']), {
  primaryCategory: 'multimodal',
  secondaryCategory: 'Audio-Text-to-Text',
  inputModalities: ['Audio', 'Text'],
  outputModalities: ['Text'],
})
assert.equal(
  taxonomy(null, ['audio', 'text'], ['audio', 'transcript'])
    .secondaryCategory,
  'Audio-Text-to-Audio-Text',
)
assert.deepEqual(taxonomy(null, ['image', 'text'], ['image']), {
  primaryCategory: 'multimodal',
  secondaryCategory: 'Vision-Text-to-Vision',
  inputModalities: ['Vision', 'Text'],
  outputModalities: ['Vision'],
})
assert.equal(
  taxonomy(null, ['vision', 'text'], ['audio']).secondaryCategory,
  'Vision-Text-to-Audio',
)
assert.equal(taxonomy(null, ['image'], ['transcript']).primaryCategory, 'vision')
assert.equal(taxonomy(null, ['text'], ['video']).secondaryCategory, 'Text-to-Vision')
assert.deepEqual(taxonomy(null, ['audio'], ['vision-embedding']), {
  primaryCategory: 'audio',
  secondaryCategory: 'Audio-to-Text',
  inputModalities: ['Audio'],
  outputModalities: ['Text'],
})
assert.equal(
  taxonomy(null, ['image'], ['image-tags']).secondaryCategory,
  'Vision-to-Text',
)

console.log(
  JSON.stringify({
    primaryCategories: ['Multimodal', 'Vision', 'Text', 'Audio'],
    status: 'passed',
  }),
)
