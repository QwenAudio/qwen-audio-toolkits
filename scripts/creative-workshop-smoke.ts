import assert from 'node:assert/strict'
import { WORKSHOP_TEMPLATES, buildWorkshopInstruction } from '../src/domain/creativeWorkshop'

const options = {
  removeSilence: true,
  removeFillers: true,
  captions: true,
  dubbingMode: 'translate' as const,
  targetLanguage: '英文',
  dubbingStyle: 'natural' as const,
  podcastLength: '5 分钟',
  podcastFormat: '双人解读',
  meetingFocus: '决策、行动项和负责人',
  detail: '',
}

assert.deepEqual(
  WORKSHOP_TEMPLATES.map(template => template.id),
  ['smart-cut', 'captions', 'video-dubbing', 'ai-podcast', 'meeting-notes'],
)
assert.deepEqual(
  new Set(WORKSHOP_TEMPLATES.filter(template => template.category === 'video').map(template => template.id)),
  new Set(['smart-cut', 'captions', 'video-dubbing']),
)
assert.deepEqual(
  new Set(WORKSHOP_TEMPLATES.filter(template => template.category === 'audio').map(template => template.id)),
  new Set(['ai-podcast', 'meeting-notes']),
)

const smartCut = WORKSHOP_TEMPLATES.find(template => template.id === 'smart-cut')!
assert.match(buildWorkshopInstruction(smartCut, options), /删除长静音、删除口水词、生成内嵌字幕/)
assert.match(buildWorkshopInstruction(smartCut, { ...options, removeSilence: false, removeFillers: false, captions: false }), /生成可复核的剪辑建议/)

const dubbing = WORKSHOP_TEMPLATES.find(template => template.id === 'video-dubbing')!
assert.match(buildWorkshopInstruction(dubbing, { ...options, dubbingMode: 'translate', dubbingStyle: 'formal', detail: '保留产品名' }), /翻译为英文配音/)
assert.match(buildWorkshopInstruction(dubbing, { ...options, dubbingMode: 'rewrite' }), /改写配音文案/)
assert.match(buildWorkshopInstruction(dubbing, { ...options, dubbingMode: 'script' }), /使用新的配音文案/)

const podcast = WORKSHOP_TEMPLATES.find(template => template.id === 'ai-podcast')!
assert.match(buildWorkshopInstruction(podcast, options), /约5 分钟的双人解读播客/)
const meeting = WORKSHOP_TEMPLATES.find(template => template.id === 'meeting-notes')!
assert.match(buildWorkshopInstruction(meeting, { ...options, detail: '标记阻塞项' }), /重点关注决策、行动项和负责人/)
assert.match(buildWorkshopInstruction(meeting, { ...options, detail: '标记阻塞项' }), /补充要求：标记阻塞项/)

console.log('Creative workshop: categories and fixed workflow instructions passed.')
