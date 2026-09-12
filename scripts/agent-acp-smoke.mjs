import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const envPath = process.env.QWEN_AUDIO_AGENT_ENV
  || path.join(
    os.homedir(),
    'workspace/gitlab/qwen-audio-agent/examples/smart-cockpit/.env.local',
  )

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {}
  const values = {}
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const name = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    values[name] = value
  }
  return values
}

const env = {
  ...process.env,
  ...loadEnvFile(envPath),
  OPENCODE_DISABLE_AUTOUPDATE: '1',
}

if (!env.DASHSCOPE_API_KEY) {
  throw new Error(`DASHSCOPE_API_KEY is missing; checked ${envPath}`)
}

const model = env.DASHSCOPE_MODEL || 'qwen3.8-flash'
env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  model: `dashscope/${model}`,
  provider: {
    dashscope: {
      npm: '@ai-sdk/openai-compatible',
      name: 'DashScope',
      options: {
        baseURL: env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: '{env:DASHSCOPE_API_KEY}',
      },
      models: {
        [model]: { name: model },
      },
    },
  },
  tools: {
    bash: false,
    edit: false,
    write: false,
  },
})

const child = spawn(
  env.OPENCODE_PATH || 'opencode',
  ['acp', '--cwd', process.cwd()],
  { env, stdio: ['pipe', 'pipe', 'pipe'] },
)

let nextId = 1
const pending = new Map()
const updates = []

function request(method, params) {
  const id = nextId
  nextId += 1
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out`))
    }, 120_000)
    pending.set(id, {
      resolve(value) {
        clearTimeout(timer)
        resolve(value)
      },
      reject(error) {
        clearTimeout(timer)
        reject(error)
      },
    })
  })
}

function handleLine(line) {
  if (!line.trim().startsWith('{')) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.id && pending.has(message.id)) {
    const callbacks = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) callbacks.reject(new Error(JSON.stringify(message.error)))
    else callbacks.resolve(message.result)
    return
  }
  if (message.method === 'session/update') {
    updates.push(message.params?.update)
  }
}

let stdout = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  stdout += chunk
  let newline = stdout.indexOf('\n')
  while (newline >= 0) {
    const line = stdout.slice(0, newline)
    stdout = stdout.slice(newline + 1)
    handleLine(line)
    newline = stdout.indexOf('\n')
  }
})

child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => {
  if (process.env.AGENT_ACP_SMOKE_VERBOSE) process.stderr.write(chunk)
})

try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: {
      name: 'qwen-audio-toolkits-smoke',
      title: 'QwenAudio Toolkits ACP Smoke',
      version: '0.1.0',
    },
  })
  if (init.protocolVersion !== 1) throw new Error('ACP protocol negotiation failed')
  const session = await request('session/new', {
    cwd: process.cwd(),
    mcpServers: [],
  })
  if (!session.sessionId) throw new Error('ACP session/new returned no sessionId')
  const result = await request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [
      {
        type: 'text',
        text: '请只回复：opencode ACP smoke ok',
      },
    ],
  })
  const reply = updates
    .filter((update) => update?.sessionUpdate === 'agent_message_chunk')
    .map((update) => update.content?.text || '')
    .join('')
  if (result.stopReason !== 'end_turn') {
    throw new Error(`Unexpected stop reason: ${result.stopReason}`)
  }
  if (!reply.toLowerCase().includes('opencode acp smoke ok')) {
    throw new Error(`Unexpected ACP reply: ${reply}`)
  }
  console.log('agent-acp-smoke ok')
} finally {
  child.kill('SIGTERM')
}
