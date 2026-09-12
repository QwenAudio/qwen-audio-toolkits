import assert from 'node:assert/strict'
import {
  createConfirmAgentAction,
  hasConfirmableAgentRequest,
  inferAgentMessageAction,
} from '../src/domain/agentMessageActions'

const denoisePlan = [
  '收到，素材 `longanhuan.wav` 已就绪，降噪模型 DeepFilterNet3（rikorose.deepfilternet3）已安装，无需下载。',
  '',
  '处理计划：',
  '1. 读取 WAV 并解码为 PCM',
  '2. 调用 `audio.enhance`（adapter: deepfilternet）执行降噪',
  '3. 输出增强后的音频并展示前后对比（波形/频谱）',
  '',
  '请确认：是否保持原始采样率与时长、不做额外归一化？回复"确认"后我再给出可执行的参数方案（当前阶段仅规划，不会实际处理）。',
].join('\n')

const positiveCases = [
  denoisePlan,
  '请确认以上方案是否可以执行。',
  '如果没有问题，请点击确认继续生成参数。',
  '回复“确认”后我继续下一步。',
  '请确认：是否保留原始时长？',
  '确认后我会开始准备可执行方案。',
]

for (const content of positiveCases) {
  assert.equal(hasConfirmableAgentRequest(content), true, content)
  const action = createConfirmAgentAction(content)
  assert.equal(action?.kind, 'confirm-agent-plan')
  assert.equal(action?.status, 'pending')
  assert.equal(action?.confirmationText, '确认')
  assert.equal(inferAgentMessageAction(content)?.kind, 'confirm-agent-plan')
}

const negativeCases = [
  '无需确认，我会直接给出建议。',
  '不需要确认，下面只是参考说明。',
  '这个计划已经确认过，不再需要操作。',
  '普通回复，没有下一步确认请求。',
]

for (const content of negativeCases) {
  assert.equal(hasConfirmableAgentRequest(content), false, content)
  assert.equal(inferAgentMessageAction(content), undefined)
}

console.log(JSON.stringify({ status: 'passed', positives: positiveCases.length, negatives: negativeCases.length }, null, 2))

