import type {
  ApiModelCatalogEntry,
  HarnessCatalog,
  ModelPlugin,
} from './types'

export const RETIRED_CLOUD_MODEL_IDS = new Set([
  'bailian-fun-audio-mss',
  'fun-audio-mss',
])

export function isRetiredCloudModelId(id: string): boolean {
  return RETIRED_CLOUD_MODEL_IDS.has(id)
}

export function cloudModelsFromCatalog(
  catalog: HarnessCatalog | null,
  installedModelIds: readonly string[] = [],
  remoteModels: readonly ApiModelCatalogEntry[] = [],
): ModelPlugin[] {
  if (!catalog) return []

  const installedIds = new Set(installedModelIds)
  const model = (
    id: string,
    name: string,
    author: string,
    description: string,
    capabilities: string[],
    harnessCapability: ModelPlugin['harnessCapabilities'][number],
    providerId: string,
    adapter: string,
    modelId: string,
    enabled: boolean,
    featured = false,
  ): ModelPlugin => ({
    id,
    name,
    author,
    engineAuthor: author,
    description,
    capabilities,
    harnessCapabilities: [harnessCapability],
    runtime: providerId === 'api.bailian' ? 'Bailian API' : 'Compatible API',
    acceleration: ['云端'],
    version: modelId,
    size: '',
    installed: installedIds.has(id),
    enabled,
    builtin: true,
    featured,
    installCount: 0,
    tone: 'violet',
    providerId,
    adapter,
    installPath: '',
    streamingMode: ['bailian-funasr', 'bailian-cosyvoice'].includes(adapter)
      ? 'streaming'
      : 'batch',
  })
  const result: ModelPlugin[] = []
  const bailian = catalog.providers.find((item) => item.id === 'api.bailian')
  if (bailian) {
    result.push(
      model(
        'bailian-fun-audio-denoising',
        'Fun Audio Denoising',
        '阿里云百炼',
        '面向录音、识别预处理和声音复刻素材的云端音频降噪服务，支持长音频与多种常用格式。',
        ['音频降噪', '文件处理', '最长 2 小时', '云端 API'],
        'audio.enhance',
        bailian.id,
        'bailian-audio-process',
        bailian.models.find((item) => item.id === 'fun-audio-denoising')
          ?.id ?? 'fun-audio-denoising',
        bailian.status === 'ready',
      ),
      model(
        'bailian-qwen-audio-tts',
        'Qwen Audio 3.0 TTS Flash',
        '阿里云百炼',
        '低延迟多语言语音合成模型，适合旁白、语音助手和内容生产，支持系统音色与自定义音色。',
        ['TTS', '中文', '多语言', '24 kHz'],
        'speech.synthesize',
        bailian.id,
        'bailian-tts',
        bailian.models.find(
          (item) => item.id === 'qwen-audio-3.0-tts-flash',
        )?.id ?? 'qwen-audio-3.0-tts-flash',
        bailian.status === 'ready',
      ),
      model(
        'bailian-qwen-audio-tts-plus',
        'Qwen Audio 3.0 TTS Plus',
        '阿里云百炼',
        '高质量多语言语音合成，支持系统音色、声音复刻与自然语言指令控制。',
        ['TTS', '高质量', '多语言', '声音复刻'],
        'speech.synthesize',
        bailian.id,
        'bailian-tts',
        bailian.models.find((item) => item.id === 'qwen-audio-3.0-tts-plus')
          ?.id ?? 'qwen-audio-3.0-tts-plus',
        bailian.status === 'ready',
      ),
      model(
        'bailian-cosyvoice-v2',
        'CosyVoice v2',
        '阿里云百炼',
        '低首包延迟的双向流式语音合成模型，支持中文与英文、系统音色和声音复刻。',
        ['TTS', '流式', '中文', '声音复刻'],
        'speech.synthesize',
        bailian.id,
        'bailian-cosyvoice',
        bailian.models.find((item) => item.id === 'cosyvoice-v2')?.id ??
          'cosyvoice-v2',
        bailian.status === 'ready',
        true,
      ),
      model(
        'bailian-cosyvoice-v3-plus',
        'CosyVoice v3 Plus',
        '阿里云百炼',
        '高质量多语言语音合成，支持系统音色、声音复刻和声音设计。',
        ['TTS', '高质量', '多语言', '声音复刻'],
        'speech.synthesize',
        bailian.id,
        'bailian-cosyvoice',
        bailian.models.find((item) => item.id === 'cosyvoice-v3-plus')?.id ??
          'cosyvoice-v3-plus',
        bailian.status === 'ready',
        true,
      ),
      model(
        'bailian-cosyvoice-v35-plus',
        'CosyVoice v3.5 Plus',
        '阿里云百炼',
        '面向高质量声音复刻与声音设计的 CosyVoice 新版本，支持指令控制。',
        ['TTS', '高质量', '声音复刻', '声音设计'],
        'speech.synthesize',
        bailian.id,
        'bailian-cosyvoice',
        bailian.models.find((item) => item.id === 'cosyvoice-v3.5-plus')
          ?.id ?? 'cosyvoice-v3.5-plus',
        bailian.status === 'ready',
        true,
      ),
      model(
        'bailian-cosyvoice-v35-flash',
        'CosyVoice v3.5 Flash',
        '阿里云百炼',
        '兼顾延迟与成本的声音复刻和声音设计模型，适合交互式语音应用。',
        ['TTS', '低延迟', '声音复刻', '声音设计'],
        'speech.synthesize',
        bailian.id,
        'bailian-cosyvoice',
        bailian.models.find((item) => item.id === 'cosyvoice-v3.5-flash')
          ?.id ?? 'cosyvoice-v3.5-flash',
        bailian.status === 'ready',
        true,
      ),
      model(
        'bailian-qwen3-asr',
        'Qwen3 ASR Flash',
        '阿里云百炼',
        '面向普通话、方言与多语言音频的快速识别模型，可直接处理录音和本地音频文件。',
        ['ASR', '多语言', '方言', '语种检测'],
        'speech.transcribe',
        bailian.id,
        'bailian-asr',
        bailian.models.find((item) => item.id === 'qwen3-asr-flash')?.id ??
          'qwen3-asr-flash',
        bailian.status === 'ready',
        true,
      ),
      model(
        'bailian-qwen-audio-asr-filetrans',
        'Qwen-Audio-3.0-ASR-Flash-Filetrans',
        '阿里云百炼',
        '面向会议、访谈和长录音的异步文件转写模型。本地音频会先上传到百炼临时存储，再获取带时间戳的完整识别结果。',
        ['ASR', '文件转写', '时间戳', '最长 12 小时', '多语言'],
        'speech.transcribe',
        bailian.id,
        'bailian-qwen-audio-asr',
        bailian.models.find(
          (item) => item.id === 'qwen-audio-3.0-asr-flash-filetrans',
        )?.id ?? 'qwen-audio-3.0-asr-flash-filetrans',
        bailian.status === 'ready',
        true,
      ),
      model(
        'bailian-qwen-audio-asr-flash',
        'Qwen-Audio-3.0-ASR-Flash',
        '阿里云百炼',
        '适合短音频快速识别，支持本地音频、语言提示、上下文增强以及句词级时间戳。',
        ['ASR', '快速识别', '时间戳', '最长 5 分钟', '多语言'],
        'speech.transcribe',
        bailian.id,
        'bailian-qwen-audio-asr',
        bailian.models.find(
          (item) => item.id === 'qwen-audio-3.0-asr-flash',
        )?.id ?? 'qwen-audio-3.0-asr-flash',
        bailian.status === 'ready',
        true,
      ),
      model(
        'bailian-funasr-realtime',
        'FunASR Realtime',
        '阿里云百炼',
        '面向会议、客服和方言场景的实时语音识别模型，支持 30 种语言、语义断句、上下文增强与词级时间戳。',
        ['ASR', '时间戳', '实时', '30 种语言'],
        'speech.transcribe',
        bailian.id,
        'bailian-funasr',
        bailian.models.find((item) => item.id === 'fun-asr-realtime')?.id ??
          'fun-asr-realtime',
        bailian.status === 'ready',
        true,
      ),
      model(
        'bailian-funasr-8k-realtime',
        'FunASR Flash 8K Realtime',
        '阿里云百炼',
        '为电话客服和语音信箱优化的 8 kHz 中文实时识别模型。',
        ['ASR', '时间戳', '实时', '8 kHz', '中文'],
        'speech.transcribe',
        bailian.id,
        'bailian-funasr',
        bailian.models.find(
          (item) => item.id === 'fun-asr-flash-8k-realtime',
        )?.id ?? 'fun-asr-flash-8k-realtime',
        bailian.status === 'ready',
      ),
      model(
        'bailian-paraformer-realtime-v2',
        'Paraformer Realtime v2',
        '阿里云百炼',
        '面向直播与会议的实时识别模型，支持中文方言及英、日、韩等语言。',
        ['ASR', '时间戳', '实时', '多语言', '热词'],
        'speech.transcribe',
        bailian.id,
        'bailian-funasr',
        bailian.models.find((item) => item.id === 'paraformer-realtime-v2')
          ?.id ?? 'paraformer-realtime-v2',
        bailian.status === 'ready',
      ),
      model(
        'bailian-paraformer-8k-realtime-v2',
        'Paraformer Realtime 8K v2',
        '阿里云百炼',
        '为 8 kHz 电话音频优化的中文实时识别模型。',
        ['ASR', '时间戳', '实时', '8 kHz', '中文'],
        'speech.transcribe',
        bailian.id,
        'bailian-funasr',
        bailian.models.find(
          (item) => item.id === 'paraformer-realtime-8k-v2',
        )?.id ?? 'paraformer-realtime-8k-v2',
        bailian.status === 'ready',
      ),
      model(
        'bailian-qwen36-plus',
        'Qwen3.6 Plus',
        '阿里云百炼',
        '兼顾质量、速度与成本的通用大模型，适合语音对话、摘要、改写和工作流中的文本推理。',
        ['LLM', '文本生成', '1M 上下文'],
        'text.generate',
        bailian.id,
        'bailian-llm',
        bailian.models.find((item) => item.id === 'qwen3.6-plus')?.id ??
          'qwen3.6-plus',
        bailian.status === 'ready',
      ),
      model(
        'bailian-qwen37-plus',
        'Qwen3.7 Plus',
        '阿里云百炼',
        '千问旗舰 Plus 模型，强化复杂推理、编码与智能体能力，适合高质量语音助手和复杂任务。',
        ['LLM', '旗舰', '1M 上下文'],
        'text.generate',
        bailian.id,
        'bailian-llm',
        bailian.models.find((item) => item.id === 'qwen3.7-plus')?.id ??
          'qwen3.7-plus',
        bailian.status === 'ready',
        true,
      ),
    )
  }

  const modelsById = new Map(result.map((item) => [item.id, item]))
  for (const entry of remoteModels) {
    if (
      isRetiredCloudModelId(entry.id) ||
      isRetiredCloudModelId(entry.modelId)
    ) {
      continue
    }
    if (entry.providerId !== 'api.bailian') continue
    const provider = catalog.providers.find(
      (item) => item.id === entry.providerId,
    )
    if (!provider) continue
    modelsById.set(entry.id, {
      id: entry.id,
      name: entry.name,
      author: entry.author,
      engineAuthor: entry.author,
      description: entry.description,
      capabilities: entry.capabilities,
      harnessCapabilities: [entry.harnessCapability],
      runtime:
        entry.providerId === 'api.bailian'
          ? 'Bailian API'
          : 'Compatible API',
      acceleration: ['云端'],
      version: entry.modelId,
      size: '',
      installed: installedIds.has(entry.id),
      enabled: provider.status === 'ready',
      builtin: true,
      featured: entry.featured,
      installCount: 0,
      tone: 'violet',
      providerId: entry.providerId,
      adapter: entry.adapter,
      installPath: '',
      catalogManaged: true,
      streamingMode: entry.streamingMode,
    })
  }
  return Array.from(modelsById.values())
}
