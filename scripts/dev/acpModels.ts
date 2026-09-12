import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Plugin } from 'vite'
import { parseAcpModelCatalog, type AcpModelCatalog } from '../../src/domain/acpModels.ts'

const providers = [
  { id: 'qoder', name: 'Qoder', command: ['qoder', '--acp'] },
  { id: 'kimi', name: 'Kimi Code', command: ['kimi', 'acp'] },
  { id: 'codex', name: 'Codex', command: ['npx', '-y', '@agentclientprotocol/codex-acp'] },
  { id: 'qwen-code', name: 'Qwen Code', command: ['npx', '-y', '@qwen-code/qwen-code', '--acp'] },
]
const paths = [...new Set([
  ...['.local/bin', '.qoder/entry', '.cargo/bin', '.volta/bin', '.npm-global/bin', 'bin'].map(path => join(homedir(), path)),
  '/opt/homebrew/bin', '/usr/local/bin', ...(process.env.PATH ?? '').split(delimiter),
])]
const executable = (command: string) => paths.map(path => join(path, command)).find(path => {
  try { accessSync(path, constants.X_OK); return true } catch { return false }
})

export async function inspectLocalAcpModels(providerId: string): Promise<AcpModelCatalog> {
  const provider = providers.find(item => item.id === providerId)
  if (!provider) throw new Error('未知的 ACP Agent')
  const command = executable(provider.command[0])
  if (!command) throw new Error(`未找到 ${provider.name}，请先安装并登录。`)
  const cwd = await mkdtemp(join(tmpdir(), 'qwenaudio-acp-models-'))
  const child = spawn(command, provider.command.slice(1), {
    cwd, env: { ...process.env, PATH: paths.join(delimiter), NO_BROWSER: '1' },
    stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  })
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let sequence = 0
  let failure: Error | null = null
  const fail = (error: Error) => {
    failure = error
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  child.on('error', () => fail(new Error(`${provider.name} 启动失败，请检查安装。`)))
  child.on('exit', () => fail(new Error(`${provider.name} 连接已结束，请检查登录状态后重试。`)))
  child.stdin.on('error', () => fail(new Error(`${provider.name} 连接已中断。`)))
  child.stderr.resume()
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (!message || typeof message !== 'object') return
    if (message.method && message.id !== undefined) {
      const response = message.method === 'session/request_permission'
        ? { result: { outcome: { outcome: 'cancelled' } } }
        : { error: { code: -32601, message: 'Model inspection does not provide tools' } }
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...response })}\n`)
      return
    }
    const request = pending.get(Number(message.id))
    if (!request) return
    pending.delete(Number(message.id))
    if (message.error) request.reject(new Error(message.error.message || 'ACP 请求失败'))
    else request.resolve(message.result)
  })
  const rpc = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    if (failure) { reject(failure); return }
    const id = ++sequence
    pending.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  const stop = (signal: NodeJS.Signals) => {
    if (!child.pid) return
    try {
      if (process.platform === 'win32') child.kill(signal)
      else process.kill(-child.pid, signal)
    } catch { /* The process has already exited. */ }
  }
  const timeout = setTimeout(() => { fail(new Error(`${provider.name} 连接超时，请检查安装和登录状态。`)); stop('SIGTERM') }, 90_000)
  try {
    await rpc('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }, clientInfo: { name: 'qwenaudio-model-inspector', version: '1' } })
    const session = await rpc('session/new', { cwd, mcpServers: [] })
    return parseAcpModelCatalog(session)
  } finally {
    clearTimeout(timeout)
    lines.close()
    child.stdin.end()
    stop('SIGTERM')
    const kill = setTimeout(() => stop('SIGKILL'), 1000)
    kill.unref()
    await rm(cwd, { recursive: true, force: true })
  }
}

export function acpModelPreview(): Plugin {
  const inFlight = new Map<string, Promise<AcpModelCatalog>>()
  return {
    name: 'local-acp-model-preview', apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__local/acp', (request, response) => {
        const host = request.headers.host ?? ''
        const origin = request.headers.origin
        const remote = request.socket.remoteAddress ?? ''
        if (request.method !== 'GET' || request.headers['x-qwenaudio-local'] !== '1' ||
          !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ||
          !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) || (origin && origin !== `http://${host}`)) {
          response.statusCode = 403; response.end(); return
        }
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
        response.setHeader('Cache-Control', 'no-store')
        const url = new URL(request.url ?? '/', `http://${host}`)
        if (url.pathname === '/providers') {
          response.end(JSON.stringify(providers.map(provider => ({ id: provider.id, name: provider.name, available: Boolean(executable(provider.command[0])) }))))
          return
        }
        const id = url.searchParams.get('provider') ?? ''
        if (url.pathname !== '/models' || !providers.some(provider => provider.id === id)) {
          response.statusCode = 404; response.end(JSON.stringify({ error: '未知的 ACP Agent' })); return
        }
        if (!inFlight.has(id)) {
          const pending = inspectLocalAcpModels(id).finally(() => inFlight.delete(id))
          inFlight.set(id, pending)
        }
        void inFlight.get(id)!.then(result => response.end(JSON.stringify(result)), error => {
          response.statusCode = 502; response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        })
      })
    },
  }
}
