import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

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

const require = createRequire(import.meta.url)
const child = spawn(process.execPath,
  [require.resolve('@tauri-apps/cli/tauri.js'), ...process.argv.slice(2)],
  { env, stdio: 'inherit' })
child.on('error', error => {
  console.error(error.message)
  process.exitCode = 1
})
child.on('exit', code => { process.exitCode = code ?? 1 })
