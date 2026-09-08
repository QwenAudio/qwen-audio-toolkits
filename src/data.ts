import type {
  ModelPlugin,
  RuntimeStatus,
} from './types'

export function createWaveSamples(
  seed: number,
  count = 220,
  energy = 0.78,
): number[] {
  let value = seed * 997 + 17

  return Array.from({ length: count }, (_, index) => {
    value = (value * 16807) % 2147483647
    const noise = value / 2147483647
    const phrase =
      Math.sin(index * 0.13 + seed) * 0.23 +
      Math.sin(index * 0.037 + seed * 2) * 0.19
    const breath = Math.pow(Math.sin((index / count) * Math.PI), 0.35)
    const pause =
      index % 67 > 57 || (index > count * 0.43 && index < count * 0.47)
        ? 0.22
        : 1

    return Math.min(
      1,
      Math.max(0.06, (0.22 + noise * 0.54 + phrase) * breath * pause * energy),
    )
  })
}

export const initialPlugins: ModelPlugin[] = [
  {
    id: 'funaudiollm.sensevoice-small-gguf',
    agent: {"task": "将音频转换为文本，附带语言、情感和音频事件信息", "usage": {"inputRequirements": ["上传可解码的音频文件。", "首次运行前安装本项目所需的模型权重和运行时。"], "limitations": ["识别质量受噪声、方言和录音质量影响。", "本项目不生成会议纪要，也不区分说话人。"], "examples": ["上传中文录音，生成转写文本。", "识别中英混合音频并查看语言与情感标签。"]}, "harness": {"kind": "host-adapter", "adapter": "funasr-sensevoice-gguf", "capability": "speech.transcribe"}},
    inputs: [{"name": "audio", "label": "音频", "type": "audio", "modes": ["batch"]}],
    outputs: [{"name": "transcript", "label": "识别结果", "type": "transcript", "modes": ["batch"]}],
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
    variants: [
      {
        id: 'sensevoice-small-gguf-q8',
        name: 'SenseVoice Small',
        precision: 'Q8',
        size: '243 MB',
      },
    ],
    installPath: '',
  },
  {
    id: 'silero-vad',
    agent: {
      task: '独立检测录音中的人声与静音区间。',
      harness: { kind: 'host-adapter', adapter: 'silero-vad', capability: 'speech.detect' },
      usage: {
        inputRequirements: ['提供包含人声的音频。'],
        limitations: ['只检测语音片段，不识别文本或说话人身份。'],
        examples: ['定位录音中的发言起止时间。'],
      },
    },
    inputs: [{ name: 'audio', label: '音频', type: 'audio', modes: ['batch'] }],
    outputs: [{ name: 'segments', label: '语音片段', type: 'speech-segments', modes: ['batch'] }],
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
  },
]

export const fallbackRuntime: RuntimeStatus = {
  apiUrl: '127.0.0.1:3847',
  backend: 'Rust + sherpa-onnx',
  device: 'Apple Metal',
  platform: 'Browser preview',
  version: '0.1.14',
}
