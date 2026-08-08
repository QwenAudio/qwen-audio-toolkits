import fs from 'node:fs/promises'
import path from 'node:path'

const dataRoot = process.env.QWEN_AUDIO_DATA_ROOT
if (!dataRoot) {
  throw new Error('Set QWEN_AUDIO_DATA_ROOT to the model repository root.')
}

const appData = process.env.QWEN_AUDIO_AUDIT_APP_DATA
if (!appData || !appData.includes('.audit')) {
  throw new Error(
    'Set QWEN_AUDIO_AUDIT_APP_DATA to a dedicated path containing .audit.',
  )
}

const auditRoot = process.env.QWEN_AUDIO_AUDIT_ROOT ?? path.join(dataRoot, '.audit')
const sourceModels = path.join(dataRoot, 'models')
const sourceRuntimes = path.join(dataRoot, 'runtimes')
const fallbackRuntimes = process.env.QWEN_AUDIO_FALLBACK_RUNTIME_ROOT ?? ''
const catalogPath = path.resolve(
  process.env.QWEN_AUDIO_CATALOG_FILE ?? 'catalog/model-catalog.json',
)
const pluginOutput = path.join(auditRoot, 'plugins')
const runtimeOutput = path.join(appData, 'runtimes')

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

async function exists(filePath) {
  try {
    await fs.lstat(filePath)
    return true
  } catch {
    return false
  }
}

async function removeIfSymlink(filePath) {
  try {
    const entry = await fs.lstat(filePath)
    if (entry.isSymbolicLink()) await fs.unlink(filePath)
    else throw new Error(`Refusing to replace a non-symlink: ${filePath}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function link(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await removeIfSymlink(target)
  await fs.symlink(source, target)
}

async function resetDirectory(directory) {
  if (await exists(directory)) {
    const entry = await fs.lstat(directory)
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Audit path is not a real directory: ${directory}`)
    }
    await fs.rm(directory, { recursive: true, force: true })
  }
  await fs.mkdir(directory, { recursive: true })
}

function variantOverrides() {
  return new Map(
    (process.env.QWEN_AUDIO_AUDIT_VARIANTS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        const separator = value.indexOf('=')
        if (separator < 1 || separator === value.length - 1) {
          throw new Error(`Invalid variant override: ${value}`)
        }
        return [value.slice(0, separator), value.slice(separator + 1)]
      }),
  )
}

const overrides = variantOverrides()
const catalog = (await readJson(catalogPath)).plugins ?? []
const catalogById = new Map(catalog.map((plugin) => [plugin.id, plugin]))

await resetDirectory(auditRoot)
await fs.mkdir(appData, { recursive: true })
await resetDirectory(pluginOutput)
await fs.mkdir(runtimeOutput, { recursive: true })

const pluginIds = (await fs.readdir(sourceModels, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const prepared = []
for (const pluginId of pluginIds) {
  const sourcePlugin = path.join(sourceModels, pluginId)
  const sourceManifest = await readJson(path.join(sourcePlugin, 'plugin.json'))
  const override = overrides.get(pluginId)
  const catalogPlugin = catalogById.get(pluginId)
  const selectedModelId = override ?? sourceManifest.models?.[0]?.id
  if (!selectedModelId) throw new Error(`${pluginId} has no model variant`)

  const selectedModel =
    catalogPlugin?.models?.find((model) => model.id === selectedModelId) ??
    sourceManifest.models?.find((model) => model.id === selectedModelId)
  if (!selectedModel && selectedModelId !== 'rnnoise-default') {
    throw new Error(`Cannot find ${pluginId} variant ${selectedModelId}`)
  }

  const manifest = {
    ...sourceManifest,
    models: [selectedModel ?? { id: selectedModelId, files: [] }],
  }
  const pluginRoot = path.join(pluginOutput, pluginId)
  const modelRoot = path.join(pluginRoot, 'models', selectedModelId)
  await fs.mkdir(modelRoot, { recursive: true })
  await fs.writeFile(
    path.join(pluginRoot, 'plugin.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )

  const sourceModel = path.join(sourcePlugin, selectedModelId)
  if (await exists(sourceModel)) {
    for (const entry of await fs.readdir(sourceModel, { withFileTypes: true })) {
      await link(path.join(sourceModel, entry.name), path.join(modelRoot, entry.name))
    }
  }

  const runtimePackage = manifest.runtime?.package
  if (runtimePackage) {
    const runtimeSource = path.join(sourceRuntimes, runtimePackage)
    const fallbackSource = path.join(fallbackRuntimes, runtimePackage)
    const resolvedRuntime = (await exists(runtimeSource) && runtimeSource) ||
      ((await exists(fallbackSource) && fallbackSource) || '')
    if (!resolvedRuntime) {
      throw new Error(`Runtime ${runtimePackage} is missing for ${pluginId}`)
    }
    const runtimeLink = path.join(runtimeOutput, runtimePackage)
    if (!(await exists(runtimeLink))) await link(resolvedRuntime, runtimeLink)
    const platform = process.platform === 'darwin' ? 'macos-arm64' : `${process.platform}-${process.arch}`
    const pointerTarget = path.join(runtimeLink, platform)
    await fs.writeFile(path.join(modelRoot, '.runtime-path'), `${pointerTarget}\n`)
  }

  prepared.push({ pluginId, adapter: manifest.adapter, modelId: selectedModelId })
}

const appPlugins = path.join(appData, 'plugins')
await removeIfSymlink(appPlugins)
if (await exists(appPlugins)) {
  const entry = await fs.lstat(appPlugins)
  if (!entry.isDirectory()) throw new Error(`Audit app plugins path is not a directory: ${appPlugins}`)
  await fs.rm(appPlugins, { recursive: true, force: true })
}
await link(pluginOutput, appPlugins)

console.log(JSON.stringify({ appData, auditRoot, count: prepared.length, prepared }, null, 2))
