import { capabilityDefinition } from './domain/capabilities'
import type { AgentProject, HarnessCapabilityId, PluginPortDefinition } from './types'

/** API projects own their model selection and contract; provider credentials are host services. */
export function apiAgentContract(
  task: string,
  adapter: string,
  capability: HarnessCapabilityId,
  modelId: string,
): { agent: AgentProject; inputs: PluginPortDefinition[]; outputs: PluginPortDefinition[] } {
  const definition = capabilityDefinition(capability)
  const inputType = definition.composer === 'text' ? 'text' : 'audio'
  return {
    agent: {
      task,
      harness: { kind: 'host-adapter', adapter, capability },
      usage: {
        inputRequirements: [
          inputType === 'text' ? '输入需要处理的文本。' : '提供本接口支持的音频输入。',
          `配置服务地址和凭据，确保账号可调用 ${modelId}。`,
          ...(capability === 'speech.synthesize' ? ['选择该接口支持的音色；自定义音色需先在当前服务创建。'] : []),
        ],
        limitations: [
          '需要联网；格式、时长、配额和计费由所选 API 服务决定。',
          '项目直接调用已配置的 API，不调用其他 Agent。',
          ...(capability === 'text.generate' ? ['生成内容需要复核，默认不会执行外部工具或操作。'] : []),
        ],
        examples: [`提交${inputType === 'text' ? '文本' : '音频'}，使用 ${modelId} 完成${definition.label}。`],
      },
    },
    inputs: [{ name: inputType, label: inputType === 'text' ? '文本' : '音频', type: inputType, modes: ['batch'] }],
    outputs: [{ name: 'result', label: definition.label, type: definition.outputType, modes: ['batch'] }],
  }
}
