import assert from 'node:assert/strict'
import { resolveRunnerAttribution } from '../src/domain/executionAttribution'

const bossPlugin = {
  name: 'Boss text model',
  providerId: 'api.boss',
  version: 'boss-v1',
}
const workbenchPlugin = {
  name: 'Workbench target model',
  providerId: 'api.workbench',
  version: 'workbench-v2',
}
const plugins = [bossPlugin, workbenchPlugin]

const workbenchText = resolveRunnerAttribution({
  mode: 'workbench',
  providerId: workbenchPlugin.providerId,
  modelId: workbenchPlugin.version,
  selectedPlugin: bossPlugin,
  plugins,
})
assert.deepEqual(workbenchText, {
  conversationProviderId: 'api.workbench',
  titlePluginName: 'Workbench target model',
  readsBossTextHistory: false,
  appendsBossTextHistory: false,
  includesSystemPrompt: false,
})

const workbenchSameProvider = resolveRunnerAttribution({
  mode: 'workbench',
  providerId: bossPlugin.providerId,
  modelId: 'workbench-on-boss-provider',
  selectedPlugin: bossPlugin,
  plugins: [
    bossPlugin,
    {
      name: 'Workbench shared-provider target',
      providerId: bossPlugin.providerId,
      version: 'workbench-on-boss-provider',
    },
  ],
})
assert.equal(workbenchSameProvider.conversationProviderId, bossPlugin.providerId)
assert.equal(workbenchSameProvider.readsBossTextHistory, false)
assert.equal(workbenchSameProvider.appendsBossTextHistory, false)
assert.equal(workbenchSameProvider.includesSystemPrompt, false)

const workbenchTitleFallback = resolveRunnerAttribution({
  mode: 'workbench',
  providerId: 'api.unknown',
  modelId: 'unknown-model',
  selectedPlugin: bossPlugin,
  plugins,
})
assert.equal(workbenchTitleFallback.titlePluginName, 'unknown-model')

const workbenchAudio = resolveRunnerAttribution({
  mode: 'workbench',
  providerId: workbenchPlugin.providerId,
  modelId: workbenchPlugin.version,
  selectedPlugin: bossPlugin,
  plugins,
})
assert.equal(workbenchAudio.conversationProviderId, workbenchPlugin.providerId)

const boss = resolveRunnerAttribution({
  mode: 'boss',
  providerId: workbenchPlugin.providerId,
  modelId: workbenchPlugin.version,
  selectedPlugin: bossPlugin,
  plugins,
})
assert.deepEqual(boss, {
  conversationProviderId: 'api.boss',
  titlePluginName: 'Boss text model',
  readsBossTextHistory: true,
  appendsBossTextHistory: true,
  includesSystemPrompt: true,
})

console.log('execution attribution smoke passed')
