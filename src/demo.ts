import { appAgentsWithInstallState, defaultInstalledAppAgentIds } from './appAgents'
import { createWaveSamples } from './data'
import type {
  AgentConversation,
  GeneralAgentMessage,
} from './domain/agents'
import type { SmartCutCandidate } from './domain/smartCut'
import type {
  AsrTranscriptionResult,
  HarnessCatalog,
  ModelPlugin,
  TextGenerateResult,
  VadDetectionResult,
} from './types'
import type { VideoDubbingTurn } from './services/videoDubbing'

export function isDemoMode(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).has('demo')
}

export const demoAppAgents: ModelPlugin[] = appAgentsWithInstallState(
  defaultInstalledAppAgentIds(),
)

export const demoPlugins: ModelPlugin[] = [
  {
    id: 'funaudiollm.sensevoice-small-gguf',
    name: 'SenseVoice Small GGUF',
    author: 'FunAudioLLM',
    engineAuthor: 'k2-fsa',
    description: '中英日韩粤语本地识别，使用 ModelScope 官方 GGUF 运行时。',
    capabilities: ['ASR', '多语言', 'GGUF'],
    harnessCapabilities: ['speech.transcribe'],
    runtime: 'funasr-llamacpp',
    acceleration: ['CPU'],
    version: 'official-0.1.9',
    size: '243 MB',
    installed: true,
    enabled: true,
    builtin: false,
    featured: true,
    tone: 'blue',
    providerId: 'plugin.funaudiollm.sensevoice-small-gguf',
    adapter: 'funasr-sensevoice-gguf',
    catalogManaged: true,
    streamingMode: 'batch',
    variants: [{ id: 'sensevoice-small-gguf-q8', name: 'SenseVoice Small', precision: 'Q8', size: '243 MB' }],
    installPath: '',
    inputs: [{ name: 'audio', label: '音频', type: 'audio', modes: ['batch'] }],
    outputs: [{ name: 'transcript', label: '识别结果', type: 'transcript', modes: ['batch'] }],
    agent: {
      task: '将音频转换为文本',
      usage: { inputRequirements: ['上传音频文件'], limitations: [], examples: [] },
      harness: { kind: 'host-adapter', adapter: 'funasr-sensevoice-gguf', capability: 'speech.transcribe' },
    },
  },
  {
    id: 'openai.whisper-medium-gguf',
    name: 'Whisper Medium GGUF',
    author: 'OpenAI',
    description: 'OpenAI Whisper 中等规模模型，支持 99 种语言语音识别。',
    capabilities: ['ASR', '多语言', 'GGUF'],
    harnessCapabilities: ['speech.transcribe'],
    runtime: 'funasr-llamacpp',
    acceleration: ['CPU', 'Apple Silicon'],
    version: '0.3',
    size: '1.5 GB',
    installed: false,
    enabled: false,
    builtin: false,
    tone: 'green',
    adapter: 'funasr-whisper-gguf',
    catalogManaged: true,
    streamingMode: 'batch',
    installPath: '',
    inputs: [{ name: 'audio', label: '音频', type: 'audio', modes: ['batch'] }],
    outputs: [{ name: 'transcript', label: '识别结果', type: 'transcript', modes: ['batch'] }],
    agent: {
      task: '将音频转换为文本',
      usage: { inputRequirements: ['上传音频文件'], limitations: [], examples: [] },
      harness: { kind: 'host-adapter', adapter: 'funasr-whisper-gguf', capability: 'speech.transcribe' },
    },
  },
  {
    id: 'silero-vad',
    name: 'Silero VAD',
    author: 'Silero',
    engineAuthor: 'k2-fsa',
    description: '独立检测语音区域、停顿和静音，并输出可定位、播放的时间片段。',
    capabilities: ['VAD', '时间片段'],
    harnessCapabilities: ['speech.detect'],
    runtime: 'sherpa-onnx',
    acceleration: ['CPU'],
    version: '5.1.2',
    size: '644 KB',
    installed: true,
    enabled: true,
    builtin: true,
    tone: 'yellow',
    providerId: 'local.silero-vad',
    adapter: 'silero-vad',
    installPath: '',
    inputs: [{ name: 'audio', label: '音频', type: 'audio', modes: ['batch'] }],
    outputs: [{ name: 'segments', label: '语音片段', type: 'speech-segments', modes: ['batch'] }],
    agent: {
      task: '检测语音与静音区间',
      usage: { inputRequirements: ['提供包含人声的音频'], limitations: [], examples: [] },
      harness: { kind: 'host-adapter', adapter: 'silero-vad', capability: 'speech.detect' },
    },
  },
  {
    id: 'funaudiollm.cosyvoice2-0.5b',
    name: 'CosyVoice 2 0.5B',
    author: 'FunAudioLLM',
    description: '零样本语音合成，支持中英日韩多语言和多种音色。',
    capabilities: ['TTS', '零样本', '流式'],
    harnessCapabilities: ['speech.synthesize'],
    runtime: 'cosyvoice-onnx',
    acceleration: ['CPU', 'Apple Silicon'],
    version: '2.0.1',
    size: '890 MB',
    installed: true,
    enabled: true,
    builtin: false,
    featured: true,
    tone: 'violet',
    providerId: 'plugin.funaudiollm.cosyvoice2-0.5b',
    adapter: 'cosyvoice2',
    catalogManaged: true,
    streamingMode: 'streaming',
    installPath: '',
    inputs: [{ name: 'text', label: '文本', type: 'text', modes: ['batch'] }],
    outputs: [{ name: 'audio', label: '合成音频', type: 'audio', modes: ['batch'] }],
    agent: {
      task: '将文本合成为自然语音',
      usage: { inputRequirements: ['输入待合成文本'], limitations: [], examples: [] },
      harness: { kind: 'host-adapter', adapter: 'cosyvoice2', capability: 'speech.synthesize' },
    },
  },
  {
    id: 'qwen.qwen2.5-7b-instruct-gguf',
    name: 'Qwen 2.5 7B Instruct',
    author: 'Alibaba Cloud',
    description: '通义千问 7B 指令模型，支持中英文文本生成和对话。',
    capabilities: ['LLM', '文本生成', 'GGUF'],
    harnessCapabilities: ['text.generate'],
    runtime: 'llamacpp',
    acceleration: ['CPU', 'Apple Silicon'],
    version: '2.5',
    size: '4.7 GB',
    installed: true,
    enabled: true,
    builtin: false,
    featured: true,
    tone: 'green',
    providerId: 'local.qwen2.5-7b',
    adapter: 'llamacpp-text',
    catalogManaged: true,
    streamingMode: 'streaming',
    installPath: '',
    inputs: [{ name: 'text', label: '文本', type: 'text', modes: ['batch'] }],
    outputs: [{ name: 'text', label: '生成文本', type: 'text', modes: ['batch'] }],
    agent: {
      task: '文本生成与对话',
      usage: { inputRequirements: ['输入提示词'], limitations: [], examples: [] },
      harness: { kind: 'host-adapter', adapter: 'llamacpp-text', capability: 'text.generate' },
    },
  },
  {
    id: 'rimelabs.deepfilternet',
    name: 'DeepFilterNet',
    author: 'Rimelabs',
    description: '基于深度学习的实时音频降噪和增强。',
    capabilities: ['音频增强', '降噪'],
    harnessCapabilities: ['audio.enhance'],
    runtime: 'ort',
    acceleration: ['CPU'],
    version: '0.5',
    size: '82 MB',
    installed: false,
    enabled: false,
    builtin: false,
    tone: 'coral',
    adapter: 'deepfilternet',
    catalogManaged: true,
    installPath: '',
    inputs: [{ name: 'audio', label: '音频', type: 'audio', modes: ['batch'] }],
    outputs: [{ name: 'audio', label: '增强音频', type: 'audio', modes: ['batch'] }],
    agent: {
      task: '音频降噪增强',
      usage: { inputRequirements: ['上传含噪声的音频'], limitations: [], examples: [] },
      harness: { kind: 'host-adapter', adapter: 'deepfilternet', capability: 'audio.enhance' },
    },
  },
  {
    id: 'funaudiollm.chinese-tn',
    name: '中文文本规范化',
    author: 'FunAudioLLM',
    description: '中文文本逆规范化（ITN），将口语数字、日期等转换为书面格式。',
    capabilities: ['TN', 'ITN', '中文'],
    harnessCapabilities: ['text.normalize'],
    runtime: 'python',
    acceleration: ['CPU'],
    version: '1.0.0',
    size: '12 MB',
    installed: true,
    enabled: true,
    builtin: false,
    tone: 'yellow',
    providerId: 'local.chinese-tn',
    adapter: 'chinese-tn',
    catalogManaged: true,
    installPath: '',
    inputs: [{ name: 'text', label: '文本', type: 'text', modes: ['batch'] }],
    outputs: [{ name: 'text', label: '规范化文本', type: 'text', modes: ['batch'] }],
    agent: {
      task: '中文文本规范化',
      usage: { inputRequirements: ['输入口语化中文文本'], limitations: [], examples: [] },
      harness: { kind: 'host-adapter', adapter: 'chinese-tn', capability: 'text.normalize' },
    },
  },
  {
    id: 'api.dashscope.qwen-max',
    name: 'Qwen-Max (百炼)',
    author: '阿里云',
    description: '通义千问旗舰模型，通过百炼 API 调用，支持复杂推理和长文本生成。',
    capabilities: ['LLM', '云端 API', '长文本'],
    harnessCapabilities: ['text.generate'],
    runtime: 'api',
    acceleration: ['云端 API'],
    version: '2.5',
    size: '',
    installed: true,
    enabled: true,
    builtin: false,
    tone: 'blue',
    providerId: 'api.dashscope',
    adapter: 'api-llm',
    catalogManaged: false,
    streamingMode: 'streaming',
    installPath: '',
    inputs: [{ name: 'text', label: '文本', type: 'text', modes: ['batch'] }],
    outputs: [{ name: 'text', label: '生成文本', type: 'text', modes: ['batch'] }],
    agent: {
      task: '云端文本生成',
      usage: { inputRequirements: ['配置 API 密钥'], limitations: [], examples: [] },
      harness: { kind: 'host-adapter', adapter: 'api-llm', capability: 'text.generate' },
    },
  },
]

export const demoCatalog: HarnessCatalog = {
  capabilities: [
    { id: 'speech.transcribe', name: '语音识别', description: '语音转文字', input: 'audio', output: 'transcript', supportsBatch: true, supportsStreaming: false },
    { id: 'speech.detect', name: '语音检测', description: '检测语音区间', input: 'audio', output: 'speech-segments', supportsBatch: true, supportsStreaming: false },
    { id: 'speech.synthesize', name: '语音合成', description: '文字转语音', input: 'text', output: 'audio', supportsBatch: true, supportsStreaming: false },
    { id: 'text.generate', name: '文本生成', description: '根据提示生成文本', input: 'text', output: 'text', supportsBatch: true, supportsStreaming: true },
    { id: 'audio.enhance', name: '音频增强', description: '增强人声', input: 'audio', output: 'audio', supportsBatch: true, supportsStreaming: false },
    { id: 'text.normalize', name: '文本规范化', description: '规范文本格式', input: 'text', output: 'text', supportsBatch: true, supportsStreaming: false },
    { id: 'speaker.diarize', name: '说话人分离', description: '标记说话人区间', input: 'audio', output: 'speaker-segments', supportsBatch: true, supportsStreaming: false },
  ],
  providers: [
    {
      id: 'plugin.funaudiollm.sensevoice-small-gguf',
      name: 'SenseVoice Small',
      kind: 'plugin',
      runtime: 'funasr-llamacpp',
      status: 'ready',
      configured: true,
      local: true,
      capabilities: ['speech.transcribe'],
      models: [{ id: 'sensevoice-small-gguf-q8', name: 'SenseVoice Small Q8', installed: true, loaded: false }],
    },
    {
      id: 'plugin.funaudiollm.cosyvoice2-0.5b',
      name: 'CosyVoice 2',
      kind: 'plugin',
      runtime: 'cosyvoice-onnx',
      status: 'ready',
      configured: true,
      local: true,
      capabilities: ['speech.synthesize'],
      models: [{ id: 'cosyvoice2-0.5b', name: 'CosyVoice 2 0.5B', installed: true, loaded: false }],
    },
    {
      id: 'local.qwen2.5-7b',
      name: 'Qwen 2.5 7B',
      kind: 'local-model',
      runtime: 'llamacpp',
      status: 'ready',
      configured: true,
      local: true,
      capabilities: ['text.generate'],
      models: [{ id: 'qwen2.5-7b-instruct-q4', name: 'Qwen 2.5 7B Q4', installed: true, loaded: false }],
    },
  ],
}

const now = Date.now()

export const demoMessages: GeneralAgentMessage[] = [
  {
    id: 'demo-msg-1',
    role: 'user',
    content: '帮我把这个视频里的口水词和静音删掉，然后导出带字幕的视频',
    createdAt: now - 120_000,
  },
  {
    id: 'demo-msg-2',
    role: 'assistant',
    content: '好的，我来帮你处理视频剪辑。需要先安装以下模型来支持语音识别和视频处理：',
    createdAt: now - 115_000,
    action: {
      id: 'demo-action-install',
      kind: 'install-on-demand-model',
      status: 'done',
      modelId: 'funaudiollm.sensevoice-small-gguf',
      modelName: 'SenseVoice Small GGUF',
      capability: 'speech.transcribe',
      needLabel: '语音识别',
      actionLabel: '安装',
      prompt: '帮我把这个视频里的口水词和静音删掉',
      selectedModeName: '视频剪辑',
      attachmentHint: '',
    },
  },
  {
    id: 'demo-msg-3',
    role: 'assistant',
    content: '模型已安装。以下是剪辑方案，包含 3 个步骤：',
    createdAt: now - 100_000,
    action: {
      id: 'demo-action-plan',
      kind: 'structured-agent-plan',
      status: 'done',
      confirmationText: '确认执行剪辑方案',
      steps: [
        { id: 'step-1', capability: 'speech.transcribe', description: '识别视频中的语音内容', status: 'done', result: '识别完成，共 8 段语音' },
        { id: 'step-2', capability: 'speech.detect', description: '检测静音段和口水词', status: 'done', result: '发现 5 处口水词和 3 处静音' },
        { id: 'step-3', capability: 'text.generate', description: '生成剪辑方案并导出', status: 'done', result: '已生成剪辑视频和字幕文件' },
      ],
    },
  },
  {
    id: 'demo-msg-4',
    role: 'assistant',
    content: '剪辑完成！已删除 5 处口水词（嗯、啊、那个）和 3 处长静音段，视频时长从 2:00 缩短到 1:42。你可以在右侧预览剪辑结果。',
    createdAt: now - 60_000,
  },
]

export const demoConversations: AgentConversation[] = [
  {
    id: 'demo-smart-cut',
    mode: 'smart-cut',
    title: '删除口水词和静音',
    prompt: '删除口水词和静音',
    sourcePath: '/demo/interview.mp4',
  },
  {
    id: 'demo-podcast',
    mode: 'ai-podcast',
    title: 'AI 播客制作',
    prompt: '把这篇论文做成双人播客',
    sourcePath: '',
  },
  {
    id: 'demo-dubbing',
    mode: 'video-dubbing',
    title: '产品演示配音',
    prompt: '翻译成英文配音',
    sourcePath: '/demo/product-demo.mp4',
    videoDubbingMode: 'translate',
    videoDubbingLanguages: { source: 'zh', target: 'en' },
    videoDubbingStyle: 'natural',
  },
  {
    id: 'demo-meeting',
    mode: 'meeting-notes',
    title: '项目周会纪要',
    prompt: '记录项目周会，整理进展和行动项',
    sourcePath: '',
  },
  {
    id: 'demo-chat',
    mode: 'agent-chat',
    title: 'Agent 对话',
    prompt: '你好，介绍一下你自己',
    sourcePath: '',
  },
]

export const demoTranscription: AsrTranscriptionResult = {
  clipName: 'interview.mp4',
  text: '大家好，欢迎来到今天的访谈节目。今天我们有幸邀请到了张教授，来聊一聊人工智能的最新发展。张教授您好，请您先跟观众打个招呼。好的，大家好，我是张明远，目前在做自然语言处理方向的研究。很高兴能来到这里跟大家交流。',
  language: 'zh',
  duration: 120,
  speechSeconds: 98.4,
  waveform: createWaveSamples(42),
  segments: [
    { id: 'seg-1', start: 0.2, end: 4.8, text: '大家好，欢迎来到今天的访谈节目。', tokens: [{ text: '大家', start: 0.2, end: 0.6 }, { text: '好', start: 0.6, end: 0.9 }, { text: '，', start: 0.9, end: 1.0 }, { text: '欢迎', start: 1.0, end: 1.5 }, { text: '来到', start: 1.5, end: 1.9 }, { text: '今天', start: 1.9, end: 2.3 }, { text: '的', start: 2.3, end: 2.5 }, { text: '访谈', start: 2.5, end: 3.2 }, { text: '节目', start: 3.2, end: 3.8 }, { text: '。', start: 3.8, end: 4.0 }] },
    { id: 'seg-2', start: 5.1, end: 12.3, text: '今天我们有幸邀请到了张教授，来聊一聊人工智能的最新发展。', tokens: [{ text: '今天', start: 5.1, end: 5.5 }, { text: '我们', start: 5.5, end: 5.9 }, { text: '有幸', start: 5.9, end: 6.4 }, { text: '邀请', start: 6.4, end: 7.0 }, { text: '到了', start: 7.0, end: 7.4 }, { text: '张', start: 7.4, end: 7.7 }, { text: '教授', start: 7.7, end: 8.3 }, { text: '，', start: 8.3, end: 8.5 }, { text: '来', start: 8.5, end: 8.8 }, { text: '聊一聊', start: 8.8, end: 9.4 }, { text: '人工智能', start: 9.4, end: 10.4 }, { text: '的', start: 10.4, end: 10.6 }, { text: '最新', start: 10.6, end: 11.2 }, { text: '发展', start: 11.2, end: 11.8 }, { text: '。', start: 11.8, end: 12.0 }] },
    { id: 'seg-3', start: 13.0, end: 19.5, text: '张教授您好，请您先跟观众打个招呼。', tokens: [{ text: '张', start: 13.0, end: 13.3 }, { text: '教授', start: 13.3, end: 13.8 }, { text: '您好', start: 13.8, end: 14.3 }, { text: '，', start: 14.3, end: 14.5 }, { text: '请', start: 14.5, end: 14.8 }, { text: '您', start: 14.8, end: 15.1 }, { text: '先', start: 15.1, end: 15.4 }, { text: '跟', start: 15.4, end: 15.7 }, { text: '观众', start: 15.7, end: 16.3 }, { text: '打个', start: 16.3, end: 16.7 }, { text: '招呼', start: 16.7, end: 17.3 }, { text: '。', start: 17.3, end: 17.5 }] },
    { id: 'seg-4', start: 20.8, end: 30.2, text: '好的，大家好，我是张明远，目前在做自然语言处理方向的研究。很高兴能来到这里跟大家交流。', tokens: [{ text: '好的', start: 20.8, end: 21.3 }, { text: '，', start: 21.3, end: 21.5 }, { text: '大家', start: 21.5, end: 21.9 }, { text: '好', start: 21.9, end: 22.2 }, { text: '，', start: 22.2, end: 22.4 }, { text: '我', start: 22.4, end: 22.6 }, { text: '是', start: 22.6, end: 22.9 }, { text: '张明远', start: 22.9, end: 23.7 }, { text: '，', start: 23.7, end: 23.9 }, { text: '目前', start: 23.9, end: 24.4 }, { text: '在做', start: 24.4, end: 24.8 }, { text: '自然语言', start: 24.8, end: 25.6 }, { text: '处理', start: 25.6, end: 26.1 }, { text: '方向', start: 26.1, end: 26.6 }, { text: '的', start: 26.6, end: 26.8 }, { text: '研究', start: 26.8, end: 27.4 }, { text: '。', start: 27.4, end: 27.6 }] },
  ],
  inferenceSeconds: 2.3,
  realTimeFactor: 0.019,
  engine: 'funasr-sensevoice-gguf',
}

export const demoVad: VadDetectionResult = {
  clipName: 'interview.mp4',
  duration: 120,
  speechSeconds: 98.4,
  silenceSeconds: 21.6,
  segments: [
    { id: 'vad-1', start: 0.2, end: 4.8, duration: 4.6 },
    { id: 'vad-2', start: 5.1, end: 12.3, duration: 7.2 },
    { id: 'vad-3', start: 13.0, end: 19.5, duration: 6.5 },
    { id: 'vad-4', start: 20.8, end: 30.2, duration: 9.4 },
    { id: 'vad-5', start: 32.0, end: 45.6, duration: 13.6 },
    { id: 'vad-6', start: 47.1, end: 62.8, duration: 15.7 },
  ],
  waveform: createWaveSamples(42),
  inferenceSeconds: 0.3,
  realTimeFactor: 0.003,
  threshold: 0.5,
  engine: 'silero-vad',
}

export const demoCandidates: SmartCutCandidate[] = [
  { id: 'c1', reason: 'filler', start: 4.8, end: 5.1, label: '口水词「嗯」', detail: '语气词', confidence: 'high', selected: true },
  { id: 'c2', reason: 'silence', start: 12.3, end: 13.0, label: '停顿', detail: '0.7 秒无语音', confidence: 'high', selected: true },
  { id: 'c3', reason: 'filler', start: 19.5, end: 20.8, label: '口水词「那个」', detail: '填充词', confidence: 'high', selected: true },
  { id: 'c4', reason: 'silence', start: 30.2, end: 32.0, label: '停顿', detail: '1.8 秒无语音', confidence: 'high', selected: true },
  { id: 'c5', reason: 'filler', start: 45.6, end: 46.1, label: '口水词「啊」', detail: '语气词', confidence: 'medium', selected: true },
  { id: 'c6', reason: 'silence', start: 62.8, end: 65.5, label: '停顿', detail: '2.7 秒无语音', confidence: 'high', selected: false },
]

export const demoPodcastScript: TextGenerateResult = {
  text: `**主持人**：大家好，欢迎收听今天的科技播客。今天我们来聊一聊大语言模型的最新进展。

**专家**：好的，很高兴来到这里。最近这个领域确实发展得非常快。

**主持人**：那我们先从 Transformer 架构说起吧，最近有什么新的突破吗？

**专家**：有的。最近的 MoE 架构，也就是混合专家模型，在保持推理效率的同时大幅提升了模型容量。像 Mixtral 和 Qwen 都采用了这种方案。

**主持人**：听起来很有意思。那对于普通用户来说，这些技术进步带来了什么实际好处呢？

**专家**：最直接的好处就是模型变小了，但能力更强了。以前需要几十 GB 显存才能跑的模型，现在在笔记本电脑上就能运行。

**主持人**：确实，我们也看到很多开源模型在本地运行的效果越来越好了。

**专家**：没错。而且多模态能力也在快速发展，现在的模型不仅能处理文本，还能理解图像、音频甚至视频。

**主持人**：感谢张教授的分享，今天的节目就到这里，我们下期再见。`,
  model: 'qwen2.5-7b-instruct',
  engine: 'demo',
  inferenceSeconds: 8.5,
  inputTokens: 450,
  outputTokens: 620,
}

export const demoVideoDubbingTurns: VideoDubbingTurn[] = [
  { id: 'd1', speaker: 'SPK 1', start: 0.0, end: 5.2, sourceText: '欢迎大家来到产品发布会', text: 'Welcome everyone to the product launch event', rhythmSegments: [{ id: 'r1', start: 0.0, end: 5.2, sourceText: '欢迎大家来到产品发布会', text: 'Welcome everyone to the product launch event' }] },
  { id: 'd2', speaker: 'SPK 1', start: 5.8, end: 11.3, sourceText: '今天我们带来了几项重要更新', text: 'Today we have several important updates to share', rhythmSegments: [{ id: 'r2', start: 5.8, end: 11.3, sourceText: '今天我们带来了几项重要更新', text: 'Today we have several important updates to share' }] },
  { id: 'd3', speaker: 'SPK 1', start: 12.1, end: 19.8, sourceText: '首先是我们的语音识别引擎升级到了最新版本', text: "First, our speech recognition engine has been upgraded to the latest version", rhythmSegments: [{ id: 'r3a', start: 12.1, end: 15.5, sourceText: '首先是我们的语音识别引擎', text: "First, our speech recognition engine" }, { id: 'r3b', start: 15.5, end: 19.8, sourceText: '升级到了最新版本', text: 'has been upgraded to the latest version' }] },
  { id: 'd4', speaker: 'SPK 1', start: 20.5, end: 28.2, sourceText: '新引擎支持九十九种语言，识别准确率提升了百分之十五', text: 'The new engine supports 99 languages with a 15 percent improvement in accuracy', rhythmSegments: [{ id: 'r4', start: 20.5, end: 28.2, sourceText: '新引擎支持九十九种语言，识别准确率提升了百分之十五', text: 'The new engine supports 99 languages with a 15 percent improvement in accuracy' }] },
  { id: 'd5', speaker: 'SPK 1', start: 29.0, end: 36.5, sourceText: '接下来我来给大家做一个现场演示', text: "Now let me give you a live demonstration", rhythmSegments: [{ id: 'r5', start: 29.0, end: 36.5, sourceText: '接下来我来给大家做一个现场演示', text: "Now let me give you a live demonstration" }] },
  { id: 'd6', speaker: 'SPK 1', start: 37.2, end: 45.8, sourceText: '大家可以看到，实时转写的速度非常快', text: 'As you can see, the real-time transcription is extremely fast', rhythmSegments: [{ id: 'r6', start: 37.2, end: 45.8, sourceText: '大家可以看到，实时转写的速度非常快', text: 'As you can see, the real-time transcription is extremely fast' }] },
]

/** Fake editor results are isolated to the task gallery and never touch saved projects. */
export function demoProjectSnapshot(projectId: string | undefined): unknown {
  if (!isDemoMode() || new URLSearchParams(window.location.search).get('demo') !== 'tasks') return null
  if (projectId === 'demo-smart-cut') return {
    version: 1, stage: 'review', instruction: '删除口水词和静音', plannerName: 'Qoder',
    media: { sourcePath: '/demo/interview.mp4', sourceName: 'interview.mp4', audioPath: '', duration: 120, width: 1920, height: 1080, fps: 30, sizeBytes: 18000000, hasAudio: true },
    transcription: demoTranscription, vadResult: demoVad, candidates: demoCandidates, samples: demoTranscription.waveform,
    includeSubtitles: true,
  }
  if (projectId === 'demo-podcast') return {
    version: 1, instruction: '把这篇论文做成双人播客', sourcePath: '/demo/AI研究.md',
    source: { fileName: 'AI研究.md', text: '大语言模型通过混合专家架构提高推理效率，端侧模型也在不断发展。', characterCount: 42, truncated: false },
    script: { title: '大模型的新进展：从云端到你的电脑', language: 'zh-CN', turns: [
      { id: 'p1', speaker: 'A', text: '欢迎收听。今天我们聊聊大语言模型的新进展，以及它们如何走进日常生活。' },
      { id: 'p2', speaker: 'B', text: '一个值得关注的方向是混合专家架构：按需启用部分网络，在保持能力的同时减少计算量。' },
      { id: 'p3', speaker: 'A', text: '这是否意味着，我们能在自己的电脑上使用更强的模型？' },
      { id: 'p4', speaker: 'B', text: '是的，但具体体验仍取决于硬件、模型大小和任务。对于隐私敏感的文档，本地处理尤其有价值。' },
    ] },
    speakerAName: '主持人', speakerBName: '嘉宾', speed: 1, voiceA: '0', voiceB: '1',
  }
  if (projectId === 'demo-meeting') return {
    version: 1, source: 'microphone', elapsed: 1560, summaryView: 'notes',
    turns: [
      { id: 'm1', start: 0, end: 12, speaker: 1, text: '今天确认发布范围，先交付视频剪辑和播客的完整流程。' },
      { id: 'm2', start: 15, end: 28, speaker: 2, text: '交互统一由 Agent 对话推进，右侧只展示生成结果。' },
      { id: 'm3', start: 32, end: 46, speaker: 1, text: '小李负责本周五前完成回归测试，小王更新使用文档。' },
    ],
    summary: '## 当前结论\n先交付视频剪辑和 AI 播客；统一采用对话驱动流程。\n\n## 讨论要点\n右侧仅展示产物，素材和模型问题在对话中处理。\n\n## 行动项\n- 小李：本周五前完成回归测试。\n- 小王：更新使用文档。\n\n## 待确认问题\n正式发布时间待回归结果确认。',
  }
  return null
}
