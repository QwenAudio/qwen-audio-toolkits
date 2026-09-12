import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { acpModelPreview } from './dev/acpModels'

let middleware!: (request: IncomingMessage, response: ServerResponse) => void
const plugin = acpModelPreview()
assert.equal(plugin.apply, 'serve', 'the local process bridge must not be included in production builds')
if (typeof plugin.configureServer !== 'function') throw new Error('Missing development server hook')
await plugin.configureServer.call({} as never, { middlewares: { use: (path: string, handler: typeof middleware) => {
  assert.equal(path, '/__local/acp')
  middleware = handler
} } } as never)

function request(overrides: { method?: string; host?: string; origin?: string; remote?: string; header?: string; url?: string } = {}) {
  let body = ''
  const response = { statusCode: 200, setHeader: () => {}, end: (value = '') => { body = value } }
  middleware({ method: overrides.method ?? 'GET', url: overrides.url ?? '/providers',
    headers: { host: overrides.host ?? 'localhost:1420', origin: overrides.origin, 'x-qwenaudio-local': overrides.header ?? '1' },
    socket: { remoteAddress: overrides.remote ?? '::1' },
  } as IncomingMessage, response as unknown as ServerResponse)
  return { status: response.statusCode, body }
}
assert.equal(request().status, 200)
const providers = JSON.parse(request().body) as Array<{ id: string; available: boolean }>
assert.ok(providers.some(provider => provider.id === 'codex'))
assert.ok(providers.some(provider => provider.id === 'qoder'))
assert.ok(providers.every(provider => typeof provider.available === 'boolean'))
for (const input of [
  { header: '' }, { method: 'POST' }, { origin: 'https://another-site.example' },
  { host: 'another-site.example:1420' }, { remote: '192.168.1.10' },
]) assert.equal(request(input).status, 403)
assert.equal(request({ url: '/models?provider=arbitrary-command' }).status, 404)
console.log('ACP preview: development-only route, real executable discovery, loopback/origin checks, and fixed Agent allowlist passed.')
