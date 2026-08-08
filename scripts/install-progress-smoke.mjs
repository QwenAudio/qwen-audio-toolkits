import assert from 'node:assert/strict'

const scopes = {
  model: [0, 84],
  dependency: [84, 99],
  package: [0, 99],
}

function mapProgress(progress, scope) {
  const [base, limit] = scopes[scope]
  const normalized = Math.max(0, Math.min(100, Math.round(progress)))
  return base + Math.round((normalized * (limit - base)) / 100)
}

function advance(current, progress, scope) {
  return Math.max(current, mapProgress(progress, scope))
}

function parseSpeed(detail) {
  return detail.match(/·\s*([^·]+\/s)$/)?.[1]?.replace(/\s+/g, '')
}

const modelEvents = [2, 18, 38, 66, 68, 70, 74, 82, 90, 94, 100]
const modelProgress = modelEvents.reduce(
  (current, event) => [...current, advance(current.at(-1), event, 'model')],
  [0],
)
const dependencyEvents = [12, 24, 90, 100]
const dependencyProgress = dependencyEvents.reduce(
  (current, event) => [
    ...current,
    advance(current.at(-1), event, 'dependency'),
  ],
  [modelProgress.at(-1)],
)

assert.equal(modelProgress.at(-1), 84)
assert.equal(dependencyProgress.at(-1), 99)
assert.ok(modelProgress.every((value, index) => index === 0 || value >= modelProgress[index - 1]))
assert.ok(
  dependencyProgress.every(
    (value, index) => index === 0 || value >= dependencyProgress[index - 1],
  ),
)
assert.equal(parseSpeed('正在下载模型 42% · 8.2 MB/s'), '8.2MB/s')
assert.equal(parseSpeed('正在写入本地插件目录'), undefined)

console.log(
  JSON.stringify({
    modelProgress: modelProgress.slice(1),
    dependencyProgress: dependencyProgress.slice(1),
    status: 'passed',
  }),
)
