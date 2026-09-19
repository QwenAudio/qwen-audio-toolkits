import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(
  new URL('../src/views/PluginsView.tsx', import.meta.url),
  'utf8',
)

assert.match(
  source,
  /const catalogLoadTimeout = useRef<number \| null>\(null\)/u,
  'the catalog load timeout must be tracked in a ref shared by ready handling and effect cleanup',
)
assert.match(
  source,
  /const clearCatalogLoadTimeout = \(\) => \{\s*if \(catalogLoadTimeout\.current !== null\) \{\s*window\.clearTimeout\(catalogLoadTimeout\.current\)\s*catalogLoadTimeout\.current = null\s*\}\s*\}/u,
  'the shared timeout cleanup must clear and reset the tracked timer',
)
assert.match(
  source,
  /isReadyMessage\(event\.data\)[\s\S]*?clearCatalogLoadTimeout\(\)[\s\S]*?setReady\(true\)/u,
  'the accepted iframe-ready message must clear the catalog load timeout before marking ready',
)
assert.match(
  source,
  /return \(\) => \{\s*clearCatalogLoadTimeout\(\)\s*window\.removeEventListener\('message', receiveReady\)/u,
  'the catalog effect cleanup must clear the same timeout before removing listeners',
)

console.log(JSON.stringify({ status: 'passed', checks: 4 }, null, 2))
