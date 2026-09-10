import fs from 'node:fs'
import path from 'node:path'

export function readJsonIfValid(filePath, isValid = () => true) {
  if (!fs.existsSync(filePath)) return undefined
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return isValid(value) ? value : undefined
  } catch {
    return undefined
  }
}

export function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`)
    fs.renameSync(temporaryPath, filePath)
  } catch (error) {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath)
    throw error
  }
}

export function createJsonCache(outputDir) {
  const saveJson = (name, value) => writeJsonAtomic(path.join(outputDir, name), value)
  const cachedJson = async (name, producer, isValid = () => true) => {
    const cached = readJsonIfValid(path.join(outputDir, name), isValid)
    if (cached !== undefined) return cached
    const value = await producer()
    saveJson(name, value)
    return value
  }
  return { cachedJson, saveJson }
}
