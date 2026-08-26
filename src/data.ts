import type {
  AudioClip,
  ModelPlugin,
  ProcessingEffect,
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

export const initialClips: AudioClip[] = [
  {
    id: 'interview-main',
    name: '采访录音_主轨.wav',
    duration: 156.4,
    sampleRate: 48000,
    channels: 1,
    kind: 'recording',
    samples: createWaveSamples(3, 280, 0.92),
    color: '#827df8',
    sizeLabel: '28.6 MB',
    sourceLabel: '文件',
  },
  {
    id: 'room-tone',
    name: '环境底噪.wav',
    duration: 42.8,
    sampleRate: 48000,
    channels: 2,
    kind: 'recording',
    samples: createWaveSamples(9, 180, 0.34),
    color: '#e9b949',
    sizeLabel: '7.8 MB',
    sourceLabel: '录音',
  },
  {
    id: 'opening-music',
    name: 'opening_theme.flac',
    duration: 68.2,
    sampleRate: 44100,
    channels: 2,
    kind: 'music',
    samples: createWaveSamples(14, 240, 0.86),
    color: '#6c9cff',
    sizeLabel: '19.2 MB',
    sourceLabel: '文件',
  },
  {
    id: 'narration-alt',
    name: '旁白_第二版.wav',
    duration: 18.6,
    sampleRate: 24000,
    channels: 1,
    kind: 'generated',
    samples: createWaveSamples(21, 170, 0.74),
    color: '#ff765f',
    sizeLabel: '872 KB',
    sourceLabel: 'Kokoro',
  },
]

export const initialEffects: ProcessingEffect[] = [
  {
    id: 'denoise',
    name: '智能降噪',
    description: 'DPDFNet2 · 48 kHz 高保真',
    enabled: true,
    value: 58,
    valueLabel: '58%',
    tone: 'green',
  },
  {
    id: 'silence',
    name: '静音压缩',
    description: 'Silero VAD · 保留自然停顿',
    enabled: true,
    value: 40,
    valueLabel: '120 ms',
    tone: 'coral',
  },
  {
    id: 'loudness',
    name: '响度标准化',
    description: '门限语音 RMS · 峰值保护',
    enabled: true,
    value: 72,
    valueLabel: '-16 dB',
    tone: 'yellow',
  },
]

export const initialPlugins: ModelPlugin[] = [
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
  version: '0.1.8',
}
