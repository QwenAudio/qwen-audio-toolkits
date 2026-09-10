import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

// Use isolated storage: no app preferences or model data are touched.
const values = new Map()
const events = new Map()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
} })
globalThis.window = { addEventListener: (name, callback) => events.set(name, callback) }
globalThis.document = { documentElement: { lang: '' } }
const { getLocale, setLocale, t, translate, subscribeLocale, LANGUAGE_STORAGE_KEY } = await import('../src/i18n/index.ts')
const { capabilityDefinition, QWEN_ASR_LANGUAGE_OPTIONS } = await import('../src/domain/capabilities.ts')
const { cloudVoiceOptions } = await import('../src/domain/voices.ts')
const { initialPlugins } = await import('../src/data.ts')
const { appAgentsWithInstallState } = await import('../src/appAgents.ts')
const { localizeVideoEditorMessage } = await import('../src/services/videoEditor.ts')
const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'))
assert.equal(getLocale(), 'zh-CN', 'First launch defaults to Chinese regardless of system language')
assert.equal(document.documentElement.lang, 'zh-CN')
assert.equal(t('设置'), '设置')
const definition = capabilityDefinition('text.generate')
const parameters = JSON.stringify(definition.defaultParameters)
const voices = cloudVoiceOptions({ version: 'cosyvoice-v2' })
const modelNames = initialPlugins.map(model => model.name)
const languageIds = QWEN_ASR_LANGUAGE_OPTIONS.map(([value]) => value)
let notifications = 0
const unsubscribe = subscribeLocale(() => notifications++)
setLocale('en')
assert.equal(getLocale(), 'en')
assert.equal(values.get(LANGUAGE_STORAGE_KEY), 'en')
assert.equal(document.documentElement.lang, 'en')
assert.equal(t('设置'), 'Settings')
assert.equal(t('版本 {0} 已可用', ['1.2.3']), 'Version 1.2.3 is available')
assert.equal(t('文件'), 'Files')
assert.equal(definition.label, 'Text generation', 'Previously loaded metadata updates without module reload')
assert.equal(definition.category, '文本智能', 'Grouping identity must remain stable')
assert.equal(JSON.stringify(definition.defaultParameters), parameters, 'Language must not change model prompts or parameters')
assert.deepEqual(QWEN_ASR_LANGUAGE_OPTIONS.map(([value]) => value), languageIds)
assert.deepEqual(initialPlugins.map(model => model.name), modelNames, 'Full model names stay intact')
assert.equal(voices[0].id, 'longxiaochun_v2')
assert.equal(voices[0].name, '龙小淳', 'Voice names are identities, not UI translations')
assert.match(voices[0].description, /Chinese & English/)
assert.equal(t('Audio-to-Text'), 'Audio-to-Text')
assert.equal(t('Text-to-Audio'), 'Text-to-Audio')
for (const agent of appAgentsWithInstallState([])) {
  const metadata = [
    agent.name,
    agent.description,
    agent.size,
    ...agent.capabilities,
    agent.agent.task,
    ...agent.agent.usage.inputRequirements,
    ...agent.agent.usage.examples,
    ...agent.agent.usage.limitations,
    ...agent.inputs.map(port => port.label),
    ...agent.outputs.map(port => port.label),
  ]
  for (const source of metadata) {
    assert.notEqual(translate(source, [], 'en'), source, `Missing ${agent.name} translation: ${source}`)
  }
}
assert.equal(localizeVideoEditorMessage('视频导出失败: encoder unavailable'), 'Video export failed: encoder unavailable')
assert.equal(localizeVideoEditorMessage('视频中没有音轨，无法进行口播剪辑'), 'The video has no audio track and cannot be edited as a talking-head video')
assert.equal(t('Unknown message'), 'Unknown message', 'Unknown messages have a safe fallback')
assert.equal(t('版本 {0} 已可用', ['<script>{1}</script>']), 'Version <script>{1}</script> is available', 'Interpolation is single-pass plain text')
setLocale('en')
assert.equal(notifications, 1, 'Repeated selection does not trigger updates')
values.set(LANGUAGE_STORAGE_KEY, 'zh-CN')
events.get('storage')({ key: LANGUAGE_STORAGE_KEY })
assert.equal(getLocale(), 'zh-CN', 'Other windows receive language changes')
assert.equal(definition.label, '文本生成')
values.set(LANGUAGE_STORAGE_KEY, 'invalid')
events.get('storage')({ key: LANGUAGE_STORAGE_KEY })
assert.equal(getLocale(), 'zh-CN', 'Invalid persisted values fall back to Chinese')
values.set(LANGUAGE_STORAGE_KEY, 'en')
events.get('storage')({ key: null })
assert.equal(getLocale(), 'en')
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage disabled') } })
assert.doesNotThrow(() => setLocale('zh-CN'))
assert.equal(getLocale(), 'zh-CN', 'Switching still works when persistence is unavailable')
unsubscribe()

const placeholders = value => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort()
for (const [source, english] of Object.entries(en)) {
  assert.ok(english.trim(), `Empty translation: ${source}`)
  assert.deepEqual(placeholders(english), placeholders(source), `Interpolation mismatch: ${source}`)
  assert.equal(translate(source, [], 'zh-CN'), source)
}
let calls = 0
function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) { scan(path); continue }
    if (!/\.tsx?$/.test(path)) continue
    const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(file) === 't' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        assert.ok(Object.hasOwn(en, node.arguments[0].text), `Missing translation in ${path}: ${node.arguments[0].text}`)
        calls++
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
}
scan(new URL('../src', import.meta.url).pathname)
console.log(`i18n: ${Object.keys(en).length} translations, ${calls} call sites, Chinese default, live switching, persistence, window sync, and stable model inputs passed.`)

const noteDirectory = new URL('../src/content/model-notes/', import.meta.url)
const noteFiles = readdirSync(noteDirectory).filter(name => name.endsWith('.md') && name !== 'README.md')
for (const name of noteFiles) {
  const source = readFileSync(new URL(name, noteDirectory), 'utf8')
  const english = readFileSync(new URL(`en/${name}`, noteDirectory), 'utf8')
  assert.match(english, /## Overview/, `Missing English note: ${name}`)
  assert.equal(english.match(/^## /gm)?.length, source.match(/^## /gm)?.length, `Missing note sections: ${name}`)
  assert.equal(english.match(/^- /gm)?.length, source.match(/^- /gm)?.length, `Missing note content: ${name}`)
}
console.log(`i18n: all ${noteFiles.length} bundled model notes have English versions.`)
