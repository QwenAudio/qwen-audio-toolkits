import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { readApiModelCatalog } from './lib/api-model-catalog.mjs'

const sourceUrl =
  process.env.QWEN_AUDIO_MODELSCOPE_CATALOG_URL ??
  'https://www.modelscope.cn/models/funaudio_public/QwenAudio-Toolkits/resolve/master/model-catalog.json'
const outputPath = resolve(process.argv[2] ?? 'dist-catalog/model-catalog.json')
const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30_000) })
if (!response.ok) {
  throw new Error(`ModelScope catalog returned HTTP ${response.status}`)
}
const bytes = Buffer.from(await response.arrayBuffer())
if (bytes.length > 2 * 1024 * 1024) {
  throw new Error('ModelScope catalog exceeds the 2 MB limit')
}
const source = JSON.parse(bytes.toString('utf8'))
if (source.schemaVersion !== 1 || !Array.isArray(source.plugins)) {
  throw new Error('ModelScope catalog has an unsupported envelope')
}
const pluginIds = new Set()
for (const plugin of source.plugins) {
  if (!plugin?.id || pluginIds.has(plugin.id)) {
    throw new Error('ModelScope catalog contains a missing or duplicate plugin id')
  }
  pluginIds.add(plugin.id)
}

const catalog = {
  schemaVersion: 1,
  plugins: source.plugins,
  apiModels: await readApiModelCatalog(),
}
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(catalog, null, 2)}\n`)
console.log(
  `Prepared signed catalog source (${catalog.plugins.length} plugins, ${catalog.apiModels.length} API models).`,
)
