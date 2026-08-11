import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { readApiModelCatalog } from './lib/api-model-catalog.mjs'

const sourcePath = resolve('src-tauri/src/plugins.rs')
const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const outputPath = resolve(
  args.find((argument) => argument !== '--check') ??
    'catalog/model-catalog.json',
)
const source = await readFile(sourcePath, 'utf8')
const apiModels = await readApiModelCatalog()
const manifestPattern = /const\s+[A-Z0-9_]+_MANIFEST:\s*&str\s*=\s*r#"([\s\S]*?)"#;/g
const sha256Pattern = /^[a-f0-9]{64}$/i

const verifiedVariant = (variant) => {
  const sourceVerified = !variant.source || sha256Pattern.test(variant.sha256 ?? '')
  const assetsVerified = (variant.assets ?? []).every((asset) =>
    sha256Pattern.test(asset.sha256 ?? ''),
  )
  return sourceVerified && assetsVerified
}

const plugins = []
for (const match of source.matchAll(manifestPattern)) {
  const manifest = JSON.parse(match[1])
  const models = (manifest.models ?? []).filter(verifiedVariant)
  if (!models.length && (manifest.models?.length ?? 0) > 0) continue
  plugins.push({ ...manifest, models })
}

plugins.sort((left, right) => left.id.localeCompare(right.id))
const catalog = { schemaVersion: 1, plugins, apiModels }
if (checkOnly) {
  const existing = JSON.parse(await readFile(outputPath, 'utf8'))
  if (!isDeepStrictEqual(existing, catalog)) {
    throw new Error(
      `${outputPath} 与内置模型清单不一致，请运行 npm run catalog:export`,
    )
  }
  console.log(`Catalog check passed (${plugins.length} plugins).`)
  process.exit(0)
}
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(catalog, null, 2)}\n`)
console.log(`Exported ${plugins.length} plugins to ${outputPath}`)
