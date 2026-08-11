import fs from 'node:fs'
import {
  appDataPath,
  audioInput,
  firstExistingPath,
  macEnglishSpeechFixture,
  modelRepositoryPath,
  resolveAudioPath,
} from './lib/model-smoke-fixtures.mjs'

const api = process.env.QWEN_AUDIO_TOOLKITS_API ?? 'http://127.0.0.1:3847/v1'
const speechFile = appDataPath('recordings/smoke-speech.wav')
const noisyFile = appDataPath(
  'recordings/test_with_noise_48k-1785405269614.wav',
)
const taggingFile = appDataPath(
  'plugins/k2-fsa.audio-tagging/models/ced-tiny-int8/test_wavs/10.wav',
)
const keywordFile = appDataPath(
  'plugins/k2-fsa.keyword-spotting/models/kws-zh-en-int8/test_wavs/en_0.wav',
)
const sourceKeywordFile = modelRepositoryPath(
  'k2-fsa.keyword-spotting/kws-zh-en-int8/test_wavs/en_0.wav',
)
const voiceRegistryFile = appDataPath('providers/bailian-voices.json')

function savedVoice(targetModel) {
  if (!fs.existsSync(voiceRegistryFile)) return ''
  const voices = JSON.parse(fs.readFileSync(voiceRegistryFile, 'utf8'))
  return (
    voices.find(
      (voice) =>
        (voice.targetModel ?? voice.target_model) === targetModel &&
        voice.status === 'OK',
    )?.id ?? ''
  )
}

async function json(url, options) {
  const response = await fetch(url, options)
  if (!response.ok) throw new Error(await response.text())
  return response.json()
}

async function execute(request, timeoutMs = 10 * 60_000) {
  const run = await json(`${api}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const current = await json(`${api}/runs/${run.id}`)
    if (current.status === 'completed') {
      return json(`${api}/runs/${run.id}/output`)
    }
    if (current.status === 'failed' || current.status === 'canceled') {
      throw new Error(current.error ?? `run ${current.status}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`run timeout: ${request.title}`)
}

function summary(output) {
  const value = output.output ?? output
  return {
    engine: value.engine ?? value.model,
    duration: value.duration,
    inferenceSeconds: value.inferenceSeconds,
    realTimeFactor: value.realTimeFactor,
    textLength: typeof value.text === 'string' ? value.text.length : undefined,
    segmentCount: Array.isArray(value.segments)
      ? value.segments.length
      : undefined,
    speakerLabels: Array.isArray(value.segments)
      ? [...new Set(value.segments.map((segment) => segment.speaker).filter(Boolean))]
      : undefined,
    tagCount: Array.isArray(value.tags) ? value.tags.length : undefined,
    trackCount: Array.isArray(value.tracks) ? value.tracks.length : undefined,
    embeddingSize: Array.isArray(value.embedding)
      ? value.embedding.length
      : undefined,
    detected: typeof value.detected === 'boolean' ? value.detected : undefined,
    hasAudio: Boolean(value.dataUrl || value.filePath || value.sourceFilePath),
  }
}

const defaultSpeechFile = resolveAudioPath(
  [process.env.QWEN_AUDIO_TOOLKITS_SPEECH_WAV, speechFile],
  'speech',
)
const defaultNoisyFile = resolveAudioPath(
  [process.env.QWEN_AUDIO_TOOLKITS_NOISY_WAV, noisyFile, defaultSpeechFile],
  'noisy',
)
const speech = audioInput(defaultSpeechFile)
const noisy = audioInput(defaultNoisyFile, defaultSpeechFile)
const tagging = audioInput(taggingFile, defaultSpeechFile)
const keywordFixture = firstExistingPath([
  process.env.QWEN_AUDIO_TOOLKITS_KEYWORD_WAV,
  keywordFile,
  sourceKeywordFile,
])
const keyword = keywordFixture ? audioInput(keywordFixture) : speech
const canaryFixture = macEnglishSpeechFixture(
  process.env.QWEN_AUDIO_TOOLKITS_CANARY_WAV,
)
const canary = canaryFixture ? audioInput(canaryFixture) : null
const englishSpeech = canary ?? speech
const text = '今天下午三点开会预算是一千七百九十九元请提前十分钟到'

const localTests = [
  {
    name: 'VITS AISHELL3 中文',
    request: {
      capability: 'speech.synthesize',
      providerId: 'plugin.k2-fsa.vits-aishell3',
      routing: 'local',
      title: 'Smoke · VITS AISHELL3',
      input: { text: '你好，这是本地语音合成测试。' },
      parameters: { sid: 3, speed: 1 },
    },
  },
  {
    name: 'SenseVoice Small',
    request: {
      capability: 'speech.transcribe',
      providerId: 'plugin.funaudiollm.sensevoice-small-gguf',
      routing: 'local',
      title: 'Smoke · SenseVoice',
      input: speech,
      parameters: { language: 'auto' },
    },
  },
  {
    name: 'Silero VAD',
    request: {
      capability: 'speech.detect',
      providerId: 'local.silero-vad',
      routing: 'local',
      title: 'Smoke · Silero VAD',
      input: speech,
      parameters: {
        threshold: 0.25,
        minSpeechDuration: 0.18,
        minSilenceDuration: 0.3,
      },
    },
  },
  {
    name: 'FSMN-VAD GGUF',
    request: {
      capability: 'speech.detect',
      providerId: 'plugin.funaudiollm.fsmn-vad-gguf',
      routing: 'local',
      title: 'Smoke · FSMN-VAD GGUF',
      input: speech,
      parameters: {},
    },
  },
  {
    name: 'Canary 180M Flash',
    skipReason: canary ? undefined : '缺少英文音频样本',
    request: {
      capability: 'speech.transcribe',
      providerId: 'plugin.nvidia.canary-180m-flash',
      routing: 'local',
      title: 'Smoke · Canary 180M Flash',
      input: canary ?? speech,
      parameters: {
        sourceLanguage: 'en',
        targetLanguage: 'en',
        punctuation: true,
      },
    },
  },
  {
    name: 'Fun-CosyVoice3 Local',
    request: {
      capability: 'speech.synthesize',
      providerId: 'plugin.lourdle.fun-cosyvoice3-local',
      routing: 'local',
      title: 'Smoke · Fun-CosyVoice3 Local',
      input: { text: '你好，这是本地音色克隆测试。' },
      parameters: {
        speed: 1,
        referenceAudioDataUrl: speech.audioDataUrl,
        referenceText: '开放时间早上九点至下午五点。',
      },
    },
  },
  {
    name: '3D-Speaker 声纹',
    request: {
      capability: 'speaker.embed',
      providerId: 'plugin.k2-fsa.speaker-embedding',
      routing: 'local',
      title: 'Smoke · Speaker Embedding',
      input: {
        ...speech,
        comparisonAudioDataUrl: tagging.audioDataUrl,
        comparisonClipName: tagging.clipName,
      },
      parameters: {},
    },
  },
  {
    name: 'CED Audio Tagging',
    request: {
      capability: 'audio.classify',
      providerId: 'plugin.k2-fsa.audio-tagging',
      routing: 'local',
      title: 'Smoke · Audio Tagging',
      input: tagging,
      parameters: {},
    },
  },
  {
    name: 'DeepFilterNet3',
    request: {
      capability: 'audio.enhance',
      providerId: 'plugin.rikorose.deepfilternet3',
      routing: 'local',
      title: 'Smoke · DeepFilterNet3',
      input: noisy,
      parameters: { operations: ['denoise'], denoiseStrength: 0.7 },
    },
  },
  {
    name: 'GTCRN Speech Enhancement',
    request: {
      capability: 'audio.enhance',
      providerId: 'plugin.k2-fsa.gtcrn-simple',
      routing: 'local',
      title: 'Smoke · GTCRN',
      input: noisy,
      parameters: { operations: ['denoise'], denoiseStrength: 0.7 },
    },
  },
  {
    name: 'Pyannote Speaker Diarization',
    request: {
      capability: 'speaker.diarize',
      providerId: 'plugin.k2-fsa.speaker-diarization',
      routing: 'local',
      title: 'Smoke · Speaker Diarization',
      input: speech,
      parameters: {},
    },
  },
  {
    name: 'RNNoise',
    request: {
      capability: 'audio.enhance',
      providerId: 'plugin.xiph.rnnoise',
      routing: 'local',
      title: 'Smoke · RNNoise',
      input: noisy,
      parameters: { operations: ['denoise'], denoiseStrength: 0.7 },
    },
  },
  {
    name: 'Streaming Zipformer 中文',
    request: {
      capability: 'speech.transcribe',
      providerId: 'plugin.k2-fsa.streaming-zipformer-zh',
      routing: 'local',
      title: 'Smoke · Streaming Zipformer',
      input: speech,
      parameters: {},
    },
  },
  {
    name: 'WeText ITN',
    request: {
      capability: 'text.normalize',
      providerId: 'plugin.wetext.text-normalization',
      routing: 'local',
      title: 'Smoke · WeText ITN',
      input: { text },
      parameters: { operator: 'itn', language: 'auto', fullToHalf: true },
    },
  },
  {
    name: 'Zipformer Keyword Spotting',
    skipReason: keywordFixture ? undefined : '缺少关键词阳性音频样本',
    request: {
      capability: 'speech.keyword',
      providerId: 'plugin.k2-fsa.keyword-spotting',
      routing: 'local',
      title: 'Smoke · Keyword Spotting',
      input: keyword,
      parameters: { keywords: ['LIGHT UP'] },
    },
    validate(output) {
      const value = output.output ?? output
      if (value.detected !== true) {
        throw new Error('known keyword fixture was not detected')
      }
    },
  },
  {
    name: '中英文标点恢复',
    request: {
      capability: 'text.punctuate',
      providerId: 'plugin.k2-fsa.punctuation-zh-en',
      routing: 'local',
      title: 'Smoke · Punctuation',
      input: { text },
      parameters: {},
    },
  },
  {
    name: 'Whisper Tiny 语言识别',
    request: {
      capability: 'speech.language',
      providerId: 'plugin.k2-fsa.whisper-language-id',
      routing: 'local',
      title: 'Smoke · Whisper Language ID',
      input: speech,
      parameters: {},
    },
  },
  {
    name: 'Spleeter 2 Stems INT8',
    request: {
      capability: 'audio.separate',
      providerId: 'plugin.k2-fsa.spleeter-2stems',
      routing: 'local',
      title: 'Smoke · Spleeter',
      input: speech,
      parameters: {},
    },
  },
  ...[
    ['FireRedASR AED', 'plugin.firered.fire-red-asr-v1', speech],
    ['FireRedASR2 CTC', 'plugin.firered.fire-red-asr2-ctc', speech],
    ['FunASR Nano', 'plugin.k2-fsa.funasr-nano', speech],
    ['Moonshine v2 Tiny English', 'plugin.usefulsensors.moonshine-v2-tiny-en', englishSpeech],
    ['Paraformer GGUF', 'plugin.funaudiollm.paraformer-gguf', speech],
    ['Parakeet TDT 0.6B v3', 'plugin.nvidia.parakeet-tdt-0.6b-v3', englishSpeech],
    ['Qwen3-ASR 0.6B', 'plugin.qwen.qwen3-asr-0.6b', speech],
    ['Streaming Paraformer', 'plugin.k2-fsa.streaming-paraformer', speech],
    ['WeNetSpeech Yue U2++ CTC', 'plugin.wenet-e2e.wenetspeech-yue-u2pp-ctc', speech],
  ].map(([name, providerId, input]) => ({
    name,
    request: {
      capability: 'speech.transcribe',
      providerId,
      routing: 'local',
      title: `Smoke · ${name}`,
      input,
      parameters: { language: 'auto' },
    },
  })),
  ...[
    ['KittenTTS Nano 英文', 'plugin.k2-fsa.kitten-nano-en', 'This is an English synthesis input test.', { sid: 0, speed: 1 }],
    ['MatchaTTS 中英双语', 'plugin.k2-fsa.matcha-zh-en', '你好，这是中英文输入测试。Hello.', { sid: 0, speed: 1 }],
    ['MeloTTS 中英双语', 'plugin.k2-fsa.vits-melo-zh-en', '你好，这是本地语音合成输入测试。', { sid: 0, speed: 1 }],
    ['PocketTTS 英文音色克隆', 'plugin.k2-fsa.pocket-tts-en', 'This voice cloning input test is working.', {
      speed: 1,
      referenceAudioDataUrl: englishSpeech.audioDataUrl,
    }],
    ['SupertonicTTS 3 多语言', 'plugin.k2-fsa.supertonic-3', 'This is a multilingual synthesis input test.', {
      sid: 0,
      speed: 1,
      language: 'en',
    }],
    ['ZipVoice 中英音色克隆', 'plugin.k2-fsa.zipvoice-zh-en', '你好，这是本地音色克隆输入测试。', {
      speed: 1,
      numSteps: 4,
      referenceAudioDataUrl: speech.audioDataUrl,
      referenceText: '开放时间早上九点至下午五点。',
    }],
  ].map(([name, providerId, synthesisText, parameters]) => ({
    name,
    request: {
      capability: 'speech.synthesize',
      providerId,
      routing: 'local',
      title: `Smoke · ${name}`,
      input: { text: synthesisText },
      parameters,
    },
  })),
]

const cloudTests = [
  ...[
    'qwen-audio-3.0-asr-flash-filetrans',
    'fun-asr',
    'qwen-audio-3.0-asr-flash',
    'fun-asr-flash',
  ].map((modelId) => ({
    name: modelId,
    request: {
      capability: 'speech.transcribe',
      providerId: 'api.bailian',
      routing: 'quality',
      title: `Smoke · ${modelId}`,
      input: speech,
      parameters: {
        modelId,
        language: 'zh',
        context: '语音工作台、Qwen Audio、阿里云百炼',
      },
    },
  })),
  ...[
    'qwen3-asr-flash',
    'qwen-audio-3.0-asr-flash-streaming',
    'fun-asr-realtime',
    'fun-asr-flash-8k-realtime',
    'paraformer-realtime-v2',
    'paraformer-realtime-8k-v2',
  ].map((modelId) => ({
    name: modelId,
    request: {
      capability: 'speech.transcribe',
      providerId: 'api.bailian',
      routing: 'quality',
      title: `Smoke · ${modelId}`,
      input: speech,
      parameters: {
        modelId,
        language: modelId.includes('-8k-') ? 'auto' : 'zh',
        semanticPunctuation: true,
        ...(modelId === 'qwen3-asr-flash'
          ? {
              context: '背景术语：语音工作台、阿里云百炼。',
              enableItn: true,
            }
          : {}),
        ...(['fun-asr-realtime', 'qwen-audio-3.0-asr-flash-streaming'].includes(
          modelId,
        )
          ? { context: '语音工作台、阿里云百炼' }
          : {}),
      },
    },
  })),
  ...['qwen3.6-plus', 'qwen3.7-plus'].map((modelId) => ({
    name: modelId,
    request: {
      capability: 'text.generate',
      providerId: 'api.bailian',
      routing: 'quality',
      title: `Smoke · ${modelId}`,
      input: {
        messages: [
          { role: 'system', content: '只回复一句简短中文。' },
          { role: 'user', content: '确认语音工作台测试正常。' },
        ],
      },
      parameters: {
        modelId,
        temperature: 0.1,
        maxTokens: 64,
      },
    },
  })),
  ...[
    ['qwen-audio-3.0-tts-flash', 'longanhuan_v3.6'],
    ['qwen-audio-3.0-tts-plus', 'longanlingxin'],
    ['cosyvoice-v2', 'longxiaochun_v2'],
    ['cosyvoice-v3-plus', 'longanyang'],
    ['cosyvoice-v3.5-flash', savedVoice('cosyvoice-v3.5-flash')],
    ['cosyvoice-v3.5-plus', savedVoice('cosyvoice-v3.5-plus')],
  ].map(([modelId, voice]) => ({
      name: modelId,
      expectedError:
        modelId === 'cosyvoice-v2' || voice
          ? undefined
          : '需要声音复刻或声音设计生成的音色 ID',
      request: {
        capability: 'speech.synthesize',
        providerId: 'api.bailian',
        routing: 'quality',
        title: `Smoke · ${modelId}`,
        input: { text: '你好，这是云端语音合成测试。' },
        parameters: {
          modelId,
          voice,
          speed: 1,
          ...(modelId.startsWith('qwen-audio-3.0-tts-') ||
          modelId.startsWith('cosyvoice-v3.5-')
            ? { instruction: '自然、清晰地朗读。' }
            : {}),
        },
      },
    })),
  {
    name: 'Fun Audio Denoising',
    request: {
      capability: 'audio.enhance',
      providerId: 'api.bailian',
      routing: 'quality',
      title: 'Smoke · Fun Audio Denoising',
      input: noisy,
      parameters: {
        modelId: 'fun-audio-denoising',
        operations: ['denoise'],
        denoiseStrength: 1,
      },
    },
  },
]

const selectedByLocation =
  process.argv.includes('--local-only')
    ? localTests
    : process.argv.includes('--cloud-only')
      ? cloudTests
      : [...localTests, ...cloudTests]
const filter = process.argv
  .find((argument) => argument.startsWith('--filter='))
  ?.slice('--filter='.length)
  .toLowerCase()
const selected = filter
  ? selectedByLocation.filter((test) =>
      test.name.toLowerCase().includes(filter),
    )
  : selectedByLocation
const results = []
const catalog = await json(`${api}/harness/catalog`)
const readyProviderIds = new Set(
  catalog.providers
    .filter((provider) => provider.status === 'ready')
    .map((provider) => provider.id),
)

for (const test of selected) {
  const startedAt = Date.now()
  if (test.skipReason) {
    results.push({
      name: test.name,
      status: 'skipped',
      elapsedSeconds: 0,
      reason: test.skipReason,
    })
    process.stderr.write(`SKIP ${test.name}\n`)
    continue
  }
  if (
    test.request.providerId.startsWith('plugin.') &&
    !readyProviderIds.has(test.request.providerId)
  ) {
    results.push({
      name: test.name,
      status: 'skipped',
      elapsedSeconds: 0,
      reason: '模型未安装或未启用',
    })
    process.stderr.write(`SKIP ${test.name}\n`)
    continue
  }
  try {
    if (test.enable) {
      await json(`${api}/plugins/${test.enable}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })
    }
    const output = await execute(test.request)
    test.validate?.(output)
    results.push({
      name: test.name,
      status: 'passed',
      elapsedSeconds: (Date.now() - startedAt) / 1000,
      ...summary(output),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    results.push({
      name: test.name,
      status:
        test.expectedError && message.includes(test.expectedError)
          ? 'blocked'
          : 'failed',
      elapsedSeconds: (Date.now() - startedAt) / 1000,
      error: message,
    })
  }
  process.stderr.write(
    `${results.at(-1).status === 'passed' ? 'PASS' : results.at(-1).status === 'blocked' ? 'BLOCK' : 'FAIL'} ${test.name}\n`,
  )
}

console.log(JSON.stringify(results, null, 2))
if (results.some((result) => result.status === 'failed')) process.exitCode = 1
