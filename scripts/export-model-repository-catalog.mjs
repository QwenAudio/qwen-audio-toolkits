import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const repository = process.argv[2]
if (!repository) {
  console.error('Usage: npm run catalog:repository -- /path/to/QwenAudio-Toolkits')
  process.exit(1)
}

const root = resolve(repository)
const modelsRoot = resolve(root, 'models')
const entries = await readdir(modelsRoot, { withFileTypes: true })
const plugins = []

for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
  if (!entry.isDirectory()) continue
  const manifestPath = resolve(modelsRoot, entry.name, 'plugin.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.id !== entry.name) {
    throw new Error(`${manifestPath}: id must match its model directory`)
  }
  plugins.push({
    ...manifest,
    models: (manifest.models ?? []).map((model) => {
      const repositoryHosted =
        Boolean(model.source?.trim()) ||
        (model.files?.length ?? 0) > 0 ||
        (model.assets?.length ?? 0) > 0
      return {
        ...model,
        source: '',
        sha256: '',
        assets: [],
        repositoryHosted,
      }
    }),
  })
}

const catalog = { schemaVersion: 1, plugins, apiModels: [] }
const output = resolve(root, 'model-catalog.json')
await writeFile(output, `${JSON.stringify(catalog, null, 2)}\n`)
console.log(`Exported ${plugins.length} plugins to ${output}`)
