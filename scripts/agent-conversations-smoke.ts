import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [serverSource, uiSource] = await Promise.all([
  readFile(new URL('../toolkits/server.py', import.meta.url), 'utf8'),
  readFile(new URL('../toolkits/ui.js', import.meta.url), 'utf8'),
])

assert.match(
  serverSource,
  /history_dir = history_root \/ agent_key/u,
  'the Agent server must keep per-agent history inside a dedicated directory',
)
assert.match(
  serverSource,
  /legacy_history\.replace\(history_dir \/ "default\.json"\)/u,
  'legacy single-file history must migrate into the default conversation',
)
assert.match(
  serverSource,
  /if route\.path == f"\/\{token\}\/conversations":/u,
  'the Agent server must expose a conversations listing endpoint',
)
assert.match(
  serverSource,
  /return None if cid is None else history_dir \/ f"\{cid\}\.json"/u,
  'conversation files must always resolve inside the history directory',
)

assert.match(
  uiSource,
  /new URLSearchParams\(location\.search\)\.get\("c"\)/u,
  'the Agent UI must read its conversation id from the page URL',
)
assert.match(
  uiSource,
  /fetch\(`history\?c=\$\{conversationId\}`/u,
  'history reads and writes must be scoped to the current conversation',
)
assert.match(
  uiSource,
  /type: "toolkits-conversations-changed"/u,
  'the Agent UI must notify the host when a conversation gains content',
)
assert.match(
  uiSource,
  /event\.data\?\.type !== "toolkits-conversations-request"/u,
  'the Agent UI must answer conversation list requests from the host',
)

console.log('agent conversations smoke passed')
