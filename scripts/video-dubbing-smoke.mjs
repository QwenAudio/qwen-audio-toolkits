import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createJsonCache, readJsonIfValid } from './lib/video-dubbing/cache.mjs'
import { isRetryableApiError } from './lib/video-dubbing/harness-client.mjs'
import {
  batchTurns,
  buildTransformationPrompt,
  buildTranslationContextPrompt,
  distributeScriptAcrossTurns,
  formatTranslationContext,
  normalizeDubbingLanguage,
  normalizeDubbingMode,
  normalizeDubbingStyle,
  speechRateGuidance,
  ttsStyleInstruction,
} from './lib/video-dubbing/script-planner.mjs'

const translationPipelineSource = fs.readFileSync(
  path.join(process.cwd(), 'scripts/video-translation-demo.mjs'),
  'utf8',
)
const videoTranslationBackendSource = fs.readFileSync(
  path.join(process.cwd(), 'src-tauri/src/video_translation.rs'),
  'utf8',
)
assert.doesNotMatch(translationPipelineSource, /Library\/Application Support/u)
assert.match(translationPipelineSource, /function readBailianCredentials\(\)/u)
assert.match(translationPipelineSource, /process\.env\.DASHSCOPE_API_KEY/u)
assert.match(translationPipelineSource, /Bailian API key is required/u)
assert.match(videoTranslationBackendSource, /bailian_video_translation_env\(&app\)/u)
assert.match(videoTranslationBackendSource, /command\.envs\(bailian_env/u)
assert.match(videoTranslationBackendSource, /node_preflight/u)

assert.equal(normalizeDubbingMode('rewrite'), 'rewrite')
assert.equal(normalizeDubbingMode('unknown'), 'translate')
assert.match(buildTransformationPrompt('translate'), /简体中文/u)
assert.match(buildTransformationPrompt('rewrite', '更简洁'), /保持原始语言/u)
assert.match(buildTransformationPrompt('rewrite', '更简洁'), /用户要求：更简洁/u)

assert.match(
  buildTransformationPrompt('translate', '', { source: 'en', target: 'ja' }),
  /把英语口播翻译成/u,
)
assert.match(
  buildTransformationPrompt('translate', '', { source: 'en', target: 'ja' }),
  /日语/u,
)
assert.match(buildTranslationContextPrompt('ko'), /韩语/u)
assert.equal(normalizeDubbingLanguage('auto'), 'auto')
assert.equal(normalizeDubbingLanguage('JA'), 'ja')
for (const [code, name, rate] of [
  ['zh', '简体中文', '每秒约 3.5 至 4.5 个汉字'],
  ['en', '英语', '每秒约 2 至 2.5 个单词'],
  ['ja', '日语', '每秒约 5 至 7 个字符'],
  ['ko', '韩语', '每秒约 5 至 7 个字符'],
  ['fr', '法语', '每秒约 2 至 2.5 个单词'],
  ['de', '德语', '每秒约 2 至 2.5 个单词'],
  ['es', '西班牙语', '每秒约 2 至 2.5 个单词'],
]) {
  const prompt = buildTransformationPrompt('translate', '', { source: 'en', target: code })
  assert.equal(normalizeDubbingLanguage(code, 'zh'), code)
  assert.match(prompt, new RegExp(name, 'u'))
  assert.match(prompt, new RegExp(rate, 'u'))
  assert.match(buildTranslationContextPrompt(code), new RegExp(name, 'u'))
  assert.equal(speechRateGuidance(code), rate)
}

assert.equal(formatTranslationContext(null), '')
assert.equal(formatTranslationContext({}), '')

assert.equal(normalizeDubbingStyle('formal'), 'formal')
assert.equal(normalizeDubbingStyle('unknown'), 'natural')
assert.doesNotMatch(buildTransformationPrompt('translate', '', { style: 'natural' }), /风格要求/u)
assert.match(buildTransformationPrompt('translate', '', { style: 'formal' }), /正式/u)
assert.match(buildTransformationPrompt('translate', '', { style: 'casual' }), /口语/u)
assert.match(ttsStyleInstruction('formal', '简体中文'), /播音腔/u)
assert.match(ttsStyleInstruction('casual', 'English'), /聊天/u)
assert.match(ttsStyleInstruction('natural', '简体中文'), /自然、清晰/u)
assert.match(formatTranslationContext({ tone: '轻快' }), /语气风格：轻快/u)
assert.equal(formatTranslationContext({ tone: '轻快' }, { includeTone: false }), '')
const formattedContext = formatTranslationContext({
  summary: '访谈节目',
  tone: '口语化',
  glossary: [
    { source: 'Qwen', target: '通义千问' },
    { source: 'skip-me' },
    ...Array.from({ length: 40 }, (_, index) => ({ source: `term-${index}`, target: `译-${index}` })),
  ],
})
assert.match(formattedContext, /内容梗概：访谈节目/u)
assert.match(formattedContext, /Qwen => 通义千问/u)
assert.doesNotMatch(formattedContext, /skip-me/u)
assert.equal(formattedContext.split('\n').filter((line) => line.startsWith('- ')).length, 30)
assert.equal(isRetryableApiError('connection timed out'), true)
assert.equal(isRetryableApiError('fetch failed'), true)
assert.equal(isRetryableApiError('invalid request'), false)

const sourceTurns = [
  { id: 'turn-1', speaker: 'SPK 1', start: 0, end: 2, text: 'first' },
  { id: 'turn-2', speaker: 'SPK 2', start: 2, end: 6, text: 'second' },
]
const script = '大家好，欢迎来到节目。今天我们讨论音频模型。'
const planned = distributeScriptAcrossTurns(script, sourceTurns)
assert.equal(planned.length, sourceTurns.length)
assert.equal(planned.map((turn) => turn.text).join(''), script)
assert.deepEqual(planned.map(({ id, speaker, start, end }) => ({ id, speaker, start, end })), sourceTurns.map(
  ({ id, speaker, start, end }) => ({ id, speaker, start, end }),
))
assert.throws(() => distributeScriptAcrossTurns('', sourceTurns), /完整配音文案/u)
assert.throws(() => distributeScriptAcrossTurns('短', sourceTurns), /新文案过短/u)

const batches = batchTurns([
  { id: '1', text: 'a' },
  { id: '2', text: 'b' },
  { id: '3', text: 'c' },
  { id: '4', text: 'd' },
])
assert.deepEqual(batches.map((batch) => batch.map((turn) => turn.id)), [['1', '2', '3'], ['4']])

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-video-dubbing-'))
try {
  const cache = createJsonCache(temporaryDirectory)
  cache.saveJson('result.json', { status: 'ok' })
  assert.deepEqual(readJsonIfValid(path.join(temporaryDirectory, 'result.json')), { status: 'ok' })
  fs.writeFileSync(path.join(temporaryDirectory, 'result.json'), '{broken')
  let produced = false
  const recovered = await cache.cachedJson('result.json', async () => {
    produced = true
    return { status: 'recovered' }
  })
  assert.equal(produced, true)
  assert.deepEqual(recovered, { status: 'recovered' })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temporaryDirectory, 'result.json'), 'utf8')), recovered)
  assert.equal(fs.readdirSync(temporaryDirectory).some((name) => name.endsWith('.tmp')), false)
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
}

console.log('video dubbing smoke: ok')
