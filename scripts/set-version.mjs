import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: npm run version:set -- 0.2.0')
  process.exit(1)
}

const root = resolve(import.meta.dirname, '..')

async function updateJson(relativePath, mutate) {
  const path = resolve(root, relativePath)
  const value = JSON.parse(await readFile(path, 'utf8'))
  mutate(value)
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

await updateJson('package.json', (value) => {
  value.version = version
})
await updateJson('package-lock.json', (value) => {
  value.version = version
  if (value.packages?.['']) value.packages[''].version = version
})
const tauriPath = resolve(root, 'src-tauri/tauri.conf.json')
const tauri = await readFile(tauriPath, 'utf8')
await writeFile(
  tauriPath,
  tauri.replace(/("version"\s*:\s*)"[^"]+"/, `$1"${version}"`),
)

const cargoPath = resolve(root, 'src-tauri/Cargo.toml')
const cargo = await readFile(cargoPath, 'utf8')
await writeFile(
  cargoPath,
  cargo.replace(
    /(\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m,
    `$1"${version}"`,
  ),
)

const fallbackDataPath = resolve(root, 'src/data.ts')
const fallbackData = await readFile(fallbackDataPath, 'utf8')
await writeFile(
  fallbackDataPath,
  fallbackData.replace(
    /(export const fallbackRuntime:[\s\S]*?version:\s*)'[^']+'/,
    `$1'${version}'`,
  ),
)

console.log(`QwenAudio Toolkits version set to ${version}`)
