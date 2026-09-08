// Run an isolated debug .app built with an identifier ending in .windowtest.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

if (process.platform !== 'darwin' || !process.argv[2]) {
  throw new Error('Usage on macOS: node scripts/macos-window-smoke.mjs /path/to/test.app')
}
const bundle = resolve(process.argv[2])
const identifier = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleIdentifier', join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
if (!/^[\w.-]+\.windowtest$/.test(identifier)) throw new Error('Use a disposable .windowtest bundle')
execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', bundle])
const logs = mkdtempSync(join(tmpdir(), 'qwen-window-smoke-'))
// Launch through Launch Services, just as Finder/Dock launches the installed app.
const child = spawn('open', ['-W', '-n', bundle, '--env', 'QWEN_AUDIO_WINDOW_SMOKE_TEST=1', '--stdout', join(logs, 'stdout'), '--stderr', join(logs, 'stderr')], { stdio: 'inherit' })
let timedOut = false
const timeout = setTimeout(() => {
  timedOut = true
  try {
    execFileSync('osascript', ['-e', `tell application id "${identifier}" to quit`], { timeout: 5000 })
  } catch (error) {
    console.error('Could not stop the disposable test app:', error.message)
  } finally {
    child.kill('SIGTERM')
  }
}, 60000)
child.on('error', error => { clearTimeout(timeout); console.error(error); process.exitCode = 1 })
child.on('exit', (code, signal) => {
  clearTimeout(timeout)
  let output = ''
  for (const file of ['stdout', 'stderr']) {
    try { output += readFileSync(join(logs, file), 'utf8') } catch { /* launch failure */ }
  }
  process.stdout.write(output)
  const checks = ['close/reopen cycle 3 passed', 'minimize/reopen passed', 'missing-window recovery passed', 'requesting full exit with captions still present']
  if (timedOut || code !== 0 || signal || checks.some(check => !output.includes(`WINDOW_SMOKE: ${check}`)) || output.includes('WINDOW_SMOKE: FAIL:')) {
    console.error('Native window lifecycle test failed', { code, signal, logs })
    process.exitCode = 1
  } else console.log('PASS: native close, Dock reopen event, minimize, missing-window recovery, and full process exit')
})
