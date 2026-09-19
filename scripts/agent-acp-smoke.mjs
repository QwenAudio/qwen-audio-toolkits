import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const acpBackend = fs.readFileSync(path.join(root, 'src-tauri/src/acp.rs'), 'utf8')
const appBackend = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8')
const acpService = fs.readFileSync(path.join(root, 'src/services/acp.ts'), 'utf8')
const acpTypes = fs.readFileSync(path.join(root, 'src/types.ts'), 'utf8')

for (const protocolSurface of [
  '"initialize"',
  '"session/new"',
  '"session/prompt"',
  '"session/cancel"',
  '"session/request_permission"',
  '"plan"',
  'acp_start_session',
  'acp_respond_permission',
  'acp_respond_question',
  'acp_respond_plan_approval',
]) {
  assert.ok(acpBackend.includes(protocolSurface), `ACP backend is missing ${protocolSurface}`)
}
for (const command of ['acp_respond_question', 'acp_respond_plan_approval']) {
  assert.match(acpBackend, new RegExp(`#[\\s\\S]*?pub fn ${command}\\(`, 'u'), `ACP backend must declare ${command}`)
  assert.match(appBackend, new RegExp(`acp::${command}`, 'u'), `Tauri command registry must include ${command}`)
}
assert.match(acpTypes, /export interface AcpQuestionOption \{\n  id: string\n  label: string\n\}/u)
assert.match(acpTypes, /export interface AcpQuestion \{\n  id: string\n  prompt: string\n  options: AcpQuestionOption\[\]\n  allowMultiple\?: boolean\n\}/u)
assert.match(acpTypes, /export interface AcpQuestionAnswer \{\n  questionId: string\n  selectedOptionIds: string\[\]\n\}/u)
assert.match(acpTypes, /export interface AcpPlanEntry \{\n  id\?: string\n  content\?: string\n  status\?: string\n\}/u)
assert.match(acpTypes, /export interface AcpPlanPhase \{\n  id\?: string\n  name\?: string\n  todos\?: AcpPlanEntry\[\]\n\}/u)
for (const eventKind of ['question_requested', 'question_resolved', 'plan_approval_requested', 'plan_approval_resolved']) {
  assert.match(acpTypes, new RegExp(`'${eventKind}'`, 'u'), `ACP event type must include ${eventKind}`)
}
assert.match(acpTypes, /questions\?: AcpQuestion\[\]/u)
assert.match(acpTypes, /phases\?: AcpPlanPhase\[\]/u)
assert.match(acpService, /AcpQuestionAnswer,/u, 'ACP service must import the question-answer type')
assert.match(acpService, /export function respondAcpQuestion\(\n  sessionId: string,\n  requestId: string,\n  answers\?: AcpQuestionAnswer\[\],\n\): Promise<void> \{[\s\S]*?invoke<void>\('acp_respond_question', \{[\s\S]*?outcome: answers[\s\S]*?outcome: 'answered', answers[\s\S]*?outcome: 'cancelled'/u)
assert.match(acpService, /export function respondAcpPlanApproval\(\n  sessionId: string,\n  requestId: string,\n  accepted: boolean,\n  reason\?: string,\n\): Promise<void> \{[\s\S]*?invoke<void>\('acp_respond_plan_approval', \{[\s\S]*?outcome: accepted[\s\S]*?outcome: 'accepted'[\s\S]*?outcome: 'rejected', reason/u)
assert.doesNotMatch(acpService, /AgentHome|panel/u, 'ACP protocol service must not add UI or panel behavior')
assert.ok(acpBackend.includes('id: "opencode"'), 'external OpenCode ACP provider must remain available')
assert.ok(!acpBackend.includes('id: "opencode-bundled"'), 'bundled OpenCode ACP provider must stay removed')
for (const installedProvider of ['id: "qoder"', 'id: "opencode"', 'id: "kimi"']) {
  assert.ok(acpBackend.includes(installedProvider), `installed ACP provider is missing: ${installedProvider}`)
}
const providerRegistryStart = acpBackend.indexOf('const ACP_PROVIDERS:')
const providerRegistryEnd = acpBackend.indexOf('\n];', providerRegistryStart)
assert.ok(providerRegistryStart >= 0 && providerRegistryEnd > providerRegistryStart, 'ACP provider registry is missing')
const providerRegistry = acpBackend.slice(providerRegistryStart, providerRegistryEnd)
for (const remoteLaunchToken of ['id: "codex"', 'id: "qwen-code"', 'command: &["npx"', '"-y"']) {
  assert.ok(!providerRegistry.includes(remoteLaunchToken), `remote ACP launch token remains: ${remoteLaunchToken}`)
}

const fixture = String.raw`
  import { createInterface } from 'node:readline'
  const send = message => process.stdout.write(JSON.stringify(message) + '\n')
  createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line)
    const reply = result => send({ jsonrpc: '2.0', id: request.id, result })
    if (request.method === 'initialize') reply({ protocolVersion: 1, agentInfo: { name: 'external-fixture' } })
    else if (request.method === 'session/new') reply({ sessionId: 'fixture-session' })
    else if (request.method === 'session/prompt') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'fixture-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'external ACP smoke ok' } },
        },
      })
      reply({ stopReason: 'end_turn' })
    }
  })
`

const child = spawn(process.execPath, ['--input-type=module', '--eval', fixture], {
  stdio: ['pipe', 'pipe', 'pipe'],
})
let nextId = 1
let output = ''
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
    }, 5_000)
    pending.set(id, message => {
      clearTimeout(timer)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    })
  })
}

child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  output += chunk
  let newline = output.indexOf('\n')
  while (newline >= 0) {
    const line = output.slice(0, newline)
    output = output.slice(newline + 1)
    const message = JSON.parse(line)
    if (message.id && pending.has(message.id)) {
      const resolve = pending.get(message.id)
      pending.delete(message.id)
      resolve(message)
    } else if (message.method === 'session/update') {
      updates.push(message.params?.update)
    }
    newline = output.indexOf('\n')
  }
})

try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'qwen-audio-boss-first-smoke', version: '0.1.0' },
  })
  assert.equal(init.protocolVersion, 1)
  const session = await request('session/new', { cwd: root, mcpServers: [] })
  assert.equal(session.sessionId, 'fixture-session')
  const result = await request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'reply with the fixture confirmation' }],
  })
  assert.equal(result.stopReason, 'end_turn')
  assert.equal(updates[0]?.content?.text, 'external ACP smoke ok')
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: session.sessionId } })}\n`)
  console.log('agent-acp-smoke ok')
} finally {
  child.kill('SIGTERM')
}
