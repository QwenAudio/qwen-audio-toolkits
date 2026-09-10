import assert from 'node:assert/strict'
import {
  appAgentsWithInstallState,
  isWorkspaceAgent,
  sanitizeInstalledAppAgentIds,
} from '../src/appAgents.ts'
import { modelTaxonomy } from '../src/domain/modelTaxonomy.ts'

const taxonomy = (harnessCapability, inputs, outputs, extensionKind) =>
  modelTaxonomy({
    harnessCapabilities: harnessCapability ? [harnessCapability] : [],
    ...(inputs ? { inputs: inputs.map((type) => ({ type })) } : {}),
    ...(outputs ? { outputs: outputs.map((type) => ({ type })) } : {}),
    ...(extensionKind ? { extensionKind } : {}),
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
assert.deepEqual(taxonomy(null, ['video'], ['video', 'transcript'], 'workspace-agent'), {
  primaryCategory: 'agents',
  secondaryCategory: 'Vision-to-Vision-Text',
  inputModalities: ['Vision'],
  outputModalities: ['Vision', 'Text'],
})

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

const [uninstalledSmartCut] = appAgentsWithInstallState([])
assert.equal(uninstalledSmartCut.id, 'qwenaudio.smart-cut')
assert.equal(uninstalledSmartCut.installed, false)
assert(isWorkspaceAgent(uninstalledSmartCut))
assert.equal(modelTaxonomy(uninstalledSmartCut).primaryCategory, 'agents')
const [installedSmartCut] = appAgentsWithInstallState([
  'qwenaudio.smart-cut',
  'unknown-agent',
])
assert.equal(installedSmartCut.installed, true)
assert.deepEqual(
  sanitizeInstalledAppAgentIds([
    'qwenaudio.smart-cut',
    'qwenaudio.smart-cut',
    'unknown-agent',
    42,
  ]),
  ['qwenaudio.smart-cut'],
)

console.log(
  JSON.stringify({
    primaryCategories: ['Multimodal', 'Vision', 'Text', 'Audio', 'Agents'],
    status: 'passed',
  }),
)
