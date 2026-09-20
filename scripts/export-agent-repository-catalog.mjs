import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const destination = process.argv[2]
if (!destination) {
  console.error('Usage: npm run agents:repository -- /path/to/QwenAudio-Toolkits')
  process.exit(1)
}
const catalog = JSON.parse(await readFile('catalog/agent-catalog.json', 'utf8'))
if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.agents)) {
  throw new Error('catalog/agent-catalog.json must contain schemaVersion 1 and agents')
}
const seen = new Set()
for (const agent of catalog.agents) {
  if (!agent || typeof agent !== 'object' || !/^(?!\.)(?!.*\.\.)[A-Za-z0-9.-]{1,100}$/.test(agent.id)) {
    throw new Error('Agent catalog contains an invalid id')
  }
  if (seen.has(agent.id)) throw new Error(`Duplicate Agent id: ${agent.id}`)
  seen.add(agent.id)
  if (typeof agent.archive !== 'string' || !agent.archive.startsWith('agents/') || !agent.archive.endsWith('.tar') || agent.archive.includes('..')) {
    throw new Error(`${agent.id}: archive must be a safe agents/*.tar path`)
  }
  if (!/^[a-f0-9]{64}$/i.test(agent.sha256)) throw new Error(`${agent.id}: sha256 is required`)
  const archive = resolve(destination, agent.archive)
  const metadata = await stat(archive)
  if (!metadata.isFile()) throw new Error(`${agent.id}: missing ${archive}`)
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex')
  if (sha256 !== agent.sha256.toLowerCase()) throw new Error(`${agent.id}: archive checksum does not match`)
}
const output = resolve(destination, 'agents/catalog.json')
await mkdir(resolve(destination, 'agents'), { recursive: true })
await writeFile(output, `${JSON.stringify(catalog, null, 2)}\n`)
console.log(`Exported ${catalog.agents.length} Agents to ${output}`)
