import { createHash, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

const OPENCODE_REPOSITORY = 'anomalyco/opencode'
const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024

export const OPENCODE_SIDECAR_DESCRIPTOR = Object.freeze({
  target: 'aarch64-apple-darwin',
  version: 'v1.18.30',
  asset: 'opencode-darwin-arm64.zip',
  sha256: 'a5e43d6887386efc7d68ce49ae28e3bbdfdee3dfd1d7169b612c3ce67e53b1e8',
  executableSha256: '2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62',
})

function fail(message) {
  throw new Error(`OpenCode sidecar: ${message}`)
}

function supportedDescriptor(target, version = OPENCODE_SIDECAR_DESCRIPTOR.version) {
  if (target !== OPENCODE_SIDECAR_DESCRIPTOR.target) {
    fail(`only ${OPENCODE_SIDECAR_DESCRIPTOR.target} is supported, received ${String(target)}`)
  }
  if (version !== OPENCODE_SIDECAR_DESCRIPTOR.version) {
    fail(`only ${OPENCODE_SIDECAR_DESCRIPTOR.version} is supported, received ${String(version)}`)
  }
  return OPENCODE_SIDECAR_DESCRIPTOR
}

function isSimpleFileName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    !name.includes('\0')
  )
}

function assetUrl(asset) {
  const url = asset?.browser_download_url
  if (typeof url !== 'string') fail('release metadata has an asset without a browser download URL')
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    fail('release metadata has an asset with an invalid browser download URL')
  }
  if (parsed.protocol !== 'https:') fail('release metadata has an asset with a non-HTTPS browser download URL')
  return parsed
}

export function selectReleaseAsset(assets, target, version = OPENCODE_SIDECAR_DESCRIPTOR.version) {
  const descriptor = supportedDescriptor(target, version)
  if (!Array.isArray(assets)) fail('release metadata does not contain an assets array')

  const archives = assets.filter(
    (asset) => isSimpleFileName(asset?.name) && asset.name === descriptor.asset,
  )
  if (archives.length === 0) fail(`missing required release asset ${descriptor.asset}`)
  if (archives.length > 1) fail(`ambiguous required release assets: found ${archives.length}`)

  const archive = archives[0]
  const expectedApiDigest = `sha256:${descriptor.sha256}`
  if (archive.digest !== expectedApiDigest) {
    fail(`release asset API digest does not match the committed SHA-256 for ${descriptor.asset}`)
  }
  assetUrl(archive)
  return archive
}

export function verifySha256(content, expectedChecksum, label = 'selected archive') {
  if (!Buffer.isBuffer(content) && !(content instanceof Uint8Array)) {
    fail(`${label} is not binary data`)
  }
  if (!/^[a-fA-F0-9]{64}$/.test(expectedChecksum ?? '')) {
    fail(`published SHA-256 checksum for ${label} is invalid`)
  }

  const actual = createHash('sha256').update(content).digest()
  const expected = Buffer.from(expectedChecksum, 'hex')
  if (!timingSafeEqual(actual, expected)) fail(`SHA-256 mismatch for ${label}`)
}

export async function verifyCachedSidecar(outputDirectory, target) {
  const descriptor = supportedDescriptor(target)
  const executablePath = path.join(path.resolve(outputDirectory), `opencode-${descriptor.target}`)
  let stat
  try {
    stat = await fs.lstat(executablePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  if (!stat.isFile() || (stat.mode & 0o111) === 0) return false

  let executable
  try {
    executable = await fs.readFile(executablePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  try {
    verifySha256(executable, descriptor.executableSha256, 'cached OpenCode sidecar')
  } catch {
    return false
  }
  return true
}

function isSafeArchivePath(name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) return false
  if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(name)) return false
  if (name.includes('\\')) return false
  const withoutTrailingSlash = name.endsWith('/') ? name.slice(0, -1) : name
  if (!withoutTrailingSlash) return false
  return withoutTrailingSlash.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
}

function requireRange(buffer, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    fail(`malformed ZIP archive while reading ${label}`)
  }
}

function findEndOfCentralDirectory(zip) {
  const minOffset = Math.max(0, zip.length - 0xffff - 22)
  for (let offset = zip.length - 22; offset >= minOffset; offset -= 1) {
    if (zip.readUInt32LE(offset) !== 0x06054b50) continue
    const commentLength = zip.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength !== zip.length) continue
    const diskNumber = zip.readUInt16LE(offset + 4)
    const directoryDisk = zip.readUInt16LE(offset + 6)
    const entriesOnDisk = zip.readUInt16LE(offset + 8)
    const entries = zip.readUInt16LE(offset + 10)
    const directorySize = zip.readUInt32LE(offset + 12)
    const directoryOffset = zip.readUInt32LE(offset + 16)
    if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entries) {
      fail('multi-disk ZIP archives are not supported')
    }
    if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      fail('ZIP64 archives are not supported')
    }
    return { entries, directoryOffset, directorySize }
  }
  fail('ZIP end-of-central-directory record is missing')
}

function readZipEntries(zip) {
  if (!Buffer.isBuffer(zip)) fail('archive is not binary data')
  if (zip.length < 22) fail('archive is too small to be a ZIP file')

  const { entries, directoryOffset, directorySize } = findEndOfCentralDirectory(zip)
  requireRange(zip, directoryOffset, directorySize, 'central directory')
  const directoryEnd = directoryOffset + directorySize
  let offset = directoryOffset
  const result = []

  for (let index = 0; index < entries; index += 1) {
    requireRange(zip, offset, 46, 'central directory entry')
    if (zip.readUInt32LE(offset) !== 0x02014b50) fail('central directory entry signature is invalid')

    const flags = zip.readUInt16LE(offset + 8)
    const compression = zip.readUInt16LE(offset + 10)
    const compressedSize = zip.readUInt32LE(offset + 20)
    const uncompressedSize = zip.readUInt32LE(offset + 24)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const externalAttributes = zip.readUInt32LE(offset + 38)
    const localHeaderOffset = zip.readUInt32LE(offset + 42)
    const recordLength = 46 + nameLength + extraLength + commentLength
    requireRange(zip, offset, recordLength, 'central directory entry content')

    const rawName = zip.subarray(offset + 46, offset + 46 + nameLength)
    const name = rawName.toString('utf8')
    if (!isSafeArchivePath(name)) fail('unsafe archive path traversal detected')

    const mode = externalAttributes >>> 16
    const fileType = mode & 0o170000
    if (fileType === 0o120000) fail('symbolic links are not allowed in the archive')

    result.push({
      name,
      rawName,
      flags,
      compression,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      directoryEnd,
    })
    offset += recordLength
  }

  if (offset !== directoryEnd) fail('central directory has unexpected trailing data')
  return result
}

function extractEntryData(zip, entry) {
  requireRange(zip, entry.localHeaderOffset, 30, 'local file header')
  if (zip.readUInt32LE(entry.localHeaderOffset) !== 0x04034b50) {
    fail('local file header signature is invalid')
  }

  const flags = zip.readUInt16LE(entry.localHeaderOffset + 6)
  const compression = zip.readUInt16LE(entry.localHeaderOffset + 8)
  const nameLength = zip.readUInt16LE(entry.localHeaderOffset + 26)
  const extraLength = zip.readUInt16LE(entry.localHeaderOffset + 28)
  const nameOffset = entry.localHeaderOffset + 30
  requireRange(zip, nameOffset, nameLength + extraLength, 'local file header content')
  const localName = zip.subarray(nameOffset, nameOffset + nameLength)
  if (flags !== entry.flags || compression !== entry.compression || !localName.equals(entry.rawName)) {
    fail('local file header does not match the central directory')
  }

  const dataOffset = nameOffset + nameLength + extraLength
  requireRange(zip, dataOffset, entry.compressedSize, 'compressed file data')
  if (dataOffset + entry.compressedSize > entry.directoryEnd) {
    fail('file data overlaps the central directory')
  }
  if (entry.uncompressedSize > MAX_EXTRACTED_BYTES) fail('executable exceeds the extraction size limit')

  const compressed = zip.subarray(dataOffset, dataOffset + entry.compressedSize)
  let data
  if (entry.compression === 0) {
    data = compressed
  } else if (entry.compression === 8) {
    try {
      data = inflateRawSync(compressed, { maxOutputLength: MAX_EXTRACTED_BYTES })
    } catch {
      fail('unable to inflate the executable from the ZIP archive')
    }
  } else {
    fail(`ZIP compression method ${entry.compression} is not supported`)
  }

  if (data.length !== entry.uncompressedSize) fail('executable size does not match ZIP metadata')
  return data
}

export async function extractZipExecutable(zip, outputDirectory, outputName) {
  if (!isSimpleFileName(outputName)) fail('output executable name is unsafe')
  const entries = readZipEntries(zip)
  const candidates = entries.filter(
    (entry) => !entry.name.endsWith('/') && path.posix.basename(entry.name) === 'opencode',
  )
  if (candidates.length !== 1) {
    fail(`expected exactly one opencode executable in the archive, found ${candidates.length}`)
  }

  const executable = extractEntryData(zip, candidates[0])
  const output = path.join(path.resolve(outputDirectory), outputName)
  await fs.mkdir(path.dirname(output), { recursive: true })
  const temporaryDirectory = await fs.mkdtemp(path.join(path.dirname(output), `.${outputName}-`))
  const temporaryOutput = path.join(temporaryDirectory, outputName)
  try {
    await fs.writeFile(temporaryOutput, executable, { mode: 0o755 })
    await fs.chmod(temporaryOutput, 0o755)
    await fs.rename(temporaryOutput, output)
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true })
  }
  return output
}

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help') return { help: true }
    if (!['--target', '--out'].includes(argument)) {
      fail(`unknown argument ${argument}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail(`${argument} requires a value`)
    if (values[argument]) fail(`${argument} was provided more than once`)
    values[argument] = value
    index += 1
  }
  if (!values['--target'] || !values['--out']) {
    fail('usage: node scripts/fetch-opencode-sidecar.mjs --target aarch64-apple-darwin --out <directory>')
  }
  return {
    target: values['--target'],
    outputDirectory: values['--out'],
  }
}

async function fetchReleaseMetadata(version, token) {
  let response
  try {
    response = await fetch(`https://api.github.com/repos/${OPENCODE_REPOSITORY}/releases/tags/${encodeURIComponent(version)}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'qwenaudio-opencode-sidecar',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
  } catch {
    fail(`unable to fetch release metadata for ${version}`)
  }
  if (!response.ok) fail(`unable to fetch release metadata for ${version}: GitHub returned HTTP ${response.status}`)
  try {
    const release = await response.json()
    if (release?.tag_name !== version) fail(`release metadata tag does not match ${version}`)
    return release
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('OpenCode sidecar:')) throw error
    fail(`release metadata for ${version} is not valid JSON`)
  }
}

async function downloadAsset(url, label) {
  let response
  try {
    response = await fetch(url)
  } catch {
    fail(`unable to download ${label}`)
  }
  if (!response.ok) fail(`unable to download ${label}: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    process.stdout.write('Usage: node scripts/fetch-opencode-sidecar.mjs --target aarch64-apple-darwin --out <directory>\n')
    return
  }

  const descriptor = supportedDescriptor(options.target)
  if (await verifyCachedSidecar(options.outputDirectory, descriptor.target)) {
    process.stdout.write(`Using verified cached OpenCode ${descriptor.version} sidecar for ${descriptor.target}.\n`)
    return
  }

  const release = await fetchReleaseMetadata(descriptor.version, process.env.GITHUB_TOKEN)
  const archive = selectReleaseAsset(release.assets, descriptor.target, descriptor.version)
  const archiveBytes = await downloadAsset(assetUrl(archive), 'OpenCode archive')
  verifySha256(archiveBytes, descriptor.sha256, 'OpenCode archive')
  await extractZipExecutable(
    archiveBytes,
    options.outputDirectory,
    `opencode-${descriptor.target}`,
  )
  if (!await verifyCachedSidecar(options.outputDirectory, descriptor.target)) {
    fail('extracted executable does not match the committed SHA-256')
  }
  process.stdout.write(`Prepared verified OpenCode ${descriptor.version} sidecar for ${descriptor.target}.\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
