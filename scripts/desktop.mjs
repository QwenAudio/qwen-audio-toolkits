import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { OPENCODE_SIDECAR_DESCRIPTOR } from './fetch-opencode-sidecar.mjs'

const env = { ...process.env }
// Tahoe draws the current native window controls only when linked with its SDK.
// Prefer full Xcode over older Command Line Tools without changing xcode-select.
if (process.platform === 'darwin' && !env.DEVELOPER_DIR && !env.SDKROOT) {
  const sdkMajor = candidateEnv => {
    const result = spawnSync('xcrun', ['--sdk', 'macosx', '--show-sdk-version'], {
      env: candidateEnv,
      encoding: 'utf8',
    })
    return Number.parseInt(result.stdout?.trim() ?? '', 10)
  }
  const developerDir = '/Applications/Xcode.app/Contents/Developer'
  if (sdkMajor(env) < 26 && existsSync(developerDir)) {
    const candidate = { ...env, DEVELOPER_DIR: developerDir }
    if (sdkMajor(candidate) >= 26) {
      env.DEVELOPER_DIR = developerDir
      console.log('Using Xcode macOS SDK for native window appearance.')
    }
  }
}

function explicitTarget(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument.startsWith('--target=')) {
      const target = argument.slice('--target='.length)
      if (target) return target
      throw new Error('Desktop dev and build require a value for --target.')
    }
    if (argument === '--target') {
      const target = args[index + 1]
      if (!target || target.startsWith('-')) {
        throw new Error('Desktop dev and build require a value for --target.')
      }
      return target
    }
  }
  return null
}

function hasInformationalFlag(args) {
  const endOfOptions = args.indexOf('--')
  const commandArguments = args.slice(1, endOfOptions === -1 ? args.length : endOfOptions)
  return commandArguments.some(argument => ['--help', '-h', '--version', '-V'].includes(argument))
}

export function shouldProvisionTauriSidecar(args) {
  return (
    (args[0] === 'dev' || args[0] === 'build') &&
    !hasInformationalFlag(args)
  )
}

export function resolveSidecarTarget(args, platform = process.platform, arch = process.arch) {
  const target = explicitTarget(args)
  if (target === OPENCODE_SIDECAR_DESCRIPTOR.target) return target
  if (target) {
    throw new Error(
      `Desktop dev and build currently support only ${OPENCODE_SIDECAR_DESCRIPTOR.target} (Apple Silicon macOS), matching the current release scope; received ${target}.`,
    )
  }
  if (platform === 'darwin' && arch === 'arm64') return OPENCODE_SIDECAR_DESCRIPTOR.target
  throw new Error(
    `Desktop dev and build currently support only ${OPENCODE_SIDECAR_DESCRIPTOR.target} (Apple Silicon macOS), matching the current release scope. Use Apple Silicon or pass --target ${OPENCODE_SIDECAR_DESCRIPTOR.target}.`,
  )
}

function run(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      const reason = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
      const error = new Error(`${label} failed with ${reason}.`)
      error.exitCode = code ?? 1
      reject(error)
    })
  })
}

async function main() {
  const args = process.argv.slice(2)
  if (shouldProvisionTauriSidecar(args)) {
    const target = resolveSidecarTarget(args)
    await run(
      process.execPath,
      [
        fileURLToPath(new URL('./fetch-opencode-sidecar.mjs', import.meta.url)),
        '--target',
        target,
        '--out',
        'src-tauri/binaries',
      ],
      'OpenCode sidecar provisioning',
    )
  }

  const require = createRequire(import.meta.url)
  await run(
    process.execPath,
    [require.resolve('@tauri-apps/cli/tauri.js'), ...args],
    'Tauri',
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = error?.exitCode ?? 1
  })
}
