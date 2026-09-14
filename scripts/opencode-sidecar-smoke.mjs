import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  OPENCODE_SIDECAR_DESCRIPTOR,
  extractZipExecutable,
  selectReleaseAsset,
  verifySha256,
} from './fetch-opencode-sidecar.mjs'
import { resolveSidecarTarget, shouldProvisionTauriSidecar } from './desktop.mjs'

const sidecarModule = await import('./fetch-opencode-sidecar.mjs')

function makeStoredZip(entries) {
  let offset = 0
  const localRecords = []
  const centralRecords = []

  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const content = Buffer.from(entry.content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(content.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(name.length, 26)
    const localRecord = Buffer.concat([local, name, content])
    localRecords.push(localRecord)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(content.length, 20)
    central.writeUInt32LE(content.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0o100755 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centralRecords.push(Buffer.concat([central, name]))
    offset += localRecord.length
  }

  const centralDirectory = Buffer.concat(centralRecords)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localRecords, centralDirectory, end])
}

const descriptor = OPENCODE_SIDECAR_DESCRIPTOR
assert.equal(typeof sidecarModule.verifyCachedSidecar, 'function')
const { verifyCachedSidecar } = sidecarModule
assert.equal(shouldProvisionTauriSidecar(['dev']), true)
assert.equal(shouldProvisionTauriSidecar(['dev', '--target', descriptor.target]), true)
assert.equal(shouldProvisionTauriSidecar(['build']), true)
assert.equal(shouldProvisionTauriSidecar(['dev', '--help']), false)
assert.equal(shouldProvisionTauriSidecar(['build', '--version']), false)
assert.equal(shouldProvisionTauriSidecar(['info']), false)
assert.equal(resolveSidecarTarget(['dev'], 'darwin', 'arm64'), descriptor.target)
assert.equal(
  resolveSidecarTarget(['dev', '--target', descriptor.target], 'darwin', 'x64'),
  descriptor.target,
)
assert.throws(
  () => resolveSidecarTarget(['dev', '--target', 'x86_64-apple-darwin'], 'darwin', 'arm64'),
  /only aarch64-apple-darwin.*received x86_64-apple-darwin/i,
)
const assets = [
  {
    name: descriptor.asset,
    digest: `sha256:${descriptor.sha256}`,
    browser_download_url: 'https://example.test/opencode.zip',
  },
]
const selected = selectReleaseAsset(assets, descriptor.target, descriptor.version)
assert.equal(selected.name, descriptor.asset)
assert.throws(
  () => selectReleaseAsset(assets, descriptor.target, 'v0.0.0'),
  /only v1\.18\.30 is supported/i,
)
assert.throws(
  () => selectReleaseAsset([{ ...assets[0], digest: `sha256:${'0'.repeat(64)}` }], descriptor.target, descriptor.version),
  /API digest.*does not match/i,
)

const archive = makeStoredZip([
  { name: 'README.md', content: 'fixture' },
  { name: 'opencode', content: '#!/bin/sh\necho fixture\n' },
])
const archiveDigest = createHash('sha256').update(archive).digest('hex')
verifySha256(archive, archiveDigest, 'downloaded OpenCode archive')
assert.throws(
  () => verifySha256(archive, descriptor.sha256, 'downloaded OpenCode archive'),
  /SHA-256 mismatch/,
)

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-sidecar-smoke-'))
try {
  const outDir = path.join(tempDir, 'out')
  assert.equal(await verifyCachedSidecar(outDir, descriptor.target), false)

  const executablePath = await extractZipExecutable(
    archive,
    outDir,
    `opencode-${descriptor.target}`,
  )
  assert.equal(await fs.readFile(executablePath, 'utf8'), '#!/bin/sh\necho fixture\n')
  assert.equal((await fs.stat(executablePath)).mode & 0o777, 0o755)
  assert.equal(await verifyCachedSidecar(outDir, descriptor.target), false)

  await assert.rejects(
    () => extractZipExecutable(Buffer.from('not a ZIP archive'), outDir, `opencode-${descriptor.target}`),
    /ZIP/i,
  )

  const traversalArchive = makeStoredZip([
    { name: '../escape', content: 'unsafe' },
    { name: 'opencode', content: 'ignored' },
  ])
  await assert.rejects(
    () => extractZipExecutable(traversalArchive, outDir, `opencode-${descriptor.target}`),
    /traversal/i,
  )

  const wrongBinaryArchive = makeStoredZip([{ name: 'not-opencode', content: 'wrong binary' }])
  await assert.rejects(
    () => extractZipExecutable(wrongBinaryArchive, outDir, `opencode-${descriptor.target}`),
    /exactly one opencode executable/i,
  )
} finally {
  await fs.rm(tempDir, { recursive: true, force: true })
}

console.log(JSON.stringify({ status: 'passed', checks: 22 }))
