import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const requiredFiles = [
  'README.md',
  'LICENSE',
  'NOTICE',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'PRIVACY.md',
  'THIRD_PARTY_NOTICES.md',
  'CHANGELOG.md',
]
const markdownFiles = [
  ...requiredFiles.filter((file) => file.endsWith('.md')),
  ...fs
    .readdirSync(path.join(root, 'docs'))
    .filter((file) => file.endsWith('.md'))
    .map((file) => `docs/${file}`),
]
const forbiddenPatterns = [
  ['internal npm registry', /registry\.anpm\.alibaba-inc\.com/i],
  ['internal GitLab URL', /gitlab\.alibaba-inc\.com/i],
  ['OAuth token in URL', /https?:\/\/oauth2:[^@\s]+@/i],
  ['cloud secret key', /\bsk-[A-Za-z0-9._-]{12,}\b/],
  ['ModelScope access token', /\bms-[A-Za-z0-9-]{20,}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
]
const textExtensions = new Set([
  '',
  '.css',
  '.html',
  '.json',
  '.md',
  '.mjs',
  '.rs',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.xml',
  '.yml',
  '.yaml',
])
const failures = []

for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) failures.push(`missing ${file}`)
}

const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard'],
  { cwd: root, encoding: 'utf8' },
)
  .trim()
  .split('\n')
  .filter(Boolean)

for (const file of files) {
  const absolute = path.join(root, file)
  if (!fs.existsSync(absolute)) continue
  const stat = fs.statSync(absolute)
  if (stat.size > 10 * 1024 * 1024) {
    failures.push(`${file}: tracked file exceeds 10 MiB`)
  }
  if (!textExtensions.has(path.extname(file).toLowerCase())) continue
  const text = fs.readFileSync(absolute, 'utf8')
  for (const [label, pattern] of forbiddenPatterns) {
    if (pattern.test(text)) failures.push(`${file}: ${label}`)
  }
}

for (const file of markdownFiles) {
  const absolute = path.join(root, file)
  if (!fs.existsSync(absolute)) continue
  const text = fs.readFileSync(absolute, 'utf8')
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0]
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue
    const resolved = path.resolve(path.dirname(absolute), target)
    if (!fs.existsSync(resolved)) failures.push(`${file}: broken link ${target}`)
  }
}

const catalog = JSON.parse(
  fs.readFileSync(path.join(root, 'catalog/model-catalog.json'), 'utf8'),
)
for (const plugin of catalog.plugins ?? []) {
  if (!plugin.license?.trim()) {
    failures.push(`catalog: ${plugin.id} has no SPDX license`)
  }
  if (!plugin.publisher?.trim()) {
    failures.push(`catalog: ${plugin.id} has no publisher`)
  }
}

for (const file of files.filter((file) => file.endsWith('/plugin.json'))) {
  const plugin = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
  if (!plugin.license?.trim()) failures.push(`${file}: no SPDX license`)
}

if (failures.length) {
  console.error(`Open-source check failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}

console.log(
  `Open-source check passed (${files.length} files, ${catalog.plugins?.length ?? 0} catalog plugins).`,
)
