import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Use isolated storage: no app preferences or model data are touched.
const values = new Map()
const events = new Map()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  },
})
globalThis.window = {
  addEventListener: (name, callback) => events.set(name, callback),
}
globalThis.document = { documentElement: { lang: '' } }

const {
  getLocale,
  setLocale,
  t,
  translate,
  subscribeLocale,
  LANGUAGE_STORAGE_KEY,
} = await import('../src/i18n/index.ts')
const en = JSON.parse(
  readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'),
)

assert.equal(getLocale(), 'zh-CN', 'Boss first launch remains Chinese')
assert.equal(document.documentElement.lang, 'zh-CN')
assert.equal(t('模型商店'), '模型商店')

let notifications = 0
const unsubscribe = subscribeLocale(() => notifications++)
setLocale('en')
assert.equal(getLocale(), 'en')
assert.equal(values.get(LANGUAGE_STORAGE_KEY), 'en')
assert.equal(document.documentElement.lang, 'en')
assert.equal(t('模型商店'), 'Model Store')
assert.equal(t('设置'), 'Settings')
assert.equal(t('版本 {0} 已可用', ['1.2.3']), 'Version 1.2.3 is available')
assert.equal(t('Unknown message'), 'Unknown message', 'Unknown text falls back safely')
assert.equal(
  t('版本 {0} 已可用', ['<script>{1}</script>']),
  'Version <script>{1}</script> is available',
  'Interpolation is single-pass plain text',
)
setLocale('en')
assert.equal(notifications, 1, 'Repeated selection does not notify listeners')
values.set(LANGUAGE_STORAGE_KEY, 'zh-CN')
events.get('storage')({ key: LANGUAGE_STORAGE_KEY })
assert.equal(getLocale(), 'zh-CN', 'Storage changes synchronize locale')
values.set(LANGUAGE_STORAGE_KEY, 'invalid')
events.get('storage')({ key: LANGUAGE_STORAGE_KEY })
assert.equal(getLocale(), 'zh-CN', 'Invalid locale falls back to Chinese')
values.set(LANGUAGE_STORAGE_KEY, 'en')
events.get('storage')({ key: null })
assert.equal(getLocale(), 'en')
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  get() {
    throw new Error('Storage disabled')
  },
})
assert.doesNotThrow(() => setLocale('zh-CN'))
assert.equal(getLocale(), 'zh-CN', 'Locale still changes without persistence')
unsubscribe()

const placeholders = (value) =>
  [...value.matchAll(/\{\d+\}/g)].map((match) => match[0]).sort()
for (const [source, english] of Object.entries(en)) {
  assert.ok(english.trim(), `Empty translation: ${source}`)
  assert.deepEqual(
    placeholders(english),
    placeholders(source),
    `Interpolation mismatch: ${source}`,
  )
  assert.equal(translate(source, [], 'zh-CN'), source)
}

const storeSource = readFileSync(
  new URL('../src/views/ExtensionModelStoreView.tsx', import.meta.url),
  'utf8',
)
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const workbenchSource = readFileSync(
  new URL('../src/views/ExtensionWorkbenchView.tsx', import.meta.url),
  'utf8',
)
for (const source of [
  '扩展工作台',
  '启用后可从程序坞访问扩展工具',
  '返回工作区',
  '扩展工作台页面',
  '模型',
  '智能剪辑',
  '播客',
  '会议纪要',
  '视频配音',
  '扩展功能将在后续版本提供。',
]) {
  assert.ok(
    Object.hasOwn(en, source),
    `Missing extension-workbench English translation: ${source}`,
  )
}
assert.match(appSource, /t\('扩展工作台'\)/u)
assert.match(appSource, /t\('启用后可从程序坞访问扩展工具'\)/u)
assert.match(
  appSource,
  /t\(extensionWorkbenchPageLabels\[extensionWorkbenchPage\]\)/u,
)
assert.match(workbenchSource, /t\('扩展工作台'\)/u)
assert.match(storeSource, /t\('扩展工作台'\)/u)
assert.match(workbenchSource, /t\('返回工作区'\)/u)
assert.match(workbenchSource, /t\('扩展工作台页面'\)/u)
assert.match(
  workbenchSource,
  /t\(extensionWorkbenchPageLabels\[pageId\]\)/u,
)
assert.match(appSource, /setLocale/u)
assert.match(appSource, /useLocale/u)
assert.match(appSource, /strong>界面语言<\/strong>/u)
assert.match(appSource, /\['zh-CN', '简体中文'\]/u)
assert.match(appSource, /\['en', 'English'\]/u)
assert.match(appSource, /onClick=\{\(\) => setLocale\(value\)\}/u)
assert.ok(
  Object.hasOwn(en, '{0} 尚未配置；请完成账号配置后返回当前模型商店。'),
  'Missing provider-configuration notification English translation',
)
assert.match(
  appSource,
  /notify\(\s*t\('\{0\} 尚未配置；请完成账号配置后返回当前模型商店。',\s*\[providerName\],?\s*\)\s*\)/u,
)
assert.match(
  storeSource,
  /selectedApiModel \? t\('服务商'\) : t\('运行环境'\)/u,
)
for (const match of storeSource.matchAll(/\bt\((['"])(.*?)\1/g)) {
  assert.ok(
    Object.hasOwn(en, match[2]),
    `Missing model-store translation: ${match[2]}`,
  )
}

console.log(
  `i18n: ${Object.keys(en).length} translations, Chinese default, live switching, persistence, and model-store coverage passed.`,
)
