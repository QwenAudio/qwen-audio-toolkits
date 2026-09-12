import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const envPath = process.env.QWEN_AUDIO_AGENT_ENV
  || path.join(
    os.homedir(),
    'workspace/gitlab/qwen-audio-agent/examples/smart-cockpit/.env.local',
  )

const cases = [
  {
    name: 'short-hello',
    text: '你好。请只用一句话回复。',
  },
  {
    name: 'short-task',
    text: '我有一个 3 分钟口播视频，想剪掉停顿，请给一个极简方案。',
  },
  {
    name: 'long-task',
    text: '我有一段 45 分钟访谈视频，里面有主持人、嘉宾和远程连线。请帮我规划一个可审阅的工作流：识别章节、清理静音和重复表达、生成双语字幕，并输出 8 分钟精华版和 60 秒预告。',
  },
]

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

function promptText(text) {
  return [
    '你是 QwenAudio Toolkits 的通用音视频创作 Agent。',
    '当前阶段只进行对话、规划和建议，不要运行命令。',
    '对寒暄和简单确认，请简短回复。',
    '默认用 120 到 180 个中文字回答，先给高层计划和最关键的确认点；只有用户明确要求详细方案时再展开。',
    '',
    `当前用户请求：\n${text}`,
  ].join('\n')
}

function nowMs() {
  return Math.round(performance.now())
}

class AcpProcess {
  constructor() {
    this.child = spawn(
      env.OPENCODE_PATH || 'opencode',
      ['acp', '--cwd', process.cwd()],
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    this.nextId = 1
    this.pending = new Map()
    this.updates = new Map()
    this.stdout = ''
    this.stderr = ''

    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => {
      this.stdout += chunk
      let newline = this.stdout.indexOf('\n')
      while (newline >= 0) {
        const line = this.stdout.slice(0, newline)
        this.stdout = this.stdout.slice(newline + 1)
        this.handleLine(line)
        newline = this.stdout.indexOf('\n')
      }
    })

    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk
      if (process.env.AGENT_ACP_LATENCY_VERBOSE) process.stderr.write(chunk)
    })
  }

  request(method, params, timeoutMs = 180_000) {
    const id = this.nextId
    this.nextId += 1
    this.updates.set(id, [])
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve({ result: value, updates: this.updates.get(id) ?? [] })
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
    })
  }

  handleLine(line) {
    if (!line.trim().startsWith('{')) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.id && this.pending.has(message.id)) {
      const callbacks = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) callbacks.reject(new Error(JSON.stringify(message.error)))
      else callbacks.resolve(message.result)
      return
    }
    if (message.method !== 'session/update') return
    const lastId = this.nextId - 1
    const updates = this.updates.get(lastId)
    if (updates) updates.push(message.params?.update)
  }

  async initialize() {
    const started = nowMs()
    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: {
        name: 'qwen-audio-toolkits-latency',
        title: 'QwenAudio Toolkits Latency Benchmark',
        version: '0.1.0',
      },
    })
    if (init.result.protocolVersion !== 1) {
      throw new Error('ACP protocol negotiation failed')
    }
    return nowMs() - started
  }

  async prompt(input) {
    const sessionStarted = nowMs()
    const session = await this.request('session/new', {
      cwd: process.cwd(),
      mcpServers: [],
    })
    const sessionMs = nowMs() - sessionStarted
    const sessionId = session.result.sessionId
    if (!sessionId) throw new Error('session/new returned no sessionId')

    const promptStarted = nowMs()
    const result = await this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: promptText(input) }],
    })
    const promptMs = nowMs() - promptStarted
    const reply = result.updates
      .filter((update) => update?.sessionUpdate === 'agent_message_chunk')
      .map((update) => update.content?.text || '')
      .join('')
      .trim()
    return {
      sessionMs,
      promptMs,
      totalMs: sessionMs + promptMs,
      stopReason: result.result.stopReason,
      replyChars: reply.length,
      replyPreview: reply.slice(0, 80),
    }
  }

  stop() {
    this.child.kill('SIGTERM')
  }
}

async function runCold() {
  const results = []
  for (const testCase of cases) {
    const started = nowMs()
    const acp = new AcpProcess()
    try {
      const initMs = await acp.initialize()
      const prompt = await acp.prompt(testCase.text)
      results.push({
        mode: 'cold',
        name: testCase.name,
        inputChars: testCase.text.length,
        initMs,
        ...prompt,
        totalMs: nowMs() - started,
      })
    } finally {
      acp.stop()
    }
  }
  return results
}

async function runWarm() {
  const acp = new AcpProcess()
  const results = []
  try {
    const initMs = await acp.initialize()
    for (const testCase of cases) {
      const prompt = await acp.prompt(testCase.text)
      results.push({
        mode: 'warm',
        name: testCase.name,
        inputChars: testCase.text.length,
        initMs: results.length === 0 ? initMs : 0,
        ...prompt,
      })
    }
  } finally {
    acp.stop()
  }
  return results
}

const cold = await runCold()
const warm = await runWarm()
console.log(JSON.stringify({
  model,
  cases: [...cold, ...warm],
  summary: {
    coldTotalMs: cold.map((item) => item.totalMs),
    warmTotalMs: warm.map((item) => item.totalMs),
    coldHelloMs: cold.find((item) => item.name === 'short-hello')?.totalMs,
    warmHelloMs: warm.find((item) => item.name === 'short-hello')?.totalMs,
  },
}, null, 2))
