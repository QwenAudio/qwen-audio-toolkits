import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const sourcePath = resolve('src-tauri/src/plugins.rs')
const outputPath = resolve(process.argv[2] ?? 'catalog/model-catalog.json')
const source = await readFile(sourcePath, 'utf8')
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
const catalog = { schemaVersion: 1, plugins, apiModels: [] }
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(catalog, null, 2)}\n`)
console.log(`Exported ${plugins.length} plugins to ${outputPath}`)
